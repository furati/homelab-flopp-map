// AC-7 (Suche), AC-8 (Ebenen), AC-9 (Distanz/Peilung/Projektion), AC-10 (JSON/GPX), AC-11 (Link), AC-12 (Version).
// Nur unkritische Testkoordinaten (um 48.0:7.8). FLOPP_COMPARE=1 vergleicht mit map.flopp.net (genau ein Link).
import { readFileSync } from "node:fs";
import { BASE, TILE_HOSTS, launch, check, finish } from "./common.mjs";

const rad = (d) => (d * Math.PI) / 180, deg = (r) => (r * 180) / Math.PI;
// Unabhängige Referenz: Vincenty auf WGS-84 (Upstream rechnet auf dem Ellipsoid).
const WA = 6378137, WF = 1 / 298.257223563, WB = WA * (1 - WF);
function vincentyInverse(p1, p2) {
    const L = rad(p2[1] - p1[1]);
    const U1 = Math.atan((1 - WF) * Math.tan(rad(p1[0]))), U2 = Math.atan((1 - WF) * Math.tan(rad(p2[0])));
    const sU1 = Math.sin(U1), cU1 = Math.cos(U1), sU2 = Math.sin(U2), cU2 = Math.cos(U2);
    let lam = L, it = 0, sSig, cSig, sig, cAlpha2, c2sm, sLam, cLam;
    do {
        sLam = Math.sin(lam); cLam = Math.cos(lam);
        sSig = Math.hypot(cU2 * sLam, cU1 * sU2 - sU1 * cU2 * cLam);
        cSig = sU1 * sU2 + cU1 * cU2 * cLam;
        sig = Math.atan2(sSig, cSig);
        const sAlpha = (cU1 * cU2 * sLam) / sSig;
        cAlpha2 = 1 - sAlpha * sAlpha;
        c2sm = cAlpha2 ? cSig - (2 * sU1 * sU2) / cAlpha2 : 0;
        const C = (WF / 16) * cAlpha2 * (4 + WF * (4 - 3 * cAlpha2));
        const prev = lam;
        lam = L + (1 - C) * WF * sAlpha * (sig + C * sSig * (c2sm + C * cSig * (-1 + 2 * c2sm * c2sm)));
        if (Math.abs(lam - prev) < 1e-12) break;
    } while (++it < 100);
    const u2 = (cAlpha2 * (WA * WA - WB * WB)) / (WB * WB);
    const A = 1 + (u2 / 16384) * (4096 + u2 * (-768 + u2 * (320 - 175 * u2)));
    const B = (u2 / 1024) * (256 + u2 * (-128 + u2 * (74 - 47 * u2)));
    const dSig = B * sSig * (c2sm + (B / 4) * (cSig * (-1 + 2 * c2sm * c2sm) - (B / 6) * c2sm * (-3 + 4 * sSig * sSig) * (-3 + 4 * c2sm * c2sm)));
    const s = WB * A * (sig - dSig);
    const az1 = Math.atan2(cU2 * sLam, cU1 * sU2 - sU1 * cU2 * cLam);
    return { s, az1: (deg(az1) + 360) % 360 };
}
function vincentyDirect(p1, az, s) {
    const a1 = rad(az), U1 = Math.atan((1 - WF) * Math.tan(rad(p1[0])));
    const sU1 = Math.sin(U1), cU1 = Math.cos(U1), sA1 = Math.sin(a1), cA1 = Math.cos(a1);
    const sig1 = Math.atan2(sU1, cU1 * cA1), sAlpha = cU1 * sA1, cA2 = 1 - sAlpha * sAlpha;
    const u2 = (cA2 * (WA * WA - WB * WB)) / (WB * WB);
    const A = 1 + (u2 / 16384) * (4096 + u2 * (-768 + u2 * (320 - 175 * u2)));
    const B = (u2 / 1024) * (256 + u2 * (-128 + u2 * (74 - 47 * u2)));
    let sig = s / (WB * A), prev;
    let c2sm, sS, cS;
    do {
        c2sm = Math.cos(2 * sig1 + sig); sS = Math.sin(sig); cS = Math.cos(sig);
        const dSig = B * sS * (c2sm + (B / 4) * (cS * (-1 + 2 * c2sm * c2sm) - (B / 6) * c2sm * (-3 + 4 * sS * sS) * (-3 + 4 * c2sm * c2sm)));
        prev = sig; sig = s / (WB * A) + dSig;
    } while (Math.abs(sig - prev) > 1e-12);
    const x = sU1 * sS - cU1 * cS * cA1;
    const phi2 = Math.atan2(sU1 * cS + cU1 * sS * cA1, (1 - WF) * Math.hypot(sAlpha, x));
    const lam = Math.atan2(sS * sA1, cU1 * cS - sU1 * sS * cA1);
    const C = (WF / 16) * cA2 * (4 + WF * (4 - 3 * cA2));
    const L = lam - (1 - C) * WF * sAlpha * (sig + C * sS * (c2sm + C * cS * (-1 + 2 * c2sm * c2sm)));
    return [deg(phi2), p1[1] + deg(L)];
}
const haversine = (a, b) => vincentyInverse(a, b).s;
const bearing = (a, b) => vincentyInverse(a, b).az1;
const project = (a, brg, d) => vincentyDirect(a, brg, d);

const browser = await launch();
const attempted = []; // alle Anfragen an nicht freigegebene Hosts
async function newCtx(opts = {}) {
    const ctx = await browser.newContext({ acceptDownloads: true, ...opts });
    const reqs = [];
    ctx.on("request", (r) => reqs.push(r.url()));
    await ctx.route("**/*", (route) => {
        const u = new URL(route.request().url());
        if (u.origin === BASE || ["data:", "blob:"].includes(u.protocol) || TILE_HOSTS.test(u.hostname)) return route.continue();
        attempted.push(route.request().url());
        return route.abort();
    });
    return { ctx, reqs };
}
const click = (page, sel) => page.evaluate((s) => document.querySelector(s).click(), sel);
async function exportJson(page) {
    const [dl] = await Promise.all([page.waitForEvent("download"), click(page, "#btn-export-json")]);
    return JSON.parse(readFileSync(await dl.path(), "utf8"));
}
async function exportGpx(page) {
    const [dl] = await Promise.all([page.waitForEvent("download"), click(page, "#btn-export-gpx")]);
    return { text: readFileSync(await dl.path(), "utf8"), path: await dl.path() };
}
const SIDEBARS = ["hero", "layers", "search", "markers", "lines", "tools", "info"];
async function openSidebar(page, name) {
    await page.evaluate((i) => document.querySelectorAll("#sidebar-controls .sidebar-control a")[i].click(), SIDEBARS.indexOf(name));
    await page.waitForTimeout(400);
}
const norm = (s) => ({ ...s, markers: s.markers.map((m) => ({ ...m })) });

const A = [48.0, 7.8], B = [48.05, 7.9];
const testLink = `${BASE}/?c=48.0:7.8&z=11&t=OPENSTREETMAP&m=A:48.0:7.8:1000:StartA:ff0000*B:48.05:7.9:0:EndeB:0000ff&d=A:B:00aa00`;

// ---------- AC-12 Version ----------
{
    const v = await (await fetch(`${BASE}/version.json`)).json();
    const pin = readFileSync(new URL("../../upstream.pin", import.meta.url), "utf8").match(/UPSTREAM_COMMIT=(\w+)/)[1];
    check("AC-12 version.json upstream_commit == upstream.pin", v.upstream_commit === pin, `${v.upstream_commit}`);
}

// ---------- AC-7 Suche, AC-8 Ebenen ----------
const { ctx, reqs } = await newCtx();
const page = await ctx.newPage();
await page.goto(testLink, { waitUntil: "load" });
await page.waitForTimeout(3000);
{
    await openSidebar(page, "search");
    await page.fill("#input-search", "Freiburg");
    await click(page, "#btn-search");
    await page.waitForTimeout(1500);
    const msg = await page.evaluate(() => document.body.innerText);
    check("AC-7 keine Anfrage an nominatim bei Ortssuche", ![...reqs, ...attempted].some((u) => /nominatim/.test(u)));
    check("AC-7 sichtbarer Hinweis 'Ortssuche abgeschaltet'", /Ortssuche ist auf dieser Instanz abgeschaltet|Place search is disabled/.test(msg));
    const help = await page.textContent("#sidebar-search .help:not(.is-hidden)").catch(() => "");
    await page.fill("#input-search", "48.2 7.7");
    await click(page, "#btn-search");
    await page.waitForTimeout(1500);
    const results = await page.evaluate(() => document.querySelector("#search-results").innerText);
    const center = await page.evaluate(() => document.querySelector("#sidebar-search-center").innerText);
    check("AC-7 Koordinatensuche liefert Treffer", /48/.test(results) || /48\.2/.test(center), `Treffer=${results.trim()} Mitte=${center.trim()}`);
}
{
    const opts = await page.$$eval("select[data-base-layer] option", (o) => o.map((x) => x.value));
    check("AC-8 Ebenenliste = OSM + OpenTopoMap", JSON.stringify(opts) === JSON.stringify(["OPENSTREETMAP", "OPENTOPOMAP"]), opts.join(","));
    check("AC-8 kein Hillshading-Schalter", (await page.$("[data-hillshading-layer]")) === null);
    for (const [val, host] of [["OPENTOPOMAP", /\.tile\.opentopomap\.org/], ["OPENSTREETMAP", /\.tile\.openstreetmap\.org/]]) {
        const { ctx: lc, reqs: lr } = await newCtx(); // frisches Profil, kein Browser-Cache
        const lp = await lc.newPage();
        await lp.goto(`${BASE}/?c=48.0:7.8&z=11&t=${val}&m=A:48.0:7.8`, { waitUntil: "load" });
        await lp.waitForTimeout(4000);
        const n = lr.filter((u) => host.test(u)).length;
        check(`AC-8 Ebene ${val} lädt Kacheln`, n > 0, `${n} Anfragen`);
        const other = lr.filter((u) => /\.tile\./.test(u) && !host.test(u)).length;
        check(`AC-8 Ebene ${val}: keine Kacheln der jeweils anderen Ebene`, other === 0, `${other}`);
        await lc.close();
    }
    const before = reqs.length;
    await page.evaluate(() => { const c = document.querySelector("[data-german-npa-layer]"); c.checked = true; c.dispatchEvent(new Event("change")); });
    await page.waitForTimeout(5000);
    const n = reqs.slice(before).filter((u) => /geodienste\.bfn\.de/.test(u)).length;
    check("AC-8 BfN-NPA-Overlay lädt", n > 0, `${n} Anfragen`);
    const bfn = reqs.filter((u) => /geodienste\.bfn\.de/.test(u));
    check("AC-8 BfN-Anfragen enthalten nur BBOX (keine Markernamen/-koordinaten)", bfn.every((u) => !/StartA|EndeB/.test(u)));
    await page.evaluate(() => { const c = document.querySelector("[data-german-npa-layer]"); c.checked = false; c.dispatchEvent(new Event("change")); });
}
// nicht freigegebene Ebenen per Link
{
    const { ctx: c2, reqs: r2 } = await newCtx();
    const p2 = await c2.newPage();
    const before = attempted.length;
    await p2.goto(`${BASE}/?c=48.0:7.8&z=11&t=STAMEN_TERRAIN&h=1&m=A:48.0:7.8`, { waitUntil: "load" });
    await p2.waitForTimeout(4000);
    const sel = await p2.$eval("select[data-base-layer]", (s) => s.value);
    check("AC-8 Link mit gesperrter Ebene (STAMEN, h=1) fällt auf OSM zurück", sel === "OPENSTREETMAP", sel);
    check("AC-8 gesperrte Ebenen: keine Anfrage an deren Hosts", attempted.length === before && !r2.some((u) => /fastly|arcgis|terrestris|mapterhorn|openstreetmap\.fr/.test(u)));
    for (const t of ["HUMANITARIAN", "ARCGIS_WORLDIMAGERY", "ARCGIS_WORLDIMAGERY_OVERLAY"]) {
        await p2.goto(`${BASE}/?c=48.0:7.8&z=11&t=${t}&m=A:48.0:7.8`, { waitUntil: "load" });
        await p2.waitForTimeout(2500);
    }
    check("AC-8 HUMANITARIAN/ARCGIS per Link: keine Anfrage an Drittserver", attempted.length === before && !r2.some((u) => /fastly|arcgis|terrestris|mapterhorn|openstreetmap\.fr/.test(u)), attempted.slice(before).join(" "));
    await c2.close();
}

// ---------- AC-9 Distanz / Peilung / Projektion ----------
const page9 = page;
await page9.goto(testLink, { waitUntil: "load" });
await page9.waitForTimeout(2500);
const stats = await page9.evaluate(() => document.querySelector(".line-stats")?.textContent);
const expDist = haversine(A, B), expBrg = bearing(A, B);
console.log(`Linie: UI='${stats}' erwartet ~${(expDist / 1000).toFixed(3)} km, ${expBrg.toFixed(2)}°`);
{
    const km = parseFloat(stats.replace(",", ".")), brg = parseFloat(stats.split(",").slice(-1)[0].replace("°", "").replace(",", ".")) ;
    const m = stats.match(/([\d.,]+)\s*(km|m)\b.*?([\d.,]+)°/);
    const d = m ? parseFloat(m[1].replace(",", ".")) * (m[2] === "km" ? 1000 : 1) : NaN;
    const b = m ? parseFloat(m[3].replace(",", ".")) : NaN;
    check("AC-9 Distanz stimmt mit unabhängiger Formel (±1 m)", Math.abs(d - expDist) < 1, `UI ${d} m, erwartet ${expDist.toFixed(1)} m`);
    check("AC-9 Peilung stimmt (±0,1°)", Math.abs(b - expBrg) < 0.1, `UI ${b}°, erwartet ${expBrg.toFixed(2)}°`);
}
let projUi;
{
    await page9.evaluate(() => document.querySelector('#markers [data-i18n="sidebar.markers.projection"]').click());
    await page9.fill("[data-distance]", "2500");
    await page9.fill("[data-bearing]", "45");
    await page9.fill("[data-target-name]", "Proj");
    await page9.evaluate(() => document.querySelector("#projection-dialog [data-ok]").click());
    await page9.waitForTimeout(1000);
    const st = await exportJson(page9);
    const p = st.markers.find((m) => m.name === "Proj");
    const exp = project(A, 45, 2500);
    projUi = p;
    const mm = String(p?.coordinates).match(/([NS])\s*([\d.]+)\s*([EW])\s*([\d.]+)/);
    const got = mm ? [(mm[1] === "S" ? -1 : 1) * parseFloat(mm[2]), (mm[3] === "W" ? -1 : 1) * parseFloat(mm[4])] : [NaN, NaN];
    const dist = haversine(got, exp);
    check("AC-9 Projektion 2500 m / 45° stimmt (<1 m Abweichung)", dist < 1, `UI ${JSON.stringify(p?.coordinates ?? p)} erwartet ${exp.map((x) => x.toFixed(6))}`);
}
if (process.env.FLOPP_COMPARE === "1") {
    // genau EIN Link an map.flopp.net, Umami blockiert, nur Testkoordinaten
    const c = await browser.newContext();
    await c.route("**/*", (r) => (/flopp\.net|tile\.openstreetmap\.org|^data:|^blob:/.test(r.request().url()) && !/umami|u\.js/.test(r.request().url()) ? r.continue() : r.abort()));
    const p = await c.newPage();
    await p.goto(`https://map.flopp.net/?c=48.0:7.8&z=11&t=OPENSTREETMAP&m=A:48.0:7.8:1000:StartA:ff0000*B:48.05:7.9:0:EndeB:0000ff&d=A:B:00aa00`, { waitUntil: "load" });
    await p.waitForTimeout(4000);
    const fs = await p.evaluate(() => document.querySelector(".line-stats")?.textContent);
    check("AC-9 Distanz/Peilung identisch zu map.flopp.net", fs === stats, `flopp.net '${fs}' vs Instanz '${stats}'`);
    await p.evaluate(() => document.querySelector('#markers [data-i18n="sidebar.markers.projection"]').click());
    await p.fill("[data-distance]", "2500"); await p.fill("[data-bearing]", "45"); await p.fill("[data-target-name]", "Proj");
    await p.evaluate(() => document.querySelector("#projection-dialog [data-ok]").click());
    await p.waitForTimeout(1000);
    const fj = await exportJson(p);
    const fp = fj.markers.find((m) => m.name === "Proj");
    check("AC-9 Projektion identisch zu map.flopp.net", JSON.stringify(fp?.coordinates ?? fp) === JSON.stringify(projUi?.coordinates ?? projUi), `${JSON.stringify(fp?.coordinates)} vs ${JSON.stringify(projUi?.coordinates)}`);
    await c.close();
}

// ---------- AC-10 JSON / GPX Export + Re-Import ----------
await page.goto(testLink, { waitUntil: "load" });
await page.waitForTimeout(2500);
const json1 = await exportJson(page);
check("AC-10 JSON enthält maptype, center, zoom, settings, markers, lines", ["maptype", "center", "zoom", "settings", "markers", "lines"].every((k) => k in json1), Object.keys(json1).join(","));
const gpx = await exportGpx(page);
check("AC-10 GPX enthält Marker (wpt) und Linie", /<wpt /.test(gpx.text) && /StartA/.test(gpx.text) && /EndeB/.test(gpx.text), `${gpx.text.length} Bytes`);
{
    const { ctx: f1 } = await newCtx();
    const p = await f1.newPage();
    await p.goto(`${BASE}/`, { waitUntil: "load" });
    await p.waitForTimeout(1500);
    await p.setInputFiles("#inp-import-json", await (async () => { const [dl] = await Promise.all([page.waitForEvent("download"), click(page, "#btn-export-json")]); return dl.path(); })());
    await p.waitForTimeout(2500);
    const json2 = await exportJson(p);
    check("AC-10 JSON-Re-Import im frischen Profil ergibt identischen Zustand", JSON.stringify(json1) === JSON.stringify(json2), JSON.stringify(json1) === JSON.stringify(json2) ? "" : `\n${JSON.stringify(json1)}\n${JSON.stringify(json2)}`);
    await f1.close();
    const { ctx: f2 } = await newCtx();
    const q = await f2.newPage();
    await q.goto(`${BASE}/`, { waitUntil: "load" });
    await q.waitForTimeout(1500);
    await q.setInputFiles("#inp-import-gpx", gpx.path);
    await q.waitForTimeout(2500);
    const json3 = await exportJson(q);
    const strip = (s) => ({ markers: s.markers, lines: s.lines });
    const same = JSON.stringify(strip(json1)) === JSON.stringify(strip(json3));
    check("AC-10 GPX-Re-Import: Marker (Koordinaten, Name, Farbe, Radius) und Linien identisch", same, same ? "" : `\n${JSON.stringify(strip(json1))}\n${JSON.stringify(strip(json3))}`);
    await f2.close();
}

// ---------- AC-11 Link-Dialog ----------
{
    await click(page, "#btn-link");
    await page.waitForTimeout(800);
    const link = await page.inputValue("#link-dialog-input");
    check("AC-11 Link beginnt mit Instanz-URL (nicht map.flopp.net)", link.startsWith(BASE + "/") && !/flopp\.net/.test(link), link.slice(0, 120));
    const { ctx: f } = await newCtx();
    const p = await f.newPage();
    await p.goto(link, { waitUntil: "load" });
    await p.waitForTimeout(2500);
    const json2 = await exportJson(p);
    const strip = (s) => JSON.stringify({ t: s.maptype, c: s.center, z: s.zoom, m: s.markers, l: s.lines });
    check("AC-11 Link im frischen Profil stellt denselben Zustand her", strip(json1) === strip(json2), strip(json1) === strip(json2) ? "" : `\n${strip(json1)}\n${strip(json2)}`);
    await f.close();
    // Handgebauter Link nach Upstream-Schema, mit c=lat/lon
    const { ctx: h } = await newCtx();
    const hp = await h.newPage();
    await hp.goto(`${BASE}/?c=48.0/7.8&z=12&m=X:48.01:7.81:250:Hand:00ff00*Y:48.02:7.82::Zwei:0000ff&d=X:Y:ff0000`, { waitUntil: "load" });
    await hp.waitForTimeout(2500);
    const hj = await exportJson(hp);
    check("AC-11 handgebauter Link (c=lat/lon, 2 Marker, Linie, Radius) wird geöffnet", hj.markers.length === 2 && hj.lines.length === 1 && hj.markers[0].name === "Hand" && hj.markers[0].radius === 250, JSON.stringify(hj.markers.map((m) => [m.name, m.radius])));
    await h.close();
}
check("keine Anfrage an nicht freigegebene Hosts im ganzen Lauf", attempted.length === 0, attempted.join(" "));
await browser.close();
finish();
