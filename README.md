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
| `nginx.conf` | Header (CSP, Referrer-Policy, HSTS), Caching, `/healthz`, `/config.json`, kein Zugriffslog |
| `tests/` | `static.sh` (Prüfungen gegen laufende Testcontainer, Aufruf im Kopf der Datei), `browser/` (Browser-Tests, Netzwerkmitschnitt, Startposition) und `fixtures/` (Test-`config.json` mit neutraler Koordinate); gehören zu Schritt 5 des Monatsupdates |
| `Dockerfile` | Build-Stufe (Node-LTS) und Laufzeit-Stufe (nginx-unprivileged), beide per Digest gepinnt |
| `.github/workflows/` | `build-docker.yml` (PR und Push, ohne Veröffentlichung, mit Rauchtest), `publish-docker.yml` (ghcr, nur amd64), `renovate.yml` (monatlich) |
| `renovate.json` | Renovate-Konfiguration (Upstream-Pin, Basis-Images, Actions) |

## Build

Das Dockerfile holt den Upstream am Pin (`git` prüft den SHA), wendet die Patches an,
installiert die Abhängigkeiten per `npm ci --ignore-scripts` aus dem Lockfile, führt die
Upstream-Tests aus, baut mit webpack und prüft die Hosts. `make build` wird **nicht**
benutzt, weil es zur Bauzeit `cloud.umami.is/script.js` nachlädt. `build_date` kommt aus
dem Commit-Zeitstempel des Upstreams.

**Reproduzierbarkeit:**

- `dist/` ist reproduzierbar: Upstream-Pin, Lockfile, `--ignore-scripts` und feste Basis-Digests
  legen den App-Code fest.
- Die Laufzeit-Schicht ist es nicht bitgleich: Das Dockerfile führt `apk upgrade` aus, damit bekannte
  CVEs im Alpine-Unterbau des nginx-Images nicht im Image bleiben. Sie kommt vom Paketstand zum
  Bauzeitpunkt. Ein erneuter Lauf für denselben Tag ergibt deshalb einen anderen Image-Digest.
- Reproduzierbar ist das **Deployment**: homelab-gitops pinnt das Image per Digest
  (`:<semver>@sha256:…`), ein neu gebauter Tag schlägt nicht still durch. Den Publish-Lauf eines
  Tags deshalb nicht wiederholen, besonders nicht für Rollback-Ziele.
- Sicherheitsfixes der Alpine-Pakete kommen nur mit einem neuen Build, bei Bedarf als PATCH-Release
  ohne Codeänderung.

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
| `0004-no-analytics-remnants` | Die wirkungslosen Umami-Reste (`window.umami?.track`, Hash-Schalter `#enable-/#disable-umami`, Typdeklaration) sind entfernt. | Kein toter Analytics-Code, FR-8, AC-6 |
| `0005-default-position` | Die Startposition (Upstream fest 48/8, Zoom 13) kommt optional aus `/config.json`. Neues Modul `start_position.ts` mit Test `tests/start_position.test.ts`; in `main.ts`, `app.ts` und `map_state.ts` ändern sich nur wenige Zeilen. | Startposition per Konfiguration, ohne sie ins öffentliche Repo zu schreiben (CR-1, siehe [Startposition](#startposition)) |

Weitere Abweichungen ohne Patch:

- `overrides/imprint.html` und `overrides/privacy.html` ersetzen Impressum und Datenschutz
  des Upstreams (die nennen den Betreiber von flopp.net) durch den Hinweis auf eine private
  interne Instanz. Die Zuordnung zum Upstream (MIT, Quelle) steht in beiden Seiten.
- `version.json` hat zusätzlich `upstream_commit` und `version`.
- `nginx.conf` setzt die CSP, die Referrer-Policy `strict-origin-when-cross-origin`,
  `X-Content-Type-Options` und HSTS (`max-age=31536000`). Das nginx-Zugriffslog ist aus.
  HSTS bewusst **ohne** `includeSubDomains` und `preload`: `includeSubDomains` gälte nur für
  `*.map.athome.buhlrich.com`, und solche Unterdomains gibt es nicht. `preload` ist für einen
  internen Namen nicht möglich und nicht sinnvoll. Gefährlich wäre `includeSubDomains` erst an
  `athome.buhlrich.com` oder `buhlrich.com`, weil dort garten-ota und tasmota-ota per HTTP laufen;
  diese Hosts setzt dieses Repo nicht. TLS terminiert Traefik, und der Ingress nimmt nur
  HTTPS an (HTTP gibt 404). Alle `add_header` stehen auf `server`-Ebene, denn ein `add_header`
  in einem `location`-Block hebt die Vererbung auf. `tests/static.sh` prüft die Header
  deshalb auch auf `/healthz`, `/version.json`, Assets und 404, der Rauchtest im Build-Workflow HSTS.

**Keine Umami-Reste:** `0004-no-analytics-remnants` entfernt die `window.umami?.track(...)`-Aufrufe,
die Schalter `#enable-/#disable-umami` und die Typdeklaration. Im `dist/` gibt es keinen Treffer für `umami`.
`mapterhorn` kommt nur noch in Übersetzungstexten und im News-Text vor.

## Startposition

Ohne Link-Parameter und ohne gespeicherten Zustand öffnet die Karte an einer festen Startposition.
Im Upstream ist das 48/8, Zoom 13. Patch `0005-default-position` liest sie optional aus
`/config.json` (gleiche Origin):

```json
{ "center": { "lat": 50.0, "lon": 10.0 }, "zoom": 9 }
```

Die Werte im Beispiel sind neutrale Testwerte (`tests/fixtures/config-test.json`).

- **Format:** `lat` −90 bis 90 und `lon` −180 bis 180 als Zahlen (kein Text), `zoom` ganzzahlig
  0 bis 20 (höchste Zoomstufe der Karte). Alle drei Werte sind Pflicht.
- **Bereitstellung:** Das Image enthält **keine** `config.json`. Die echte Startposition ist privat
  und steht nur im privaten homelab-gitops, nie in diesem Repo, in Tests oder im Image. Der Cluster
  bindet die Datei als ConfigMap per `subPath` read-only nach `/usr/share/nginx/html/config.json`
  ein; das geht mit schreibgeschütztem Root-Dateisystem. Lokal:
  `docker run --rm --read-only --tmpfs /tmp -p 8080:8080 -v "$PWD/config.json:/usr/share/nginx/html/config.json:ro" homelab-flopp-map:dev`.
- **Laden:** Die App holt die Datei beim Start genau einmal (`fetch("config.json")`, `cache: "no-store"`,
  Timeout 2 s), bevor sie den Kartenzustand aufbaut. nginx liefert sie mit `Cache-Control: no-store`;
  dafür reicht die CSP `connect-src 'self'`.
- **Vorrang wie im Upstream:** Link-Parameter (`?c=`, `z=`, Marker) vor gespeichertem Zustand im
  Browser (localStorage: letzte Kartenmitte und Zoomstufe) vor `config.json` vor 48/8, Zoom 13.
  `config.json` ersetzt also nur den Upstream-Default.
- **Fallback:** Fehlt die Datei (404), antwortet sie nicht innerhalb von 2 s, ist sie kein gültiges JSON
  oder liegt ein Wert außerhalb des Bereichs, startet die Karte bei 48/8, Zoom 13, ohne Fehlerdialog.
  Außer beim 404 steht in der Browser-Konsole eine Warnung (`Ignoring config.json …`). Den 404 zeigt
  der Browser selbst als fehlgeschlagene Anfrage an; nginx schreibt ihn nicht ins Fehlerlog.
- **Änderungen wirken nur für neue Browser:** Wer die Instanz schon geöffnet hat, hat Kartenmitte und
  Zoomstufe im localStorage; dort wirkt eine geänderte Startposition erst nach dem Löschen der
  Website-Daten. Eine per `subPath` eingebundene ConfigMap wird im laufenden Pod nicht aktualisiert,
  eine Änderung braucht einen Neustart des Pods.
- **Datenschutz:** Jeder, der die Instanz erreicht (LAN/VPN), kann `/config.json` abrufen. Die
  Kachelhosts sehen beim ersten Aufruf den Ausschnitt um die Startposition, wie bei jeder anderen
  Kartenansicht auch.

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
4. Upstream-Tests und Build laufen grün (gehören zum Docker-Build). Der Build-Workflow prüft außerdem,
   dass der Pin auf `master` des Upstreams liegt (GitHub liefert über `flopp/map.git` auch Commits aus Forks).
   Bei einem von Hand eingetragenen Pin lokal: `git merge-base --is-ancestor <SHA> origin/master`.
5. Der Tester prüft AC-3 bis AC-6 per HAR gegen das lokal gestartete Image und trägt das Ergebnis
   in den PR ein. Ein neuer externer Host oder eine Lockerung der CSP blockiert den Merge, bis Ralf
   entschieden hat.
6. Ralf merged, setzt den Tag (`vX.Y.Z`, MINOR hoch) und merged danach den gitops-PR.

Ohne beide Merges ändert sich die laufende Instanz nicht.

Voraussetzung für Renovate ist das Repo-Secret `RENOVATE_TOKEN` (klassischer PAT mit Scope `repo`).

## GitHub-Einstellungen

Gesetzt am 15.11.2026 (per `gh api` geprüft), Voraussetzung für Merge und Veröffentlichung:

- **Actions:** nur GitHub-eigene Actions sowie `docker/build-push-action`, `docker/login-action`,
  `docker/metadata-action`, `docker/setup-buildx-action` und `renovatebot/github-action`.
  SHA-Pinning ist Pflicht (`sha_pinning_required`). **Wird eine neue Action nötig, muss die
  Allowlist (Settings, Actions, General) vorher ergänzt werden**, sonst scheitert der Lauf.
- **Fork-Pull-Requests:** Freigabe für alle externen Beitragenden nötig.
  Dazu die Regeln: kein `pull_request_target`, kein `workflow_run` mit Secrets, keine self-hosted Runner.
- **Ruleset `main-schutz`** (Standardbranch): PR-Pflicht, Status-Check `build` muss grün sein,
  kein Force-Push, kein Löschen, kein Bypass.
- **Ruleset `release-tags`** (`v*`): Anlegen, Ändern und Löschen nur durch Repo-Admin.
- **ghcr-Paket** nach der ersten Veröffentlichung auf öffentlich stellen (siehe oben).

Renovate läuft nur monatlich; ein Haken im Dependency Dashboard wirkt daher erst beim nächsten Lauf
oder nach einem Start per `workflow_dispatch`.

## Lizenz

Flopp's Map ist von Florian Pigorsch und steht unter der MIT-Lizenz
(<https://github.com/flopp/map>). Die Upstream-`LICENSE` wird mit dem Image
ausgeliefert. Dieses Repo ist ein privater Betriebs-Build und gehört nicht zum
Upstream-Projekt.
