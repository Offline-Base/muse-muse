// Demo Studio: turns the demo recording into the product's launch video. See docs/DEMO_STUDIO.md in the Muse Muse
// repo. Don't edit this file.
//
//   node scripts/demo-studio.mjs --spec spec.json [--basic]
//
// spec.json: { title, tagline, note?: string, models: string[], url: string | null, timeline: "<path to timeline.json>",
// out: "<dir>", basic?: boolean }. Relative paths in it are resolved from the current directory, and frame files from
// timeline.json's folder. scripts/demo-plan.mjs plans the cut, the camera, captions and wait badges. Chromium (from
// @playwright/test) draws the window, the intro and outro cards, captions and badges as pictures, and ffmpeg
// composites them with the recorded frames into <out>/demo.mp4 (1920x1080, 30 fps, H.264) and <out>/poster.jpg, the
// result as the camera shows it, without the window or captions.
//
// --basic (or spec.basic) makes the plain cut instead: the recording with its waits sped up, in the window with
// captions and wait badges, and no camera or cards. When the full render fails, the basic cut is tried once by itself.
// Writes <out>/studio.json and prints the same summary as the LAST line of stdout:
// {"musemuse_studio":1,"ok":bool,"mode":"studio"|"basic","seconds",...}
// Exits 0 on success, 1 on failure (with the error on stderr) and 2 when the timeline has fewer than 5 frames or
// covers less than a second.
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  FPS,
  cameraAt,
  captionLayers,
  letterbox,
  normalizeTimeline,
  planCamera,
  planCaptions,
  planEdit,
  planFrames,
  plainText,
  posterTime,
  redactValues,
  sharedKeyValues,
  zoompanExpressions,
} from "./demo-plan.mjs";

const MIN_FRAMES = 5;
const MIN_SECONDS = 1;
// A 36 s video took 11 s on an M4 Max and 71 s on its 4 efficiency cores alone, so these leave plenty of room. The
// basic cut is the fallback and must finish sooner.
const FFMPEG_TIMEOUT_MS = 240_000;
const BASIC_TIMEOUT_MS = 140_000;

// Layout of the 1920x1080 video (docs/DEMO_STUDIO.md). The window is the chrome bar plus the screen.
const W = 1920;
const H = 1080;
const CHROME = { x: 224, y: 64, w: 1472, h: 40 };
const SCREEN = { x: 224, y: 104, w: 1472, h: 828, radius: 18 };
const CAPTION = { top: 932, centerY: 1006 };
const BADGE = { right: CHROME.x + CHROME.w - 10, centerY: CHROME.y + CHROME.h / 2 };
const INTRO_FRAMES = Math.round(2.6 * FPS);
const OUTRO_FRAMES = Math.round(2.2 * FPS);
// The cards and the main part meet through the plain backdrop: each side fades out to it and the next fades in from
// it, DIP seconds each, so two screens are never on top of each other. Badges, and captions where none follows
// another, fade in and out in FADE (demo-plan.mjs captionLayers).
const DIP = 0.3;
const FADE = 0.25;

// The Meta look: Meta blue, a lighter blue, the wash, dark and secondary text. The backdrop's glow is the Facebook UI
// blue, #0866FF.
const C = { blue: "#0064E0", light: "#0082FB", wash: "#F0F2F5", ink: "#1C2B33", muted: "#65676B" };
// Inter comes with the studio (scripts/demo-inter.woff2, Latin, every weight), so the cards look the same in sandboxes
// from snapshots made before Inter was installed. Other scripts fall back to the system's fonts.
const FONT = `"Inter", "Noto Sans", "Liberation Sans", "DejaVu Sans", system-ui, sans-serif`;
const INTER = (() => {
  try {
    return readFileSync(new URL("./demo-inter.woff2", import.meta.url)).toString("base64");
  } catch {
    return null;
  }
})();
const FOOTER = "Built with Muse Muse. Not an official Meta product.";

const started = Date.now();
const log = (line) => process.stdout.write(`demo-studio: ${line}\n`);
const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const even = (v) => Math.max(2, Math.round(v / 2) * 2);

// ---------------------------------------------------------------------------------------------------------------
// Input

function parseArgs(argv) {
  const args = { spec: "", basic: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--spec") args.spec = argv[++i] ?? "";
    else if (argv[i] === "--basic") args.basic = true;
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (!args.spec) throw new Error("Usage: node scripts/demo-studio.mjs --spec spec.json [--basic]");
  return args;
}

function readSpec(file) {
  const raw = JSON.parse(readFileSync(file, "utf8"));
  if (typeof raw?.timeline !== "string" || !raw.timeline) throw new Error("spec.timeline must be the path to timeline.json");
  if (typeof raw?.out !== "string" || !raw.out) throw new Error("spec.out must be the output folder");
  return {
    title: plainText(raw.title, 60) || "Untitled",
    tagline: plainText(raw.tagline, 150),
    note: plainText(raw.note, 120),
    models: (Array.isArray(raw.models) ? raw.models : []).map((m) => plainText(m, 40)).filter(Boolean).slice(0, 5),
    url: typeof raw.url === "string" && /^https?:\/\//i.test(raw.url) ? raw.url : null,
    timeline: path.resolve(raw.timeline),
    out: path.resolve(raw.out),
    basic: raw.basic === true,
  };
}

/** The timeline with every frame path made absolute. Frames outside the timeline's folder or missing on disk are dropped. */
function readTimeline(file) {
  const dir = path.dirname(file);
  const tl = normalizeTimeline(JSON.parse(readFileSync(file, "utf8")));
  tl.frames = tl.frames
    .map((f) => ({ ...f, file: path.resolve(dir, f.file) }))
    .filter((f) => !path.relative(dir, f.file).startsWith("..") && existsSync(f.file));
  return tl;
}

/** Width and height of a JPEG file, from the start-of-frame marker in its first few KB. Null when they don't say. */
function jpegSize(file) {
  const bytes = Buffer.alloc(8192);
  const fd = openSync(file, "r");
  let n = 0;
  try {
    n = readSync(fd, bytes, 0, bytes.length, 0);
  } finally {
    closeSync(fd);
  }
  const u16 = (i) => (bytes[i] << 8) | bytes[i + 1];
  for (let i = 2; i + 9 < n && bytes[i] === 0xff; i += 2 + u16(i + 2)) {
    const marker = bytes[i + 1];
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { width: u16(i + 7), height: u16(i + 5) };
  }
  return null;
}

/**
 * Frames of another shape than the recording's would be stretched into it. They come from a page screenshot or a
 * viewport change the recorder didn't see. A run of them shorter than a second is dropped, so the frame before holds;
 * a longer one is fitted into the recording's shape with the wash around it, by ffmpeg, into `dir`. The recording's
 * shape is its most common frame shape, which also tells whether the timeline's viewport (and so its rects) can be
 * trusted. Returns what it did, for the log.
 */
async function fitFrames(tl, dir) {
  const sizes = tl.frames.map((f) => jpegSize(f.file));
  const shapes = new Map();
  for (const s of sizes) if (s) shapes.set(`${s.width}x${s.height}`, (shapes.get(`${s.width}x${s.height}`) ?? 0) + 1);
  const main = [...shapes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (!main) return { dropped: 0, fitted: 0, trusted: true, aspect: tl.viewport.width / tl.viewport.height, odd: false };
  const [mw, mh] = main.split("x").map(Number);
  const aspect = mw / mh;
  const off = (s) => s && Math.abs(s.width / s.height - aspect) / aspect > 0.02;
  const runs = [];
  for (let i = 0; i < tl.frames.length; i++) {
    if (!off(sizes[i])) continue;
    const last = runs[runs.length - 1];
    if (last && last.end === i - 1) last.end = i;
    else runs.push({ start: i, end: i });
  }
  const keep = new Set(tl.frames.map((_, i) => i));
  let fitted = 0;
  for (const [k, run] of runs.entries()) {
    const next = tl.frames[run.end + 1];
    const span = (next ? next.t : tl.duration) - tl.frames[run.start].t;
    if (span < 1 && run.start > 0) {
      for (let i = run.start; i <= run.end; i++) keep.delete(i);
      continue;
    }
    const src = path.join(dir, `fit-${k}`, "in");
    const out = path.join(dir, `fit-${k}`, "out");
    mkdirSync(src, { recursive: true });
    mkdirSync(out, { recursive: true });
    for (let i = run.start; i <= run.end; i++) symlinkSync(tl.frames[i].file, path.join(src, `${String(i - run.start + 1).padStart(6, "0")}.jpg`));
    const count = run.end - run.start + 1;
    await run_("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-start_number", "1", "-i", path.join(src, "%06d.jpg"), "-frames:v", String(count),
      "-vf", `scale=${mw}:${mh}:force_original_aspect_ratio=decrease,pad=${mw}:${mh}:-1:-1:color=${C.wash.replace("#", "0x")}`,
      "-q:v", "2", "-start_number", "1", path.join(out, "%06d.jpg"),
    ]);
    for (let i = run.start; i <= run.end; i++) tl.frames[i] = { ...tl.frames[i], file: path.join(out, `${String(i - run.start + 1).padStart(6, "0")}.jpg`) };
    fitted += count;
  }
  tl.frames = tl.frames.filter((_, i) => keep.has(i));
  const trusted = Math.abs(tl.viewport.width / tl.viewport.height - aspect) / aspect <= 0.02;
  return { dropped: sizes.length - keep.size, fitted, trusted, aspect, odd: mw % 2 === 1 || mh % 2 === 1 };
}

/** "receipts.vercel.app" from "https://receipts.vercel.app/", or null. */
function hostOf(url) {
  try {
    return url ? new URL(url).host : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Cards, drawn by Chromium

const escapeHtml = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const BASE_CSS = `${INTER ? `@font-face{font-family:"Inter";src:url(data:font/woff2;base64,${INTER}) format("woff2");font-weight:100 900;font-display:block}` : ""}
*{box-sizing:border-box;margin:0}
html,body{background:transparent}
body{position:relative;width:${W}px;height:${H}px;overflow:hidden;font-family:${FONT};color:${C.ink};
  -webkit-font-smoothing:antialiased;text-rendering:geometricPrecision}
.backdrop{position:absolute;inset:0;background:
  radial-gradient(1200px 640px at 50% -10%,rgba(255,255,255,.34),rgba(255,255,255,0) 70%),
  radial-gradient(1000px 760px at 104% 108%,rgba(0,40,140,.42),rgba(0,40,140,0) 70%),
  radial-gradient(900px 640px at -6% 96%,rgba(8,102,255,.55),rgba(8,102,255,0) 72%),
  linear-gradient(160deg,${C.light} 0%,${C.blue} 52%,#0055C4 100%)}
.backdrop::after{content:"";position:absolute;inset:0;opacity:.05;background-image:
  url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2' stitchTiles='stitch'/></filter><rect width='160' height='160' filter='url(%23n)'/></svg>")}
`;

const page = (body, css = "", zoom = 1) =>
  `<!doctype html><html style="zoom:${zoom}"><head><meta charset="utf-8"><style>${BASE_CSS}${css}</style></head><body>${body}</body></html>`;

const LOCK = (size = 1) =>
  `<svg width="${11 * size}" height="${13 * size}" viewBox="0 0 11 13" fill="none"><rect x=".75" y="5.25" width="9.5" height="7" rx="1.75" fill="${C.muted}"/><path d="M2.75 5.5V3.75a2.75 2.75 0 0 1 5.5 0V5.5" stroke="${C.muted}" stroke-width="1.5"/></svg>`;

/**
 * The backdrop, window shadow and chrome bar, with a transparent hole where the screen goes. The address bar shows
 * the live URL's host with a lock, or just the product's name when there is no URL. A note on how the video was made
 * sits beside it, so it stays on screen for the whole main part and in the basic cut.
 */
export function windowHtml(host, title, note = "") {
  const s = SCREEN;
  const r = s.radius;
  const hole = `M${s.x} ${s.y}H${s.x + s.w}V${s.y + s.h - r}A${r} ${r} 0 0 1 ${s.x + s.w - r} ${s.y + s.h}H${s.x + r}A${r} ${r} 0 0 1 ${s.x} ${s.y + s.h - r}Z`;
  const css = `
.under{position:absolute;inset:0;clip-path:path(evenodd,'M0 0H${W}V${H}H0Z ${hole}')}
.frame{position:absolute;left:${CHROME.x}px;top:${CHROME.y}px;width:${CHROME.w}px;height:${CHROME.h + s.h}px;border-radius:${r}px;
  background:#fff;box-shadow:0 0 0 1px rgba(255,255,255,.28),0 54px 120px rgba(0,22,74,.42),0 18px 44px rgba(0,22,74,.22)}
.chrome{position:absolute;left:${CHROME.x}px;top:${CHROME.y}px;width:${CHROME.w}px;height:${CHROME.h}px;border-radius:${r}px ${r}px 0 0;
  background:#fff;border-bottom:1px solid #E4E6EB}
.dots{position:absolute;left:18px;top:14px;display:flex;gap:8px}
.dots i{width:12px;height:12px;border-radius:50%;background:#DADDE1}
.note{position:absolute;left:84px;top:7px;height:26px;color:${C.muted};font-size:15px;font-weight:500;line-height:26px;white-space:nowrap}
.url{position:absolute;left:50%;top:7px;transform:translateX(-50%);height:26px;min-width:440px;max-width:${note ? 600 : 720}px;padding:0 18px;
  border-radius:13px;background:${C.wash};color:${C.muted};font-size:15px;font-weight:500;display:flex;align-items:center;
  justify-content:center;gap:8px;white-space:nowrap}
.url span{overflow:hidden;text-overflow:ellipsis}
`;
  return page(
    `<div class="under"><div class="backdrop"></div><div class="frame"></div></div>
<div class="chrome"><div class="dots"><i></i><i></i><i></i></div>${note ? `<div class="note">${escapeHtml(note)}</div>` : ""}<div class="url">${host ? LOCK() : ""}<span>${escapeHtml(host ?? title)}</span></div></div>`,
    css,
  );
}

/** The plain backdrop the cards and the main part fade through. */
const backdropHtml = () => page(`<div class="backdrop"></div>`);

/**
 * The intro card: a white card sized to its text, with the product's name, tagline and model chips under a "Made with
 * Muse Muse" label, and beside it the poster in a small browser window, so the first second shows what the product
 * makes. Without a poster the card stands alone in the middle. Drawn at 2x for the push-in.
 */
function introHtml(spec, posterUrl) {
  const shot = Boolean(posterUrl);
  const css = `
.stage{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;gap:60px;padding:0 112px}
.card{flex:0 1 auto;min-width:520px;max-width:${shot ? 720 : 1180}px;padding:58px 64px 60px;border-radius:18px;background:#fff;
  box-shadow:0 0 0 1px rgba(255,255,255,.3),0 60px 140px rgba(0,22,74,.45),0 18px 48px rgba(0,22,74,.22)}
.made{display:inline-flex;align-items:center;gap:10px;height:40px;padding:0 18px;border-radius:20px;background:#E7F0FD;color:${C.blue};
  font-size:19px;font-weight:600;white-space:nowrap}
.made::before{content:"";width:10px;height:10px;border-radius:50%;background:${C.blue}}
h1{margin-top:30px;font-size:${shot ? 74 : 88}px;line-height:1.06;font-weight:700;letter-spacing:-.02em;text-wrap:balance;
  display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.tag{margin-top:20px;font-size:${shot ? 30 : 34}px;line-height:1.36;color:${C.muted};text-wrap:balance;
  display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.note{margin-top:28px;font-size:24px;line-height:1.36;color:${C.muted}}
.chips{margin-top:36px;display:flex;flex-wrap:wrap;gap:12px}
.chip{display:inline-flex;align-items:center;height:46px;padding:0 22px;border-radius:23px;background:${C.wash};color:${C.ink};
  font-size:21px;font-weight:600;white-space:nowrap}
.shot{flex:none;width:860px;border-radius:16px;overflow:hidden;background:#fff;
  box-shadow:0 0 0 1px rgba(255,255,255,.3),0 60px 140px rgba(0,22,74,.45),0 18px 48px rgba(0,22,74,.22)}
.bar{position:relative;height:36px;border-bottom:1px solid #E4E6EB}
.bar .dots{position:absolute;left:14px;top:12px;display:flex;gap:7px}
.bar .dots i{width:11px;height:11px;border-radius:50%;background:#DADDE1}
.bar .url{position:absolute;left:50%;top:6px;transform:translateX(-50%);height:24px;max-width:520px;padding:0 16px;border-radius:12px;
  background:${C.wash};color:${C.muted};font-size:14px;font-weight:500;display:flex;align-items:center;gap:7px;white-space:nowrap}
.bar .url span{overflow:hidden;text-overflow:ellipsis}
.shot img{display:block;width:100%;aspect-ratio:16/9;object-fit:cover}
`;
  const host = hostOf(spec.url);
  const chips = spec.models.map((m) => `<span class="chip">${escapeHtml(m)}</span>`).join("");
  const card = `<div class="card"><div class="made">Made with Muse Muse</div><h1>${escapeHtml(spec.title)}</h1>
${spec.tagline ? `<p class="tag">${escapeHtml(spec.tagline)}</p>` : ""}${chips ? `<div class="chips">${chips}</div>` : ""}${spec.note ? `<p class="note">${escapeHtml(spec.note)}</p>` : ""}</div>`;
  const window = shot
    ? `<div class="shot"><div class="bar"><div class="dots"><i></i><i></i><i></i></div><div class="url">${host ? LOCK() : ""}<span>${escapeHtml(host ?? spec.title)}</span></div></div><img src="${posterUrl}" alt=""></div>`
    : "";
  return page(`<div class="backdrop"></div><div class="stage">${card}${window}</div>`, css, 2);
}

/**
 * The outro card: "Try it" with the live URL and the product's name above it, or just the product's name and tagline
 * when there is no URL, and the footer. Drawn at 2x for the push-in.
 */
function outroHtml(spec) {
  const host = hostOf(spec.url);
  const css = `
.wrap{position:absolute;left:0;right:0;top:50%;transform:translateY(-56%);display:flex;flex-direction:column;align-items:center;
  text-align:center;color:#fff;padding:0 160px}
.name{font-size:36px;font-weight:600;opacity:.9;max-width:1500px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
h1{margin-top:6px;font-size:160px;line-height:1.04;font-weight:700;letter-spacing:-.03em}
h1.title{font-size:112px;line-height:1.08;text-wrap:balance;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.tag{margin-top:26px;max-width:1300px;font-size:36px;line-height:1.36;font-weight:500;opacity:.9;text-wrap:balance;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.link{margin-top:40px;max-width:1500px;padding:22px 44px;border-radius:999px;background:#fff;color:${C.blue};font-size:46px;font-weight:600;
  display:flex;align-items:center;gap:16px;white-space:nowrap;box-shadow:0 24px 60px rgba(0,22,74,.35)}
.link span{overflow:hidden;text-overflow:ellipsis}
.foot{position:absolute;left:0;right:0;bottom:56px;text-align:center;color:rgba(255,255,255,.86);font-size:24px;font-weight:500}
`;
  const body = host
    ? `<div class="name">${escapeHtml(spec.title)}</div><h1>Try it</h1><div class="link">${LOCK(2.4)}<span>${escapeHtml(host)}</span></div>`
    : `<h1 class="title">${escapeHtml(spec.title)}</h1>${spec.tagline ? `<p class="tag">${escapeHtml(spec.tagline)}</p>` : ""}`;
  return page(`<div class="backdrop"></div><div class="wrap">${body}</div><div class="foot">${escapeHtml(FOOTER)}</div>`, css, 2);
}

/**
 * One caption, placed where it shows: centered under the window. The step count shows when there are two or more. It
 * is drawn twice in the same place, as `part` "pill" (the white pill alone) and "text" (the count and title alone), so
 * one caption's text can fade out and the next one's in on a pill that stays up (captionLayers).
 */
function captionHtml(caption, part) {
  const css = `
.cap{position:absolute;left:50%;top:${CAPTION.centerY}px;transform:translate(-50%,-50%);max-width:1440px;display:flex;align-items:center;gap:18px;
  padding:13px 34px 13px ${caption.count > 1 ? 14 : 34}px;border-radius:36px;background:#fff;
  box-shadow:0 14px 34px rgba(0,22,74,.30),0 2px 6px rgba(0,22,74,.12)}
.n{flex:none;height:44px;padding:0 16px;border-radius:22px;background:${C.blue};color:#fff;font-size:21px;font-weight:700;
  display:flex;align-items:center;white-space:nowrap}
.t{font-size:34px;line-height:1.24;font-weight:600;letter-spacing:-.005em;text-wrap:balance;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
${part === "pill" ? ".cap>*{visibility:hidden}" : ".cap{background:transparent;box-shadow:none}"}
`;
  const count = caption.count > 1 ? `<span class="n">${caption.index} of ${caption.count}</span>` : "";
  return page(`<div class="cap" id="el">${count}<span class="t">${escapeHtml(caption.text)}</span></div>`, css);
}

/** One wait badge, placed where it shows: at the right end of the chrome bar. */
function badgeHtml(badge) {
  const css = `
.b{position:absolute;right:${W - BADGE.right}px;top:${BADGE.centerY - 16}px;height:32px;padding:0 15px 0 12px;border-radius:16px;
  background:${C.blue};color:#fff;font-size:19px;font-weight:600;display:flex;align-items:center;gap:8px;white-space:nowrap;
  box-shadow:0 2px 8px rgba(0,100,224,.35)}
`;
  const ff = `<svg width="18" height="12" viewBox="0 0 15 10"><path d="M0 0l7 5-7 5zM7.5 0l7 5-7 5z" fill="#fff"/></svg>`;
  return page(`<div class="b" id="el">${ff}<span>${escapeHtml(badge.text)}</span></div>`, css);
}

/**
 * Renders every picture the composite needs, in one browser and one page. Captions (each as its pill and its text)
 * and badges are cut out where they sit in the frame and keep that position (x, y) for the overlay. The shadow under a
 * caption is cut off at the window's bottom edge, so nothing is ever drawn over the app. The intro shows the poster
 * when there is one.
 */
async function renderCards({ spec, captions, badges, cards, poster, dir }) {
  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch().catch((err) => {
    throw new Error(`Chromium didn't start: ${String(err?.message ?? err).split("\n")[0]}`);
  });
  try {
    const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    const show = async (html) => {
      await page.setContent(html, { waitUntil: "load" });
      await page.evaluate(() => document.fonts.ready.then(() => true));
    };
    const out = { window: path.join(dir, "window.png"), backdrop: null, intro: null, outro: null, captions: [], badges: [] };

    await show(windowHtml(hostOf(spec.url), spec.title, spec.note));
    await page.screenshot({ path: out.window, omitBackground: true });

    const cutOut = async (file, margin, minY) => {
      const box = await page.locator("#el").boundingBox();
      if (!box) throw new Error(`Nothing to cut out for ${path.basename(file)}`);
      const x = Math.max(0, Math.floor(box.x - margin));
      const y = Math.max(minY, Math.floor(box.y - margin));
      const clip = { x, y, width: Math.min(W, Math.ceil(box.x + box.width + margin)) - x, height: Math.min(H, Math.ceil(box.y + box.height + margin * 1.6)) - y };
      await page.screenshot({ path: file, clip, omitBackground: true });
      return { file, x, y, w: clip.width };
    };
    for (const [i, c] of captions.entries()) {
      const parts = {};
      for (const part of ["pill", "text"]) {
        await show(captionHtml(c, part));
        parts[part] = await cutOut(path.join(dir, `caption-${i}-${part}.png`), 36, CAPTION.top);
      }
      out.captions.push({ ...parts, from: c.out0, to: c.out1 });
    }
    for (const [i, b] of badges.entries()) {
      await show(badgeHtml(b));
      out.badges.push({ ...(await cutOut(path.join(dir, `badge-${i}.png`), 0, 0)), from: b.show0, to: b.show1 });
    }

    if (cards) {
      // The cards are opaque, so they are JPEGs: PNG takes seconds to compress the backdrop's grain, which is there
      // to keep the gradient from banding in H.264.
      out.backdrop = path.join(dir, "backdrop.jpg");
      await show(backdropHtml());
      await page.screenshot({ path: out.backdrop, type: "jpeg", quality: 95 });
      // Drawn at twice the size so the slow push-ins move by half pixels and the text stays sharp.
      await page.setViewportSize({ width: W * 2, height: H * 2 });
      out.outro = path.join(dir, "outro.jpg");
      await show(outroHtml(spec));
      await page.screenshot({ path: out.outro, type: "jpeg", quality: 95 });
      out.intro = path.join(dir, "intro.jpg");
      const posterUrl = poster && existsSync(poster) ? `data:image/jpeg;base64,${readFileSync(poster).toString("base64")}` : null;
      await show(introHtml(spec, posterUrl));
      await page.screenshot({ path: out.intro, type: "jpeg", quality: 95 });
    }
    return out;
  } finally {
    await browser.close();
  }
}

// ---------------------------------------------------------------------------------------------------------------
// ffmpeg

/** ffconcat list for the frame plan. Each file is read at FPS so durations of whole frames land exactly. */
function concatList(runs, frames) {
  const quote = (p) => `'${p.replace(/'/g, "'\\''")}'`;
  const lines = ["ffconcat version 1.0"];
  for (const r of runs) lines.push(`file ${quote(frames[r.frame].file)}`, `option framerate ${FPS}`, `duration ${(r.count / FPS).toFixed(6)}`);
  // The concat demuxer needs the last file again for the last duration to count.
  lines.push(`file ${quote(frames[runs[runs.length - 1].frame].file)}`, `option framerate ${FPS}`);
  return `${lines.join("\n")}\n`;
}

// RGB pictures and the JPEG frames (BT.601, full range) are converted once to BT.709 video range, which the MP4 is
// tagged as, so colors like Meta blue come out the same in every player. The conversions go through 4:4:4: swscale's
// direct 4:2:0 to 4:2:0 matrix change tints near-white app backgrounds by a few levels.
const TO_709 = "out_color_matrix=bt709:out_range=tv";
// ffmpeg 8 tags the MP4 from its frames, so the frames carry the full BT.709 tags.
const TAG_709 = "setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv";
const WASH = C.wash.replace("#", "0x");

/**
 * A still picture shown from `from` to `to` seconds of the main part, fading in over `fadeIn` and out over `fadeOut`
 * seconds (each at most a third of its time), as a stream to overlay. The picture is converted once and looped, so it
 * isn't decoded again for every frame.
 */
function timedStill(input, label, from, to, fadeIn = FADE, fadeOut = FADE) {
  const start = Math.round(from * FPS);
  const count = Math.max(2, Math.round(to * FPS) - start);
  const seconds = count / FPS;
  const din = Math.min(fadeIn, seconds / 3);
  const dout = Math.min(fadeOut, seconds / 3);
  return (
    `[${input}:v]scale=${TO_709},format=yuva420p,loop=loop=${count - 1}:size=1:start=0,settb=1/${FPS},setpts=N,` +
    `fade=t=in:st=0:d=${din.toFixed(3)}:alpha=1,fade=t=out:st=${(seconds - dout).toFixed(3)}:d=${dout.toFixed(3)}:alpha=1,` +
    `setpts=PTS+${start}[${label}]`
  );
}

/**
 * The stills laid over the screen, bottom to top, with when each shows: the captions' pills and texts in the order
 * and timing captionLayers gives (the wider of two pills that meet on top), then the wait badges.
 */
function overlays(layers) {
  const captions = captionLayers(
    layers.captions.map((c) => ({ out0: c.from, out1: c.to, w: c.pill.w })),
    FADE,
  ).map((l) => ({ ...layers.captions[l.index][l.part], from: l.from, to: l.to, fadeIn: l.fadeIn, fadeOut: l.fadeOut }));
  return [...captions, ...layers.badges.map((b) => ({ ...b, fadeIn: FADE, fadeOut: FADE }))];
}

/**
 * How the recording sits in the 16:9 screen layer, in pixels: the content (the recording as it was, scaled to its
 * size at the recording's scale) inside a canvas with the wash around it when the recording isn't 16:9. `odd` says the
 * frames have an odd width or height, as a phone-shaped recording's do once the screencast fits it into 2560x1440.
 */
function screenGeometry(tl, box, canvas, odd) {
  // The recorder records at 2x; a scale past 3x would only make the render slower.
  const dpr = Math.min(3, Math.max(1, tl.dpr));
  return {
    srcW: even(box.w * dpr),
    srcH: even(box.h * dpr),
    canvasW: even(canvas.width * dpr),
    canvasH: even(canvas.height * dpr),
    padX: Math.round(box.x * dpr),
    padY: Math.round(box.y * dpr),
    boxed: box.x > 0.5 || box.y > 0.5,
    // swscale blackens the last column when it scales 4:2:0 frames of an odd width. In 4:4:4 it doesn't.
    first: odd ? "format=yuvj444p," : "",
  };
}

/** The recording's frames at their size, with the scale's own options (`opts`), in the 16:9 canvas when they need one. */
function toCanvas(g, opts) {
  const fit = `scale=${g.srcW}:${g.srcH}:${opts}`;
  return g.boxed ? `${fit},pad=${g.canvasW}:${g.canvasH}:${g.padX}:${g.padY}:color=${WASH}` : fit;
}

/**
 * The filter graph. Input 0 is the frame list and input 1 the window layer (when there is one); captions, badges and
 * the cards follow.
 * Main part: frames at FPS, the camera (zoompan, studio mode) or a plain scale (basic), into the window, then
 * captions and badges. Studio mode joins the intro and outro to it through the plain backdrop.
 */
function filterGraph({ mode, edit, camera, layers, geometry }) {
  const N = edit.frames;
  const chains = [];
  const frames = `fps=${FPS},tpad=stop_mode=clone:stop=2,trim=end_frame=${N},setpts=N`;
  if (mode === "studio") {
    const zp = zoompanExpressions(camera.keys);
    // 4:4:4 so zoompan doesn't round the crop to even pixels, which would make slow moves jitter.
    chains.push(
      `[0:v]${geometry.first}${toCanvas(geometry, `flags=bicubic:${TO_709}`)},format=yuv444p,${frames},` +
        `zoompan=z='${zp.z}':x='${zp.x}':y='${zp.y}':d=1:s=${SCREEN.w}x${SCREEN.h}:fps=${FPS},format=yuv420p,` +
        `pad=${W}:${H}:${SCREEN.x}:${SCREEN.y}:color=black[screen]`,
    );
  } else {
    // Meta blue around the screen, in case there is no window layer to cover it.
    const toScreen = geometry.boxed
      ? `${toCanvas(geometry, `flags=bicubic:${TO_709}`)},scale=${SCREEN.w}:${SCREEN.h}:flags=lanczos`
      : `scale=${SCREEN.w}:${SCREEN.h}:flags=lanczos:${TO_709}`;
    chains.push(
      `[0:v]${geometry.first}${toScreen},format=yuv444p,format=yuv420p,${frames},` +
        `pad=${W}:${H}:${SCREEN.x}:${SCREEN.y}:color=${C.blue.replace("#", "0x")}[screen]`,
    );
  }
  let input = 1;
  if (layers.window) {
    chains.push(`[${input++}:v]scale=${TO_709},format=yuva420p[win]`, `[screen][win]overlay=0:0:format=yuv420[l0]`);
  } else {
    chains.push("[screen]null[l0]");
  }

  let last = "l0";
  for (const [i, s] of overlays(layers).entries()) {
    chains.push(timedStill(input++, `s${i}`, s.from, s.to, s.fadeIn, s.fadeOut));
    chains.push(`[${last}][s${i}]overlay=x=${s.x}:y=${s.y}:eof_action=pass:format=yuv420[l${i + 1}]`);
    last = `l${i + 1}`;
  }
  chains.push(`[${last}]setsar=1[main]`);

  if (mode !== "studio") {
    chains.push(`[main]${TAG_709}[v]`);
    return chains.join(";\n");
  }
  const backdrop = input++;
  const intro = input++;
  const outro = input++;
  const I = INTRO_FRAMES / FPS;
  const M = edit.seconds;
  const dipFrames = Math.round(2 * DIP * FPS);
  // A slow, steady push-in from the 2x picture to 1920x1080, about 4% over each card.
  const pushIn = (n, frames) =>
    `[${n}:v]scale=${TO_709},format=yuv444p,zoompan=z='1+0.04*on/${frames}':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2':` +
    `d=${frames}:s=${W}x${H}:fps=${FPS},format=yuv420p,setsar=1`;
  const fade = (a, b, offset, out) => `[${a}][${b}]xfade=transition=fade:duration=${DIP}:offset=${offset.toFixed(4)}${out}`;
  chains.push(
    `[${backdrop}:v]scale=${W}:${H}:${TO_709},format=yuv420p,loop=loop=${dipFrames - 1}:size=1:start=0,settb=1/${FPS},setpts=N,setsar=1,split[bd0][bd1]`,
    `${pushIn(intro, INTRO_FRAMES)}[intro]`,
    `${pushIn(outro, OUTRO_FRAMES)}[outro]`,
    `${fade("intro", "bd0", I - DIP, "[a]")}`,
    `${fade("a", "main", I, "[b]")}`,
    `${fade("b", "bd1", I + M - DIP, "[c]")}`,
    `${fade("c", "outro", I + M, `,${TAG_709}[v]`)}`,
  );
  return chains.join(";\n");
}

const children = new Set();

/** Runs a command. Resolves with its output on exit 0 and rejects with stderr's tail otherwise or on timeout. */
function run_(cmd, args, timeoutMs = FFMPEG_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let err = "";
    let out = "";
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    children.add(child);
    child.stdout.on("data", (d) => (out = (out + d).slice(-20_000)));
    child.stderr.on("data", (d) => (err = (err + d).slice(-20_000)));
    const timer = setTimeout(() => {
      err += `\n${cmd} timed out after ${Math.round(timeoutMs / 1000)} s`;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      children.delete(child);
      reject(new Error(`${cmd}: ${e.message}`));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      children.delete(child);
      if (code === 0) resolve({ out, err });
      else reject(new Error(`${cmd} ${signal ? `was stopped (${signal})` : `exited with code ${code}`}: ${err.trim().split("\n").slice(-8).join("\n")}`));
    });
  });
}

/**
 * The poster: the screen as the camera shows it at main-part time t, without the window, captions or badges, as a
 * 1920x1080 JPEG that fills a 16:9 card. One source frame through ffmpeg, in RGB so the crop lands on exact pixels.
 * JPEG viewers assume BT.601 full range, which is what the frames already are.
 */
async function renderPoster({ tl, edit, camera, t, geometry, file }) {
  const n = clamp(Math.round(t * FPS), 0, edit.frames - 1);
  const source = tl.frames[planFrames(tl.frames, edit, n + 1)[n].frame];
  const keys = camera?.keys ?? [{ t: 0, z: 1, cx: 0.5, cy: 0.5 }];
  const c = cameraAt(keys, n / FPS, geometry.canvasW, geometry.canvasH);
  const crop = `crop=${(geometry.canvasW / c.z).toFixed(2)}:${(geometry.canvasH / c.z).toFixed(2)}:${c.x.toFixed(2)}:${c.y.toFixed(2)}:exact=1`;
  await run_("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", source.file, "-frames:v", "1",
    "-vf", `format=rgb24,${toCanvas(geometry, "flags=bicubic")},${crop},scale=${W}:${H}:flags=lanczos,format=yuvj444p`,
    "-q:v", "2", "-update", "1", file,
  ]);
}

// ---------------------------------------------------------------------------------------------------------------
// Render

async function render(mode, spec, raw, tmp) {
  const t0 = Date.now();
  const studio = mode === "studio";
  // Both cuts speed up the waits. Only the camera and the cards cost much to render, and the basic cut leaves them out.
  const tl = structuredClone(raw);
  const fit = await fitFrames(tl, tmp);
  if (fit.dropped || fit.fitted) log(`${fit.dropped} frames of another shape dropped, ${fit.fitted} fitted into the recording's shape`);
  // A recording whose frames don't match its viewport's shape (the viewport changed before the first frame) is shown
  // whole without the camera, since its rects are measured in another viewport.
  const shaped = fit.trusted ? tl : { ...tl, viewport: { width: Math.round(tl.viewport.height * fit.aspect), height: tl.viewport.height } };
  const { tl: plan, box } = letterbox(shaped);
  const edit = planEdit(plan);
  const camera = studio ? (fit.trusted ? planCamera(plan, edit) : { keys: [{ t: 0, z: 1, cx: 0.5, cy: 0.5 }], shots: [], poster: posterTime(plan, edit, []) }) : null;
  // The owner's shared keys, when this build has them, never show in a caption. Read from .env.local in memory only.
  const keys = sharedKeyValues(existsSync(".env.local") ? readFileSync(".env.local", "utf8") : null);
  const captions = planCaptions(plan, edit).map((c) => (keys.length ? { ...c, text: redactValues(c.text, keys) } : c));
  const badges = edit.badges;
  const poster = camera ? camera.poster : posterTime(plan, edit, []);
  const geometry = screenGeometry(shaped, box, plan.viewport, fit.odd);
  log(
    `${mode}: ${tl.frames.length} frames over ${tl.duration.toFixed(1)} s -> ${edit.seconds.toFixed(1)} s main part, ` +
      `${camera?.shots.length ?? 0} zooms, ${captions.length} captions, ${badges.length} badges${geometry.boxed ? ", letterboxed" : ""}`,
  );

  // The poster comes first, since the intro card shows it.
  const jpg = path.join(tmp, "poster.jpg");
  const posterMade = await renderPoster({ tl: plan, edit, camera, t: poster, geometry, file: jpg }).then(
    () => true,
    (err) => {
      process.stderr.write(`demo-studio: no poster: ${err?.message ?? err}\n`);
      return false;
    },
  );

  let layers;
  try {
    layers = await renderCards({ spec, captions, badges, cards: studio, poster: posterMade ? jpg : null, dir: tmp });
    log(`cards drawn in ${seconds(Date.now() - t0)}`);
  } catch (err) {
    // The basic cut is the last resort, so it goes on without Chromium: the screen on Meta blue, with no captions. A note
    // lives in the window, and a video that must carry one is better left out than published without it.
    if (studio || spec.note) throw err;
    process.stderr.write(`demo-studio: no window or captions, Chromium failed: ${err?.message ?? err}\n`);
    layers = { window: null, backdrop: null, intro: null, outro: null, captions: [], badges: [] };
  }

  const list = path.join(tmp, "frames.ffconcat");
  writeFileSync(list, concatList(edit.runs, plan.frames));
  const graph = path.join(tmp, "graph.txt");
  writeFileSync(graph, filterGraph({ mode, edit, camera, layers, geometry }));

  const mp4 = path.join(tmp, "demo.mp4");
  // The inputs follow the filter graph's order: the window, then the overlays bottom to top.
  const stills = [layers.window, ...overlays(layers).map((s) => s.file)].filter(Boolean);
  if (studio) stills.push(layers.backdrop, layers.intro, layers.outro);
  const t1 = Date.now();
  const encode = [
    "-map", "[v]", "-an", "-c:v", "libx264", "-profile:v", "high", "-crf", "19", "-pix_fmt", "yuv420p", "-r", String(FPS),
    // The basic cut is the fallback, so it trades a little size for a faster encode.
    "-preset", studio ? "medium" : "veryfast",
    "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv", "-movflags", "+faststart",
  ];
  const inputs = [
    "-f", "concat", "-safe", "0", "-reinit_filter", "0", "-i", list,
    ...stills.flatMap((file) => ["-framerate", String(FPS), "-i", file]),
  ];
  await run_(
    "ffmpeg",
    ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", ...inputs, "-/filter_complex", graph, ...encode, mp4],
    studio ? FFMPEG_TIMEOUT_MS : BASIC_TIMEOUT_MS,
  );
  log(`ffmpeg finished in ${seconds(Date.now() - t1)}`);

  const expected = studio ? (INTRO_FRAMES + edit.frames + OUTRO_FRAMES) / FPS : edit.seconds;
  const probe = await run_("ffprobe", [
    "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name,width,height", "-show_entries", "format=duration", "-of", "json", mp4,
  ]);
  const info = JSON.parse(probe.out);
  const stream = info.streams?.[0];
  const duration = Number(info.format?.duration) || 0;
  if (stream?.codec_name !== "h264" || stream.width !== W || stream.height !== H || Math.abs(duration - expected) > 0.25) {
    throw new Error(`demo.mp4 came out wrong (expected ${expected.toFixed(2)} s): ${probe.out.replace(/\s+/g, " ").slice(0, 300)}`);
  }
  // The finished video's own frame at the poster time stands in when the poster couldn't be cut from the recording.
  if (!posterMade) {
    const at = (studio ? INTRO_FRAMES / FPS : 0) + Math.round(poster * FPS) / FPS;
    await run_("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-ss", at.toFixed(4), "-i", mp4, "-frames:v", "1",
      "-vf", "format=yuv444p,scale=out_color_matrix=bt601:out_range=pc,format=yuvj444p", "-q:v", "2", "-update", "1", jpg,
    ]);
  }
  if (!existsSync(jpg)) throw new Error("poster.jpg was not written");
  renameSync(mp4, path.join(spec.out, "demo.mp4"));
  renameSync(jpg, path.join(spec.out, "poster.jpg"));
  return {
    seconds: Number(duration.toFixed(2)),
    sourceSeconds: Number(edit.sourceSeconds.toFixed(2)),
    compressedSeconds: Number(edit.compressedSeconds.toFixed(2)),
    zooms: camera?.shots.length ?? 0,
    captions: layers.captions.length,
    badges: layers.badges.length,
    poster: Number(poster.toFixed(2)),
    ...(fit.dropped || fit.fitted ? { framesDropped: fit.dropped, framesFitted: fit.fitted } : {}),
    ...(geometry.boxed ? { letterboxed: true } : {}),
  };
}

async function main() {
  let spec = null;
  let tmp = null;
  let finished = false;
  const finish = (code, summary) => {
    if (finished) return;
    finished = true;
    for (const child of children) child.kill("SIGKILL");
    const line = JSON.stringify({ musemuse_studio: 1, ...summary, ms: Date.now() - started });
    if (spec?.out && existsSync(spec.out)) writeFileSync(path.join(spec.out, "studio.json"), `${line}\n`);
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    process.stdout.write(`${line}\n`, () => process.exit(code));
  };
  // The demo runner stops a render that runs too long. Leave no ffmpeg or temporary files behind.
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => finish(1, { ok: false, mode: spec?.basic ? "basic" : "studio", error: `stopped by ${signal}` }));
  }

  let tl;
  try {
    const args = parseArgs(process.argv.slice(2));
    spec = readSpec(path.resolve(args.spec));
    if (args.basic) spec.basic = true;
    mkdirSync(spec.out, { recursive: true });
    // A failed render must never leave an older video behind to be published.
    for (const f of ["demo.mp4", "poster.jpg", "studio.json"]) rmSync(path.join(spec.out, f), { force: true });
    tl = readTimeline(spec.timeline);
  } catch (err) {
    process.stderr.write(`demo-studio: ${err?.stack ?? err}\n`);
    return finish(1, { ok: false, mode: spec?.basic ? "basic" : "studio", error: String(err?.message ?? err) });
  }
  if (tl.frames.length < MIN_FRAMES || tl.duration < MIN_SECONDS) {
    const error = `timeline.json has ${tl.frames.length} usable frames over ${tl.duration.toFixed(2)} s; a video needs at least ${MIN_FRAMES} frames and ${MIN_SECONDS} s`;
    process.stderr.write(`demo-studio: ${error}\n`);
    return finish(2, { ok: false, mode: spec.basic ? "basic" : "studio", error });
  }

  tmp = path.join(spec.out, ".studio-tmp");
  let firstError = null;
  for (const mode of spec.basic ? ["basic"] : ["studio", "basic"]) {
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });
    try {
      const result = await render(mode, spec, tl, tmp);
      return finish(0, { ok: true, mode, ...result, ...(firstError ? { error: firstError } : {}) });
    } catch (err) {
      firstError ??= String(err?.message ?? err).slice(0, 2000);
      process.stderr.write(`demo-studio: ${mode} render failed: ${err?.stack ?? err}\n`);
      for (const f of ["demo.mp4", "poster.jpg"]) rmSync(path.join(spec.out, f), { force: true });
    }
  }
  return finish(1, { ok: false, mode: "basic", error: firstError });
}

if (process.argv[1] && import.meta.filename === realpathSync(process.argv[1])) main();
