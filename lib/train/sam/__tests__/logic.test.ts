/**
 * The SAM tune run's pure rules: the verdict on the Nov 3 numbers and at each boundary, the table's blue winners, the
 * report check, the split, the plan and the side-by-side picks. No database, no board.
 *
 *   npx tsx --test lib/train/sam/__tests__/logic.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  caveatsFor,
  finishReport,
  genericProblem,
  heldCount,
  pickImages,
  pickRule,
  planFor,
  reportColumns,
  reportRows,
  splitBySeed,
  validateReportIn,
  verdictFor,
  wordProblem,
  type ReportRun,
  type SamPickCandidate,
} from "@/lib/train/sam/logic";
import type { SamPhoto, SamReportIn, SamSettingScore } from "@/lib/train/sam/types";
import { nov3Report, nov3Report as nov3Fixture } from "./nov3";

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** The Nov 3 report with the tune's numbers changed. */
function withTuned(change: (t: SamSettingScore) => void): SamReportIn {
  const r = clone(nov3Report());
  change(r.settings.tuned_word!);
  return r;
}

describe("the verdict", () => {
  it("calls the Nov 3 numbers mixed against Meta's \"toy\", and says each number", () => {
    const v = verdictFor(nov3Report());
    assert.equal(v.code, "mixed");
    assert.match(v.text, /asked "toy"/);
    for (const part of ["0.77", "0.50", "22 of 30", "against 20", "against 29"]) assert.ok(v.text.includes(part), part);
    assert.doesNotMatch(v.text, /—/);
  });

  it("compares with whichever of the generic words and \"toy\" has the higher AP", () => {
    const r = clone(nov3Report());
    r.settings.meta_generic!.B.ap = 0.6;
    assert.match(verdictFor(r).text, /asked "plush toy"/);
  });

  it("is better only with AP up 0.10, fires down by 20% of n and top matches up by 20% of n", () => {
    const edge = (t: SamSettingScore) => {
      t.B.ap = 0.598; // toy 0.498 + 0.10
      t.A.firedPhotos = 23; // toy 29 - 6
      t.B.top = 26; // toy 20 + 6
    };
    assert.equal(verdictFor(withTuned(edge)).code, "better");
    assert.equal(verdictFor(withTuned(edge)).text, 'Picks it out better than Meta\'s SAM 3.1 asked "toy".');
    assert.equal(verdictFor(withTuned((t) => (edge(t), (t.B.ap = 0.597)))).code, "mixed");
    assert.equal(verdictFor(withTuned((t) => (edge(t), (t.A.firedPhotos = 24)))).code, "mixed");
    assert.equal(verdictFor(withTuned((t) => (edge(t), (t.B.top = 25)))).code, "mixed");
  });

  it("adds a name when AP is within 0.05, and is worse below that", () => {
    assert.equal(verdictFor(withTuned((t) => (t.B.ap = 0.548))).code, "adds_name");
    assert.equal(verdictFor(withTuned((t) => (t.B.ap = 0.448))).code, "adds_name");
    assert.match(verdictFor(withTuned((t) => (t.B.ap = 0.448))).text, /^Adds a name, not accuracy/);
    assert.equal(verdictFor(withTuned((t) => (t.B.ap = 0.447))).code, "worse");
    assert.match(verdictFor(withTuned((t) => (t.B.ap = 0.2))).text, /^Worse than Meta's own word/);
    assert.equal(verdictFor(withTuned((t) => (t.B.ap = 0.549))).code, "mixed");
  });

  it("always carries the caveats, whatever the verdict", () => {
    for (const r of [nov3Report(), withTuned((t) => (t.B.ap = 0.5))]) {
      const c = caveatsFor(r).join(" ");
      assert.match(c, /30 photos/);
      assert.match(c, /pasted into the photos, not photographed together/);
      assert.match(c, /made up \(Muse Image\) or come from COCO/);
      assert.match(c, /never shows that it tells muse apart from all look-alikes/);
    }
    assert.match(caveatsFor(nov3Report()).join(" "), /scored 0.5 or more, so it is a lower bound/);
    assert.doesNotMatch(caveatsFor(nov3Report({ apFrom: 0.05 })).join(" "), /lower bound/);
    assert.deepEqual(finishReport(nov3Report()).caveats, caveatsFor(nov3Report()));
  });
});

describe("the table", () => {
  const r = nov3Report();
  const cols = reportColumns(r).map((c) => c.id);
  const rows = Object.fromEntries(reportRows(r).map((row) => [row.key, row]));
  const blue = (key: string) => rows[key]!.cells.flatMap((c, i) => (c.best ? [cols[i]] : []));

  it("has Meta's word, generic and \"toy\", then the tune", () => {
    assert.deepEqual(cols, ["meta_word", "meta_generic", "meta_toy", "tuned_word"]);
    assert.equal(reportColumns(r)[2]!.prompt, '"toy"');
  });

  it("marks the one best value blue, none on a tie, never Meta asked the new word", () => {
    assert.deepEqual(blue("found"), [], "plush toy and toy tie at 30 of 30");
    assert.deepEqual(blue("top"), ["tuned_word"]);
    assert.deepEqual(blue("only"), ["tuned_word"]);
    assert.deepEqual(blue("fires"), ["tuned_word"], "lower is better, and Meta asked muse (0) is never blue");
    assert.deepEqual(blue("ap"), ["tuned_word"]);
    assert.deepEqual(blue("truck"), []);
    assert.equal(rows.fires!.cells[3]!.text, "22 of 30");
    assert.equal(rows.held, undefined, "held-out photos are for uploads only");
  });

  it("adds the Nov 3 tune column and the generic row when scored", () => {
    const more = clone(nov3Report());
    more.settings.prior_word = clone(more.settings.tuned_word!);
    more.settings.tuned_generic = clone(more.settings.meta_generic!);
    more.settings.tuned_generic.B.ap = 0.5;
    assert.deepEqual(reportColumns(more).map((c) => c.id), ["meta_word", "meta_generic", "meta_toy", "prior_word", "tuned_word"]);
    const rs = reportRows(more);
    assert.equal(rs.find((x) => x.key === "ap")!.cells.some((c) => c.best), false, "the two tunes tie");
    const g = rs.find((x) => x.key === "generic")!;
    assert.equal(g.label, 'Still knows "plush toy" (AP)');
    assert.equal(g.cells[4]!.text, "0.50");
    assert.equal(g.cells[4]!.best, true);
  });
});

describe("the board's report", () => {
  /** What a board posts: the Nov 3 numbers, scored from 0.05 as /done requires. */
  const nov3Report = (over: Partial<SamReportIn> = {}) => nov3Fixture({ apFrom: 0.05, ...over });
  const withTuned = (change: (t: SamSettingScore) => void) => {
    const r = nov3Report();
    change(r.settings.tuned_word!);
    return r;
  };
  const files = nov3Report().files;
  const img = "https://blob.example/samtune/x/report/c-sbs1.jpg";
  const run: ReportRun = { word: "muse", generic: "plush toy", seed: 20261103, data: "builtin-muse", workerId: "jetson-03", uploads: [files.scores, files.perImage, img] };

  it("takes the Nov 3 numbers and keeps only known fields", () => {
    const got = validateReportIn({ ...nov3Report(), verdict: { code: "better", text: "Tells muse apart" }, extra: 1 }, run);
    assert.ok(got.ok);
    assert.equal("verdict" in got.report, false);
    assert.equal("extra" in got.report, false);
  });

  it("rewrites captions and refuses images it didn't save or may not show", () => {
    const image = { url: img, rule: "tuned_top", caption: "Tells muse apart from every toy", credit: "Photo by A, CC BY 2.0", license: "CC BY 2.0" };
    const got = validateReportIn(nov3Report({ images: [image as never] }), run);
    assert.ok(got.ok);
    assert.doesNotMatch(got.report.images[0]!.caption, /apart/);
    assert.equal(validateReportIn(nov3Report({ images: [{ ...image, url: "https://evil.example/x.jpg" } as never] }), run).ok, false);
    assert.equal(validateReportIn(nov3Report({ images: [{ ...image, license: "CC BY-NC 2.0" } as never] }), run).ok, false);
    assert.equal(validateReportIn(nov3Report({ images: [{ ...image, credit: null } as never] }), run).ok, false);
    const unlicensed = { ...image, license: null, credit: null };
    assert.equal(validateReportIn(nov3Report({ images: [unlicensed as never] }), run).ok, false, "a built-in run's pictures are all COCO photos");
    assert.equal(validateReportIn(nov3Report({ images: [unlicensed as never] }), { ...run, data: "uploads" }).ok, false, "uploads still need H");
  });

  it("refuses a report for another word, a missing \"toy\" column, impossible counts and anything over 64 KB", () => {
    assert.equal(validateReportIn(nov3Report({ word: "bear" }), run).ok, false);
    const noToy = clone(nov3Report());
    delete noToy.settings.meta_toy;
    assert.deepEqual(validateReportIn(noToy, run), { ok: false, problem: "settings.meta_toy" });
    assert.equal(validateReportIn(withTuned((t) => (t.B.found = 31)), run).ok, false);
    assert.equal(validateReportIn(withTuned((t) => (t.B.ap = 1.2)), run).ok, false);
    assert.equal(validateReportIn(nov3Report({ workerId: "jetson-04" }), run).ok, false);
    assert.equal(validateReportIn(nov3Report({ files: { scores: "https://evil.example/s.json", perImage: files.perImage } }), run).ok, false);
    assert.deepEqual(validateReportIn(nov3Report({ timings: { pad: 1, ["x".repeat(10)]: 2 } }), run, 70_000), { ok: false, problem: "report_too_large" });
    assert.equal(validateReportIn(nov3Report(), { ...run, data: "uploads" }).ok, false, "an uploads run needs its own sets and held-out photos");
    assert.deepEqual(validateReportIn(nov3Fixture(), run), { ok: false, problem: "apFrom" }, "only the hand import may say 0.5");
  });
});

describe("words, split, plan and picks", () => {
  it("checks the new name and the everyday words", () => {
    assert.equal(wordProblem("muse"), null);
    for (const w of ["Muse", "m", "two words", "muse1", "a".repeat(25)]) assert.ok(wordProblem(w), w);
    assert.equal(genericProblem("plush toy", "muse"), null);
    for (const g of ["plush  toy", "plush toy ", "Toy", "x"]) assert.ok(genericProblem(g), g);
    assert.ok(genericProblem("muse", "muse"));
  });

  it("splits the same way for the same seed, holding a quarter and at least 4", () => {
    const photos = Array.from({ length: 20 }, (_, i) => ({ url: `u${i}` }));
    const a = splitBySeed(photos, 7);
    assert.deepEqual(a, splitBySeed(photos, 7));
    assert.notDeepEqual(a, splitBySeed(photos, 8));
    assert.equal(a.filter((p) => p.split === "held").length, 5);
    assert.deepEqual(a.map((p) => p.url), photos.map((p) => p.url));
    assert.equal(heldCount(12), 4);
    assert.equal(heldCount(60), 15);
  });

  it("plans the built-in run at $0 and an uploads run at labels plus look-alikes", () => {
    const builtin = planFor({ data: "builtin-muse" });
    assert.equal(builtin.costUsd, 0);
    assert.equal(builtin.steps, 200 * 5);
    assert.ok(builtin.minutes >= 30 && builtin.minutes <= 60, String(builtin.minutes));
    assert.ok(planFor({ data: "builtin-muse", baseLocal: false }).minutes >= builtin.minutes + 20);
    assert.equal(planFor({ data: "builtin-muse", lookAlikes: 20 }).costUsd, 0.2);
    const photos: SamPhoto[] = splitBySeed(Array.from({ length: 60 }, (_, i) => ({ url: `u${i}`, box: [0, 0, 1, 1] as [number, number, number, number], skipped: false })), 1);
    assert.equal(planFor({ data: "uploads", photos, lookAlikes: 20 }).costUsd, 0.35);
    assert.equal(planFor({ data: "uploads", photos, lookAlikes: 20 }).trainImages, 45 + 20);
  });

  it("picks side by sides only from photos it may show", () => {
    const base: SamPickCandidate = { key: "b1", set: "B", source: "coco", license: "CC BY 2.0", tunedTop: true, genericTop: false, tunedFalseScore: null };
    assert.equal(pickRule(base), "tuned_top");
    assert.equal(pickRule({ ...base, license: "CC BY-NC-SA 2.0" }), null);
    assert.equal(pickRule({ ...base, source: "muse-image", license: null }), "tuned_top");
    assert.equal(pickRule({ ...base, genericTop: true }), "generic_top");
    const picks = pickImages([
      base,
      { ...base, key: "a1", set: "A", tunedTop: false, tunedFalseScore: 0.6 },
      { ...base, key: "a2", set: "A", tunedTop: false, tunedFalseScore: 0.99 },
      { ...base, key: "a3", set: "A", tunedTop: false, tunedFalseScore: 1, license: "CC BY-ND 2.0" },
    ]);
    assert.deepEqual(picks, [{ key: "b1", rule: "tuned_top" }, { key: "a2", rule: "tuned_false_fire" }]);
  });
});
