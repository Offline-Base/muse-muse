/**
 * Makes the sample files the docs demos offer next to every file picker (public/docs-samples/, catalogued in
 * lib/docs/media/samples.ts, sources and licenses in public/docs-samples/README.md):
 *
 *   - photos from Muse Image (POST /v1/images/generations, $0.01 each, at most 8 calls a run; every raw reply is cached
 *     in .data/docs-samples-work/raw, so a rerun never pays twice), resized with sips
 *   - a chart, an error screenshot, a receipt, a sign-up screen and a 2-page PDF, rendered from HTML written here with
 *     headless Chrome (its own profile under .data/, no remote debugging port)
 *   - a 5 s H.264 clip panned across the street photo with ffmpeg, no audio
 *   - speech as 16 kHz mono 16-bit WAV from macOS `say` and `afconvert`, rewritten with lib/docs/media/wav.ts
 *   - three chapters of Alice's Adventures in Wonderland from Project Gutenberg, header and footer removed
 *
 *   npx tsx --env-file-if-exists=.env.local scripts/docs/make-samples.ts [--only=id,id] [--force] [--no-paid]
 *
 * The key is read from DOCS_MODEL_API_KEY (or MODEL_API_KEY) inside this process and never printed. Every output must
 * stay under 1.5 MB; the script fails if one doesn't.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { sniffMime } from "@/lib/docs/media/base64";
import { decodeWav, encodeWav } from "@/lib/docs/media/wav";
import { mixToMono, resample } from "@/lib/docs/media/resample";
import { parseMp4 } from "@/lib/docs/media/mp4";

const ROOT = process.cwd();
const OUT = path.join(ROOT, "public/docs-samples");
const WORK = path.join(ROOT, ".data/docs-samples-work");
const RAW = path.join(WORK, "raw");
const HTML = path.join(WORK, "html");
const TMP = path.join(WORK, "tmp");
const CHROME_PROFILE = path.join(WORK, "chrome-profile");
const DOWNLOAD = path.join(WORK, "download");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const MAX_BYTES = 1.5 * 1024 * 1024;
const MAX_PAID_CALLS = 8;
const IMAGE_PRICE = 0.01;

const args = process.argv.slice(2);
const force = args.includes("--force");
const noPaid = args.includes("--no-paid");
const only = new Set(
  (args.find((a) => a.startsWith("--only="))?.slice(7) ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);
const wanted = (id: string) => !only.size || only.has(id);

let paidCalls = 0;
let spentUsd = 0;

for (const dir of [OUT, RAW, HTML, TMP, CHROME_PROFILE, DOWNLOAD]) mkdirSync(dir, { recursive: true });

function run(cmd: string, argv: string[], timeoutMs = 120_000): string {
  const res = spawnSync(cmd, argv, { encoding: "utf8", timeout: timeoutMs });
  if (res.status !== 0) {
    throw new Error(`${path.basename(cmd)} failed (${res.status ?? res.signal}): ${(res.stderr || res.stdout || "").slice(-800)}`);
  }
  return res.stdout;
}

function skip(file: string): boolean {
  return !force && existsSync(file);
}

// ---- Photos (Muse Image) -------------------------------------------------------------------------------------------

interface PhotoSpec {
  id: string;
  size: string;
  prompt: string;
}

const PHOTOS: PhotoSpec[] = [
  {
    id: "fridge",
    size: "1024x1536",
    prompt:
      "Realistic eye-level photo looking into an open home refrigerator, bright interior light, sharp focus. Shelves hold: " +
      "a carton of eggs, a glass bottle of milk, a head of green lettuce, red tomatoes, a jar of pickles, a bowl of " +
      "strawberries, three yogurt cups, lemons and a bottle of orange juice in the door, and clear takeout containers " +
      "with handwritten masking-tape labels that read PASTA, SOUP and RICE. No brand logos.",
  },
  {
    id: "street",
    size: "1536x1024",
    prompt:
      "Realistic street photo on a sunny afternoon in a small city: a wide sidewalk with several people walking, a woman " +
      "walking two dogs on leashes (a golden retriever and a black labrador), three bicycles locked to a metal rack, cafe " +
      "tables and storefronts behind them, natural light, wide shot, sharp focus. No readable brand names.",
  },
  {
    id: "cat-sofa",
    size: "1536x1024",
    prompt:
      "Realistic photo of a ginger tabby cat curled up asleep on a grey fabric sofa with two cushions, soft morning window " +
      "light, a living room softly out of focus behind it.",
  },
  {
    id: "sneaker",
    size: "1024x1024",
    prompt:
      "Studio product photo of a single white and light grey running sneaker with no logo, three-quarter side view, on a " +
      "pure white seamless background with a soft shadow, high detail.",
  },
  {
    id: "living-room",
    size: "1536x1024",
    prompt:
      "Realistic photo of a bright modern living room with no people: a beige sofa, a round wooden coffee table with a " +
      "potted plant and two books, a woven rug, a floor lamp, a large window with daylight, white walls, wide angle.",
  },
];

async function generatePhoto(spec: PhotoSpec): Promise<void> {
  const out = path.join(OUT, `${spec.id}.jpg`);
  if (skip(out)) return console.log(`= ${spec.id}.jpg (exists)`);
  const raw = path.join(RAW, `${spec.id}.jpg`);
  if (!existsSync(raw) || force) {
    if (noPaid) return console.log(`- ${spec.id}.jpg skipped (--no-paid)`);
    if (paidCalls >= MAX_PAID_CALLS) throw new Error(`Stopped: this run already made ${MAX_PAID_CALLS} paid calls.`);
    const key = process.env.DOCS_MODEL_API_KEY || process.env.MODEL_API_KEY;
    if (!key) throw new Error("Set DOCS_MODEL_API_KEY (or MODEL_API_KEY) in .env.local to make the photos.");
    paidCalls++;
    console.log(`$ ${spec.id}: POST images/generations (${spec.size})`);
    const res = await fetch("https://api.meta.ai/v1/images/generations", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "muse-image-1.0", prompt: spec.prompt, n: 1, size: spec.size, output_format: "jpeg" }),
      signal: AbortSignal.timeout(240_000),
    });
    const body = (await res.json().catch(() => null)) as { data?: Array<{ b64_json?: string }>; error?: { message?: string } } | null;
    const b64 = body?.data?.[0]?.b64_json;
    if (!res.ok || !b64) throw new Error(`Muse Image failed for ${spec.id} (${res.status}): ${body?.error?.message ?? "no image"}`);
    spentUsd += IMAGE_PRICE;
    writeFileSync(raw, Buffer.from(b64, "base64"));
  }
  // 1280 px on the long side keeps each photo a few hundred KB: plenty for vision, SAM and edits.
  run("sips", ["-Z", "1280", "-s", "format", "jpeg", "-s", "formatOptions", "82", raw, "--out", out]);
  console.log(`+ ${spec.id}.jpg`);
}

// ---- Rendered with Chrome ---------------------------------------------------------------------------------------

const BASE_CSS = `
  * { box-sizing: border-box; }
  html, body { margin: 0; }
  body { font-family: -apple-system, "Helvetica Neue", Helvetica, Arial, sans-serif; color: #1c1d1f; background: #fff; }
`;

const CHART = {
  title: "Cups sold by drink, week of Oct 20, 2026",
  rows: [
    ["Latte", 412],
    ["Cold brew", 341],
    ["Cappuccino", 287],
    ["Americano", 198],
    ["Mocha", 156],
    ["Tea", 122],
  ] as Array<[string, number]>,
};

function chartHtml(): string {
  const w = 1200;
  const h = 800;
  const left = 110;
  const right = 40;
  const top = 120;
  const bottom = 110;
  const plotW = w - left - right;
  const plotH = h - top - bottom;
  const max = 500;
  const bar = plotW / CHART.rows.length;
  const colors = ["#4c6ef5", "#4c6ef5", "#4c6ef5", "#4c6ef5", "#4c6ef5", "#4c6ef5"];
  const grid = [0, 100, 200, 300, 400, 500]
    .map((v) => {
      const y = top + plotH - (v / max) * plotH;
      return `<line x1="${left}" x2="${w - right}" y1="${y}" y2="${y}" stroke="#e3e5e8"/><text x="${left - 14}" y="${y + 6}" text-anchor="end" font-size="18" fill="#5b5f66">${v}</text>`;
    })
    .join("");
  const bars = CHART.rows
    .map(([label, v], i) => {
      const bh = (v / max) * plotH;
      const x = left + i * bar + bar * 0.18;
      const bw = bar * 0.64;
      const y = top + plotH - bh;
      return (
        `<rect x="${x}" y="${y}" width="${bw}" height="${bh}" rx="6" fill="${colors[i]}"/>` +
        `<text x="${x + bw / 2}" y="${y - 12}" text-anchor="middle" font-size="22" font-weight="600" fill="#1c1d1f">${v}</text>` +
        `<text x="${x + bw / 2}" y="${top + plotH + 36}" text-anchor="middle" font-size="20" fill="#1c1d1f">${label}</text>`
      );
    })
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS}</style></head><body>
<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg" font-family="-apple-system, Helvetica, Arial, sans-serif">
  <rect width="${w}" height="${h}" fill="#ffffff"/>
  <text x="${left}" y="58" font-size="32" font-weight="700" fill="#1c1d1f">${CHART.title}</text>
  <text x="${left}" y="92" font-size="19" fill="#5b5f66">Riverside Coffee Co., all locations. Values are cups sold.</text>
  ${grid}
  <line x1="${left}" x2="${w - right}" y1="${top + plotH}" y2="${top + plotH}" stroke="#9aa0a6" stroke-width="2"/>
  ${bars}
  <text x="34" y="${top + plotH / 2}" font-size="18" fill="#5b5f66" transform="rotate(-90 34 ${top + plotH / 2})" text-anchor="middle">Cups sold</text>
  <text x="${w - right}" y="${h - 22}" text-anchor="end" font-size="16" fill="#8a8f96">Source: point-of-sale export, Oct 27, 2026</text>
</svg></body></html>`;
}

function errorHtml(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS}
  body { background: #dfe3e8; padding: 0; }
  .win { width: 1280px; height: 800px; background: #fff; display: flex; flex-direction: column; }
  .tabs { height: 40px; background: #e8eaed; display: flex; align-items: flex-end; padding: 0 12px; gap: 6px; }
  .tab { background: #fff; border-radius: 8px 8px 0 0; padding: 9px 16px; font-size: 13px; color: #3c4043; width: 240px; }
  .bar { height: 44px; display: flex; align-items: center; gap: 12px; padding: 0 14px; border-bottom: 1px solid #dadce0; }
  .dot { width: 12px; height: 12px; border-radius: 50%; display: inline-block; }
  .url { flex: 1; background: #f1f3f4; border-radius: 16px; padding: 7px 16px; font-size: 14px; color: #202124; }
  .page { flex: 1; position: relative; background: #fafafa; }
  .overlay { position: absolute; inset: 24px 64px; background: #fff; border-radius: 12px; box-shadow: 0 12px 40px rgba(0,0,0,.18); overflow: hidden; }
  .head { background: #fdeaea; color: #a1161b; padding: 18px 26px; font-size: 15px; font-weight: 600; display: flex; justify-content: space-between; }
  .body { padding: 22px 26px; }
  h1 { font-size: 22px; margin: 0 0 6px; color: #a1161b; font-family: Menlo, monospace; font-weight: 600; }
  .src { margin: 16px 0; background: #1f2329; color: #d6dae0; border-radius: 8px; padding: 14px 18px; font: 14px/1.55 Menlo, monospace; white-space: pre; }
  .hl { background: #4a2228; display: block; }
  .stack { font: 13.5px/1.6 Menlo, monospace; color: #3c4043; white-space: pre; }
  .label { font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; color: #6b7076; margin-top: 18px; }
  </style></head><body><div class="win">
  <div class="tabs"><div class="tab">Checkout | Plantwise Shop</div></div>
  <div class="bar"><span class="dot" style="background:#ff5f57"></span><span class="dot" style="background:#febc2e"></span><span class="dot" style="background:#28c840"></span><div class="url">localhost:3000/checkout</div></div>
  <div class="page">
  <div class="overlay">
    <div class="head"><span>Unhandled Runtime Error</span><span>1 of 1 error</span></div>
    <div class="body">
      <h1>TypeError: Cannot read properties of undefined (reading 'map')</h1>
      <div style="color:#5f6368;font-size:14px">components/CartItems.tsx (14:27) @ CartItems</div>
      <div class="src">  12 | export function CartItems({ cart }: { cart: Cart }) {
  13 |   return (
<span class="hl">&gt; 14 |     &lt;ul&gt;{cart.items.map((item) =&gt; (</span>     |                           ^
  15 |       &lt;li key={item.id}&gt;{item.name} x {item.quantity}&lt;/li&gt;
  16 |     ))}&lt;/ul&gt;</div>
      <div class="label">Call stack</div>
      <div class="stack">TypeError: Cannot read properties of undefined (reading 'map')
    at CartItems (webpack-internal:///./components/CartItems.tsx:14:27)
    at renderWithHooks (webpack-internal:///./node_modules/react-dom/cjs/react-dom.development.js:16305:18)
    at mountIndeterminateComponent (webpack-internal:///./node_modules/react-dom/cjs/react-dom.development.js:20074:13)
    at beginWork (webpack-internal:///./node_modules/react-dom/cjs/react-dom.development.js:21587:16)
    at CheckoutPage (webpack-internal:///./app/checkout/page.tsx:22:9)</div>
    </div>
  </div></div></div></body></html>`;
}

const RECEIPT = {
  store: "Corner Market",
  date: "Oct 24, 2026 4:12 PM",
  items: [
    ["Oat milk, 64 oz", "1", "4.29"],
    ["Bananas, 2.1 lb @ 0.69/lb", "1", "1.45"],
    ["Sourdough loaf", "1", "5.99"],
    ["Eggs, dozen", "1", "3.89"],
    ["Coffee beans, 12 oz", "1", "11.49"],
  ],
  subtotal: "27.11",
  tax: "2.24",
  total: "29.35",
};

function receiptHtml(): string {
  const rows = RECEIPT.items
    .map(([name, qty, price]) => `<tr><td>${name}</td><td class="q">${qty}</td><td class="p">$${price}</td></tr>`)
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS}
  body { background: #e9e6df; display: flex; justify-content: center; padding: 40px 0; width: 800px; }
  .r { width: 520px; background: #fffdf8; padding: 36px 40px 44px; box-shadow: 0 6px 24px rgba(0,0,0,.12); font: 17px/1.5 Menlo, "Courier New", monospace; color: #222; }
  .c { text-align: center; }
  h1 { font-size: 26px; margin: 0; letter-spacing: .08em; }
  table { width: 100%; border-collapse: collapse; margin: 18px 0; }
  td { padding: 4px 0; vertical-align: top; }
  .q { text-align: center; width: 40px; } .p { text-align: right; width: 90px; }
  .rule { border-top: 2px dashed #999; margin: 14px 0; }
  .t td { font-weight: 700; font-size: 19px; }
  </style></head><body><div class="r">
  <div class="c"><h1>${RECEIPT.store.toUpperCase()}</h1><div>418 Elm Street, Springfield</div><div>(555) 014-2290</div></div>
  <div class="rule"></div>
  <div>${RECEIPT.date}</div><div>Register 2 &nbsp; Cashier: Dana</div><div>Receipt #004817</div>
  <div class="rule"></div>
  <table><tr><td><b>Item</b></td><td class="q"><b>Qty</b></td><td class="p"><b>Price</b></td></tr>${rows}</table>
  <div class="rule"></div>
  <table>
    <tr><td>Subtotal</td><td class="p">$${RECEIPT.subtotal}</td></tr>
    <tr><td>Tax (8.25%)</td><td class="p">$${RECEIPT.tax}</td></tr>
    <tr class="t"><td>TOTAL</td><td class="p">$${RECEIPT.total}</td></tr>
    <tr><td>Card ending 4242</td><td class="p">$${RECEIPT.total}</td></tr>
  </table>
  <div class="rule"></div>
  <div class="c">5 items. Thank you for shopping local!</div>
  </div></body></html>`;
}

function signupHtml(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS}
  body { width: 1280px; height: 800px; background: #f3f5f8; display: flex; }
  .side { width: 520px; background: #1d4f3c; color: #fff; padding: 64px 56px; display: flex; flex-direction: column; justify-content: space-between; }
  .logo { font-size: 26px; font-weight: 700; }
  .pitch { font-size: 34px; font-weight: 700; line-height: 1.2; }
  .sub { font-size: 18px; opacity: .85; margin-top: 16px; line-height: 1.5; }
  .main { flex: 1; display: flex; align-items: center; justify-content: center; }
  form { width: 420px; background: #fff; border-radius: 16px; padding: 36px 36px 30px; box-shadow: 0 8px 30px rgba(0,0,0,.08); }
  h1 { font-size: 26px; margin: 0 0 6px; } p { margin: 0 0 24px; color: #5b6168; }
  label { display: block; font-size: 14px; font-weight: 600; margin: 14px 0 6px; }
  .in { height: 44px; border: 1px solid #c9ced6; border-radius: 10px; padding: 0 14px; display: flex; align-items: center; color: #9aa0a8; font-size: 15px; }
  .chk { display: flex; align-items: center; gap: 10px; margin: 18px 0 22px; font-size: 14px; color: #3d4248; }
  .box { width: 18px; height: 18px; border: 2px solid #8b929b; border-radius: 4px; }
  .btn { height: 46px; border-radius: 999px; display: flex; align-items: center; justify-content: center; font-weight: 600; font-size: 16px; }
  .primary { background: #1d6b4f; color: #fff; } .ghost { border: 1px solid #c9ced6; color: #1c1d1f; margin-top: 12px; }
  .foot { text-align: center; margin-top: 18px; font-size: 14px; color: #5b6168; } .foot b { color: #1d6b4f; }
  </style></head><body>
  <div class="side"><div class="logo">Sprout</div><div><div class="pitch">Grow your garden plan in minutes.</div><div class="sub">Plant schedules, watering reminders and a shared journal for your whole household.</div></div><div style="opacity:.7">Step 1 of 3</div></div>
  <div class="main"><form>
    <h1>Create your account</h1><p>Free for 30 days. No card needed.</p>
    <label>Full name</label><div class="in">Jordan Lee</div>
    <label>Email</label><div class="in">you@example.com</div>
    <label>Password</label><div class="in">At least 8 characters</div>
    <div class="chk"><span class="box"></span>I agree to the Terms and Privacy Policy</div>
    <div class="btn primary">Create account</div>
    <div class="btn ghost">Cancel</div>
    <div class="foot">Already have an account? <b>Sign in</b></div>
  </form></div></body></html>`;
}

function reportHtml(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS}
  @page { size: Letter; margin: 0.75in; }
  body { font-size: 12.5pt; line-height: 1.5; }
  h1 { font-size: 24pt; margin: 0 0 4pt; } h2 { font-size: 15pt; margin: 20pt 0 6pt; }
  .meta { color: #5b5f66; margin-bottom: 18pt; }
  table { border-collapse: collapse; width: 100%; margin: 8pt 0; }
  th, td { border-bottom: 1px solid #d4d7dc; padding: 6pt 8pt; text-align: left; } th { background: #f0f2f5; }
  td.n, th.n { text-align: right; }
  .page { page-break-after: always; }
  .foot { color: #8a8f96; font-size: 10pt; margin-top: 24pt; }
  </style></head><body>
  <div class="page">
    <h1>Northwind Bikes: Q3 2026 Field Report</h1>
    <div class="meta">Prepared Oct 6, 2026 by the operations team. Page 1 of 2.</div>
    <h2>Summary</h2>
    <p>Rentals grew 18% over Q2 to 12,480 rides across our three stations. The new Harbor station opened on July 14 and already carries a quarter of all rides. Average ride length fell slightly, from 31 to 28 minutes, as more riders used bikes for short commutes.</p>
    <h2>Rides by station</h2>
    <table><tr><th>Station</th><th class="n">Rides</th><th class="n">Revenue</th><th class="n">Avg. minutes</th></tr>
      <tr><td>Central Square</td><td class="n">5,210</td><td class="n">$41,680</td><td class="n">26</td></tr>
      <tr><td>Riverside Park</td><td class="n">4,130</td><td class="n">$37,170</td><td class="n">34</td></tr>
      <tr><td>Harbor (opened Jul 14)</td><td class="n">3,140</td><td class="n">$23,550</td><td class="n">24</td></tr>
      <tr><th>Total</th><th class="n">12,480</th><th class="n">$102,400</th><th class="n">28</th></tr></table>
    <h2>Fleet</h2>
    <p>We ended the quarter with 140 bikes, 36 of them electric. Electric bikes made up 26% of the fleet but 41% of rides. Eleven bikes were out of service for more than a week, mostly for brake and chain repairs.</p>
  </div>
  <div>
    <h1 style="font-size:18pt">Issues and next steps</h1>
    <div class="meta">Page 2 of 2.</div>
    <h2>Top rider complaints</h2>
    <ol><li>No bikes left at Central Square on weekday mornings (62 reports).</li><li>App map slow to load at Harbor (28 reports).</li><li>Squeaky brakes on older bikes (19 reports).</li></ol>
    <h2>Action items for Q4</h2>
    <table><tr><th>Action</th><th>Owner</th><th>Due</th></tr>
      <tr><td>Move 15 bikes from Riverside to Central Square before 7 AM on weekdays</td><td>Priya</td><td>Nov 1</td></tr>
      <tr><td>Add 12 electric bikes to the fleet</td><td>Marcus</td><td>Nov 30</td></tr>
      <tr><td>Replace brake pads on the 40 oldest bikes</td><td>Lena</td><td>Dec 15</td></tr></table>
    <h2>Budget</h2>
    <p>The Q4 budget is $58,000: $33,600 for the new electric bikes, $9,400 for repairs and parts, and $15,000 for staff overtime during the holiday season.</p>
    <div class="foot">Northwind Bikes is a fictional company. This report was written for software demos.</div>
  </div></body></html>`;
}

function chrome(argv: string[]): void {
  run(
    CHROME,
    [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-background-networking",
      `--user-data-dir=${CHROME_PROFILE}`,
      "--force-device-scale-factor=1",
      "--virtual-time-budget=3000",
      ...argv,
    ],
    90_000,
  );
}

function renderPng(id: string, html: string, width: number, height: number): void {
  const out = path.join(OUT, `${id}.png`);
  if (skip(out)) return console.log(`= ${id}.png (exists)`);
  const file = path.join(HTML, `${id}.html`);
  writeFileSync(file, html);
  chrome([`--window-size=${width},${height}`, `--screenshot=${out}`, `file://${file}`]);
  console.log(`+ ${id}.png`);
}

function renderPdf(id: string, html: string): void {
  const out = path.join(OUT, `${id}.pdf`);
  if (skip(out)) return console.log(`= ${id}.pdf (exists)`);
  const file = path.join(HTML, `${id}.html`);
  writeFileSync(file, html);
  chrome(["--no-pdf-header-footer", `--print-to-pdf=${out}`, `file://${file}`]);
  console.log(`+ ${id}.pdf`);
}

// ---- Video -------------------------------------------------------------------------------------------------------

function makeVideo(): void {
  const out = path.join(OUT, "street-pan.mp4");
  if (skip(out)) return console.log("= street-pan.mp4 (exists)");
  const source = existsSync(path.join(RAW, "street.jpg")) ? path.join(RAW, "street.jpg") : path.join(OUT, "street.jpg");
  if (!existsSync(source)) return console.log("- street-pan.mp4 skipped (no street photo yet)");
  // A 5 s pan at 24 fps (120 frames): a still photo slid left to right at 1.25x zoom, so objects move across the frame
  // and SAM has something to track. Quality steps down until the file fits.
  for (const crf of [23, 26, 28, 30, 32]) {
    run("ffmpeg", [
      "-y",
      "-loglevel",
      "error",
      "-loop",
      "1",
      "-framerate",
      "24",
      "-i",
      source,
      "-t",
      "5",
      "-vf",
      // Limited (TV) range yuv420p: a JPEG source is full range, which some decoders mishandle.
      "scale=2400:-2,crop=2400:1350,zoompan=z=1.25:x='(iw-iw/zoom)*on/119':y='(ih-ih/zoom)/2':d=1:s=1280x720:fps=24,scale=out_range=limited,format=yuv420p",
      "-c:v",
      "libx264",
      "-preset",
      "slow",
      "-profile:v",
      "high",
      "-crf",
      String(crf),
      "-pix_fmt",
      "yuv420p",
      "-color_range",
      "tv",
      "-movflags",
      "+faststart",
      "-an",
      out,
    ]);
    if (statSync(out).size <= 1.35 * 1024 * 1024) break;
  }
  console.log("+ street-pan.mp4");
}

// ---- Speech ------------------------------------------------------------------------------------------------------

const SPEECH = {
  paragraph:
    "Hi, this is a short test recording for Muse Voice Transcribe. Our team at Acme Mobile is rolling out eSIM support " +
    "on every 5G plan next week. Anaya will run the launch from Kolkata, and the first status call is on Thursday at " +
    "three thirty.",
  conversation: [
    ["Samantha", "Hi, thanks for calling Riverside Bikes. How can I help?"],
    ["Daniel", "Hi. The back brake on my bike is squeaking. Can I bring it in today?"],
    ["Samantha", "Sure. We're open until six, and a brake tune-up takes about thirty minutes."],
    ["Daniel", "Great. I'll come by around four. How much does it cost?"],
    ["Samantha", "Twenty-five dollars, and that includes new pads if you need them."],
    ["Daniel", "Perfect. See you at four."],
  ] as Array<[string, string]>,
  chess: ["Pawn to e4.", "Knight to f3.", "Bishop to c4.", "Castle kingside."],
};

function sayToSamples(voice: string, text: string, rate = 175): Float32Array {
  const aiff = path.join(TMP, "say.aiff");
  const wav = path.join(TMP, "say.wav");
  rmSync(aiff, { force: true });
  rmSync(wav, { force: true });
  run("say", ["-v", voice, "-r", String(rate), "-o", aiff, text]);
  run("afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", aiff, wav]);
  const decoded = decodeWav(new Uint8Array(readFileSync(wav)));
  if (!decoded) throw new Error("afconvert didn't write a readable WAV.");
  // afconvert already wrote 16 kHz mono; resample anyway in case a macOS version ignores the rate.
  return resample(mixToMono(decoded.channels), decoded.sampleRate, 16_000);
}

function joinWithSilence(parts: Float32Array[], gapMs: number): Float32Array {
  const gap = Math.round((16_000 * gapMs) / 1000);
  const total = parts.reduce((n, p) => n + p.length, 0) + gap * (parts.length + 1);
  const out = new Float32Array(total);
  let at = gap;
  for (const p of parts) {
    out.set(p, at);
    at += p.length + gap;
  }
  return out;
}

function writeWav(id: string, samples: Float32Array): void {
  writeFileSync(path.join(OUT, `${id}.wav`), encodeWav(samples, 16_000));
  console.log(`+ ${id}.wav (${(samples.length / 16_000).toFixed(1)} s)`);
}

function makeSpeech(): void {
  if (wanted("speech-paragraph") && !skip(path.join(OUT, "speech-paragraph.wav"))) {
    writeWav("speech-paragraph", joinWithSilence([sayToSamples("Samantha", SPEECH.paragraph)], 300));
  }
  if (wanted("two-voices") && !skip(path.join(OUT, "two-voices.wav"))) {
    writeWav("two-voices", joinWithSilence(SPEECH.conversation.map(([voice, line]) => sayToSamples(voice, line)), 450));
  }
  if (wanted("chess-moves") && !skip(path.join(OUT, "chess-moves.wav"))) {
    writeWav("chess-moves", joinWithSilence(SPEECH.chess.map((m) => sayToSamples("Daniel", m, 160)), 900));
  }
}

// ---- Long text ---------------------------------------------------------------------------------------------------

async function makeAlice(): Promise<void> {
  const out = path.join(OUT, "alice-chapters-1-3.txt");
  if (skip(out)) return console.log("= alice-chapters-1-3.txt (exists)");
  const cached = path.join(DOWNLOAD, "pg11.txt");
  if (!existsSync(cached)) {
    const res = await fetch("https://www.gutenberg.org/cache/epub/11/pg11.txt", { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`Project Gutenberg answered ${res.status}.`);
    writeFileSync(cached, await res.text());
  }
  const book = readFileSync(cached, "utf8").replace(/\r\n/g, "\n");
  // The contents list repeats the chapter titles, so start at the chapter heading that begins a line on its own.
  const start = book.search(/^CHAPTER I\.\s*\n+Down the Rabbit-Hole/m);
  const end = book.search(/^CHAPTER IV\.\s*\n+The Rabbit Sends in a Little Bill/m);
  if (start < 0 || end <= start) throw new Error("Couldn't find chapters I to III in the Gutenberg text.");
  // Carroll's em dashes are written "--", as plain-text editions do, so no em dash ships in our files.
  const chapters = book.slice(start, end).trim().replace(/\u2014/g, "--");
  const text =
    // The source is credited in public/docs-samples/README.md. Gutenberg asks that a stripped ebook not carry its name.
    "Alice's Adventures in Wonderland, by Lewis Carroll (1865). Chapters I to III. Public domain.\n\n" +
    chapters +
    "\n";
  writeFileSync(out, text);
  console.log(`+ alice-chapters-1-3.txt (${Math.round(text.length / 1024)} KB)`);
}

// ---- Thumbnails --------------------------------------------------------------------------------------------------

/** Small JPEGs for the pickers' sample chips, so a page with a picker doesn't load every full photo. */
function makeThumbs(): void {
  const dir = path.join(OUT, "thumbs");
  mkdirSync(dir, { recursive: true });
  for (const f of spawnSync("ls", [OUT], { encoding: "utf8" }).stdout.split("\n")) {
    const id = f.replace(/\.[^.]+$/, "");
    const out = path.join(dir, `${id}.jpg`);
    if (!/\.(jpg|png|mp4)$/.test(f) || !wanted(id) || skip(out)) continue;
    if (f.endsWith(".mp4")) {
      run("ffmpeg", ["-v", "error", "-y", "-ss", "1", "-i", path.join(OUT, f), "-frames:v", "1", "-vf", "scale=96:-2", "-q:v", "6", out]);
    } else {
      run("sips", ["-Z", "96", "-s", "format", "jpeg", "-s", "formatOptions", "70", path.join(OUT, f), "--out", out]);
    }
    console.log(`+ thumbs/${id}.jpg`);
  }
}

// ---- Run ---------------------------------------------------------------------------------------------------------

async function main() {
  for (const spec of PHOTOS) if (wanted(spec.id)) await generatePhoto(spec);
  if (wanted("bar-chart")) renderPng("bar-chart", chartHtml(), 1200, 800);
  if (wanted("error-screenshot")) renderPng("error-screenshot", errorHtml(), 1280, 800);
  if (wanted("receipt")) renderPng("receipt", receiptHtml(), 800, 830);
  if (wanted("signup-screen")) renderPng("signup-screen", signupHtml(), 1280, 800);
  if (wanted("field-report")) renderPdf("field-report", reportHtml());
  if (wanted("street-pan")) makeVideo();
  makeSpeech();
  if (wanted("alice")) await makeAlice();
  makeThumbs();

  console.log("\nFiles:");
  let bad = 0;
  const files = spawnSync("ls", [OUT], { encoding: "utf8" }).stdout.split("\n").filter((f) => f && f !== "README.md" && f !== "thumbs");
  for (const f of files) {
    const full = path.join(OUT, f);
    const bytes = statSync(full).size;
    const head = new Uint8Array(readFileSync(full).subarray(0, 16));
    let extra = "";
    if (f.endsWith(".mp4")) {
      const info = parseMp4(new Uint8Array(readFileSync(full)));
      extra = info ? ` ${info.width}x${info.height} ${info.fps} fps ${info.frames} frames ${info.durationSec.toFixed(2)} s ${info.codec}` : "";
    } else if (f.endsWith(".jpg") || f.endsWith(".png")) {
      const dims = run("sips", ["-g", "pixelWidth", "-g", "pixelHeight", full]).match(/pixelWidth: (\d+)[\s\S]*pixelHeight: (\d+)/);
      extra = dims ? ` ${dims[1]}x${dims[2]}` : "";
    }
    const ok = bytes <= MAX_BYTES;
    if (!ok) bad++;
    console.log(`${ok ? " " : "!"} ${f.padEnd(26)} ${String(bytes).padStart(9)} bytes  ${sniffMime(head) ?? "text"}${extra}`);
  }
  console.log(`\nPaid calls this run: ${paidCalls}, about $${spentUsd.toFixed(2)}.`);
  if (bad) throw new Error(`${bad} file(s) are over 1.5 MB.`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
