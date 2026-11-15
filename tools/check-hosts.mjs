// Host-Prüfung für das gebaute dist/ (FAB-010, FR-9, AC-14).
//
// Zieht alle URL-Hosts aus den Textdateien von dist/ (ohne Source Maps) und
// vergleicht sie mit `known-hosts`. Ein neuer oder entfallener Host lässt den
// Build scheitern, bis die Liste im selben PR angepasst ist. Zusätzlich müssen
// die Hosts der Klasse `tile` exakt denen in `img-src` der CSP in nginx.conf
// entsprechen; `script-src` und `connect-src` dürfen nur 'self' enthalten.
//
// Aufruf: node tools/check-hosts.mjs <dist> <known-hosts> <nginx.conf>

import {readdirSync, readFileSync} from "node:fs";
import {extname, join} from "node:path";
import {pathToFileURL} from "node:url";

export const CLASSES = ["tile", "link", "xmlns", "same-origin"];
const TEXT_EXTENSIONS = new Set([".html", ".js", ".css", ".json", ".svg", ".txt", ""]);
// Platzhalter {s} der Kachel-URLs; die Subdomains stehen in known-hosts-Zeile und CSP.
const TILE_SUBDOMAINS = ["a", "b", "c"];

export const extractHosts = (text) => {
    const hosts = new Set();
    for (const match of text.matchAll(/\b(?:https?|wss?):\/\/([A-Za-z0-9._{}$-]+)/g)) {
        hosts.add(match[1].toLowerCase().replace(/\.+$/, ""));
    }
    return hosts;
};

export const parseKnownHosts = (text) => {
    const known = new Map();
    text.split("\n").forEach((line, index) => {
        const trimmed = line.trim();
        if (trimmed === "" || trimmed.startsWith("#")) {
            return;
        }
        const fields = trimmed.split("|").map((field) => field.trim());
        if (fields.length !== 4 || fields.some((field) => field === "")) {
            throw new Error(`known-hosts Zeile ${index + 1}: erwartet "host | klasse | zweck | kartenzustand"`);
        }
        const [host, cls, purpose, state] = fields;
        if (!CLASSES.includes(cls)) {
            throw new Error(`known-hosts Zeile ${index + 1}: unbekannte Klasse "${cls}" (erlaubt: ${CLASSES.join(", ")})`);
        }
        if (known.has(host)) {
            throw new Error(`known-hosts Zeile ${index + 1}: Host "${host}" doppelt`);
        }
        known.set(host, {cls, purpose, state});
    });
    return known;
};

export const expandTileHost = (host) =>
    host.includes("{s}") ? TILE_SUBDOMAINS.map((sub) => host.replace("{s}", sub)) : [host];

const cspDirective = (nginxConf, name) => {
    const csp = nginxConf.match(/add_header Content-Security-Policy "([^"]*)"/);
    if (csp === null) {
        throw new Error("nginx.conf: keine Content-Security-Policy gefunden");
    }
    const directive = csp[1]
        .split(";")
        .map((part) => part.trim())
        .find((part) => part.split(/\s+/)[0] === name);
    if (directive === undefined) {
        throw new Error(`nginx.conf: CSP ohne ${name}`);
    }
    return directive.split(/\s+/).slice(1);
};

export const cspImgHosts = (nginxConf) =>
    cspDirective(nginxConf, "img-src")
        .filter((source) => source.startsWith("https://"))
        .map((source) => source.slice("https://".length));

const sorted = (values) => [...values].sort();

export const compare = (found, known, nginxConf) => {
    const problems = [];
    for (const host of sorted(found)) {
        if (!known.has(host)) {
            problems.push(`neuer Host in dist/: ${host} (in known-hosts klassifizieren und prüfen, ob Kartenzustand fließt)`);
        }
    }
    for (const host of sorted(known.keys())) {
        if (!found.has(host)) {
            problems.push(`Host nicht mehr in dist/: ${host} (aus known-hosts entfernen)`);
        }
    }

    const tiles = sorted([...known].filter(([, entry]) => entry.cls === "tile").flatMap(([host]) => expandTileHost(host)));
    const csp = sorted(cspImgHosts(nginxConf));
    if (tiles.join(" ") !== csp.join(" ")) {
        problems.push(`tile-Hosts (${tiles.join(", ")}) entsprechen nicht img-src der CSP (${csp.join(", ")})`);
    }
    for (const name of ["script-src", "connect-src"]) {
        if (cspDirective(nginxConf, name).join(" ") !== "'self'") {
            problems.push(`CSP ${name} muss genau 'self' sein`);
        }
    }
    return problems;
};

const listFiles = (dir) =>
    readdirSync(dir, {withFileTypes: true}).flatMap((entry) =>
        entry.isDirectory() ? listFiles(join(dir, entry.name)) : [join(dir, entry.name)],
    );

export const collectHosts = (dist) => {
    const hosts = new Set();
    for (const file of listFiles(dist)) {
        if (file.endsWith(".map") || !TEXT_EXTENSIONS.has(extname(file))) {
            continue;
        }
        extractHosts(readFileSync(file, "utf8")).forEach((host) => hosts.add(host));
    }
    return hosts;
};

const main = (dist, knownFile, nginxFile) => {
    const found = collectHosts(dist);
    const known = parseKnownHosts(readFileSync(knownFile, "utf8"));
    const problems = compare(found, known, readFileSync(nginxFile, "utf8"));
    if (problems.length > 0) {
        console.error("Host-Prüfung fehlgeschlagen:");
        problems.forEach((problem) => console.error(`  - ${problem}`));
        process.exit(1);
    }
    console.log(`Host-Prüfung ok: ${found.size} Hosts, alle in known-hosts, tile-Hosts stimmen mit der CSP überein`);
};

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
    if (process.argv.length !== 5) {
        console.error("Aufruf: node tools/check-hosts.mjs <dist> <known-hosts> <nginx.conf>");
        process.exit(2);
    }
    main(process.argv[2], process.argv[3], process.argv[4]);
}
