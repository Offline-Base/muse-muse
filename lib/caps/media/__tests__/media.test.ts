/**
 * The media cap (docs/CAPABILITIES.md, section 14): its brief block and the part flags, the writer's rules, the catalog
 * and the two workaround lines it replaces, the build prompt's section, the judge's note, the env a build and a deploy
 * get, the overlays, the limits and the vetted asset list against the template's copies, and the assets route's hash
 * allowlist, rate limit, redirect and local copy.
 *   npx tsx --test lib/caps/media/__tests__/media.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, afterEach, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { briefToMarkdown, renderBuildPrompt } from "@/lib/brief/render";
import { normalizeRawBrief } from "@/lib/brief/normalize";
import { BriefSchema, newBriefSchemaFor, type Brief } from "@/lib/brief/schema";
import { capsWriterRules } from "@/lib/caps/brief-fields";
import { capsCatalogBlocks, capsWorkaround, howProductsRun } from "@/lib/caps/catalog";
import { capBuildEnv, capDeployEnv } from "@/lib/caps/env";
import { capBuildHosts } from "@/lib/caps/hosts";
import { capsJudgeNotes } from "@/lib/caps/judge";
import { ASSETS_PER_MINUTE, handleAsset, vettedAssets, type AssetsDeps, type VettedAsset } from "@/lib/caps/media/assets";
import { MediaBriefBlock, mediaWriterRules, normalizeMediaBlock, type MediaBrief } from "@/lib/caps/media/brief";
import { mediaCatalog, mediaWorkarounds } from "@/lib/caps/media/catalog";
import { MEDIA_LIMITS, samPhotoCostUsd, samVideoCostUsd } from "@/lib/caps/media/limits";
import { capsFileFor, overlaysFor } from "@/lib/caps/overlays";
import { capsBuildLines, capsMarkdown, capsRefineLines } from "@/lib/caps/render";
import { catalogSummary } from "@/lib/prompts/catalog";
import { allowedModelsFor } from "@/lib/pipeline/logic";
import { BRIEF } from "@/lib/promote/__tests__/fixtures";

const TEMPLATE = path.join(import.meta.dirname, "../../../../template");
const ALL: MediaBrief = { why: "Turns comic panels into a short video with a tune.", video: true, music: true, samTiling: true };
const VIDEO: MediaBrief = { why: "Turns four photos into a slideshow video.", video: true, music: false, samTiling: false };
const withMedia = (media: MediaBrief) => ({ ...BRIEF, media }) as Brief;
const render = { inspoFiles: [], fixtures: [], maxModelSteps: 40 };
const PART_FLAGS = ["MEDIA_SPEECH", "MEDIA_VIDEO", "MEDIA_MUSIC", "MEDIA_SAM_TILING"];

afterEach(() => {
  for (const f of PART_FLAGS) delete process.env[f];
});

describe("the media brief block", () => {
  it("is an optional field of the stored brief, and in the writer's schema only when the cap is on", () => {
    assert.deepEqual(BriefSchema.parse(withMedia(ALL)).media, ALL);
    assert.equal(BriefSchema.parse(BRIEF).media, undefined);
    const on = newBriefSchemaFor({ gadgets: false, targets: [], caps: ["media"] });
    assert.equal(on.safeParse(BRIEF).success, false);
    assert.equal(on.safeParse({ ...BRIEF, media: null }).success, true);
    assert.equal(on.safeParse(withMedia(VIDEO)).success, true);
    assert.equal(MediaBriefBlock.safeParse({ ...VIDEO, why: "" }).success, false);
    assert.equal(MediaBriefBlock.safeParse({ ...VIDEO, video: "yes" }).success, false);
  });

  it("is cleaned before zod: string booleans, missing parts false, parts whose flag is off false, and null with none left", () => {
    assert.deepEqual(normalizeMediaBlock({ why: " A video ", video: "true", speech: "no" }, ["video"]), { why: "A video", video: true, music: false, samTiling: false });
    assert.equal(normalizeMediaBlock({ ...ALL, video: true }, []), null);
    assert.deepEqual(normalizeMediaBlock(ALL, ["music"]), { ...ALL, video: false, samTiling: false });
    // An old brief's speech part is dropped: SpeechT5 isn't a Meta model (the Nov 2 ruling).
    assert.equal(normalizeMediaBlock({ why: "x", speech: true, video: false, music: false, samTiling: false }, ["video", "music", "samTiling"]), null);
    assert.ok(((normalizeMediaBlock({ ...VIDEO, why: "x".repeat(300) }, ["video"]) as MediaBrief).why.length) <= 200);
    // Through normalizeRawBrief, the part flags come from the env.
    process.env.MEDIA_VIDEO = "1";
    const kept = normalizeRawBrief({ ...BRIEF, media: { ...ALL } }, []) as { media: MediaBrief };
    assert.deepEqual(kept.media, { ...ALL, music: false, samTiling: false });
    delete process.env.MEDIA_VIDEO;
    assert.equal((normalizeRawBrief({ ...BRIEF, media: { ...ALL } }, []) as { media: unknown }).media, null);
  });
});

describe("the writer's rules, catalog and judge note", () => {
  it("name only the parts whose flags are on", () => {
    assert.deepEqual(mediaWriterRules([]), []);
    const one = mediaWriterRules(["video"]).join("\n");
    assert.match(one, /media\.video: true when the product turns pictures into a short video/);
    assert.match(one, /Only media\.video can be true here/);
    assert.doesNotMatch(one, /media\.speech:/);
    const all = mediaWriterRules(["video", "music", "samTiling"]).join("\n");
    assert.doesNotMatch(all, /can be true here/);
    assert.doesNotMatch(all, /media\.speech|SpeechT5|reads text aloud/);
    for (const p of ["video", "music", "samTiling"]) assert.match(all, new RegExp(`media\\.${p}: true when`));
    process.env.MEDIA_MUSIC = "1";
    assert.match(capsWriterRules(["media"]), /media\.music: true when/);
    assert.doesNotMatch(capsWriterRules(["media"]), /media\.speech: true/);
    delete process.env.MEDIA_MUSIC;
    assert.equal(capsWriterRules(["media"]), "");
  });

  it("gives a catalog block and a How products run name for the parts on", () => {
    const c = mediaCatalog(["video", "samTiling"]);
    assert.equal(c.name, "media made in the browser (video from pictures and SAM counts past 16 objects)");
    assert.doesNotMatch(c.block, /SpeechT5|speech/i);
    assert.match(c.block, /up to 16 overlapping tiles/);
    assert.doesNotMatch(c.block, /MIDI/);
    process.env.MEDIA_VIDEO = "1";
    assert.match(capsCatalogBlocks(["media"]).join("\n"), /video: up to 120 pictures/);
    assert.match(howProductsRun(["media", "runtime"], { gadgets: false })!.first, /add media made in the browser \(video from pictures\) and small Python functions/);
  });

  it("replaces the video workaround only while its part is on, and never offers a speech model", () => {
    assert.deepEqual(mediaWorkarounds([]), {});
    assert.deepEqual(Object.keys(mediaWorkarounds(["video", "music"])), ["video"]);
    assert.equal(capsWorkaround([], "speech"), null);
    // MEDIA_SPEECH turns nothing on: SpeechT5 isn't a Meta model (the Nov 2 ruling).
    process.env.MEDIA_SPEECH = "1";
    assert.equal(capsWorkaround(["media"], "speech"), null);
    assert.equal(capsWorkaround(["media"], "video"), null);
    assert.equal(capsWriterRules(["media"]), "");
    const summary = catalogSummary(["media"]);
    assert.match(summary, /- Text-to-speech: the browser's built-in speech synthesis\./);
    assert.doesNotMatch(summary, /SpeechT5|open speech model/);
    assert.match(summary, /- Video generation: a short image sequence from muse-image-1.0\./);
    assert.doesNotMatch(catalogSummary([]), /media service/);
  });

  it("has a judge note that expects plain media, and mentions tiles only with tiling", () => {
    assert.match(capsJudgeNotes(withMedia(VIDEO)), /Video and audio made in the browser may look and sound plain in this test\./);
    assert.doesNotMatch(capsJudgeNotes(withMedia(VIDEO)), /tiles/);
    assert.match(capsJudgeNotes(withMedia(ALL)), /at most 4 tiles/);
  });

  it("has no em dash anywhere a person or Muse Code reads", () => {
    const texts = [
      mediaWriterRules(["video", "music", "samTiling"]).join("\n"),
      mediaCatalog(["video", "music", "samTiling"]).block,
      Object.values(mediaWorkarounds(["video"])).join("\n"),
      capsBuildLines(withMedia(ALL)).join("\n"),
      capsJudgeNotes(withMedia(ALL)),
    ];
    for (const t of texts) assert.ok(!t.includes("—"));
  });
});

describe("the build prompt", () => {
  it("has a Media in the browser section with the parts line, the skill, each part's helpers, privacy, limits and smoke rules", () => {
    const lines = capsBuildLines(withMedia(ALL)).join("\n");
    assert.match(lines, /^\n## Platform services\n\n### Media in the browser\n\nThe brief asks for videos made from pictures, music as MIDI, counting past 16 objects with SAM: /);
    assert.doesNotMatch(lines, /speak\(text\)|SpeechT5|expectSpeech|the speech model/);
    assert.match(lines, /Every model the product calls is a Meta model through the Muse Muse gateway/);
    for (const want of [
      "- Media parts: video, music, samTiling",
      ".agents/skills/muse-media/SKILL.md",
      "imagesToVideo(frames, { fps })",
      "toMidi(notes, { bpm })",
      "findAll(image, phrase, { tiles, segment })",
      "samBoxes(request, tile, phrase)",
      "videoChunks(file)",
      "expectVideoPlays",
      "expectMidi",
      "expectTiles",
      "/notices/media.txt",
      "`template/AGENTS.md` says the build machine reaches only npm",
    ]) {
      assert.ok(lines.includes(want), want);
    }
    const video = capsBuildLines(withMedia(VIDEO)).join("\n");
    assert.match(video, /- Media parts: video\n/);
    assert.doesNotMatch(video, /speak\(text\)|samBoxes|toMidi/);
    assert.ok(renderBuildPrompt(withMedia(VIDEO), render).includes("### Media in the browser"));
    assert.match(capsRefineLines(withMedia(VIDEO)).join("\n"), /videos made from pictures/);
    assert.match(capsMarkdown(withMedia(VIDEO)).join("\n"), /\*\*Media in the browser\*\*[\s\S]*- Videos made from pictures/);
    assert.ok(briefToMarkdown(withMedia(VIDEO)).includes("Media in the browser"));
  });

  it("orders the media section before runtime's, in plan order", () => {
    const both = { ...withMedia(VIDEO), runtime: { why: "Exact math.", functions: [{ name: "stats", does: "Sums a list." }], packages: [] } } as unknown as Brief;
    const lines = capsBuildLines(both).join("\n");
    assert.ok(lines.indexOf("### Media in the browser") < lines.indexOf("### Python"), lines.slice(0, 200));
  });
});

describe("the build sandbox", () => {
  it("gets core and the media overlay, the assets URL, and no extra hosts", () => {
    assert.deepEqual(overlaysFor(withMedia(VIDEO)), ["core", "media"]);
    assert.deepEqual(capsFileFor(withMedia(VIDEO)), { caps: ["media"], overlays: ["core", "media"] });
    const build = capBuildEnv(withMedia(VIDEO));
    assert.match(build, /^NEXT_PUBLIC_MUSEMUSE_ASSETS_URL=http.+\/api\/gateway\/assets\nNEXT_PUBLIC_MUSEMUSE_MEDIA_SMOKE=1\n$/);
    const deploy = capDeployEnv(withMedia(VIDEO), "mm_live_x");
    assert.deepEqual(Object.keys(deploy), ["NEXT_PUBLIC_MUSEMUSE_ASSETS_URL"]);
    assert.ok(!JSON.stringify(deploy).includes("mm_live_x"), "the live token never goes to the page");
    assert.deepEqual(capBuildHosts(["media"]), []);
    assert.ok(allowedModelsFor(withMedia(VIDEO)).includes("cap:media"));
  });
});

describe("the limits and the asset list", () => {
  it("match the template's platform files", async () => {
    const tiles = readFileSync(path.join(TEMPLATE, "caps/media/files/lib/platform/sam-tiles.ts"), "utf8");
    const num = (name: string, text: string) => Number(text.match(new RegExp(`export const ${name} = ([\\d_]+);`))?.[1]?.replace(/_/g, ""));
    assert.equal(num("SAM_OBJECTS_PER_CALL", tiles), MEDIA_LIMITS.samObjectsPerCall);
    assert.equal(num("SAM_TILES_MAX", tiles), MEDIA_LIMITS.samTilesMax);
    assert.equal(num("SAM_TILES_SMOKE", tiles), MEDIA_LIMITS.samTilesSmoke);
    assert.equal(num("SAM_VIDEO_FRAMES_MAX", tiles), MEDIA_LIMITS.samVideoFramesMax);
    assert.equal(num("SAM_CHUNK_FRAMES", tiles), MEDIA_LIMITS.samChunkFramesMax);
    assert.equal(num("SAM_SAMPLE_FPS", tiles), MEDIA_LIMITS.samSampleFps);
    const video = readFileSync(path.join(TEMPLATE, "caps/media/files/lib/platform/video.ts"), "utf8");
    assert.equal(num("VIDEO_FRAMES_MAX", video), MEDIA_LIMITS.videoFramesMax);
    assert.equal(num("VIDEO_SIDE_MAX", video), MEDIA_LIMITS.videoSideMax);
    assert.equal(num("SPEECH_CHARS_MAX", readFileSync(path.join(TEMPLATE, "caps/media/files/lib/platform/speech.ts"), "utf8")), MEDIA_LIMITS.speechCharsMax);
    assert.equal(num("NOTES_MAX", readFileSync(path.join(TEMPLATE, "caps/media/files/lib/platform/midi.ts"), "utf8")), MEDIA_LIMITS.notesMax);
    // SAM's price, from lib/meta/pricing.ts, is what the template's copy says.
    assert.match(tiles, /perImage: 0\.0025, perVideoFrame: 0\.0002, minVideoFrames: 50/);
    assert.equal(samPhotoCostUsd(16), 0.04);
    assert.equal(+samVideoCostUsd([300, 300, 300]).toFixed(4), 0.18);
    assert.equal(+samVideoCostUsd([10]).toFixed(4), 0.01, "a clip is billed for at least 50 frames");
  });

  it("serves none of the speech helper's files, so no SpeechT5 model reaches a product's page", async () => {
    const assets = vettedAssets();
    assert.deepEqual(assets, [], "the list is empty since the Nov 2 ruling");
    const T = (await import(pathToFileURL(path.join(TEMPLATE, "caps/media/files/lib/platform/media-assets.ts")).href)) as { MEDIA_ASSETS: Array<{ name: string; bytes: number; sha256: string }> };
    for (const a of T.MEDIA_ASSETS) assert.ok(!(assets as Array<{ sha256: string }>).some((x) => x.sha256 === a.sha256), `${a.name} isn't served`);
  });

  it("refuses model weights in the list: every model a product calls is Meta's, through the gateway's API", () => {
    const good = { name: "x/y.bin", cap: "media", bytes: 3, sha256: "a".repeat(64), contentType: "application/octet-stream", license: "MIT", source: "https://example.invalid/y.bin", mirror: null };
    for (const name of ["speecht5_tts/encoder_model_quantized.onnx", "x/model.tflite", "x/model.safetensors", "x/m.gguf"]) {
      assert.throws(() => vettedAssets({ version: 1, assets: [{ ...good, name }] }), /model weights/, name);
    }
  });

  it("refuses a list with a bad entry", () => {
    const good = { name: "x/y.bin", cap: "media", bytes: 3, sha256: "a".repeat(64), contentType: "application/octet-stream", license: "MIT", source: "https://example.invalid/y.bin", mirror: null };
    assert.equal(vettedAssets({ version: 1, assets: [good] }).length, 1);
    for (const [bad, why] of [
      [{ ...good, sha256: "nope" }, /no sha256/],
      [{ ...good, license: "GPL-3.0" }, /permissive list/],
      [{ ...good, license: "CC-BY-NC-4.0" }, /permissive list/],
      [{ ...good, source: "http://x" }, /https source/],
      [{ ...good, name: "../x" }, /plain name/],
      [{ ...good, mirror: "http://blob" }, /mirror/],
    ] as const) {
      assert.throws(() => vettedAssets({ version: 1, assets: [bad] }), why);
    }
    assert.throws(() => vettedAssets({ version: 1, assets: [good, good] }), /twice/);
    assert.throws(() => vettedAssets({ version: 2, assets: [] }), /version 1/);
  });
});

describe("GET {GATEWAY_URL}/assets/<sha256>", () => {
  const SHA = "b".repeat(64);
  const asset = (over: Partial<VettedAsset> = {}): VettedAsset => ({ name: "speecht5_tts/x.onnx", cap: "media", bytes: 5, sha256: SHA, contentType: "application/octet-stream", license: "MIT", source: "https://example.invalid/x.onnx", mirror: "https://store.public.blob.vercel-storage.com/assets/" + SHA, ...over });
  const NOW = new Date("2026-11-02T12:00:30Z");
  let hits = 0;
  let keys: string[] = [];
  const deps = (over: Partial<AssetsDeps> = {}): AssetsDeps => ({
    enabledCaps: () => ["media"],
    hitRateLimits: async (k, windowStart) => {
      keys = k;
      assert.equal(windowStart.toISOString(), "2026-11-02T12:00:00.000Z");
      return Object.fromEntries(k.map((x) => [x, ++hits]));
    },
    assets: [asset()],
    now: () => NOW,
    ...over,
  });
  const get = (method = "GET", headers: Record<string, string> = { "x-real-ip": "203.0.113.9" }) => new Request(`https://platform.example/api/gateway/assets/${SHA}`, { method, headers });
  const dirs: string[] = [];
  after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

  it("answers 404 unknown_endpoint and touches nothing while no cap that lists files is on", async () => {
    const res = await handleAsset(get(), SHA, deps({ enabledCaps: () => ["runtime"], hitRateLimits: async () => assert.fail("rate limits read") }));
    assert.equal(res.status, 404);
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, "unknown_endpoint");
  });

  it("redirects a listed file to its mirror, readable from any origin, rate limited per address", async () => {
    hits = 0;
    const res = await handleAsset(get(), SHA, deps());
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), asset().mirror);
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
    assert.equal(res.headers.get("cross-origin-resource-policy"), "cross-origin");
    assert.equal(res.headers.get("x-content-sha256"), SHA);
    assert.equal(res.headers.get("cache-control"), "public, max-age=3600", "an hour, so a switched-off cap stops redirecting soon");
    assert.deepEqual(keys, [`assets:ip:203.0.113.9:${SHA.slice(0, 16)}`]);
    hits = ASSETS_PER_MINUTE;
    const limited = await handleAsset(get(), SHA, deps());
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get("access-control-allow-origin"), "*");
    hits = 0;
  });

  it("counts each file on its own, so 30 page loads of a 5-file model from one school address all get through", async () => {
    const files = ["1", "2", "3", "4", "5"].map((d) => asset({ sha256: d.repeat(64), mirror: `https://store.public.blob.vercel-storage.com/assets/${d.repeat(64)}` }));
    const counts = new Map<string, number>();
    const counting = deps({ assets: files, hitRateLimits: async (k) => Object.fromEntries(k.map((x) => [x, counts.set(x, (counts.get(x) ?? 0) + 1).get(x)!])) });
    const statuses: number[] = [];
    for (let load = 0; load < 30; load++) {
      for (const f of files) statuses.push((await handleAsset(new Request(`https://platform.example/api/gateway/assets/${f.sha256}`, { headers: { "x-real-ip": "198.51.100.7" } }), f.sha256, counting)).status);
    }
    assert.equal(statuses.length, 150);
    assert.ok(statuses.every((s) => s === 302), "150 requests a minute, 30 of each file, none refused");
    assert.equal(counts.size, 5);
    // The limit still holds for one file.
    for (let i = 0; i < ASSETS_PER_MINUTE; i++) await handleAsset(new Request(`https://platform.example/api/gateway/assets/${files[0]!.sha256}`, { headers: { "x-real-ip": "198.51.100.7" } }), files[0]!.sha256, counting);
    assert.equal((await handleAsset(new Request(`https://platform.example/api/gateway/assets/${files[0]!.sha256}`, { headers: { "x-real-ip": "198.51.100.7" } }), files[0]!.sha256, counting)).status, 429);
  });

  it("serves only hashes on the list, of a cap that is on", async () => {
    for (const sha of ["c".repeat(64), "B".repeat(64), "../../etc/passwd", SHA.slice(1)]) {
      const res = await handleAsset(get(), sha, deps());
      assert.equal(res.status, 404, sha);
      assert.equal(((await res.json()) as { error: { code: string } }).error.code, "asset_not_found");
    }
    const codeOnly = await handleAsset(get(), SHA, deps({ assets: [asset({ cap: "code" }), asset({ sha256: "d".repeat(64) })] }));
    assert.equal(codeOnly.status, 404, "a code file isn't served while only media is on");
  });

  it("answers 503 for a listed file not mirrored yet, 405 to a POST, and 204 to a preflight", async () => {
    const res = await handleAsset(get(), SHA, deps({ assets: [asset({ mirror: null })] }));
    assert.equal(res.status, 503);
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, "asset_unavailable");
    assert.equal((await handleAsset(get("POST"), SHA, deps())).status, 405);
    const pre = await handleAsset(get("OPTIONS"), SHA, deps());
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get("access-control-allow-methods"), "GET, HEAD");
  });

  it("streams the local copy on a local run, when its size matches", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mm-assets-"));
    dirs.push(dir);
    const file = path.join(dir, SHA);
    writeFileSync(file, "hello");
    const res = await handleAsset(get(), SHA, deps({ localPath: () => file, assets: [asset({ mirror: null })] }));
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "hello");
    assert.equal(res.headers.get("content-length"), "5");
    assert.match(res.headers.get("cache-control")!, /immutable/);
    const head = await handleAsset(get("HEAD"), SHA, deps({ localPath: () => file }));
    assert.equal(head.status, 200);
    writeFileSync(file, "hello, longer");
    const wrong = await handleAsset(get(), SHA, deps({ localPath: () => file, assets: [asset({ mirror: null })] }));
    assert.equal(wrong.status, 503, "a local copy of the wrong size isn't served");
  });
});

describe("the build firewall", () => {
  it("opens no host for media until the files are mirrored, then the mirror's host only", async () => {
    const { mediaMirrorHosts } = await import("@/lib/caps/media/hosts");
    assert.deepEqual(mediaMirrorHosts(), [], "nothing is mirrored in the committed list yet");
    assert.deepEqual(capBuildHosts(["media"]), []);
    const mirrored = { assets: [
      { cap: "media", mirror: "https://abc.public.blob.vercel-storage.com/assets/1" },
      { cap: "media", mirror: "https://abc.public.blob.vercel-storage.com/assets/2" },
      { cap: "code", mirror: "https://other.example/x" },
      { cap: "media", mirror: "http://plain.example/x" },
      { cap: "media", mirror: null },
    ] };
    assert.deepEqual(mediaMirrorHosts(mirrored, undefined), ["abc.public.blob.vercel-storage.com"]);
  });

  it("opens only a Vercel Blob public store, and only the platform's own when its id is known", async () => {
    const { mediaMirrorHosts, ownBlobHost } = await import("@/lib/caps/media/hosts");
    const at = (...mirrors: string[]) => ({ assets: mirrors.map((mirror) => ({ cap: "media", mirror })) });
    for (const bad of [
      "https://evil.example/assets/1",
      "https://abc.public.blob.vercel-storage.com.evil.example/assets/1",
      "https://a.b.public.blob.vercel-storage.com/assets/1",
      "https://abc.blob.vercel-storage.com/assets/1",
      "https://user:pw@abc.public.blob.vercel-storage.com/assets/1",
      "https://abc.public.blob.vercel-storage.com:8443/assets/1",
      "http://abc.public.blob.vercel-storage.com/assets/1",
    ]) {
      assert.deepEqual(mediaMirrorHosts(at(bad), undefined), [], bad);
    }
    assert.equal(ownBlobHost("store_AbC123"), "abc123.public.blob.vercel-storage.com");
    assert.equal(ownBlobHost(undefined), null);
    assert.deepEqual(mediaMirrorHosts(at("https://abc123.public.blob.vercel-storage.com/assets/1"), "store_AbC123"), ["abc123.public.blob.vercel-storage.com"]);
    assert.deepEqual(mediaMirrorHosts(at("https://other9.public.blob.vercel-storage.com/assets/1"), "store_AbC123"), [], "another Blob store");
  });
});
