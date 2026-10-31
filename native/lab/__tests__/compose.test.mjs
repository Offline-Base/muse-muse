import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { captionLines, composeArgs, composeClip, drawtextFilter, filterPath, MAX_CLIP_SECONDS, posterArgs } from "../compose.mjs";
import { CANVAS, layoutFor, renderFrameLayer } from "../lib/frames.mjs";
import { isBlankScreen, screenStats } from "../lib/pixels.mjs";

const HAS_FFMPEG = spawnSync("ffmpeg", ["-version"]).status === 0;

describe("layoutFor", () => {
  test("a phone recording fits the canvas above the caption, in the middle", () => {
    const { screen, body } = layoutFor("phone", 1080, 2400);
    assert.ok(body.y + body.h <= 930, "clears the caption");
    assert.equal(body.x + body.w / 2, CANVAS.w / 2);
    assert.equal(screen.w % 2, 0);
    assert.equal(screen.h % 2, 0);
    assert.ok(Math.abs(screen.w / screen.h - 1080 / 2400) < 0.01);
  });
  test("a desktop recording stays wide, and clears the caption", () => {
    const { screen, body } = layoutFor("desktop", 1280, 800);
    assert.ok(screen.w > screen.h);
    assert.ok(body.y + body.h <= 930);
    assert.ok(screen.w <= 1500);
  });
  test("an unknown size still lays out", () => {
    assert.ok(layoutFor("phone", 0, 0).screen.w > 0);
  });
});

describe("renderFrameLayer", () => {
  const layout = layoutFor("phone", 1080, 2400);
  const layer = renderFrameLayer(layout);
  const pixel = (x, y) => [...layer.subarray((y * CANVAS.w + x) * 4, (y * CANVAS.w + x) * 4 + 4)];
  test("it's one full RGBA canvas", () => assert.equal(layer.length, CANVAS.w * CANVAS.h * 4));
  test("the backdrop is opaque Meta blue", () => {
    const [r, g, b, a] = pixel(60, 1040);
    assert.equal(a, 255);
    assert.ok(b > 150 && b > g && g > r, `${r},${g},${b}`);
  });
  test("the screen is a hole", () => {
    assert.equal(pixel(layout.screen.x + layout.screen.w / 2, layout.screen.y + layout.screen.h / 2)[3], 0);
  });
  test("the body is opaque and dark", () => {
    const [r, , , a] = pixel(layout.body.x + 6, layout.body.y + layout.body.h / 2);
    assert.equal(a, 255);
    assert.ok(r < 90);
  });
});

describe("filter text", () => {
  test("filterPath escapes what a filter graph treats as syntax", () => {
    assert.equal(filterPath("C:\\Muse Lab\\a'b.ttf"), "C\\:/Muse Lab/a\\'b.ttf");
  });
  test("drawtext reads the words from a file with expansion off", () => {
    const filter = drawtextFilter({ textFile: "/t/c.txt", font: "/f/i.ttf", size: 42, y: 954, alpha: 1 });
    assert.match(filter, /textfile='\/t\/c\.txt'/);
    assert.match(filter, /expansion=none/);
    assert.ok(!filter.includes(" text="));
  });
  test("captionLines has one line or two", () => {
    assert.equal(captionLines("a", "").length, 1);
    assert.deepEqual(captionLines("a", "b").map((l) => l.text), ["a", "b"]);
  });
});

describe("composeArgs", () => {
  const base = { ffmpeg: "ffmpeg", recording: "r.mp4", frameLayer: "f.rgba", screen: { x: 700, y: 50, w: 400, h: 860 }, out: "o.mp4" };
  test("clip length, canvas size and color tags", () => {
    const argv = composeArgs(base);
    assert.equal(argv[argv.indexOf("-t") + 1], String(MAX_CLIP_SECONDS));
    assert.ok(argv.includes(`${CANVAS.w}x${CANVAS.h}`));
    assert.equal(argv[argv.indexOf("-colorspace") + 1], "bt709");
    assert.ok(argv.includes("+faststart"));
    assert.ok(argv.includes("-an"));
    assert.match(argv[argv.indexOf("-filter_complex") + 1], /overlay=700:50/);
  });
  test("a caption PNG is a third input", () => {
    const argv = composeArgs({ ...base, captionPng: "c.png" });
    assert.equal(argv.filter((a) => a === "-i").length, 3);
    assert.match(argv[argv.indexOf("-filter_complex") + 1], /\[2:v\]overlay/);
  });
  test("posterArgs takes a frame near the end", () => {
    const argv = posterArgs({ ffmpeg: "ffmpeg", clip: "c.mp4", seconds: 10, out: "p.jpg" });
    assert.equal(argv[argv.indexOf("-ss") + 1], "8.50");
    assert.equal(posterArgs({ ffmpeg: "ffmpeg", clip: "c.mp4", seconds: null, out: "p.jpg" }).includes("0.00"), true);
  });
});

describe("composeClip with the real ffmpeg", { skip: !HAS_FFMPEG }, () => {
  test("makes a 1920x1080 clip under its size limit, and a poster that isn't blank", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mm-compose-"));
    try {
      const recording = path.join(dir, "in.mp4");
      execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=540x1200:r=30:d=3", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", recording]);
      const result = await composeClip({ recording, outDir: path.join(dir, "out"), form: "phone", caption: "On an Android emulator", note: "A note" });
      assert.ok(existsSync(result.clip));
      assert.ok(statSync(result.clip).size < 12 * 1024 * 1024);
      assert.ok(existsSync(result.poster));
      const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,pix_fmt,color_space", "-of", "json", result.clip]));
      assert.equal(probe.streams[0].width, 1920);
      assert.equal(probe.streams[0].height, 1080);
      assert.equal(probe.streams[0].pix_fmt, "yuv420p");
      assert.equal(probe.streams[0].color_space, "bt709");
      if (process.platform === "darwin") assert.equal(result.captionBurned, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the blank check", () => {
  const flat = (v, n = 128 * 256) => new Uint8Array(n).fill(v);
  test("one flat color is blank at any text length", () => {
    const stats = screenStats(flat(250), 128, 256);
    assert.equal(stats.stddev, 0);
    assert.equal(isBlankScreen(stats, 0), true);
    assert.equal(isBlankScreen(stats, 500), true);
  });
  test("a nearly flat page is blank only with almost no text", () => {
    const gray = flat(250);
    for (let i = 0; i < 180; i++) gray[i * 40] = 10;
    const stats = screenStats(gray, 128, 256);
    assert.ok(stats.dominantShare > 0.985);
    assert.equal(isBlankScreen(stats, 3), true);
    assert.equal(isBlankScreen(stats, 400), false);
  });
  test("a busy canvas with no text isn't blank", () => {
    const gray = flat(0).map((_, i) => (i * 7) % 256);
    assert.equal(isBlankScreen(screenStats(gray, 128, 256), 0), false);
  });
  test("the crop keeps a status bar out of the count", () => {
    const gray = flat(255);
    gray.fill(0, 0, 128 * 20);
    assert.ok(screenStats(gray, 128, 256).stddev > 50);
    assert.equal(screenStats(gray, 128, 256, { top: 0.08 }).stddev, 0);
  });
  test("with no pixels it goes on the text, and with nothing it can't say", () => {
    assert.equal(isBlankScreen(null, 0), true);
    assert.equal(isBlankScreen(null, 50), false);
    assert.equal(isBlankScreen(null, null), null);
  });
});
