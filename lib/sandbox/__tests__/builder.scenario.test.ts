/**
 * Runs lib/sandbox/builder.ts with the sandbox and Blob faked. writeFixScreenshots: the four-screenshot cap, the 2 MB
 * cap (downscaled in the sandbox, or left out), downloads that fail, and a downscale that fails. finishDemo: Demo
 * Studio's render uploaded with its poster and the frames cleared after, the basic cut when the render didn't come out,
 * no video for a failed run, and the old recorder in sandboxes from older snapshots and for studio runs that recorded
 * nothing. Also writeDemoSpec and refreshPlatformFiles.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/sandbox/__tests__/builder.scenario.test.ts
 *
 * Without the flag, node:test has no mock.module and this file skips.
 */
import assert from "node:assert/strict";
import { before, beforeEach, describe, it, mock } from "node:test";
import { PLATFORM_FILES } from "@/lib/sandbox/paths";

const MB = 1024 * 1024;
const DIR = "/vercel/app/.muse-fix";

/** Bytes each URL downloads as, or an error to throw. */
let downloads: Record<string, number | Error> = {};
let fetched: Array<{ url: string; signal?: AbortSignal }> = [];
let scripts: string[] = [];
let sudoScripts: string[] = [];
let written: Array<{ path: string; bytes: number; text: string }> = [];
/** What the downscale script prints (the files that now fit), or an error for the command itself. */
let shrinkResult: ((script: string) => string) | Error = () => "";
/** Answers every command when set (the finishDemo tests); unset, commands go to the downscale stand-in above. */
let onCommand: ((script: string) => { exitCode?: number; stdout?: string }) | null = null;
/** Files readFileToBuffer finds. */
let files: Record<string, string> = {};
let uploads: Array<{ key: string; contentType: string }> = [];
/** Uploads whose key matches fail. */
let failUploads: RegExp | null = null;

/** The fake sandbox's tags, and every update() call. */
let tags: Record<string, string> | undefined;
let updates: Array<Record<string, unknown>> = [];

const fakeSandbox = {
  get tags() {
    return tags;
  },
  update: async (u: Record<string, unknown>) => {
    updates.push(u);
    if (u.tags) tags = u.tags as Record<string, string>;
  },
  runCommand: async (opts: { args: string[]; sudo?: boolean }) => {
    const script = opts.args[1] ?? "";
    scripts.push(script);
    if (opts.sudo) sudoScripts.push(script);
    if (onCommand) {
      const res = onCommand(script);
      return { exitCode: res.exitCode ?? 0, stdout: async () => res.stdout ?? "", stderr: async () => "" };
    }
    const isShrink = script.includes("ffmpeg");
    if (isShrink && shrinkResult instanceof Error) throw shrinkResult;
    const stdout = isShrink && typeof shrinkResult === "function" ? shrinkResult(script) : "";
    return { exitCode: 0, stdout: async () => stdout, stderr: async () => "" };
  },
  writeFiles: async (batch: Array<{ path: string; content: string | Buffer }>) => {
    for (const f of batch) written.push({ path: f.path, bytes: Buffer.byteLength(f.content), text: String(f.content) });
  },
  readFileToBuffer: async ({ path }: { path: string }) => (path in files ? Buffer.from(files[path]!) : null),
};

const canMock = typeof (mock as { module?: unknown }).module === "function";
let builder: typeof import("../builder");

const shot = (url: string) => ({ url, caption: url });

before(async () => {
  if (!canMock) return;
  mock.module("@vercel/sandbox", {
    namedExports: { APIError: class APIError extends Error {}, Sandbox: { get: async () => fakeSandbox } },
  });
  mock.module(new URL("../../storage.ts", import.meta.url).href, {
    namedExports: {
      putFile: async (prefix: string, key: string, _body: Buffer, contentType: string) => {
        if (failUploads?.test(key)) throw new Error("Blob is down");
        uploads.push({ key: `${prefix}/${key}`, contentType });
        return `https://blob/${prefix}/${key}`;
      },
      fetchBytes: (url: string, opts: { signal?: AbortSignal } = {}) => {
        fetched.push({ url, signal: opts.signal });
        const d = downloads[url];
        if (d instanceof Error) return Promise.reject(d);
        return Promise.resolve(Buffer.alloc(d ?? 1000, 1));
      },
    },
  });
  builder = await import("../builder");
});

beforeEach(() => {
  downloads = {};
  fetched = [];
  scripts = [];
  sudoScripts = [];
  written = [];
  shrinkResult = () => "";
  onCommand = null;
  files = {};
  uploads = [];
  failUploads = null;
  tags = undefined;
  updates = [];
});

describe("writeFixScreenshots", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {

  it("attaches at most four, skips a failed download and numbers the rest in order", async () => {
    downloads = { "https://b/2.png": new Error("Download failed (404)") };
    const out = await builder.writeFixScreenshots("sb", 1, [1, 2, 3, 4, 5].map((n) => shot(`https://b/${n}.png`)));
    assert.deepEqual(
      fetched.map((f) => f.url),
      ["https://b/1.png", "https://b/2.png", "https://b/3.png", "https://b/4.png"],
    );
    assert.ok(fetched.every((f) => f.signal instanceof AbortSignal && !f.signal.aborted), "every download has a deadline");
    assert.deepEqual(out, [".muse-fix/round-1-1.png", ".muse-fix/round-1-2.png", ".muse-fix/round-1-3.png"]);
    assert.deepEqual(
      written.map((w) => w.path),
      [`${DIR}/.gitignore`, `${DIR}/round-1-1.png`, `${DIR}/round-1-2.png`, `${DIR}/round-1-3.png`],
    );
    // Earlier copies of this round, downscale leftovers included, go first. Nothing needed downscaling.
    assert.match(scripts[0]!, /rm -f '\/vercel\/app\/\.muse-fix'\/round-1-\*$/);
    assert.equal(scripts.length, 1);
  });

  it("downscales a screenshot over 2 MB in the sandbox, and leaves it out when that doesn't get it under", async () => {
    downloads = { "https://b/big.png": 3 * MB, "https://b/huge.png": 40 * MB, "https://b/edge.png": 2 * MB };
    // The downscale gets big.png under 2 MB but not huge.png. edge.png is exactly 2 MB, so it goes as it is.
    shrinkResult = (script) => (script.includes("round-2-2.png") ? `${DIR}/round-2-2.png\n` : "");
    const shots = ["small", "big", "huge", "edge"].map((name) => shot(`https://b/${name}.png`));
    const out = await builder.writeFixScreenshots("sb", 2, shots);
    assert.deepEqual(
      written.map((w) => w.path),
      [`${DIR}/.gitignore`, `${DIR}/round-2-1.png`, `${DIR}/round-2-2.png.big`, `${DIR}/round-2-3.png.big`, `${DIR}/round-2-4.png`],
    );
    assert.equal(scripts.length, 2);
    assert.match(scripts[1]!, /for f in '\/vercel\/app\/\.muse-fix\/round-2-2\.png' '\/vercel\/app\/\.muse-fix\/round-2-3\.png'; do/);
    assert.match(scripts[1]!, new RegExp(`-le ${2 * MB} \\]`));
    assert.deepEqual(out, [".muse-fix/round-2-1.png", ".muse-fix/round-2-2.png", ".muse-fix/round-2-4.png"]);
  });

  it("goes on without the oversized ones when downscaling fails outright", async () => {
    downloads = { "https://b/big.png": 3 * MB };
    shrinkResult = new Error("Sandbox command timed out");
    const out = await builder.writeFixScreenshots("sb", 3, [shot("https://b/a.png"), shot("https://b/big.png")]);
    assert.deepEqual(out, [".muse-fix/round-3-1.png"]);
  });
});

const OUT = "/vercel/musemuse/out/demo";
const REPORT = "/vercel/app/test-results/report.json";
const TIMELINE = "/vercel/app/test-results/demo/timeline.json";
const FRAMES = "/vercel/app/test-results/demo/frames";

/**
 * A Playwright JSON report with one demo test, from the studio project, or from the video project (the old recorder's,
 * which carries its video attachment).
 */
function demoReport(status: string, video?: string): string {
  const attachments = video ? [{ name: "video", path: video, contentType: "video/webm" }] : [];
  const projectName = video ? "demo" : "studio";
  return JSON.stringify({ suites: [{ specs: [{ tests: [{ projectName, results: [{ status, steps: [{ title: "Open the product", duration: 1200 }], attachments }] }] }] }] });
}

/** What a render leaves in OUT: studio.json, demo.mp4 (as ffprobe sees it) and, unless `poster` is false, poster.jpg. */
interface Render {
  ok: boolean;
  stream?: { codec_name: string; width: number; height: number };
  seconds?: number;
  poster?: boolean;
}

const GOOD: Render = { ok: true, stream: { codec_name: "h264", width: 1920, height: 1080 }, seconds: 31.5 };

/**
 * Plays the sandbox for finishDemo: whether the pristine copy has Demo Studio, whether the recorder left a timeline
 * (it does unless `recorded` is false), the demo run's report, what the task's render left, and what the basic cut
 * makes (null: it fails and writes nothing). Records the poster frame's time and whether the frames were cleared.
 */
function demoSandbox(opts: { studio: boolean; recorded?: boolean; report: string; render?: Render | null; basic?: Render | null; basicLog?: string }) {
  const seen = { basicRuns: 0, posterAt: null as string | null, framesCleared: false };
  if (opts.studio && opts.recorded !== false) files[TIMELINE] = "{}";
  let probe: Render | null = null;
  const leave = (r: Render | null | undefined) => {
    probe = r ?? null;
    if (!r) return;
    files[`${OUT}/studio.json`] = JSON.stringify({ ok: r.ok, mode: "studio" });
    files[`${OUT}/demo.mp4`] = "mp4";
    if (r.poster !== false) files[`${OUT}/poster.jpg`] = "jpg";
  };
  files[REPORT] = opts.report;
  leave(opts.render);
  onCommand = (script) => {
    if (script.startsWith("[ -f '/vercel/musemuse/pristine/tests/demo-fixtures.ts' ]")) return { exitCode: opts.studio ? 0 : 1 };
    if (script.includes("--basic")) {
      seen.basicRuns += 1;
      for (const f of ["studio.json", "demo.mp4", "poster.jpg"]) delete files[`${OUT}/${f}`];
      leave(opts.basic);
      return { exitCode: opts.basic ? 0 : 1 };
    }
    if (script.includes("demo-basic.log") && script.includes("base64")) return { stdout: Buffer.from(opts.basicLog ?? "").toString("base64") };
    if (script.startsWith("ffprobe") && script.includes("-of csv=p=0")) return { stdout: "6.2\n" };
    if (script.startsWith("ffprobe")) {
      const r = probe as Render | null;
      if (!files[`${OUT}/demo.mp4`] || !r?.stream) return { exitCode: 1 };
      return { stdout: JSON.stringify({ streams: [r.stream], format: { duration: String(r.seconds ?? 0) } }) };
    }
    if (script.includes("-frames:v 1")) {
      // The poster fallback: a frame from the video, unless the render left one.
      if (!files[`${OUT}/poster.jpg`]) {
        seen.posterAt = /-ss (\S+)/.exec(script)?.[1] ?? null;
        files[`${OUT}/poster.jpg`] = "frame";
      }
      return {};
    }
    if (script.startsWith("ffmpeg -y -hide_banner")) {
      // The old recorder's render.
      files[`${OUT}/demo.mp4`] = "mp4";
      probe = { ok: true, stream: { codec_name: "h264", width: 1280, height: 720 }, seconds: 8.7 };
      return {};
    }
    if (script.startsWith("[ -s ")) return { exitCode: files[/'([^']+)'/.exec(script)![1]!] ? 0 : 1 };
    if (script === `rm -rf '${FRAMES}'`) seen.framesCleared = true;
    return {};
  };
  return seen;
}

const demoInput = { sandboxName: "sb", buildId: "b1", title: "Receipt Counter", subtitle: "Adds up a week of receipts" };

describe("finishDemo", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  it("uploads Demo Studio's video and poster when the run passed and the render checks out", async () => {
    const seen = demoSandbox({ studio: true, report: demoReport("passed"), render: GOOD });
    const out = await builder.finishDemo(demoInput);
    assert.deepEqual(out, { videoUrl: "https://blob/demos/b1/demo.mp4", posterUrl: "https://blob/demos/b1/poster.jpg" });
    assert.deepEqual(uploads, [
      { key: "demos/b1/demo.mp4", contentType: "video/mp4" },
      { key: "demos/b1/poster.jpg", contentType: "image/jpeg" },
    ]);
    assert.equal(seen.basicRuns, 0);
    assert.equal(seen.posterAt, null, "the render's own poster is kept");
    assert.ok(scripts.some((s) => s.includes("-show_entries stream=codec_name,width,height") && s.includes(`'${OUT}/demo.mp4'`)));
    assert.ok(seen.framesCleared, "the frames don't stay in the sandbox's snapshots");
  });

  it("puts the spec's note in the old MP4", async () => {
    demoSandbox({ studio: true, recorded: false, report: demoReport("passed", "/vercel/app/test-results/playwright/x/video.webm"), render: GOOD });
    files["/vercel/app/test-results/playwright/x/video.webm"] = "webm";
    files["/vercel/musemuse/demo-spec.json"] = JSON.stringify({ note: "Recorded in a simulated Meta Quest 3 headset." });
    await builder.finishDemo(demoInput);
    assert.equal(written.find((w) => w.path === `${OUT}/note.txt`)?.text, "Recorded in a simulated Meta Quest 3 headset.");
    assert.match(written.find((w) => w.path === `${OUT}/graph.txt`)!.text, /textfile=\/vercel\/musemuse\/out\/demo\/note\.txt/);
    delete files["/vercel/musemuse/demo-spec.json"];
  });

  it("makes the old MP4 when the studio run recorded nothing and the demo was recorded with Playwright's video", async () => {
    const seen = demoSandbox({ studio: true, recorded: false, report: demoReport("passed", "/vercel/app/test-results/playwright/x/video.webm"), render: GOOD });
    files["/vercel/app/test-results/playwright/x/video.webm"] = "webm";
    const out = await builder.finishDemo(demoInput);
    assert.deepEqual(out, { videoUrl: "https://blob/demos/b1/demo.mp4", posterUrl: "https://blob/demos/b1/poster.jpg" });
    assert.equal(seen.basicRuns, 0);
    assert.ok(scripts.some((s) => s.startsWith("ffmpeg -y -hide_banner") && s.includes("-i '/vercel/app/test-results/playwright/x/video.webm'")));
    // A studio run that failed before it recorded has no video project result to use.
    uploads = [];
    demoSandbox({ studio: true, recorded: false, report: demoReport("failed"), render: GOOD });
    assert.deepEqual(await builder.finishDemo(demoInput), { videoUrl: null, posterUrl: null });
    assert.equal(uploads.length, 0);
  });

  it("makes the basic cut once, with a time limit, when the render is missing or wrong, and uses it", async () => {
    for (const render of [null, { ...GOOD, ok: false }, { ...GOOD, stream: { codec_name: "h264", width: 1280, height: 720 } }, { ...GOOD, seconds: 2 }]) {
      uploads = [];
      scripts = [];
      const seen = demoSandbox({ studio: true, report: demoReport("passed"), render, basic: { ...GOOD, poster: false } });
      const out = await builder.finishDemo(demoInput);
      assert.equal(seen.basicRuns, 1, JSON.stringify(render));
      assert.deepEqual(out, { videoUrl: "https://blob/demos/b1/demo.mp4", posterUrl: "https://blob/demos/b1/poster.jpg" });
      const basic = scripts.find((s) => s.includes("--basic"))!;
      assert.match(basic, /^rm -f '\/vercel\/musemuse\/out\/demo\/studio\.json' '\/vercel\/musemuse\/out\/demo\/demo\.mp4' '\/vercel\/musemuse\/out\/demo\/poster\.jpg'\n/);
      assert.match(basic, /timeout -k 10 180 node scripts\/demo-studio\.mjs --spec '\/vercel\/musemuse\/demo-spec\.json' --basic > '\/vercel\/musemuse\/logs\/demo-basic\.log' 2>&1$/);
      // The basic cut left no poster, so one is taken from its intro card.
      assert.equal(seen.posterAt, "1.5");
    }
  });

  it("throws, with the basic cut's log, when neither render comes out", async () => {
    demoSandbox({ studio: true, report: demoReport("passed"), render: null, basic: null, basicLog: "demo-studio: timeline.json has no frames" });
    await assert.rejects(builder.finishDemo(demoInput), (err: Error) => {
      assert.match(err.message, /Demo Studio couldn't make the video \(there is no studio\.json\), and its basic cut failed too: there is no studio\.json\./);
      assert.match(err.message, /timeline\.json has no frames/);
      return true;
    });
    assert.equal(uploads.length, 0);
  });

  it("publishes nothing, and renders nothing, when the demo run failed or didn't run", async () => {
    for (const report of [demoReport("failed"), JSON.stringify({ suites: [{ specs: [{ tests: [{ projectName: "smoke", results: [{ status: "passed" }] }] }] }] })]) {
      const seen = demoSandbox({ studio: true, report, render: GOOD, basic: GOOD });
      assert.deepEqual(await builder.finishDemo(demoInput), { videoUrl: null, posterUrl: null });
      assert.equal(seen.basicRuns, 0);
    }
    assert.equal(uploads.length, 0);
  });

  it("keeps the video when its poster won't upload", async () => {
    demoSandbox({ studio: true, report: demoReport("passed"), render: GOOD });
    failUploads = /poster\.jpg$/;
    const out = await builder.finishDemo(demoInput);
    assert.deepEqual(out, { videoUrl: "https://blob/demos/b1/demo.mp4", posterUrl: null });
    assert.deepEqual(uploads.map((u) => u.key), ["demos/b1/demo.mp4"]);
  });

  it("records the old way in a sandbox from an older snapshot, with a poster from the title card", async () => {
    const seen = demoSandbox({ studio: false, report: demoReport("passed", "/vercel/app/test-results/playwright/x/video.webm"), basic: GOOD });
    files["/vercel/app/test-results/playwright/x/video.webm"] = "webm";
    const out = await builder.finishDemo(demoInput);
    assert.deepEqual(out, { videoUrl: "https://blob/demos/b1/demo.mp4", posterUrl: "https://blob/demos/b1/poster.jpg" });
    assert.equal(seen.basicRuns, 0);
    assert.equal(seen.posterAt, "1.25");
    assert.ok(scripts.some((s) => s.startsWith("ffmpeg -y -hide_banner") && s.includes("-i '/vercel/app/test-results/playwright/x/video.webm'")));
    assert.ok(written.some((w) => w.path === `${OUT}/title-0.txt` && w.text === "Receipt Counter"));
  });

  it("returns sandbox paths without uploading when asked to skip the upload, and keeps the frames", async () => {
    const seen = demoSandbox({ studio: true, report: demoReport("passed"), render: GOOD });
    const out = await builder.finishDemo({ ...demoInput, skipUpload: true });
    assert.deepEqual(out, { videoUrl: `sandbox://sb${OUT}/demo.mp4`, posterUrl: `sandbox://sb${OUT}/poster.jpg` });
    assert.equal(uploads.length, 0);
    assert.equal(seen.framesCleared, false);
  });
});

describe("writeDemoSpec", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  it("writes the spec Demo Studio reads, with the fixed recording and render paths and clean card text", async () => {
    const spec = await builder.writeDemoSpec("sb", {
      title: "Receipt Counter \u2014 Weekly",
      tagline: "  Adds up a week of receipts ",
      models: ["Muse Spark 1.3", "SAM 3.1", "Muse Spark 1.3", " "],
      url: "https://musemuse-receipt-counter.vercel.app",
    });
    const want = {
      title: "Receipt Counter, Weekly",
      tagline: "Adds up a week of receipts",
      models: ["Muse Spark 1.3", "SAM 3.1"],
      url: "https://musemuse-receipt-counter.vercel.app",
      timeline: "/vercel/app/test-results/demo/timeline.json",
      out: OUT,
    };
    assert.deepEqual(spec, want);
    assert.equal(written.length, 1);
    assert.equal(written[0]!.path, "/vercel/musemuse/demo-spec.json");
    assert.deepEqual(JSON.parse(written[0]!.text), want);
  });
});

describe("refreshPlatformFiles", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  const template = PLATFORM_FILES.map((f) => ({ path: f, content: `new ${f}\n` }));

  it("replaces the product's platform files, then remakes the pristine copy as root", async () => {
    onCommand = () => ({});
    await builder.refreshPlatformFiles("sb", [...template, { path: "app/page.tsx", content: "not a platform file" }]);
    assert.match(scripts[0]!, /^cd '\/vercel\/app' && rm -f -- 'scripts\/verify\.mjs' .*'scripts\/demo-studio\.mjs' 'scripts\/demo-inter\.woff2'$/);
    assert.deepEqual(
      written.map((w) => w.path),
      PLATFORM_FILES.map((f) => `/vercel/app/${f}`),
    );
    assert.equal(sudoScripts.length, 1);
    assert.match(sudoScripts[0]!, /chown -R root:root '\/vercel\/musemuse\/pristine'/);
    assert.ok(scripts.indexOf(sudoScripts[0]!) > 0, "after the files are written");
  });

  it("refuses a template that lacks a platform file, before touching the sandbox", async () => {
    onCommand = () => ({});
    await assert.rejects(builder.refreshPlatformFiles("sb", template.filter((t) => t.path !== "scripts/demo-studio.mjs")), /missing from template\/: scripts\/demo-studio\.mjs/);
    assert.equal(scripts.length, 0);
  });

  it("fails when the pristine copy can't be remade, so the old files don't come back unnoticed", async () => {
    onCommand = (script) => (script.includes("chown -R root:root") ? { exitCode: 1 } : {});
    await assert.rejects(builder.refreshPlatformFiles("sb", template), /Sandbox command failed \(exit 1\)/);
  });
});

describe("product sandboxes", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  const PRODUCT = "3f2a9c1e-77b0-4d2e-9f00-0123456789ab";
  const reopen = (productId: string) =>
    builder.reopenSandbox({ sandboxName: "product-bird-finder", productId, buildToken: "mm_build_x", gatewayUrl: "https://g", newReferences: [] });

  it("are named after the slug and the product id, so another database's product with the same slug can't share one", () => {
    assert.equal(builder.sandboxNameFor("Bird Finder", PRODUCT), "product-bird-finder-3f2a9c1e");
    assert.notEqual(builder.sandboxNameFor("bird-finder", PRODUCT), builder.sandboxNameFor("bird-finder", "9b1d0c3e-0000-4000-8000-000000000000"));
    assert.ok(builder.sandboxNameFor("a".repeat(80), PRODUCT).length <= 61);
    assert.throws(() => builder.sandboxNameFor("bird", "not-a-uuid"), /Invalid product id/);
  });

  it("refuses a sandbox tagged with another product before touching it", async () => {
    tags = { app: "musemuse", role: "product", slug: "bird-finder", product: "9b1d0c3e-0000-4000-8000-000000000000" };
    await assert.rejects(reopen(PRODUCT), /belongs to another product/);
    assert.equal(updates.length, 0, "no policy change");
    assert.equal(written.length, 0, "no files written");
  });

  it("claims an untagged sandbox from before the tag existed, then carries on", async () => {
    tags = { app: "musemuse", role: "product", slug: "bird-finder" };
    const savedKey = process.env.MODEL_API_KEY;
    process.env.MODEL_API_KEY = "test-model-key";
    try {
      await reopen(PRODUCT);
    } finally {
      if (savedKey === undefined) delete process.env.MODEL_API_KEY;
      else process.env.MODEL_API_KEY = savedKey;
    }
    assert.equal(tags?.product, PRODUCT);
    assert.equal(tags?.slug, "bird-finder", "keeps the other tags");
    assert.ok(written.some((w) => w.path.endsWith("/.env.local")));
  });
});
