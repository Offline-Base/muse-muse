// Platform file: don't edit. A look inside the VR product while building it: opens it in the simulated headset, does what
// the flags say in order, saves a picture of the view and prints what it found. Against `next dev` on port 3000 by default.
//   node scripts/xr-peek.mjs --enter --look 0,1.6,1.5:0,1.2,-1 --select "Start game" --out .muse-peek/start.png
// Flags: --url <url>, --enter, --look [<x,y,z>:]<x,y,z or name> (from where, to where), --select <name>, --hand left|right,
// --wait <status text>, --out <png>. Prints one JSON line: { mode, inSession, fps, blank, stats, targets, status,
// consoleErrors }. Then open the PNG with read_file.
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";

const SESSION_MS = 15_000;
const WAIT_MS = 60_000;
/** Named objects and the stage come up after the page's first paint. */
const STAGE_MS = 60_000;

const ROOT = path.resolve(import.meta.dirname, "..");
const browserFlags = () => JSON.parse(readFileSync(path.join(ROOT, "scripts", "browser.json"), "utf8")).vr;

export function parseArgs(argv) {
  const out = { url: "http://localhost:3000/", out: ".muse-peek/peek.png", hand: "right", steps: [] };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--enter") out.steps.push({ kind: "enter" });
    else if (flag === "--look") out.steps.push({ kind: "look", ...parseLook(argv[++i] ?? "") });
    else if (flag === "--select") out.steps.push({ kind: "select", name: argv[++i] ?? "" });
    else if (flag === "--wait") out.steps.push({ kind: "wait", text: argv[++i] ?? "" });
    else if (flag === "--url") out.url = argv[++i] ?? out.url;
    else if (flag === "--out") out.out = argv[++i] ?? out.out;
    else if (flag === "--hand") out.hand = argv[++i] === "left" ? "left" : "right";
    else throw new Error(`Unknown flag: ${flag}`);
  }
  return out;
}

function parsePoint(text) {
  const parts = text.split(",").map(Number);
  return parts.length === 3 && parts.every(Number.isFinite) ? { x: parts[0], y: parts[1], z: parts[2] } : null;
}

/** "--look to", or "--look from:to". `to` is a point or a name, and `from` a point. */
export function parseLook(text) {
  const at = text.indexOf(":");
  const from = at >= 0 ? parsePoint(text.slice(0, at)) : null;
  const rest = at >= 0 && from ? text.slice(at + 1) : text;
  return { from, to: parsePoint(rest) ?? rest };
}

/** Runs in the browser. The same as measureView in tests/xr.ts: a template test keeps them the same. */
async function measureView(png) {
  const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0));
  const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
  const canvas = new OffscreenCanvas(320, 180);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("no 2d context");
  context.imageSmoothingEnabled = false;
  context.drawImage(bitmap, 0, 0, 320, 180);
  const { data } = context.getImageData(0, 0, 320, 180);
  const lumas = [];
  const bins = new Map();
  for (let i = 0; i < data.length; i += 4) {
    lumas.push(0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]);
    const bin = ((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3);
    bins.set(bin, (bins.get(bin) ?? 0) + 1);
  }
  lumas.sort((a, b) => a - b);
  const spread = lumas[Math.floor(lumas.length * 0.95)] - lumas[Math.floor(lumas.length * 0.05)];
  const top = Math.max(...bins.values()) / lumas.length;
  return { spread: Number(spread.toFixed(1)), colors: bins.size, top: Number(top.toFixed(3)), blank: spread < 6 || bins.size < 12 || top > 0.95 };
}

const remote = (page, method, params) => page.evaluate(([m, p]) => window.__musemuseXR.remote(m, p), [method, params]);
const targets = (page) => page.evaluate(() => window.__musemuseXR.targets());
const waitFrames = (page, n) => page.evaluate((count) => window.__musemuseXR.waitFrames(count, 15000), n);

/** The named object's position, or the point itself. A wrong name says which names exist. */
async function where(page, target) {
  if (typeof target !== "string") return target;
  const list = await targets(page);
  const found = list.find((t) => t.name === target);
  if (!found) throw new Error(`No VR object is named "${target}". Named: ${list.map((t) => t.name).join(", ") || "none"}.`);
  return found.position;
}

function facing(from, to) {
  const deg = 180 / Math.PI;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  return { pitch: Math.atan2(dy, Math.hypot(dx, dz)) * deg, yaw: Math.atan2(-dx, -dz) * deg, roll: 0 };
}

async function runStep(page, step, hand) {
  if (step.kind === "enter") {
    await page.getByRole("button", { name: /^Enter VR/ }).click({ timeout: STAGE_MS });
    await page.waitForFunction(() => window.__musemuseXR?.inSession(), null, { timeout: SESSION_MS });
    await waitFrames(page, 5);
  } else if (step.kind === "look") {
    const now = await remote(page, "get_transform", { device: "headset" });
    const position = step.from ?? now.position;
    const orientation = facing(position, await where(page, step.to));
    await remote(page, "animate_to", { device: "headset", position, orientation, duration: 0.4, easing: "minimum-jerk" });
  } else if (step.kind === "select") {
    await remote(page, "look_at", { device: `controller-${hand}`, target: await where(page, step.name) });
    await waitFrames(page, 3);
    await remote(page, "select", { device: `controller-${hand}` });
    await waitFrames(page, 3);
  } else if (step.kind === "wait") {
    await page.locator("[data-xr-status]").filter({ hasText: step.text }).waitFor({ state: "attached", timeout: WAIT_MS });
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const flags = browserFlags();
  const browser = await chromium.launch({ args: flags.args });
  const report = { mode: null, inSession: false, fps: null, blank: null, stats: null, targets: [], status: null, consoleErrors: [], out: args.out };
  try {
    const page = await browser.newPage({ viewport: flags.viewport });
    page.on("console", (msg) => {
      if (msg.type() === "error") report.consoleErrors.push(msg.text().slice(0, 300));
    });
    page.on("pageerror", (err) => report.consoleErrors.push(err.message.slice(0, 300)));
    await page.goto(args.url, { waitUntil: "load", timeout: STAGE_MS });
    await page.waitForFunction(() => window.__musemuseXR, null, { timeout: STAGE_MS });
    try {
      for (const step of args.steps) await runStep(page, step, args.hand);
    } catch (err) {
      report.failed = err.message.split("\n")[0].slice(0, 300);
    }
    const handle = await page.evaluate(() => {
      const x = window.__musemuseXR;
      return { mode: x.mode, inSession: x.inSession(), stats: x.info, frames: x.frames(), at: performance.now() };
    });
    Object.assign(report, { mode: handle.mode, inSession: handle.inSession, stats: handle.stats });
    if (handle.inSession) {
      await page.waitForTimeout(800);
      const later = await page.evaluate(() => ({ frames: window.__musemuseXR.frames(), at: performance.now() }));
      report.fps = Number((((later.frames - handle.frames) * 1000) / (later.at - handle.at)).toFixed(1));
    }
    const png = await page.screenshot({ type: "png" });
    report.view = await page.evaluate(measureView, png.toString("base64"));
    report.blank = report.view.blank;
    const file = path.resolve(args.out);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(path.join(path.dirname(file), ".gitignore"), "*\n");
    writeFileSync(file, png);
    report.targets = await targets(page);
    report.status = await page.locator("[data-xr-status]").textContent({ timeout: 1000 }).catch(() => null);
  } finally {
    await browser.close();
  }
  process.stdout.write(`${JSON.stringify(report)}\n`);
  process.exit(report.failed ? 1 : 0);
}

if (process.argv[1] && import.meta.filename === realpathSync(process.argv[1])) {
  main().catch((err) => {
    process.stdout.write(`${JSON.stringify({ failed: String(err?.message ?? err).split("\n")[0].slice(0, 300) })}\n`);
    process.exit(1);
  });
}
