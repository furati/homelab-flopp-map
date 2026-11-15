// AC-3/AC-4/AC-5: Netzwerkmitschnitt mit >=10 Markern. DURATION_S (Standard 600 = 10 min).
import { writeFileSync } from "node:fs";
import { BASE, TILE_HOSTS, launch, check, finish } from "./common.mjs";

const DURATION_S = Number(process.env.DURATION_S || 600);
const OUT = process.env.OUT || "privacy-requests.json";
// eindeutige Muster: Namen "ZQX..." und Koordinaten 48.0xxxxx / 7.8xxxxx
const markers = Array.from({ length: 12 }, (_, i) => ({
    id: String.fromCharCode(65 + i),
    lat: (48.0 + 0.0137 * (i + 1)).toFixed(6),
    lon: (7.8 + 0.0171 * (i + 1)).toFixed(6),
    name: `ZQXmarker${String(i + 1).padStart(2, "0")}`,
}));
const m = markers.map((x) => `${x.id}:${x.lat}:${x.lon}:${i100(x)}:${x.name}:ff0000`).join("*");
function i100(x) { return x.id === "A" ? 150 : 0; }
const link = `${BASE}/?c=48.1:7.9&z=11&t=OPENSTREETMAP&m=${m}&d=A:B:0000ff*C:D:00aa00`;
const patterns = [...markers.flatMap((x) => [x.name, x.lat, x.lon, x.lat.replace(/0+$/, ""), x.lon.replace(/0+$/, "")]),
    "ZQX", "48.0137", "7.8171"];

const browser = await launch();
const ctx = await browser.newContext(); // frisches Profil
const log = [];
ctx.on("request", async (req) => {
    let headers = {};
    try { headers = await req.allHeaders(); } catch {}
    log.push({ t: Date.now(), method: req.method(), url: req.url(), headers, body: req.postData() });
});
const blocked = [];
await ctx.route("**/*", (route) => {
    const u = new URL(route.request().url());
    if (u.origin === BASE || u.protocol === "data:" || u.protocol === "blob:" || TILE_HOSTS.test(u.hostname)) return route.continue();
    blocked.push(route.request().url());
    return route.abort();
});
const page = await ctx.newPage();
const consoleMsgs = [];
page.on("console", (c) => { if (["error", "warning"].includes(c.type())) consoleMsgs.push(c.text()); });
await page.goto(link, { waitUntil: "load" });
await page.waitForTimeout(5000);
// Bedienung: Ebene wechseln, Link-Dialog, Marker anklicken, Zoomen
const setLayer = (v) => page.evaluate((x) => { const s = document.querySelector("select[data-base-layer]"); s.value = x; s.dispatchEvent(new Event("change")); }, v);
await setLayer("OPENTOPOMAP");
await page.waitForTimeout(3000);
await page.evaluate(() => { const c = document.querySelector("[data-german-npa-layer]"); c.checked = true; c.dispatchEvent(new Event("change")); });
await page.waitForTimeout(3000);
await setLayer("OPENSTREETMAP");
await page.waitForTimeout(2000);
await page.mouse.wheel(0, -300);
await page.waitForTimeout(2000);
const nMarkers = await page.locator("#markers > *").count();
console.log(`Wartezeit ${DURATION_S}s ...`);
await page.waitForTimeout(DURATION_S * 1000);
await browser.close();

writeFileSync(OUT, JSON.stringify({ link, DURATION_S, log, blocked, consoleMsgs }, null, 1));
const hosts = new Map();
for (const r of log) { const h = new URL(r.url).host; hosts.set(h, (hosts.get(h) || 0) + 1); }
console.log("Zielhosts:", [...hosts].map(([h, n]) => `${h} (${n})`).join(", "));

check("12 Marker in der Seitenleiste", nMarkers >= 10, `gefunden ${nMarkers}`);
check("keine Anfrage an nicht freigegebene Hosts (abgebrochen)", blocked.length === 0, blocked.join(" "));
check("Hosts nur Instanz + OSM/OpenTopoMap/BfN", [...hosts.keys()].every((h) => h === new URL(BASE).host || TILE_HOSTS.test(h) || h === ""), [...hosts.keys()].join(","));
check("kein umami/analytics/flopp.net", ![...hosts.keys()].some((h) => /umami|flopp\.net|analytics|plausible|google/.test(h)));
check("Kacheln von OSM, OpenTopoMap und BfN-Overlay geladen", ["openstreetmap", "opentopomap", "geodienste.bfn.de"].every((h) => log.some((r) => new URL(r.url).host.includes(h))));
check("mindestens eine Kachel geladen", log.some((r) => TILE_HOSTS.test(new URL(r.url).host)));
const foreign = log.filter((r) => new URL(r.url).host !== new URL(BASE).host);
const leaks = [];
for (const r of foreign) {
    const blob = decodeURIComponent(r.url) + JSON.stringify(r.headers) + (r.body || "");
    for (const p of patterns) if (blob.includes(p)) leaks.push(`${p} in ${r.url}`);
}
check("kein Marker-Muster in URL/Header/Body von Fremd-Anfragen", leaks.length === 0, leaks.slice(0, 3).join("; "));
const refs = foreign.map((r) => r.headers.referer).filter(Boolean);
check("Referer an Fremdhosts nur Origin (ohne Pfad/Query)", refs.every((x) => x === BASE + "/"), [...new Set(refs)].join(","));
check("Fremd-Anfragen ohne Cookies/Authorization", foreign.every((r) => !r.headers.cookie && !r.headers.authorization));
check("nur GET an Fremdhosts", foreign.every((r) => r.method === "GET"));
const csp = consoleMsgs.filter((x) => /Content Security Policy|Refused/.test(x));
check("keine CSP-Verstöße in der Konsole", csp.length === 0, csp.slice(0, 2).join("; "));
finish();
