/**
 * U6: Muse Image look-alikes (lib/train/sam/distractors.ts) and the photo checks of /photos (lib/train/sam/photo.ts).
 * Meta and Blob are fakes: no call leaves the process, no database. Made-up pictures.
 *
 *   npx tsx --experimental-test-module-mocks --test lib/train/sam/__tests__/distractors.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  LOOKALIKE_BATCH,
  LOOKALIKE_USD,
  lookalikePrompt,
  lookalikeRequest,
  lookalikesToMake,
  makeLookalikes,
  referenceFor,
  type DistractorDeps,
  type LookalikeRequest,
} from "@/lib/train/sam/distractors";
import { checkPhoto, imageDims, splitFor, uploadsProblems } from "@/lib/train/sam/photo";
import { SAM_TUNE_DAY_KEY, SAM_TUNE_LIMITS, samTuneRunKey, type SamDistractor } from "@/lib/train/sam/types";
import { counted, fakeCounters, photos, type FakeCounters } from "./fakes";

const RUN_ID = "00000000-0000-4000-8000-000000000016";
/** A JPEG's first bytes and a SOF0 segment for a 640 x 480 picture: enough for imageType and imageDims. */
function jpeg(width = 640, height = 480): Buffer {
  return Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
}
const B64 = jpeg().toString("base64");

function deps(counters: FakeCounters, draw: DistractorDeps["draw"], room = Infinity) {
  const calls: LookalikeRequest[] = [];
  const saved: SamDistractor[] = [];
  const charged: number[] = [];
  let stored = 0;
  const d: DistractorDeps = {
    ...counters,
    draw: async (req, signal) => {
      calls.push(req);
      return draw(req, signal);
    },
    store: async (_bytes, type) => `https://made-up.public.blob.vercel-storage.com/samtune/${RUN_ID}/lookalikes/l${stored++}.${type.ext}`,
    save: async (x) => {
      if (saved.length >= room) return false;
      saved.push(x);
      return true;
    },
    charge: async (u) => {
      charged.push(u.costUsd);
    },
    log: () => undefined,
    timeoutMs: 1_000,
  };
  return { d, calls, saved, charged };
}

const labeled = () => photos(6).map((p) => ({ ...p, box: [1, 1, 50, 50] as [number, number, number, number] }));
const run = (distractors: SamDistractor[] = []) => ({ id: RUN_ID, generic: "plush toy", photos: labeled(), distractors });
const limits = (runMaxUsd = 1, dailyUsd = 5) => ({ runId: RUN_ID, runMaxUsd, dailyUsd });
const picture = async () => ({ data: [{ b64_json: B64 }] });

describe("Muse Image look-alikes", () => {
  it("draws after a training photo with a box, with search and shell off", () => {
    const ref = referenceFor(labeled(), 0);
    assert.equal(ref, labeled()[0].url);
    const req = lookalikeRequest("plush toy", 0, ref);
    assert.equal(req.path, "/images/edits");
    assert.deepEqual(req.body.images, [{ image_url: ref }]);
    assert.deepEqual(req.body.tool_enablement, { enable_image_search: false, enable_web_search: false, enable_shell: false });
    assert.equal(req.body.model, "muse-image-1.0");
    const plain = lookalikeRequest("plush toy", 1, null);
    assert.equal(plain.path, "/images/generations");
    assert.equal(plain.body.images, undefined);
    assert.equal(referenceFor(photos(3), 0), null, "photos with no box are never a reference");
  });

  it("the prompt quotes the word, asks for a different one, and has no em dashes", () => {
    const p = lookalikePrompt("plush toy", "on a bookshelf", true);
    assert.match(p, /a different "plush toy"/);
    assert.match(p, /on a bookshelf/);
    assert.doesNotMatch(p, /\u2014/);
  });

  it("makes a batch, keeps them, splits them, and the cost adds up", async () => {
    const c = fakeCounters();
    const { d, calls, saved, charged } = deps(c, picture);
    const out = await makeLookalikes(run(), limits(), d, 10);
    assert.equal(calls.length, LOOKALIKE_BATCH);
    assert.equal(out.made.length, LOOKALIKE_BATCH);
    assert.deepEqual(saved.map((s) => [s.source, s.kept, s.split]), [
      ["muse-image", true, "train"],
      ["muse-image", true, "train"],
      ["muse-image", true, "held"],
      ["muse-image", true, "train"],
    ]);
    assert.equal(out.costUsd, 0.04);
    assert.equal(charged.length, 4);
    assert.equal(counted(c, SAM_TUNE_DAY_KEY), 40_000);
    assert.equal(counted(c, samTuneRunKey(RUN_ID)), 40_000);
  });

  it("never past 24 look-alikes", () => {
    const full = Array.from({ length: SAM_TUNE_LIMITS.distractorsMax - 1 }, (_, i) => ({ url: `u${i}`, source: "own" as const, split: "train" as const, kept: true }));
    assert.equal(lookalikesToMake({ distractors: full }, 4), 1);
    assert.equal(lookalikesToMake({ distractors: [...full, full[0]] }, 4), 0);
    assert.equal(lookalikesToMake({ distractors: [] }, Number.NaN), 0);
  });

  it("the run's cap refuses before any call", async () => {
    const c = fakeCounters();
    const { d, calls } = deps(c, picture);
    const out = await makeLookalikes(run(), limits(0.005), d, 4);
    assert.equal(calls.length, 0);
    assert.equal(out.refused, "run_cap");
    assert.equal(counted(c, SAM_TUNE_DAY_KEY), 0);
  });

  it("SAM_TUNE_DAILY_USD stops a batch part way: two fit in $0.02", async () => {
    const c = fakeCounters();
    const { d, calls } = deps(c, picture);
    const out = await makeLookalikes(run(), limits(1, 0.02), d, 4);
    assert.equal(calls.length, 2);
    assert.equal(out.made.length, 2);
    assert.equal(out.refused, "daily_cap");
    assert.equal(out.costUsd, 0.02);
  });

  it("the platform's daily cap refuses before any call", async () => {
    const c = fakeCounters();
    c.platformOk = false;
    const { d, calls } = deps(c, picture);
    const out = await makeLookalikes(run(), limits(), d, 4);
    assert.equal(calls.length, 0);
    assert.equal(out.refused, "platform_cap");
  });

  it("a refusal or an empty reply costs nothing; a timed-out call stays spent", async () => {
    const c = fakeCounters();
    let n = 0;
    const { d, charged } = deps(c, async () => {
      n += 1;
      if (n === 1) throw Object.assign(new Error("blocked"), { code: "content_policy_violation" });
      return { data: [] };
    });
    const out = await makeLookalikes(run(), limits(), d, 2);
    assert.deepEqual(out.skipped, ["refused", "empty"]);
    assert.equal(out.costUsd, 0);
    assert.deepEqual(charged, []);
    assert.equal(counted(c, SAM_TUNE_DAY_KEY), 0);

    const c2 = fakeCounters();
    const slow = deps(c2, (_req, signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))));
    slow.d.timeoutMs = 5;
    const late = await makeLookalikes(run(), limits(), slow.d, 1);
    assert.deepEqual(late.skipped, ["timeout"]);
    assert.equal(late.costUsd, LOOKALIKE_USD);
    assert.equal(counted(c2, SAM_TUNE_DAY_KEY), 10_000);
  });

  it("stops when the run fills up or was started meanwhile", async () => {
    const c = fakeCounters();
    const { d, calls } = deps(c, picture, 1);
    const out = await makeLookalikes(run(), limits(), d, 4);
    assert.equal(out.made.length, 1);
    assert.deepEqual(out.skipped, ["full"]);
    assert.equal(calls.length, 2);
  });
});

describe("the person's photos", () => {
  it("reads a JPEG's size from its own header", () => {
    assert.deepEqual(imageDims(jpeg(800, 600), "image/jpeg"), { width: 800, height: 600 });
    const ok = checkPhoto(`data:image/jpeg;base64,${B64}`);
    assert.ok(!("problem" in ok));
    assert.equal(ok.width, 640);
  });

  it("refuses what can't be used", () => {
    assert.deepEqual(checkPhoto("not base64!"), { problem: "not_base64" });
    assert.deepEqual(checkPhoto(Buffer.from("hello there").toString("base64")), { problem: "not_image" });
    assert.deepEqual(checkPhoto(jpeg(2000, 1000).toString("base64")), { problem: "too_wide" });
    assert.deepEqual(checkPhoto(B64, 4), { problem: "too_large" });
  });

  it("every third is held out, and Start's needs are listed", () => {
    assert.deepEqual([0, 1, 2, 3, 4, 5].map(splitFor), ["train", "train", "held", "train", "train", "held"]);
    const problems = uploadsProblems(photos(3), []);
    assert.ok(problems.some((p) => /no box yet/.test(p)));
    assert.ok(problems.some((p) => /at least 16 look-alikes/.test(p)));
    const ready = photos(12).map((p) => ({ ...p, box: [1, 1, 9, 9] as [number, number, number, number] }));
    const kept = Array.from({ length: 16 }, (_, i) => ({ url: `u${i}`, source: "muse-image" as const, split: "train" as const, kept: true }));
    assert.deepEqual(uploadsProblems(ready, kept), []);
  });
});
