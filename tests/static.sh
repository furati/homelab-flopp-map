#!/usr/bin/env bash
# FAB-010 Tests ohne Browser: AC-6, AC-12, AC-13/14 (Konfiguration), AC-16, Härtung (NFR-3), CR-1.
# Aufruf aus dem Repo-Wurzelverzeichnis; benötigt Docker und zwei laufende Testcontainer
# (der zweite mit der Test-config.json für CR-1 Startposition, read-only eingebunden):
#   docker build --build-arg UPSTREAM_COMMIT="$(sed -n 's/^UPSTREAM_COMMIT=//p' upstream.pin)" --build-arg VERSION=qa -t fab010-qa:test .
#   docker run -d --name fab010-qa -p 127.0.0.1:18080:8080 --read-only --tmpfs /tmp --cap-drop ALL fab010-qa:test
#   docker run -d --name fab010-qa-cfg -p 127.0.0.1:18081:8080 --read-only --tmpfs /tmp --cap-drop ALL \
#     -v "$PWD/tests/fixtures/config-test.json:/usr/share/nginx/html/config.json:ro" fab010-qa:test
#   tests/static.sh
# Browser-Tests danach mit denselben Containern: tests/browser/*.mjs (BASE, BASE_CONFIG).
set -u
BASE=${BASE:-http://127.0.0.1:18080}
BASE_CONFIG=${BASE_CONFIG:-http://127.0.0.1:18081}
IMG=${IMG:-fab010-qa:test}
CNT=${CNT:-fab010-qa}
CNT_CONFIG=${CNT_CONFIG:-fab010-qa-cfg}
fail=0
ok()  { echo "PASS  $1"; }
bad() { echo "FAIL  $1"; fail=$((fail+1)); }
t()   { if eval "$2"; then ok "$1"; else bad "$1"; fi; }

# AC-6: kein Umami-Skript im Artefakt, in Dockerfile, Workflows, Patches (hinzugefügte Zeilen)
dist=$(mktemp -d); docker cp "$CNT":/usr/share/nginx/html/. "$dist" >/dev/null
t "AC-6 kein Script-Tag/Abruf mit umami im Artefakt" '! grep -rIE "<script[^>]*umami|cloud\.umami\.is|u\.js" "$dist" --include=*.html --include=*.js'
t "AC-6 im Artefakt nur inaktive umami-Referenzen (window.umami?.track, disable)" 'python3 - "$dist" <<PY
import sys,glob,re
bad=[]
for f in glob.glob(sys.argv[1]+"/*.js"):
    for m in re.finditer(r".{0,30}umami.{0,30}", open(f,errors="ignore").read()):
        if not re.search(r"window\.umami|umami\.disabled|disable-umami|enable-umami", m.group(0)): bad.append(m.group(0))
print(bad[:3]); sys.exit(1 if bad else 0)
PY'
t "AC-6 index.html ohne <script src=u.js>" '! grep -q "u\.js" "$dist/index.html"'
t "AC-6 Dockerfile/Workflows laden kein Umami" '! grep -rIE "umami|u\.js" Dockerfile .github/workflows | grep -vE "^Dockerfile:[0-9]*:?#|/u\.js\)\" = 404"'
t "AC-6 Build benutzt nicht make build" '! grep -qE "^RUN .*make build" Dockerfile'
t "AC-6 /u.js liefert 404" '[ "$(curl -s -o /dev/null -w "%{http_code}" $BASE/u.js)" = 404 ]'
t "AC-6 Artefakt ohne bekannte Drittserver (nominatim, stamen, fastly, arcgis, terrestris, mapterhorn, openstreetmap.fr)" '! grep -rIEl "nominatim|stamen|fastly|arcgisonline|terrestris|mapterhorn\.com|openstreetmap\.fr" "$dist" --include=*.js --include=*.html'
t "AC-6 index.html/imprint/privacy ohne <script src=http(s)://" '! grep -E "<script[^>]*src=\"https?://" "$dist"/*.html'
t "AC-3 Impressum/Datenschutz ohne Betreiberanschrift/E-Mail von flopp.net (Namensnennung als MIT-Urheber ist gewollt)" '! grep -qiE "Freiburg im Breisgau|Stra(ß|ss)e|79[0-9]{3}|@[a-z0-9.-]+\.[a-z]{2,}|mailto:" "$dist/imprint.html" "$dist/privacy.html"'

# AC-12: Version == Pin == Label
pin=$(sed -n 's/^UPSTREAM_COMMIT=//p' upstream.pin)
t "AC-12 version.json upstream_commit == upstream.pin" 'curl -s $BASE/version.json | grep -q "\"upstream_commit\": \"$pin\""'
t "AC-12 Image-Label upstream-revision == upstream.pin" '[ "$(docker inspect -f "{{index .Config.Labels \"com.github.furati.flopp-map.upstream-revision\"}}" $IMG)" = "$pin" ]'
t "AC-12 Pin ist ein 40-stelliger SHA" '[[ $pin =~ ^[0-9a-f]{40}$ ]]'

# Härtung (NFR-3/NFR-1)
t "NFR-3 Container läuft als Nicht-Root (UID 101)" '[ "$(docker exec $CNT id -u)" = 101 ]'
t "NFR-3 Root-Dateisystem schreibgeschützt" '[ "$(docker inspect -f "{{.HostConfig.ReadonlyRootfs}}" $CNT)" = true ]'
t "NFR-3 cap-drop ALL" 'docker inspect -f "{{.HostConfig.CapDrop}}" $CNT | grep -q ALL'
t "NFR-3 Schreiben ins Wurzel-FS schlägt fehl" '! docker exec $CNT sh -c "touch /usr/share/nginx/html/x" 2>/dev/null'
h=$(curl -sI $BASE/)
t "NFR-1 Referrer-Policy strict-origin-when-cross-origin" 'grep -qi "^referrer-policy: strict-origin-when-cross-origin" <<<"$h"'
t "NFR-1 CSP connect-src self, script-src self" 'grep -qi "connect-src .self.;" <<<"$h" && grep -qi "script-src .self.;" <<<"$h"'
t "NFR-1 CSP img-src nur OSM/OpenTopoMap/BfN" '! grep -i "^content-security-policy" <<<"$h" | grep -oE "https://[a-z.]+" | grep -vE "^https://([abc]\.tile\.(openstreetmap|opentopomap)\.org|geodienste\.bfn\.de)$" | grep -q .'
# S-13: HSTS genau einmal, ohne includeSubDomains/preload. Dazu CSP und Referrer-Policy je genau
# einmal, auch auf Pfaden mit eigenem location-Block, Assets und 404 (add_header-Vererbung).
hdr() { curl -sI "$BASE$1" | tr -d '\r' | tr '[:upper:]' '[:lower:]' | grep "^$2:"; }
js=$(cd "$dist" && printf '%s\n' *.js | grep -E '\.[0-9a-f]{20}\.js$' | head -n 1)
png=$(cd "$dist" && printf '%s\n' *.png | head -n 1)
t "S-13 gehashtes JS-Asset und PNG im Artefakt gefunden" '[ -f "$dist/$js" ] && [ -f "$dist/$png" ]'
for p in / /index.html /healthz /version.json /config.json "/$js" "/$png" /nope; do
  t "S-13 $p: Strict-Transport-Security genau einmal, genau max-age=31536000" '[ "$(hdr "$p" strict-transport-security)" = "strict-transport-security: max-age=31536000" ]'
  t "S-13 $p: CSP und Referrer-Policy je genau einmal" '[ "$(hdr "$p" content-security-policy | wc -l)" -eq 1 ] && [ "$(hdr "$p" referrer-policy)" = "referrer-policy: strict-origin-when-cross-origin" ]'
done
t "S-13 nginx.conf: add_header nur auf server-Ebene (kein add_header in location)" '! awk "/^[[:space:]]*location/{l=1} l&&/add_header/{f=1} l&&/^[[:space:]]*}/{l=0} END{exit !f}" nginx.conf'

# CR-1 Startposition (Patch 0005): /config.json nie im Image, im Cluster read-only eingebunden;
# Cache-Control no-store; CSP, HSTS und Referrer-Policy wie überall genau einmal.
t "CR-1 Artefakt enthält keine config.json" '[ ! -e "$dist/config.json" ]'
t "CR-1 ohne Mount: /config.json liefert 404" '[ "$(curl -s -o /dev/null -w "%{http_code}" $BASE/config.json)" = 404 ]'
t "CR-1 ohne Mount: 404 auf /config.json landet nicht im Fehlerlog" '! docker logs $CNT 2>&1 | grep -q "config\.json"'
cfg_hdr() { curl -sI "$BASE_CONFIG$1" | tr -d '\r' | tr '[:upper:]' '[:lower:]' | grep "^$2:"; }
t "CR-1 Mount-Container läuft read-only mit cap-drop ALL" '[ "$(docker inspect -f "{{.HostConfig.ReadonlyRootfs}}" $CNT_CONFIG)" = true ] && docker inspect -f "{{.HostConfig.CapDrop}}" $CNT_CONFIG | grep -q ALL'
t "CR-1 mit Mount: /config.json liefert 200 und genau die Test-Datei" '[ "$(curl -s -o /dev/null -w "%{http_code}" $BASE_CONFIG/config.json)" = 200 ] && curl -s $BASE_CONFIG/config.json | cmp -s - tests/fixtures/config-test.json'
t "CR-1 mit Mount: Content-Type application/json" '[ "$(cfg_hdr /config.json content-type)" = "content-type: application/json" ]'
for b in "$BASE" "$BASE_CONFIG"; do
  t "CR-1 $b/config.json: Cache-Control genau einmal, genau no-store" '[ "$(curl -sI "$b/config.json" | tr -d "\r" | tr "[:upper:]" "[:lower:]" | grep "^cache-control:")" = "cache-control: no-store" ]'
done
t "CR-1 mit Mount: HSTS, CSP und Referrer-Policy auf /config.json je genau einmal" '[ "$(cfg_hdr /config.json strict-transport-security)" = "strict-transport-security: max-age=31536000" ] && [ "$(cfg_hdr /config.json content-security-policy | wc -l)" -eq 1 ] && [ "$(cfg_hdr /config.json referrer-policy)" = "referrer-policy: strict-origin-when-cross-origin" ]'
t "CR-1 CSP connect-src bleibt genau self (kein Fremdhost für config.json)" '[ "$(cfg_hdr /config.json content-security-policy | grep -oE "connect-src [^;]*")" = "connect-src '"'"'self'"'"'" ]'
t "CR-1 andere JSON/HTML weiter no-cache (nicht no-store)" '[ "$(cfg_hdr /version.json cache-control)" = "cache-control: no-cache, max-age=0, must-revalidate" ] && [ "$(cfg_hdr /index.html cache-control)" = "cache-control: no-cache, max-age=0, must-revalidate" ]'
t "CR-1 Test-config.json nutzt nur die neutrale Testkoordinate 50.0/10.0" 'python3 -c "import json,sys;c=json.load(open(\"tests/fixtures/config-test.json\"));sys.exit(0 if c==dict(center=dict(lat=50.0,lon=10.0),zoom=9) else 1)"'

t "NFR-2 kein Zugriffslog im Container (Query nicht protokolliert)" 'curl -s "$BASE/?c=48.0123:7.8123&m=A:48.0123:7.8123:0:ZQXlogtest" >/dev/null; ! docker logs $CNT 2>&1 | grep -q ZQXlogtest'
t "Rauchtest /healthz 200" '[ "$(curl -s -o /dev/null -w "%{http_code}" $BASE/healthz)" = 200 ]'
t "Rauchtest unbekannter Pfad -> 404 (kein Proxy/Redirect nach außen)" '[ "$(curl -s -o /dev/null -w "%{http_code}" $BASE/nope)" = 404 ]'
t "Rauchtest Schreibzugriffe (POST) liefern keine 2xx-Daten" '[ "$(curl -s -o /dev/null -w "%{http_code}" -X POST -d x=1 $BASE/)" != 200 ] || true'

# Negativtests Build
t "Neg: Build ohne UPSTREAM_COMMIT scheitert" '! docker build -q -t fab010-neg:x . >/dev/null 2>&1'
t "Neg: Build mit falschem UPSTREAM_COMMIT scheitert" '! docker build -q --build-arg UPSTREAM_COMMIT=0000000000000000000000000000000000000000 -t fab010-neg:x . >/dev/null 2>&1'

# AC-13/AC-14: Konfiguration
t "AC-13 renovate.json: gültiges JSON" 'python3 -c "import json;json.load(open(\"renovate.json\"))"'
t "AC-13 Upstream-Regel ohne Automerge" 'python3 - <<PY
import json,sys
c=json.load(open("renovate.json"))
r=[x for x in c["packageRules"] if "https://github.com/flopp/map" in x.get("matchDepNames",[])][0]
sys.exit(0 if r["automerge"] is False and "compare/{{{currentDigest}}}...{{{newDigest}}}" in "".join(r["prBodyNotes"]) else 1)
PY'
t "AC-13 upstream.pin trägt Renovate-Kommentar (git-refs)" 'grep -q "^# renovate: datasource=git-refs depName=https://github.com/flopp/map$" upstream.pin'
t "AC-14 Checkliste nennt Host-Prüfung und HAR" 'grep -q "known-hosts" renovate.json && grep -qi "HAR" renovate.json'
t "AC-13 Renovate-Workflow nur schedule/workflow_dispatch (kein Push-Trigger)" '! grep -qE "^  (push|pull_request):" .github/workflows/renovate.yml'
t "NFR-9 Publish-Workflow nur main/Tags, nicht fab-Branch" '! grep -q "fab/" .github/workflows/publish-docker.yml'

# AC-16: Secrets
t "AC-16 keine Klartext-Secrets (Token-Muster, private keys)" '! git grep -InE "ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|AKIA[0-9A-Z]{16}|password\s*[:=]\s*[^ ]{4,}" -- . ":!package-lock.json"'
t "AC-16 Secrets nur als \${{ secrets.* }} referenziert" '! grep -rnE "(token|password):\s*[A-Za-z0-9]{10,}" .github'
t "AC-16 kein .env/Schlüsseldatei im Repo" '! git ls-files | grep -qiE "(^|/)\.env|\.pem$|\.key$|secret"'

rm -rf "$dist"
echo; [ $fail -eq 0 ] && echo "alle bestanden" || echo "$fail fehlgeschlagen"
exit $fail
