// The same measurements for phase A's bare page and phase B's Next.js product: everything goes through
// window.__musemuseXR and the button named "Enter VR", so only the URL changes. Decodes pictures with ffmpeg, so the check
// doesn't depend on the browser under test. The pass thresholds are the design's (vr-glasses.md, section 7).
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(process.env.PROBE_ROOT ?? "/vercel/app/package.json");
const { chromium } = require("@playwright/test");

const W = 320;
const H = 180;
/** Decodes any picture to raw RGB at 320x180, nearest neighbor so pixel values stay exact. */
export function decode(file) {
  const r = spawnSync("ffmpeg", ["-v", "error", "-i", file, "-vf", `scale=${W}:${H}:flags=neighbor`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { maxBuffer: W * H * 3 + 1024 });
  if (r.status !== 0 || r.stdout.length !== W * H * 3) throw new Error(`ffmpeg decode failed for ${file}: ${r.stderr}`);
  return r.stdout;
}

/** The design's blank test: brightness spread under 6, under 12 distinct colors, or one color over 95%. */
export function stats(rgb) {
  const lumas = [];
  const bins = new Map();
  for (let i = 0; i < rgb.length; i += 3) {
    lumas.push(0.2126 * rgb[i] + 0.7152 * rgb[i + 1] + 0.0722 * rgb[i + 2]);
    const bin = ((rgb[i] >> 3) << 10) | ((rgb[i + 1] >> 3) << 5) | (rgb[i + 2] >> 3);
    bins.set(bin, (bins.get(bin) ?? 0) + 1);
  }
  lumas.sort((a, b) => a - b);
  const spread = lumas[Math.floor(lumas.length * 0.95)] - lumas[Math.floor(lumas.length * 0.05)];
  const top = Math.max(...bins.values()) / lumas.length;
  return { spread: Number(spread.toFixed(1)), colors: bins.size, top: Number(top.toFixed(3)), blank: spread < 6 || bins.size < 12 || top > 0.95 };
}

/** Share of pixels that changed by more than 24 of 255 in any channel. */
function changed(a, b) {
  let n = 0;
  for (let i = 0; i < a.length; i += 3) if (Math.abs(a[i] - b[i]) > 24 || Math.abs(a[i + 1] - b[i + 1]) > 24 || Math.abs(a[i + 2] - b[i + 2]) > 24) n++;
  return Number((n / (a.length / 3)).toFixed(3));
}

const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/**
 * spec: { label, url, out, channel?, args, width?, height?, checkOnly?, poses?, seconds?, expectBlank? }. Never throws: a
 * step that fails is in `failedAt`, with what was measured before it.
 */
export async function probe(spec) {
  const width = spec.width ?? 1280;
  const height = spec.height ?? 720;
  const seconds = spec.seconds ?? 4;
  const r = { label: spec.label, url: spec.url, channel: spec.channel ?? "default", args: spec.args, width, height, consoleErrors: [], pageErrors: [], external: [], failedRequests: [], badResponses: [] };
  const shot = (name) => `${spec.out}/${spec.label}-${name}`;
  let browser;
  let step = "launch";
  try {
    const launched = Date.now();
    browser = await chromium.launch({ channel: spec.channel ?? undefined, args: spec.args, timeout: 60_000 });
    r.version = browser.version();
    r.launchMs = Date.now() - launched;
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    page.on("console", (m) => {
      if (m.type() === "error" && r.consoleErrors.length < 20) r.consoleErrors.push(m.text().slice(0, 300));
    });
    page.on("pageerror", (e) => {
      if (r.pageErrors.length < 20) r.pageErrors.push(String(e.message).slice(0, 300));
    });
    page.on("request", (q) => {
      const u = new URL(q.url());
      if (!["data:", "blob:"].includes(u.protocol) && !["localhost", "127.0.0.1"].includes(u.hostname)) r.external.push(q.url());
    });
    page.on("requestfailed", (q) => {
      if (r.failedRequests.length < 20) r.failedRequests.push(`${q.url()} ${q.failure()?.errorText ?? ""}`);
    });

    page.on("response", (q) => {
      if (q.status() >= 400 && r.badResponses.length < 20) r.badResponses.push(`${q.status()} ${q.url()}`);
    });

    step = "load";
    const loaded = Date.now();
    await page.goto(spec.url, { waitUntil: "load", timeout: 60_000 });
    await page.waitForFunction(() => window.__musemuseXR, null, { timeout: 30_000 });
    r.handleMs = Date.now() - loaded;
    r.mode = await page.evaluate(() => window.__musemuseXR.mode);
    await page.waitForFunction(() => document.documentElement.dataset.ready === "1", null, { timeout: 30_000 });
    r.info = await page.evaluate(() => window.__musemuseXR.info);
    r.loadConsoleErrors = r.consoleErrors.length + r.pageErrors.length;
    r.scripts = await page.evaluate(() =>
      performance.getEntriesByType("resource").filter((e) => /\.m?js(\?|$)/.test(e.name)).reduce((s, e) => ({ files: s.files + 1, kb: s.kb + Math.round(e.decodedBodySize / 1024), sentKb: s.sentKb + Math.round(e.encodedBodySize / 1024) }), { files: 0, kb: 0, sentKb: 0 }),
    );
    if (spec.checkOnly || r.info?.webglError) return r;

    step = "enter";
    const button = page.getByRole("button", { name: /^Enter VR/ });
    await button.waitFor({ timeout: 30_000 });
    const entered = Date.now();
    await button.click({ timeout: 30_000 });
    await page.waitForFunction(() => window.__musemuseXR.inSession(), null, { timeout: 30_000 });
    r.sessionMs = Date.now() - entered;
    await page.evaluate(() => window.__musemuseXR.waitFrames(5, 30_000));
    r.info = await page.evaluate(() => window.__musemuseXR.info);

    step = "fps";
    const count = () => page.evaluate(() => ({ f: window.__musemuseXR.frames(), t: performance.now() }));
    const c0 = await count();
    await page.waitForTimeout(seconds * 1000);
    const c1 = await count();
    r.fps = Number((((c1.f - c0.f) * 1000) / (c1.t - c0.t)).toFixed(1));
    r.info = await page.evaluate(() => window.__musemuseXR.info);

    step = "pose 1 shot";
    const file1 = shot("pose1.png");
    await page.screenshot({ path: file1 });
    const pose1 = decode(file1);
    r.pose1 = stats(pose1);
    if (spec.expectBlank) return r;

    step = "animate_to";
    const goal = { x: 0.7, y: 1.5, z: 0.9 };
    const before = Date.now();
    const landed = await page.evaluate((p) => window.__musemuseXR.remote("animate_to", { device: "headset", position: p, orientation: { pitch: -5, yaw: 30, roll: 0 }, duration: 1.2, easing: "minimum-jerk" }), goal);
    r.animateMs = Date.now() - before;
    r.animateActual = landed?.actualDuration ?? null;
    const transform = await page.evaluate(() => window.__musemuseXR.remote("get_transform", { device: "headset" }));
    r.animateErrorCm = Number((distance(transform.position, goal) * 100).toFixed(2));
    await page.evaluate(() => window.__musemuseXR.waitFrames(3, 30_000));

    step = "pose 2 shot";
    const file2 = shot("pose2.png");
    await page.screenshot({ path: file2 });
    const pose2 = decode(file2);
    r.pose2 = stats(pose2);
    r.poseChanged = changed(pose1, pose2);

    step = "select";
    const targets = await page.evaluate(() => window.__musemuseXR.targets());
    r.targets = targets.map((t) => t.name);
    const target = targets.find((t) => t.name.startsWith("Start"));
    if (!target) throw new Error(`no target named Start in ${JSON.stringify(r.targets)}`);
    const statusBefore = await page.locator("[data-xr-status]").textContent();
    await page.evaluate((t) => window.__musemuseXR.remote("look_at", { device: "controller-right", target: t.position }), target);
    await page.evaluate(() => window.__musemuseXR.waitFrames(3, 30_000));
    await page.evaluate(() => window.__musemuseXR.remote("select", { device: "controller-right" }));
    await page.evaluate(() => window.__musemuseXR.waitFrames(3, 30_000));
    const statusAfter = await page.locator("[data-xr-status]").textContent();
    r.select = { before: statusBefore, after: statusAfter, changed: statusBefore !== statusAfter };
    const file3 = shot("selected.png");
    await page.screenshot({ path: file3 });
    r.selectedShot = stats(decode(file3));

    step = "fps after select";
    const a0 = await count();
    await page.waitForTimeout(Math.min(seconds, 3) * 1000);
    const a1 = await count();
    r.fpsAfter = Number((((a1.f - a0.f) * 1000) / (a1.t - a0.t)).toFixed(1));
    r.infoAfter = await page.evaluate(() => { const { drawCalls, triangles } = window.__musemuseXR.info; return { drawCalls, triangles }; });

    if (spec.hands) {
      step = "hands";
      await page.evaluate(() => window.__musemuseXR.remote("set_input_mode", { mode: "hand" }));
      await page.evaluate(() => window.__musemuseXR.waitFrames(10, 30_000));
      await page.waitForTimeout(1500);
      const file = shot("hands.png");
      await page.screenshot({ path: file });
      r.handsShot = stats(decode(file));
      await page.evaluate(() => window.__musemuseXR.remote("set_input_mode", { mode: "controller" }));
    }

    step = "screencast";
    const cdp = await context.newCDPSession(page);
    const frames = [];
    cdp.on("Page.screencastFrame", (f) => {
      frames.push(f.data);
      void cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
    });
    await cdp.send("Page.startScreencast", { format: "jpeg", quality: 80, maxWidth: 2560, maxHeight: 1440, everyNthFrame: 1 });
    const castStart = await count();
    await page.evaluate(() => window.__musemuseXR.remote("animate_to", { device: "headset", position: { x: -0.7, y: 1.6, z: 0.4 }, orientation: { pitch: 0, yaw: -25, roll: 0 }, duration: 4, easing: "linear" }));
    const castEnd = await count();
    await cdp.send("Page.stopScreencast");
    const castSeconds = (castEnd.t - castStart.t) / 1000;
    r.screencast = { frames: frames.length, seconds: Number(castSeconds.toFixed(1)), fps: Number((frames.length / castSeconds).toFixed(1)), xrFps: Number(((castEnd.f - castStart.f) / castSeconds).toFixed(1)) };
    const picked = Array.from({ length: Math.min(8, frames.length) }, (_, i) => frames[Math.floor((i * frames.length) / Math.min(8, frames.length))]);
    const results = picked.map((data, i) => {
      const file = shot(`cast-${i}.jpg`);
      writeFileSync(file, Buffer.from(data, "base64"));
      const s = stats(decode(file));
      return s;
    });
    r.screencast.sampled = results.length;
    r.screencast.nonBlank = results.filter((s) => !s.blank).length;

    step = "exit";
    await page.evaluate(() => window.__musemuseXR.remote("end_session"));
    await page.waitForFunction(() => !window.__musemuseXR.inSession(), null, { timeout: 15_000 });
    r.exited = true;
    r.totalConsoleErrors = r.consoleErrors.length + r.pageErrors.length;
  } catch (err) {
    r.failedAt = step;
    r.error = String(err?.message ?? err).slice(0, 500);
  } finally {
    await browser?.close().catch(() => {});
  }
  return r;
}

/** The design's pass list for one result. Returns what fell short, empty when it passed. */
export function shortfalls(r) {
  const out = [];
  if (r.failedAt) out.push(`failed at ${r.failedAt}: ${r.error}`);
  if (r.info?.webglError) out.push(`no WebGL: ${r.info.webglError}`);
  if (!/swiftshader/i.test(r.info?.renderer ?? "")) out.push(`renderer is ${r.info?.renderer ?? "unknown"}`);
  if (r.loadConsoleErrors) out.push(`${r.loadConsoleErrors} console errors on load`);
  if (!(r.sessionMs <= 5000)) out.push(`session took ${r.sessionMs} ms`);
  if (!(r.fps >= 15)) out.push(`${r.fps} fps`);
  if (!(r.fpsAfter >= 15)) out.push(`${r.fpsAfter} fps after select`);
  if (r.pose1?.blank !== false) out.push("pose 1 is blank");
  if (r.pose2?.blank !== false) out.push("pose 2 is blank");
  if (!(r.poseChanged >= 0.1)) out.push(`poses differ by ${r.poseChanged}`);
  if (!(r.animateErrorCm <= 1)) out.push(`animate_to is off by ${r.animateErrorCm} cm`);
  if (!r.select?.changed) out.push("select changed nothing");
  if (!(r.screencast?.fps >= 10)) out.push(`screencast ${r.screencast?.fps} fps`);
  if (r.screencast && r.screencast.nonBlank !== r.screencast.sampled) out.push("blank screencast frames");
  if (r.external.length) out.push(`${r.external.length} requests left localhost, first ${r.external[0]}`);
  if (r.badResponses.length) out.push(`${r.badResponses.length} bad responses, first ${r.badResponses[0]}`);
  return out;
}
