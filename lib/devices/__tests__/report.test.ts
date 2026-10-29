/**
 * lib/devices/report.ts and scripts/devices/report.ts on results read from the fixtures (fixtures/*, each through
 * parseKitOutput) and variations of them: the rows and their order, the tier rule (a tier changes only when its best
 * file is usable or slow on every phone tested in it, by the newest run of each phone and file; the largest such file
 * wins; smoke runs stay out), the picker's summary, the markdown, and the script's reading of result.json files.
 * Nothing here runs anything.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/devices/__tests__/report.test.ts
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { PICKER_WORDS, pickerSummary, pickerTiers, reportMarkdown, reportRows, sizeText } from "@/lib/devices/report";
import { parseKitOutput } from "@/lib/devices/result";
import { SMOKE, subjectById } from "@/lib/devices/subjects";
import type { Rating, Result, Subject } from "@/lib/devices/types";
import { readResults } from "@/scripts/devices/report";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));
const Q3 = subjectById("bartowski-q3_k_m")!;
const IQ2M = subjectById("bartowski-iq2_m")!;
const IQ2XXS = subjectById("bartowski-iq2_xxs")!;
const META = subjectById("meta-q4_k_m")!;

const temps: string[] = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

const qdcPhone = parseKitOutput(path.join(FIXTURES, "android-sm8850-q3_k_m"), {
  cloud: "qdc",
  runId: "qdc-job-1",
  stamp: "20261028T235200Z",
  subject: Q3,
  device: { name: "Snapdragon 8 Elite Gen 5 QRD", manufacturer: "Qualcomm", model: "SM8850 QRD", cloudId: "qdc:SM8850" },
});
const galaxy = parseKitOutput(path.join(FIXTURES, "android-12gb-lmk"), {
  cloud: "devicefarm",
  runId: "arn:aws:devicefarm:us-west-2:123456789012:run:fake/run",
  stamp: "20261029T072000Z",
  subject: IQ2XXS,
  device: { name: "Samsung Galaxy S24 Ultra" },
});
const macSmoke = parseKitOutput(path.join(FIXTURES, "mac-m4max-smoke"), {
  cloud: "local",
  runId: "local-20261029T031655Z",
  stamp: "20261029T031655Z",
  subject: SMOKE,
});

/** A copy of a result as another device, file, rating or time. */
function variant(
  base: Result,
  over: { slug?: string; name?: string; ramGiB?: number; subject?: Subject; rating?: Rating; genTps?: number | null; stamp?: string },
): Result {
  const r = structuredClone(base);
  if (over.slug) r.device.slug = over.slug;
  if (over.name) r.device.name = over.name;
  if (over.ramGiB) r.device.marketedRamGiB = over.ramGiB;
  if (over.subject) r.subject = over.subject;
  if (over.rating) r.verdict.rating = over.rating;
  if (over.genTps !== undefined) r.verdict.genTps = over.genTps;
  if (over.stamp) r.stamp = over.stamp;
  return r;
}

const tierOf = (results: Result[], ramGiB: number, os: "android" | "macos" = "android") =>
  pickerTiers(reportRows(results)).find((t) => t.os === os && t.ramGiB === ramGiB)!;

describe("reportRows", () => {
  it("makes one row per result, phones by RAM first, then Macs", () => {
    const rows = reportRows([macSmoke, qdcPhone, galaxy]);
    assert.deepEqual(rows.map((r) => [r.os, r.ramGiB, r.subjectId]), [
      ["android", 12, "bartowski-iq2_xxs"],
      ["android", 24, "bartowski-q3_k_m"],
      ["macos", 36, "smoke-smollm2-135m-q4_0"],
    ]);
    const phone = rows[1];
    assert.deepEqual(
      [phone.cloud, phone.device, phone.rating, phone.words, phone.backend, phone.genTps, phone.answersRight, phone.answersTotal],
      ["qdc", "Snapdragon 8 Elite Gen 5 QRD", "slow", "Runs slowly", "cpu", 3.010551, 2, 3],
    );
    assert.deepEqual(phone.backends, ["cpu 3.01 t/s, 2/3 right", "gpu 2.09 t/s, 3/3 right", "npu out of time"]);
    assert.deepEqual([phone.peakBytes, phone.minAvailableBytes], [7618560 * 1024, 6678528 * 1024]);
    assert.equal(phone.path, "devices/results/qdc/qualcomm-sm8850-qrd-24gb/bartowski-q3_k_m/20261028T235200Z");
    assert.deepEqual(rows[0].backends, ["cpu killed by the low-memory killer", "gpu error", "npu not run: device not here"]);
  });

  it("writes sizes in GB, or MB under 1 GB", () => {
    assert.deepEqual([sizeText(16_756_683_904), sizeText(91_893_088), sizeText(null)], ["16.8 GB", "92 MB", ""]);
  });
});

describe("the picker's tiers", () => {
  it("change a tier when its file runs usable or slow on the one phone tested", () => {
    const t = tierOf([qdcPhone], 24);
    assert.deepEqual(
      [t.changes, t.rating, t.words, t.line, t.subjectId, t.kind, t.quant, t.genTps],
      [true, "slow", "Runs slowly", "Runs slowly: about 3.01 tokens a second (Q3_K_M)", "bartowski-q3_k_m", "base", "Q3_K_M", 3.010551],
    );
    assert.equal(
      t.evidence,
      "bartowski-q3_k_m (14.0 GB) ran slowly on all 1 phone tested, in tokens a second: Snapdragon 8 Elite Gen 5 QRD 3.01 on cpu.",
    );
  });

  it("keep \"Won't run here\" unless the file works on every phone tested in the tier", () => {
    const second = variant(qdcPhone, { slug: "other-24gb", name: "Other Phone", rating: "unusable", genTps: null });
    const t = tierOf([qdcPhone, second], 24);
    assert.deepEqual([t.changes, t.rating, t.words, t.subjectId], [false, "unusable", PICKER_WORDS.unusable, null]);
    assert.ok(t.evidence.startsWith("No file ran usable or slow on all 2 phones tested."), t.evidence);
    assert.deepEqual(t.devices.map((d) => [d.name, d.rating]), [["Other Phone", "unusable"], ["Snapdragon 8 Elite Gen 5 QRD", "slow"]]);
  });

  it("pick the largest file that works on every phone, and ignore one tested on only some of them", () => {
    const a = (subject: Subject, rating: Rating, genTps: number) => variant(qdcPhone, { subject, rating, genTps });
    const b = (subject: Subject, rating: Rating, genTps: number) => variant(qdcPhone, { slug: "b-24gb", name: "Phone B", subject, rating, genTps });
    const t = tierOf([a(META, "usable", 4.2), a(Q3, "usable", 5.1), a(IQ2M, "usable", 6.8), b(Q3, "slow", 3.9), b(IQ2M, "usable", 6.1)], 24);
    assert.deepEqual([t.changes, t.subjectId, t.rating, t.genTps], [true, "bartowski-q3_k_m", "slow", 3.9]);
    assert.deepEqual(t.devices.map((d) => [d.name, d.genTps]), [["Phone B", 3.9], ["Snapdragon 8 Elite Gen 5 QRD", 5.1]]);
    assert.equal(t.line, "Runs slowly: about 3.90 tokens a second (Q3_K_M)");
  });

  it("go by each phone's newest run of a file", () => {
    const later = variant(qdcPhone, { rating: "failed", genTps: null, stamp: "20261030T000000Z" });
    assert.equal(tierOf([qdcPhone, later], 24).changes, false);
    const earlier = variant(qdcPhone, { rating: "failed", genTps: null, stamp: "20261020T000000Z" });
    assert.equal(tierOf([earlier, qdcPhone], 24).changes, true);
  });

  it("list every phone tier of the matrix, say so when one wasn't tested, and leave smoke runs out", () => {
    const tiers = pickerTiers(reportRows([qdcPhone, galaxy, macSmoke, variant(macSmoke, { slug: "phone-smoke", subject: SMOKE })]));
    assert.deepEqual(tiers.map((t) => [t.os, t.ramGiB, t.rating]), [["android", 12, "unusable"], ["android", 16, null], ["android", 24, "slow"]]);
    assert.deepEqual([tiers[1].changes, tiers[1].words, tiers[1].evidence], [false, null, "No phone with 16 GB tested yet."]);
    assert.ok(tiers[0].evidence.includes("Samsung Galaxy S24 Ultra with bartowski-iq2_xxs: unusable (No backend ran with enough right answers"));
  });

  it("add a Mac tier once a Mac ran a real file", () => {
    const mac = variant(macSmoke, { subject: META, rating: "usable", genTps: 23.7 });
    const t = tierOf([macSmoke, mac], 36, "macos");
    assert.deepEqual([t.changes, t.words, t.subjectId, t.line], [true, "Runs", "meta-q4_k_m", "Runs: about 23.7 tokens a second (Q4_K_M)"]);
  });

  it("summarize the same results the same way, with the newest stamp instead of the time", () => {
    const rows = reportRows([galaxy, qdcPhone, macSmoke]);
    const summary = pickerSummary(rows);
    assert.deepEqual([summary.schema, summary.results, summary.newest], [1, 3, "20261029T072000Z"]);
    assert.deepEqual(pickerSummary(reportRows([macSmoke, qdcPhone, galaxy])), summary);
  });
});

describe("reportMarkdown", () => {
  it("gives the picker's lines, every run with its reasons, and the smoke runs apart", () => {
    const md = reportMarkdown(reportRows([qdcPhone, galaxy, macSmoke]));
    assert.ok(md.startsWith("# Device results\n\n2 runs of Muse Glimmer 30B files and 1 smoke run."), md.slice(0, 120));
    assert.match(md, /^- \*\*12 GB phones:\*\* No change: Won't run here: use Try it live\. No file ran usable or slow on all 1 phone tested\./m);
    assert.match(md, /^- \*\*16 GB phones:\*\* No change \(nothing tested\)\.$/m);
    assert.match(md, /^- \*\*24 GB phones:\*\* Runs slowly: about 3\.01 tokens a second \(Q3_K_M\)\. bartowski-q3_k_m/m);
    assert.match(md, /^\| Snapdragon 8 Elite Gen 5 QRD \| QDC \| 24 GB \| bartowski-q3_k_m \(14\.0 GB\) \| slow \| cpu \| 3\.01 t\/s \| 5\.61 t\/s \| 2\/3 \|/m);
    assert.match(md, /^- Samsung Galaxy S24 Ultra, bartowski-iq2_xxs, 20261029T072000Z: unusable\. cpu: the bench was killed by the low-memory killer\./m);
    assert.match(md, /## Smoke runs\n\nThese only show that the path works on a device/);
    assert.match(md, /^\| Mac16,5 \(Apple M4 Max\) \| this Mac \| 36 GB \| smoke-smollm2-135m-q4_0 \(92 MB\) \| usable \|/m);
    assert.ok(md.endsWith("|\n"));
  });

  it("escapes a pipe in a device name", () => {
    const md = reportMarkdown(reportRows([variant(qdcPhone, { name: "Phone | Pro" })]));
    assert.ok(md.includes("| Phone \\| Pro | QDC |"));
  });

  it("links each run's folder from devices/results, where report.md lives, or from the repo's root", () => {
    const rows = reportRows([macSmoke]);
    const folder = "local/apple-mac16-5-36gb/smoke-smollm2-135m-q4_0/20261029T031655Z";
    assert.ok(reportMarkdown(rows).includes(`| [20261029T031655Z](${folder}) |`));
    assert.ok(reportMarkdown(rows, { linksFrom: "" }).includes(`| [20261029T031655Z](devices/results/${folder}) |`));
  });
});

describe("scripts/devices/report.ts", () => {
  it("reads every result.json under a folder, in path order, and prints the report", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mm-report-"));
    temps.push(dir);
    const put = (r: Result) => {
      const at = path.join(dir, r.cloud, r.device.slug, r.subject.id, r.stamp);
      mkdirSync(at, { recursive: true });
      writeFileSync(path.join(at, "result.json"), JSON.stringify(r));
    };
    put(macSmoke);
    put(qdcPhone);
    mkdirSync(path.join(dir, "local", "empty"), { recursive: true });
    const results = readResults(dir);
    assert.deepEqual(results.map((r) => r.cloud), ["local", "qdc"]);
    assert.deepEqual(readResults(path.join(dir, "nowhere")), []);

    const out = spawnSync(process.execPath, ["--import", "tsx", path.join(REPO, "scripts/devices/report.ts"), "--dir", dir], {
      cwd: REPO,
      encoding: "utf8",
    });
    assert.equal(out.status, 0, out.stderr);
    assert.ok(out.stdout.startsWith("# Device results\n\n1 run of Muse Glimmer 30B files and 1 smoke run."), out.stdout.slice(0, 100));
    const bad = spawnSync(process.execPath, ["--import", "tsx", path.join(REPO, "scripts/devices/report.ts"), "--nope"], { cwd: REPO, encoding: "utf8" });
    assert.equal(bad.status, 2);
  });
});
