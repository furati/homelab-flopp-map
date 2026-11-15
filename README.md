# homelab-flopp-map

Build-Repo für eine private Instanz von [Flopp's Map](https://github.com/flopp/map)
(Kartenwerkzeug für Geocacher, reine Browser-App ohne Backend). Die Instanz
läuft im Homelab-k3s unter `map.athome.buhlrich.com` und ist nur im LAN/VPN
erreichbar. Der Kartenzustand (Koordinaten, Markernamen, Links) soll dabei nicht
an Dritte gehen, ausgenommen die Kartenkachel-Abrufe.

Das Repo enthält **keinen Upstream-Code**. Es hält den gepinnten Upstream-Commit,
das Lockfile und die Abweichungen. Das Image holt den Upstream beim Build am Pin.

## Dateien

| Datei oder Ordner | Zweck |
|---|---|
| `upstream.pin` | Upstream-Branch und gepinnter Commit-SHA (Renovate-Kommentar `git-refs`) |
| `package-lock.json` | Lockfile zur `package.json` des gepinnten Upstream-Commits (der Upstream hat keines) |
| `patches/` | die Abweichungen vom Upstream, je ein Patch (siehe unten) |
| `overrides/` | Ersatzseiten `imprint.html` und `privacy.html` |
| `known-hosts` | klassifizierte Liste aller Hosts in der gebauten Seite (**Hostliste**, FR-9) |
| `tools/check-hosts.mjs` | Host-Prüfung im Build, mit Tests (`node --test tools/`) |
| `nginx.conf` | Header (CSP, Referrer-Policy), Caching, `/healthz`, kein Zugriffslog |
| `Dockerfile` | Build-Stufe (Node-LTS) und Laufzeit-Stufe (nginx-unprivileged), beide per Digest gepinnt |
| `.github/workflows/` | `build-docker.yml` (PR und Push, ohne Veröffentlichung, mit Rauchtest), `publish-docker.yml` (ghcr, amd64 und arm64), `renovate.yml` (monatlich) |
| `renovate.json` | Renovate-Konfiguration (Upstream-Pin, Basis-Images, Actions) |

## Build

Das Dockerfile holt den Upstream am Pin (`git` prüft den SHA), wendet die Patches an,
installiert die Abhängigkeiten per `npm ci --ignore-scripts` aus dem Lockfile, führt die
Upstream-Tests aus, baut mit webpack und prüft die Hosts. `make build` wird **nicht**
benutzt, weil es zur Bauzeit `cloud.umami.is/script.js` nachlädt. `build_date` kommt aus
dem Commit-Zeitstempel des Upstreams, der Build ist damit reproduzierbar.

```bash
docker build \
  --build-arg UPSTREAM_COMMIT="$(sed -n 's/^UPSTREAM_COMMIT=//p' upstream.pin)" \
  --build-arg VERSION=dev -t homelab-flopp-map:dev .
docker run --rm --read-only --tmpfs /tmp -p 8080:8080 homelab-flopp-map:dev
```

`UPSTREAM_COMMIT` muss zu `upstream.pin` passen, sonst bricht der Build ab. `/version.json`
nennt `build_date`, `upstream_commit` und `version`; das Image trägt die Upstream-Revision
im Label `com.github.furati.flopp-map.upstream-revision`.

Das Cluster-Deployment liegt in **homelab-gitops** (`manifests/flopp-map/`, `apps/flopp-map.yaml`).

## Abweichungen vom Upstream

| Patch | Was | Warum |
|---|---|---|
| `0001-no-analytics` | Das Script-Tag `u.js` (Umami) fehlt in `index.html`. | Kein Analytics, FR-8, AC-6 |
| `0002-search-coordinates-only` | Das Suchfeld versteht nur Koordinaten. Der Nominatim-Rückfall fehlt, stattdessen erscheint ein Hinweis (de, en, fr). | Suchtext geht nicht an Dritte, FR-10 |
| `0003-layers` | Nur OpenStreetMap, OpenTopoMap und die BfN-Schutzgebiets-Ebene. Stamen, Humanitarian, ArcGIS (auch mit terrestris-Overlay) und das Mapterhorn-Hillshading sind samt Code entfernt. `t=`-Werte dieser Ebenen (URL, localStorage, JSON-Import) fallen auf OpenStreetMap zurück. Zwei Upstream-Tests sind angepasst, `tests/map_type.test.ts` kommt dazu. | Weniger Drittserver, FR-11 |

Weitere Abweichungen ohne Patch:

- `overrides/imprint.html` und `overrides/privacy.html` ersetzen Impressum und Datenschutz
  des Upstreams (die nennen den Betreiber von flopp.net) durch den Hinweis auf eine private
  interne Instanz. Die Zuordnung zum Upstream (MIT, Quelle) steht in beiden Seiten.
- `version.json` hat zusätzlich `upstream_commit` und `version`.
- `nginx.conf` setzt die CSP, die Referrer-Policy `strict-origin-when-cross-origin` und
  `X-Content-Type-Options`. Das nginx-Zugriffslog ist aus.

**Bekannte Reste** im ausgelieferten `dist/`: Der Treffer für `umami` besteht nur aus den
wirkungslosen Aufrufen `window.umami?.track(...)` (ohne `u.js` gibt es kein `window.umami`)
und dem lokalen Schalter `#disable-umami` in `main.ts`. Es wird kein Skript geladen.
`mapterhorn` kommt nur noch in Übersetzungstexten und im News-Text vor.

## Hostliste (Datenschutz)

Die Seite kontaktiert im Browser nur die eigene Instanz und, je nach Ebene, diese Kachelhosts:
`{a,b,c}.tile.openstreetmap.org`, `{a,b,c}.tile.opentopomap.org` und `geodienste.bfn.de` (WMS
mit dem Kartenausschnitt). Alle Hosts mit Zweck und Klasse stehen in [`known-hosts`](known-hosts).
Die Kachelhosts sehen den **Kartenausschnitt samt Zoomstufe**; bei hoher Zoomstufe über einem
privaten Final ist das fast die Koordinate. Marker, Namen und Links gehen nicht an Dritte, der
Referrer enthält nur die Origin der Instanz.

Zwei Verteidigungslinien halten das ein:

1. **CSP** in `nginx.conf`: `default-src`, `script-src` und `connect-src` nur `'self'`, `img-src`
   nur die Kachelhosts. Ein neuer Abruf im Upstream wird vom Browser blockiert.
   `style-src` braucht `'unsafe-inline'` (style-Attribut im HTML, style-Elemente von
   style-loader und Leaflet).
2. **Host-Prüfung** im Build (`tools/check-hosts.mjs`): Ein neuer oder entfallener Host in
   `dist/` lässt den Build scheitern, bis `known-hosts` im selben PR angepasst ist. Die
   `tile`-Einträge müssen genau den Hosts in `img-src` entsprechen.

## Versionen und Veröffentlichung

Der Tag `vMAJOR.MINOR.PATCH` im Build-Repo ergibt den Image-Tag
(`ghcr.io/furati/homelab-flopp-map:X.Y.Z`, dazu `X.Y`; `main` und `sha-...` bei Push auf `main`).

- MINOR steigt mit jeder Upstream-Übernahme.
- PATCH steigt bei eigenen Korrekturen und Basis-Image-Updates.
- MAJOR steigt, wenn der Upstream das Link- oder JSON-Format ändert (Signal für die dosenwerk-Anbindung).

homelab-gitops pinnt den Semver-Tag; Renovate dort öffnet den PR, der nicht automatisch gemergt wird.
Nach der ersten Veröffentlichung muss das ghcr-Paket einmalig auf **öffentlich** gestellt werden,
sonst schlägt der Pull ohne Pull-Secret fehl. Rollback: den gitops-PR zurücknehmen (ältere Images
bleiben in ghcr).

## Monatliches Update

Der Upstream hat keine Releases. Renovate (Workflow `renovate.yml`, monatlich am 1. um 04:00 UTC
oder per `workflow_dispatch`) vergleicht den Branch `master` mit dem Pin und öffnet bei Änderungen
einen PR mit dem neuen SHA, dem Compare-Link `alt...neu` und der Checkliste nach AC-14.
Basis-Images und Actions kommen im selben Lauf als eigene PRs, ohne Automerge.

1. Renovate öffnet den PR mit neuem SHA.
2. Das CI scheitert typischerweise an Patch, Lockfile oder `known-hosts`.
3. Auf dem PR-Branch Patches und Lockfile neu erzeugen und `known-hosts` anpassen:
   ```bash
   git clone https://github.com/flopp/map.git /tmp/map && cd /tmp/map
   git checkout <neuer SHA>
   # Patches: Abweichungen aus patches/ von Hand übertragen, `git diff > ../NNNN-name.patch`
   # Lockfile (im Verzeichnis mit der neuen package.json):
   npm install --package-lock-only --ignore-scripts
   cp package-lock.json <dieses Repo>/package-lock.json
   ```
   Den Lockfile-Diff prüfen: nur erwartete Änderungen, keine neuen Install-Skripte.
4. Upstream-Tests und Build laufen grün (gehören zum Docker-Build).
5. Der Tester prüft AC-3 bis AC-6 per HAR gegen das lokal gestartete Image und trägt das Ergebnis
   in den PR ein. Ein neuer externer Host oder eine Lockerung der CSP blockiert den Merge, bis Ralf
   entschieden hat.
6. Ralf merged, setzt den Tag (`vX.Y.Z`, MINOR hoch) und merged danach den gitops-PR.

Ohne beide Merges ändert sich die laufende Instanz nicht.

Voraussetzung für Renovate ist das Repo-Secret `RENOVATE_TOKEN` (klassischer PAT mit Scope `repo`).

## Lizenz

Flopp's Map ist von Florian Pigorsch und steht unter der MIT-Lizenz
(<https://github.com/flopp/map>). Die Upstream-`LICENSE` wird mit dem Image
ausgeliefert. Dieses Repo ist ein privater Betriebs-Build und gehört nicht zum
Upstream-Projekt.
