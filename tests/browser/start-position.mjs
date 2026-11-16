// CR-1 Startposition (Patch 0005): config.json gilt nur als Default; URL-Parameter und gespeicherter
// Zustand haben Vorrang, Fehler fallen still auf den Upstream-Default 48/8, Zoom 13 zurück.
// Nur neutrale Testkoordinaten. Zwei Container (Aufruf im Kopf von tests/static.sh):
//   BASE         ohne config.json (Image wie gebaut, 404)
//   BASE_CONFIG  mit tests/fixtures/config-test.json read-only nach /usr/share/nginx/html/config.json
import { readFileSync } from "node:fs";
import { BASE, launch, check, finish } from "./common.mjs";

const BASE_CONFIG = process.env.BASE_CONFIG || "http://127.0.0.1:18081";
const fixture = JSON.parse(readFileSync(new URL("../fixtures/config-test.json", import.meta.url), "utf8"));
const CONFIG = { lat: fixture.center.lat, lon: fixture.center.lon, zoom: fixture.zoom };
const DEFAULT = { lat: 48, lon: 8, zoom: 13 };

const browser = await launch();
const foreign = []; // Anfragen außer der Instanz; Kacheln werden hier nicht gebraucht und abgebrochen

// Frisches Profil; `config` ersetzt optional die Antwort auf /config.json (Body, Status oder "hang").
async function open(base, path = "/", { config, ctx: reuse } = {}) {
    const ctx = reuse ?? (await browser.newContext());
    if (!reuse) {
        await ctx.route("**/*", (route) => {
            const u = new URL(route.request().url());
            if (u.origin === new URL(base).origin || ["data:", "blob:"].includes(u.protocol)) return route.continue();
            if (!/\.tile\.|geodienste\.bfn\.de/.test(u.hostname)) foreign.push(u.href);
            return route.abort();
        });
        if (config !== undefined) {
            await ctx.route(`${base}/config.json`, (route) => {
                if (config === "hang") return; // nie beantworten: Timeout der App greift
                return route.fulfill({ status: config.status ?? 200, contentType: "application/json", body: config.body });
            });
        }
    }
    const page = await ctx.newPage();
    const warnings = [];
    page.on("console", (m) => { if (m.type() === "warning") warnings.push(m.text()); });
    const t0 = Date.now();
    await page.goto(base + path, { waitUntil: "load" });
    await page.waitForFunction(() => window.app?.map_state?.center, null, { timeout: 10000 });
    const startMs = Date.now() - t0;
    await page.waitForTimeout(300);
    const view = await page.evaluate(() => {
        const s = window.app.map_state, m = window.app.leaflet.map.getCenter();
        return {
            lat: s.center.lat(), lon: s.center.lng(), zoom: s.zoom,
            map: { lat: m.lat, lon: m.lng, zoom: window.app.leaflet.map.getZoom() },
            errors: document.querySelectorAll("#notification-container .is-danger").length,
        };
    });
    return { ctx, page, view, warnings, startMs };
}
// Zustand exakt; Leaflet rundet die Kartenmitte auf ganze Pixel (bei Zoom 9 etwa 0,003°).
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;
const at = (v, exp) => near(v.lat, exp.lat) && near(v.lon, exp.lon) && v.zoom === exp.zoom
    && near(v.map.lat, exp.lat, 0.01) && near(v.map.lon, exp.lon, 0.01) && v.map.zoom === exp.zoom;
const fmt = (v) => `state ${v.lat}/${v.lon} z${v.zoom}, Karte ${v.map.lat}/${v.map.lon} z${v.map.zoom}`;
const appWarn = (w) => w.some((x) => /config\.json/.test(x));

// (1) ohne config.json: Upstream-Default, kein Fehlerdialog, keine Warnung der App
{
    const { ctx, view, warnings } = await open(BASE);
    check("CR-1 (1) ohne config.json: Start bei 48/8, Zoom 13", at(view, DEFAULT), fmt(view));
    check("CR-1 (1) ohne config.json: kein Fehlerdialog, keine Warnung", view.errors === 0 && !appWarn(warnings), warnings.join(" | "));
    await ctx.close();
}

// (2) gültige config.json (Container mit Mount)
{
    const r = await (await fetch(`${BASE_CONFIG}/config.json`)).json();
    check("CR-1 (2) BASE_CONFIG liefert die Test-config.json", JSON.stringify(r) === JSON.stringify(fixture), JSON.stringify(r));
    const { ctx, view, warnings } = await open(BASE_CONFIG);
    check("CR-1 (2) mit config.json: Karte startet an der konfigurierten Position und Zoomstufe", at(view, CONFIG), fmt(view));
    check("CR-1 (2) mit config.json: kein Fehlerdialog, keine Warnung", view.errors === 0 && !appWarn(warnings), warnings.join(" | "));
    await ctx.close();
}

// (3) kaputte oder ungültige Datei: still auf den Default (höchstens console.warn)
const bad = [
    ["kaputtes JSON", { body: '{ "center": { "lat": 50.0, "lon": ' }],
    ["leere Datei", { body: "" }],
    ["lat außerhalb (90.5)", { body: JSON.stringify({ center: { lat: 90.5, lon: 10.0 }, zoom: 9 }) }],
    ["lon außerhalb (-180.5)", { body: JSON.stringify({ center: { lat: 50.0, lon: -180.5 }, zoom: 9 }) }],
    ["Zoom 21", { body: JSON.stringify({ center: { lat: 50.0, lon: 10.0 }, zoom: 21 }) }],
    ["Zoom 9.5", { body: JSON.stringify({ center: { lat: 50.0, lon: 10.0 }, zoom: 9.5 }) }],
    ["Werte als Text", { body: JSON.stringify({ center: { lat: "50.0", lon: "10.0" }, zoom: "9" }) }],
    ["ohne zoom", { body: JSON.stringify({ center: { lat: 50.0, lon: 10.0 } }) }],
    ["HTTP 500", { status: 500, body: JSON.stringify(fixture) }],
];
for (const [name, config] of bad) {
    const { ctx, view, warnings } = await open(BASE_CONFIG, "/", { config });
    check(`CR-1 (3) ${name}: Start bei 48/8, Zoom 13, kein Fehlerdialog, console.warn`, at(view, DEFAULT) && view.errors === 0 && appWarn(warnings), `${fmt(view)}; ${warnings.join(" | ")}`);
    await ctx.close();
}
{
    const { ctx, view, startMs } = await open(BASE_CONFIG, "/", { config: "hang" });
    check("CR-1 (3) config.json antwortet nicht: nach Timeout (2 s) Start bei 48/8, Zoom 13", at(view, DEFAULT) && startMs >= 1900 && startMs < 6000, `${fmt(view)}; Start nach ${startMs} ms`);
    await ctx.close();
}

// (4) URL-Parameter schlagen config.json
{
    const { ctx, view } = await open(BASE_CONFIG, "/?c=48.0:7.8&z=11");
    check("CR-1 (4) ?c=48.0:7.8&z=11 schlägt config.json", at(view, { lat: 48.0, lon: 7.8, zoom: 11 }), fmt(view));
    await ctx.close();
}
{
    const { ctx, page } = await open(BASE_CONFIG, "/?m=A:48.0:7.8:0:ZQXstart:ff0000");
    await page.waitForTimeout(1000);
    const v = await page.evaluate(() => {
        const m = window.app.leaflet.map.getCenter();
        return { lat: m.lat, lon: m.lng, markers: window.app.map_state.markers.length };
    });
    check("CR-1 (4) Link nur mit Marker (?m=…): Karte zeigt den Marker, nicht die config.json-Position", v.markers === 1 && Math.abs(v.lat - 48.0) < 0.01 && Math.abs(v.lon - 7.8) < 0.01, JSON.stringify(v));
    await ctx.close();
}

// (5) gespeicherter Zustand (localStorage) schlägt config.json
{
    const first = await open(BASE_CONFIG, "/?c=47.5:9.0&z=12");
    await first.page.close();
    const { ctx, view } = await open(BASE_CONFIG, "/", { ctx: first.ctx });
    check("CR-1 (5) gespeicherter Zustand (47.5/9, z12) schlägt config.json beim nächsten Aufruf ohne Parameter", at(view, { lat: 47.5, lon: 9.0, zoom: 12 }), fmt(view));
    await ctx.close();
}

check("keine Anfrage an Fremdhosts außer Kacheln", foreign.length === 0, foreign.join(" "));
await browser.close();
finish();
