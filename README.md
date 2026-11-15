# homelab-flopp-map

Build-Repo für eine private Instanz von [Flopp's Map](https://github.com/flopp/map)
(Kartenwerkzeug für Geocacher, reine Browser-App ohne Backend). Die Instanz
läuft im Homelab-k3s unter `map.athome.buhlrich.com` und ist nur im LAN/VPN
erreichbar. Der Kartenzustand (Koordinaten, Markernamen, Links) soll dabei nicht
an Dritte gehen, ausgenommen die Kartenkachel-Abrufe.

Das Repo enthält **keinen Upstream-Code**. Es hält den gepinnten Upstream-Commit,
das Lockfile und die Abweichungen. Das Image holt den Upstream beim Build am Pin.

## Dateien

| Datei | Zweck |
|---|---|
| `upstream.pin` | Upstream-Branch und gepinnter Commit-SHA (Renovate-Kommentar `git-refs`) |
| `package-lock.json` | Lockfile zur `package.json` des gepinnten Upstream-Commits |
| `.gitignore`, `.dockerignore` | Ausschlüsse |

## Abweichungen vom Upstream

Keine.

## Lizenz

Flopp's Map ist von Florian Pigorsch und steht unter der MIT-Lizenz
(<https://github.com/flopp/map>). Die Upstream-`LICENSE` wird mit dem Image
ausgeliefert. Dieses Repo ist ein privater Betriebs-Build und gehört nicht zum
Upstream-Projekt.
