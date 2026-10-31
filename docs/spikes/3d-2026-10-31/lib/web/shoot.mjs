// Opens each GLB in headless Chromium with SwiftShader (the VR spike's flags) and screenshots the canvas.
//   node shoot.mjs <port> <out dir> <name>=<url path> ...
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire("/vercel/app/package.json");
const { chromium } = require("@playwright/test");
const [port, out, ...items] = process.argv.slice(2);
const launched = Date.now();
const browser = await chromium.launch({ args: ["--enable-unsafe-swiftshader"], timeout: 60_000 });
console.log(`chromium ${browser.version()} launched in ${Date.now() - launched} ms`);
const rows = [];
for (const item of items) {
  const [name, glb] = item.split("=");
  const row = { name, glb, consoleErrors: [], external: [] };
  const page = await browser.newPage({ viewport: { width: 640, height: 480 }, deviceScaleFactor: 1 });
  page.on("console", (m) => m.type() === "error" && row.consoleErrors.length < 10 && row.consoleErrors.push(m.text().slice(0, 200)));
  page.on("pageerror", (e) => row.consoleErrors.length < 10 && row.consoleErrors.push(String(e.message).slice(0, 200)));
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (!["data:", "blob:"].includes(u.protocol) && u.hostname !== "127.0.0.1") row.external.push(r.url());
  });
  const t = Date.now();
  try {
    await page.goto(`http://127.0.0.1:${port}/?glb=${encodeURIComponent(glb)}`);
    await page.waitForFunction(() => window.__view, null, { timeout: 30_000 });
    row.view = await page.evaluate(() => window.__view);
    row.wallMs = Date.now() - t;
    await page.locator("canvas").screenshot({ path: `${out}/${name}.png` });
  } catch (e) {
    row.error = String(e.message ?? e).slice(0, 300);
  }
  await page.close();
  rows.push(row);
  console.log(JSON.stringify(row));
}
await browser.close();
writeFileSync(`${out}/shoot.json`, JSON.stringify(rows, null, 2));
