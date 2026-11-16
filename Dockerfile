# Flopp's Map als statischer Build eines gepinnten Upstream-Commits.
# Der Upstream hat weder Releases noch ein Image, deshalb holt die Build-Stufe
# den Commit aus upstream.pin, wendet die Patches an und baut mit webpack.
# `make build` wird bewusst NICHT benutzt: Es lädt zur Bauzeit das Umami-Skript
# (cloud.umami.is) nach dist/u.js.
#
# Bauen (die Upstream-Revision kommt aus der Pin-Datei und wird gegengeprüft):
#   docker build --build-arg UPSTREAM_COMMIT="$(sed -n 's/^UPSTREAM_COMMIT=//p' upstream.pin)" \
#                --build-arg VERSION=dev -t homelab-flopp-map:dev .

FROM --platform=$BUILDPLATFORM node:26-alpine@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5 AS build

# Muss mit upstream.pin übereinstimmen; so landet kein veralteter Wert im Label.
ARG UPSTREAM_COMMIT
ARG VERSION=dev

# Nur Build-Stufe; die Paketversion wandert mit dem Basis-Image-Digest.
# hadolint ignore=DL3018
RUN apk add --no-cache git

WORKDIR /src
COPY upstream.pin package-lock.json ./

# Upstream am Pin holen; git prüft dabei den SHA.
RUN PIN="$(sed -n 's/^UPSTREAM_COMMIT=//p' upstream.pin)" \
    && { test -n "$UPSTREAM_COMMIT" && test "$UPSTREAM_COMMIT" = "$PIN" \
         || { echo "UPSTREAM_COMMIT passt nicht zu upstream.pin" >&2; exit 1; }; } \
    && git init -q upstream \
    && git -C upstream fetch -q --depth 1 https://github.com/flopp/map.git "$UPSTREAM_COMMIT" \
    && git -C upstream checkout -q FETCH_HEAD \
    && test "$(git -C upstream rev-parse HEAD)" = "$UPSTREAM_COMMIT"

WORKDIR /src/upstream

# Abhängigkeiten aus dem Lockfile des Build-Repos (der Upstream hat keines).
RUN cp /src/package-lock.json . \
    && npm ci --ignore-scripts --no-audit --no-fund

# Ersatzseiten für Impressum und Datenschutz (die Upstream-Seiten nennen den
# Betreiber von flopp.net).
COPY overrides/ src/

# Abweichungen vom Upstream. `git apply` bricht bei jedem Konflikt ab, der Build
# scheitert dann laut, statt eine Änderung still zu verlieren.
COPY patches/ /src/patches/
RUN git apply --whitespace=error-all /src/patches/*.patch

# Host-Prüfung: Hilfsskript, Hostliste und CSP (nginx.conf).
COPY tools/ /src/tools/
COPY known-hosts nginx.conf /src/
RUN node --test /src/tools/check-hosts.test.mjs

# Upstream-Tests (inklusive der in den Patches angepassten). Eigener Schritt, damit
# das Build-Log zeigt, welche Prüfung scheitert.
# hadolint ignore=DL3059
RUN npx --no-install vitest run

# version.ts mit dem Commit-Zeitstempel des Upstreams (reproduzierbar, nicht `date`).
RUN echo "export const Version = { build_date: $(git log -1 --format=%ct) };" > src/components/version.ts \
    && npx --no-install webpack --config webpack.prod.js

# Jeder neue oder entfallene Host in dist/ lässt den Build scheitern.
RUN node /src/tools/check-hosts.mjs dist /src/known-hosts /src/nginx.conf

RUN printf '{ "build_date": %s, "upstream_commit": "%s", "version": "%s" }\n' \
      "$(git log -1 --format=%ct)" "$UPSTREAM_COMMIT" "$VERSION" > dist/version.json \
    && cp LICENSE dist/LICENSE


FROM nginxinc/nginx-unprivileged:1.30-alpine@sha256:f5116ed4606f3eb015dd4a8e28cb9b351476dc0ad4bc6e9f93b19cec130cdf03

# Sicherheitsupdates der Alpine-Pakete: Der Digest-Pin des Basis-Images hinkt den
# Fixes hinterher (brotli, curl, expat, libxslt, musl, zlib). Zurück auf 101 am Ende.
USER 0
RUN apk upgrade --no-cache

ARG UPSTREAM_COMMIT
ARG VERSION=dev

LABEL org.opencontainers.image.title="homelab-flopp-map" \
      org.opencontainers.image.description="Flopp's Map ohne Analytics, nur OSM, OpenTopoMap und BfN-NPA" \
      org.opencontainers.image.source="https://github.com/furati/homelab-flopp-map" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${VERSION}" \
      com.github.furati.flopp-map.upstream-revision="${UPSTREAM_COMMIT}"

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /src/upstream/dist /usr/share/nginx/html

# Nicht-Root ausdrücklich, unabhängig vom Basis-Image (nginx-unprivileged: uid 101).
USER 101

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8080/healthz"]
