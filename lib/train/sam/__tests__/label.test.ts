/**
 * U6: hosted SAM 3.1 first boxes for the person's own photos (lib/train/sam/label.ts) and the caps every paid look is
 * held to (lib/train/sam/spend.ts). Meta is a fake: no call leaves the process, no database, no Blob. Made-up photos.
 *
 *   npx tsx --experimental-test-module-mocks --test lib/train/sam/__tests__/label.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { boxesOf, cocoBox, LABEL_PHOTO_USD, labelPhotos, labelRequest, personBox, type LabelDeps } from "@/lib/train/sam/label";
import { holdSpend, micros, refusalText, runCapUsd, utcDay } from "@/lib/train/sam/spend";
import { SAM_TUNE_DAY_KEY, samTuneRunKey, type SamPhoto } from "@/lib/train/sam/types";
import { counted, fakeCounters, photos, samReply, type FakeCounters } from "./fakes";

const RUN_ID = "00000000-0000-4000-8000-000000000006";

function deps(counters: FakeCounters, segment: LabelDeps["segment"]) {
  const calls: unknown[] = [];
  const saved: Array<{ url: string; box: unknown; skipped: boolean }> = [];
  const charged: number[] = [];
  const d: LabelDeps = {
    ...counters,
    segment: async (body, signal) => {
      calls.push(body);
      return segment(body, signal);
    },
    savePhoto: async (url, patch) => {
      saved.push({ url, ...patch });
    },
    charge: async (u) => {
      charged.push(u.costUsd);
    },
    log: () => undefined,
    timeoutMs: 1_000,
  };
  return { d, calls, saved, charged };
}

const run = (p: SamPhoto[]) => ({ id: RUN_ID, generic: "plush toy", photos: p });
const limits = (runMaxUsd = 1, dailyUsd = 5) => ({ runId: RUN_ID, runMaxUsd, dailyUsd });

describe("SAM 3.1 first boxes", () => {
  it("asks the everyday word, not streamed, boxes with confidence", () => {
    const body = labelRequest("plush toy", "https://made-up.example/p.jpg") as Record<string, unknown>;
    assert.equal(body.model, "sam-3.1");
    assert.equal(body.stream, undefined);
    assert.deepEqual(body.metadata, { mask_encoding: "one_bit", include_confidence: "true" });
    assert.match(JSON.stringify(body.input), /plush toy/);
  });

  it("reads boxes best first, as COCO [x, y, w, h]", () => {
    const boxes = boxesOf(samReply());
    assert.equal(boxes.length, 2);
    assert.deepEqual(boxes[0], { box: [10, 20, 100, 200], confidence: 0.91 });
    assert.deepEqual(boxes[1].box, [300, 300, 40, 40]);
    assert.deepEqual(cocoBox({ x1: 5, y1: 5, x2: 2000, y2: 2000, w: 640, h: 480 }), [5, 5, 635, 475]);
  });

  it("labels a batch, saves the best box, and the cost adds up", async () => {
    const c = fakeCounters();
    const { d, calls, saved, charged } = deps(c, async () => samReply());
    const out = await labelPhotos(run(photos(8)), limits(), d, 6);
    assert.equal(calls.length, 6);
    assert.equal(out.labeled.length, 6);
    assert.equal(out.left, 2);
    assert.deepEqual(saved[0], { url: photos(1)[0].url, box: [10, 20, 100, 200], skipped: false });
    assert.equal(out.costUsd, 0.015);
    assert.equal(charged.reduce((a, b) => a + b, 0).toFixed(4), "0.0150");
    // Both counters hold exactly what was spent: 6 x 2,500 micro-dollars.
    assert.equal(counted(c, SAM_TUNE_DAY_KEY), 15_000);
    assert.equal(counted(c, samTuneRunKey(RUN_ID)), 15_000);
  });

  it("takes Meta's own image count when the reply gives one", async () => {
    const c = fakeCounters();
    const { d, charged } = deps(c, async () => samReply({ usage: true }));
    await labelPhotos(run(photos(1)), limits(), d);
    assert.deepEqual(charged, [LABEL_PHOTO_USD]);
  });

  it("a photo where SAM found nothing is skipped, so the batch moves on", async () => {
    const c = fakeCounters();
    const { d, saved } = deps(c, async () => samReply({ empty: true }));
    const out = await labelPhotos(run(photos(2)), limits(), d);
    assert.deepEqual(saved.map((s) => s.skipped), [true, true]);
    assert.equal(out.left, 0);
  });

  it("only photos with no box and not skipped are asked", async () => {
    const p = photos(3);
    p[0].box = [1, 1, 5, 5];
    p[1].skipped = true;
    const c = fakeCounters();
    const { d, calls } = deps(c, async () => samReply());
    await labelPhotos(run(p), limits(), d);
    assert.equal(calls.length, 1);
  });

  it("the run's cap refuses before any call", async () => {
    const c = fakeCounters();
    const { d, calls } = deps(c, async () => samReply());
    const out = await labelPhotos(run(photos(4)), limits(0), d);
    assert.equal(calls.length, 0);
    assert.equal(out.refused, "run_cap");
    assert.equal(out.costUsd, 0);
    // The day's hold was given back when the run's counter said no.
    assert.equal(counted(c, SAM_TUNE_DAY_KEY), 0);
  });

  it("the run's cap stops a batch part way: 3 looks fit in $0.0075", async () => {
    const c = fakeCounters();
    const { d, calls } = deps(c, async () => samReply());
    const out = await labelPhotos(run(photos(6)), limits(0.0075), d);
    assert.equal(calls.length, 3);
    assert.equal(out.refused, "run_cap");
    assert.equal(out.left, 3);
  });

  it("SAM_TUNE_DAILY_USD refuses before any call, across runs", async () => {
    const c = fakeCounters();
    await c.adjustCounter(SAM_TUNE_DAY_KEY, utcDay(c.now()), micros(4.999));
    const { d, calls } = deps(c, async () => samReply());
    const out = await labelPhotos(run(photos(2)), limits(1, 5), d);
    assert.equal(calls.length, 0);
    assert.equal(out.refused, "daily_cap");
    assert.equal(counted(c, samTuneRunKey(RUN_ID)), 0);
  });

  it("the platform's daily cap refuses before any call and holds nothing", async () => {
    const c = fakeCounters();
    c.platformOk = false;
    const { d, calls } = deps(c, async () => samReply());
    const out = await labelPhotos(run(photos(2)), limits(), d);
    assert.equal(calls.length, 0);
    assert.equal(out.refused, "platform_cap");
    assert.equal(c.reserves.length, 0);
  });

  it("a failed look costs nothing and gives its hold back; a timed-out one stays spent", async () => {
    const c = fakeCounters();
    const { d } = deps(c, async () => {
      throw Object.assign(new Error("bad gateway"), { status: 502 });
    });
    const out = await labelPhotos(run(photos(2)), limits(), d);
    assert.equal(out.failed, 2);
    assert.equal(out.costUsd, 0);
    assert.equal(counted(c, SAM_TUNE_DAY_KEY), 0);

    const c2 = fakeCounters();
    const slow = deps(c2, (_body, signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))));
    slow.d.timeoutMs = 5;
    const late = await labelPhotos(run(photos(1)), limits(), slow.d);
    assert.equal(late.failed, 1);
    assert.equal(late.costUsd, LABEL_PHOTO_USD);
    assert.deepEqual(slow.charged, [LABEL_PHOTO_USD]);
    assert.equal(counted(c2, SAM_TUNE_DAY_KEY), 2_500);
  });

  it("two runs share one day cap", async () => {
    const c = fakeCounters();
    const a = await holdSpend(c, { runId: "a", runMaxUsd: 1, dailyUsd: 0.005 }, LABEL_PHOTO_USD);
    const b = await holdSpend(c, { runId: "b", runMaxUsd: 1, dailyUsd: 0.005 }, LABEL_PHOTO_USD);
    const third = await holdSpend(c, { runId: "c", runMaxUsd: 1, dailyUsd: 0.005 }, LABEL_PHOTO_USD);
    assert.ok(a.ok && b.ok);
    assert.deepEqual(third, { ok: false, reason: "daily_cap" });
  });

  it("a run's cap is never above SAM_TUNE_MAX_USD", () => {
    assert.equal(runCapUsd(5, 1), 1);
    assert.equal(runCapUsd(0.4, 1), 0.4);
    assert.equal(runCapUsd(null, 1), 1);
    assert.equal(runCapUsd(-2, 1), 0);
  });

  it("refusals read plainly, with no em dashes", () => {
    for (const r of ["platform_cap", "daily_cap", "run_cap"] as const) assert.doesNotMatch(refusalText(r), /\u2014/);
  });

  it("checks the person's own box", () => {
    assert.deepEqual(personBox([1.4, 2, 30, 40]), [1, 2, 30, 40]);
    assert.equal(personBox([0, 0, 1, 40]), null);
    assert.equal(personBox([-1, 0, 10, 10]), null);
    assert.equal(personBox(["1", 0, 10, 10]), null);
    assert.equal(personBox([0, 0, 10]), null);
  });
});
