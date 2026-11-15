// Gemeinsame Helfer für die Browser-Tests (FAB-010). Voraussetzung:
//   npm i playwright-core   (in einem Wegwerf-Verzeichnis, NODE_PATH darauf zeigen lassen)
//   CHROMIUM=/pfad/zu/chrome  (sonst Playwright-Cache ~/Library/Caches/ms-playwright)
import { createRequire } from "node:module";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
export const { chromium } = require(process.env.PW_CORE || "playwright-core");

export const BASE = process.env.BASE || "http://127.0.0.1:18080";

export function chromiumPath() {
    if (process.env.CHROMIUM) return process.env.CHROMIUM;
    const cache = path.join(homedir(), "Library/Caches/ms-playwright");
    if (existsSync(cache)) {
        for (const d of readdirSync(cache).filter((x) => x.startsWith("chromium-"))) {
            const p = path.join(cache, d, "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing");
            if (existsSync(p)) return p;
        }
    }
    return undefined;
}

export async function launch() {
    return chromium.launch({ executablePath: chromiumPath(), headless: true });
}

// Erlaubte Fremdhosts (Frage 3): OSM, OpenTopoMap, BfN.
export const TILE_HOSTS = /^([abc]\.tile\.openstreetmap\.org|[abc]\.tile\.opentopomap\.org|geodienste\.bfn\.de)$/;

export const results = [];
export function check(name, ok, detail = "") {
    results.push({ name, ok });
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -- " + detail : ""}`);
}
export function finish() {
    const failed = results.filter((r) => !r.ok).length;
    console.log(`\n${results.length - failed}/${results.length} bestanden`);
    process.exit(failed ? 1 : 0);
}
