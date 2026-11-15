import assert from "node:assert/strict";
import {test} from "node:test";

import {compare, cspImgHosts, expandTileHost, extractHosts, parseKnownHosts} from "./check-hosts.mjs";

const NGINX = `add_header Content-Security-Policy "default-src 'self'; script-src 'self'; img-src 'self' data: https://a.tile.example.org https://b.tile.example.org https://c.tile.example.org https://wms.example.org; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'" always;`;
const KNOWN = parseKnownHosts(`
# Kommentar
{s}.tile.example.org | tile | Kacheln | Ausschnitt
wms.example.org | tile | WMS | Ausschnitt
www.w3.org | xmlns | Namensraum | nein
`);

test("extractHosts findet Hosts, Platzhalter und Template-Reste", () => {
    const text = 'a="https://{s}.tile.example.org/{z}/{x}/{y}.png" b=http://WWW.w3.org/2000/svg c="https://${host}/x"';
    assert.deepEqual(
        [...extractHosts(text)].sort(),
        ["${host}", "www.w3.org", "{s}.tile.example.org"],
    );
});

test("parseKnownHosts lehnt falsche Zeilen ab", () => {
    assert.throws(() => parseKnownHosts("a.example | tile | nur drei"), /erwartet/);
    assert.throws(() => parseKnownHosts("a.example | tracker | x | y"), /unbekannte Klasse/);
    assert.throws(() => parseKnownHosts("a.example | link | x | y\na.example | link | x | y"), /doppelt/);
});

test("expandTileHost ersetzt {s} durch a, b, c", () => {
    assert.deepEqual(expandTileHost("{s}.tile.example.org"), ["a.tile.example.org", "b.tile.example.org", "c.tile.example.org"]);
    assert.deepEqual(expandTileHost("wms.example.org"), ["wms.example.org"]);
});

test("cspImgHosts liest nur https-Quellen aus img-src", () => {
    assert.deepEqual(cspImgHosts(NGINX).length, 4);
});

test("compare: alles passt", () => {
    const found = new Set(["{s}.tile.example.org", "wms.example.org", "www.w3.org"]);
    assert.deepEqual(compare(found, KNOWN, NGINX), []);
});

test("compare: neuer Host lässt die Prüfung scheitern", () => {
    const found = new Set(["{s}.tile.example.org", "wms.example.org", "www.w3.org", "tracker.example.com"]);
    const problems = compare(found, KNOWN, NGINX);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /neuer Host in dist\/: tracker\.example\.com/);
});

test("compare: entfallener Host lässt die Prüfung scheitern", () => {
    const found = new Set(["{s}.tile.example.org", "wms.example.org"]);
    assert.match(compare(found, KNOWN, NGINX)[0], /Host nicht mehr in dist\/: www\.w3\.org/);
});

test("compare: tile-Host ohne CSP-Eintrag wird gemeldet", () => {
    const nginx = NGINX.replace(" https://wms.example.org", "");
    const found = new Set(["{s}.tile.example.org", "wms.example.org", "www.w3.org"]);
    assert.match(compare(found, KNOWN, nginx)[0], /entsprechen nicht img-src/);
});

test("compare: gelockerte CSP wird gemeldet", () => {
    const nginx = NGINX.replace("connect-src 'self'", "connect-src 'self' https://x.example.org");
    const found = new Set(["{s}.tile.example.org", "wms.example.org", "www.w3.org"]);
    assert.match(compare(found, KNOWN, nginx)[0], /connect-src muss genau 'self' sein/);
});

const FOUND = new Set(["{s}.tile.example.org", "wms.example.org", "www.w3.org"]);

test("compare: gelockertes img-src (*, https:, http:, Wildcard-Host) wird gemeldet", () => {
    for (const loose of ["*", "https:", "http://a.tile.example.org", "https://*.example.org"]) {
        const nginx = NGINX.replace("img-src 'self'", `img-src ${loose} 'self'`);
        const problems = compare(FOUND, KNOWN, nginx);
        assert.ok(problems.some((problem) => problem.includes("img-src zu locker") && problem.includes(loose)), loose);
    }
});

test("compare: fehlende oder gelockerte Direktiven werden gemeldet", () => {
    for (const [directive, replacement] of [
        ["default-src 'self'; ", ""],
        ["default-src 'self'", "default-src *"],
        ["base-uri 'self'; ", ""],
        ["form-action 'self'", "form-action https://x.example.org"],
        ["frame-ancestors 'none'", "frame-ancestors 'self'"],
        ["object-src 'none'; ", ""],
    ]) {
        const problems = compare(FOUND, KNOWN, NGINX.replace(directive, replacement));
        assert.equal(problems.length, 1, directive);
        assert.match(problems[0], /CSP/);
    }
});
