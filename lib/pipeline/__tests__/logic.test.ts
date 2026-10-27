import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  allowedModelsFor,
  BuildStop,
  decideOutcome,
  failureMessage,
  museImagePaths,
  nextFreeSlug,
  normalizeSlug,
  pickBuildModel,
  pollLimit,
  pollTimedOut,
  SLUG_MAX,
  slugWithSuffix,
} from "@/lib/pipeline/logic";

describe("slugs", () => {
  it("normalizes to lowercase words and dashes", () => {
    assert.equal(normalizeSlug("Receipt  Reader!"), "receipt-reader");
    assert.equal(normalizeSlug("--Café--Shelf--"), "cafe-shelf");
    assert.equal(normalizeSlug("!!!"), "product");
  });

  it("keeps the base, then adds -2, -3 on conflict", () => {
    assert.equal(nextFreeSlug("shelf", []), "shelf");
    assert.equal(nextFreeSlug("shelf", ["shelf"]), "shelf-2");
    assert.equal(nextFreeSlug("shelf", ["shelf", "shelf-2", "shelf-3"]), "shelf-4");
    assert.equal(nextFreeSlug("shelf", ["shelf-2"]), "shelf");
  });

  it("trims a long base so the suffix still fits", () => {
    const base = "a".repeat(SLUG_MAX);
    assert.equal(slugWithSuffix(base, 1), base);
    const second = slugWithSuffix(base, 2);
    assert.equal(second.length, SLUG_MAX);
    assert.ok(second.endsWith("-2"));
    assert.equal(nextFreeSlug(base, [base, second]).length, SLUG_MAX);
    assert.ok(nextFreeSlug(base, [base, second]).endsWith("-3"));
  });

  it("never leaves a dash before the suffix", () => {
    const base = `${"a".repeat(37)}-bc`;
    assert.equal(slugWithSuffix(base, 2), `${"a".repeat(37)}-2`);
    assert.match(slugWithSuffix(base, 12), /^[a-z0-9]+(-[a-z0-9]+)*$/);
  });
});

describe("decideOutcome", () => {
  const steps = (ok: Record<string, boolean>) => Object.entries(ok).map(([name, v]) => ({ name, ok: v }));

  const allOk = steps({ typecheck: true, build: true, start: true, console: true, smoke: true, manifest: true });
  const minor = { pass: false, blocking: false };
  const blocking = { pass: false, blocking: true };

  it("is live when verify and the judge passed, for builds and refinements", () => {
    assert.equal(decideOutcome({ kind: "build", passed: true, steps: allOk, judge: { pass: true, blocking: false } }), "live");
    assert.equal(decideOutcome({ kind: "refine", passed: true, steps: allOk, judge: { pass: true, blocking: false } }), "live");
  });

  it("is partial only when every runtime step passed and the judge failed it for a minor reason", () => {
    assert.equal(decideOutcome({ kind: "build", passed: false, steps: allOk, judge: minor }), "partial");
  });

  it("fails when the judge's failure is blocking (copying, Meta branding, no result)", () => {
    assert.equal(decideOutcome({ kind: "build", passed: false, steps: allOk, judge: blocking }), "failed");
  });

  it("fails when the judge never ran, because verify failed", () => {
    const s = steps({ typecheck: true, build: true, start: true, console: true, smoke: true, manifest: false });
    assert.equal(decideOutcome({ kind: "build", passed: false, steps: s, judge: null }), "failed");
  });

  it("fails when the smoke test or the console check failed", () => {
    for (const broken of ["smoke", "console", "start", "build", "typecheck"]) {
      const s = steps({ typecheck: true, build: true, start: true, console: true, smoke: true, [broken]: false });
      assert.equal(decideOutcome({ kind: "build", passed: false, steps: s, judge: minor }), "failed", broken);
    }
    assert.equal(decideOutcome({ kind: "build", passed: false, steps: [], judge: minor }), "failed");
  });

  it("never ships a refinement that didn't fully pass, so the live version stays", () => {
    assert.equal(decideOutcome({ kind: "refine", passed: false, steps: allOk, judge: minor }), "failed");
    assert.equal(decideOutcome({ kind: "refine", passed: false, steps: allOk, judge: null }), "failed");
  });
});

describe("poll timeouts", () => {
  it("fits the cap into whole polls", () => {
    assert.equal(pollLimit(20 * 60_000, 15_000), 80);
    assert.equal(pollLimit(8 * 60_000, 10_000), 48);
    assert.equal(pollLimit(6 * 60_000, 10_000), 36);
    assert.equal(pollLimit(1, 15_000), 1);
  });

  it("times out on the clock or on the poll count, whichever comes first", () => {
    const base = { startedAt: 1_000, capMs: 60_000, intervalMs: 15_000 };
    assert.equal(pollTimedOut({ ...base, now: 1_000 + 30_000, polls: 2 }), false);
    assert.equal(pollTimedOut({ ...base, now: 1_000 + 60_000, polls: 2 }), true);
    // The workflow clock can lag behind real time; the count still ends the loop.
    assert.equal(pollTimedOut({ ...base, now: 1_000, polls: 4 }), true);
    assert.equal(pollTimedOut({ ...base, now: 1_000, polls: 3 }), false);
  });
});

describe("models", () => {
  it("allows the brief's models minus Glimmer, once each", () => {
    const brief = {
      capabilities: [
        { need: "a", model: "muse-spark-1.3" as const, why: "" },
        { need: "b", model: "muse-glimmer" as const, why: "" },
        { need: "c", model: "sam-3.1" as const, why: "" },
        { need: "d", model: "muse-spark-1.3" as const, why: "" },
      ],
    };
    assert.deepEqual(allowedModelsFor(brief), ["muse-spark-1.3", "sam-3.1"]);
  });

  it("builds complex briefs with the complex model", () => {
    const models = { buildModel: "muse-spark-1.3", complexBuildModel: "muse-wonder-1.0" };
    assert.equal(pickBuildModel("complex", models), "muse-wonder-1.0");
    assert.equal(pickBuildModel("standard", models), "muse-spark-1.3");
    assert.equal(pickBuildModel("simple", models), "muse-spark-1.3");
    assert.equal(pickBuildModel("simple", { buildModel: "nope", complexBuildModel: "nope" }), "muse-spark-1.3");
    assert.equal(pickBuildModel("complex", { buildModel: "nope", complexBuildModel: "nope" }), "muse-wonder-1.0");
  });

  it("attaches only image references", () => {
    assert.deepEqual(
      museImagePaths([
        { kind: "image", fileName: "a.png" },
        { kind: "pdf", fileName: "b.pdf" },
        { kind: "image", fileName: "c.jpg" },
      ]),
      ["inspo/a.png", "inspo/c.jpg"],
    );
  });
});

describe("failureMessage", () => {
  it("keeps messages the pipeline raised on purpose", () => {
    assert.equal(failureMessage("build", new BuildStop("Muse Code ran past its limit.")), "Muse Code ran past its limit.");
    const fatal = Object.assign(new Error("This product has no sandbox."), { name: "FatalError" });
    assert.equal(failureMessage("provision", fatal), "This product has no sandbox.");
  });

  it("names the stage for steps that ran out of retries", () => {
    const wrapped = Object.assign(new Error('Step "step//lib/x//provisionStep" failed after 2 retries: fetch failed\n  at x'), {
      name: "FatalError",
    });
    assert.equal(failureMessage("provision", wrapped), "The sandbox setup step failed: fetch failed");
    assert.equal(failureMessage("deploy", new Error("boom")), "The deploy step failed: boom");
    assert.equal(failureMessage("verify", "odd"), "The check step failed: odd");
  });

  it("never passes an em dash through", () => {
    const msg = failureMessage("build", new Error("upstream \u2014 timed out"));
    assert.ok(!msg.includes("\u2014"));
    assert.equal(msg, "The build step failed: upstream, timed out");
  });
});
