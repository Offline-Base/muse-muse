import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { gunzipSync, gzipSync } from "node:zlib";

import { classify, filterFile, loadRecords, parseArgs, recordIdOf } from "./filter.mjs";

// Row shapes copied from the public Knowledge-Data release (field names only; text made up).
const rel = (writer, row_license, source_license = "") => ({ messages: [], release: { writer, row_license, source_license } });
const nc = rel("muse-spark-open@fireworks", "CC BY-NC-SA 4.0 (source is NC licensed); Muse Model License; Built with Muse Spark Open", "fair-noncommercial-research-license, training only");
const sparkBaseten = rel("muse-spark-open@baseten", "CC BY-SA 4.0 (source terms in source_license); Muse Model License; Built with Muse Spark Open", "Public domain (US government work)");
const glimmer = rel("muse-glimmer-30b", "CC BY-SA 4.0");
const template = rel("template", "CC BY-SA 4.0");
const labelled = rel("template, labelled by stage2-multi", "CC BY-SA 4.0; Muse Model License");
const measured = rel("stage2-multi (reply); question and gold answer: muse-spark-open@fireworks", "CC BY-SA 4.0; Muse Model License");
const evalRow = rel("written by the coding agent or a script (no model writer)", "CC BY-SA 4.0");

test("license flags: NC, ND, no-reuse", () => {
  assert.equal(classify(nc).flags.nc, true);
  assert.equal(classify(nc).reason, "nc");
  assert.equal(classify({ license: "CC BY-NC-ND 4.0" }).reason, "nd");
  assert.equal(classify({ license: "cc-by-nd" }).flags.nd, true);
  assert.equal(classify({ license: "CC-BY-NC" }).flags.nc, true);
  assert.equal(classify({ license: "World Bank non-commercial general terms" }).flags.nc, true);
  assert.equal(classify({ license: "no-reuse (authors kept their rights)" }).reason, "no-reuse");
  for (const ok of ["CC BY-SA 4.0", "CC BY 4.0", "Apache 2.0", "Open Government Licence v3.0", "CC0"]) {
    const c = classify({ license: ok });
    assert.deepEqual([c.flags.nc, c.flags.nd, c.flags.noReuse, c.reason], [false, false, false, null], ok);
  }
});

test("writer flags: Fireworks, Meta API, model-written", () => {
  assert.equal(classify(nc).flags.fireworks, true);
  assert.equal(classify(sparkBaseten).flags.fireworks, false);
  assert.equal(classify(sparkBaseten).flags.metaApi, false, "Spark Open is open weights, not the Model API");
  assert.equal(classify(measured).flags.fireworks, true, "a measured row whose question Spark Open wrote on Fireworks");
  for (const w of ["muse-spark-1.3-contributor", "muse-wonder-1.0", "muse-spark-1.3"]) assert.equal(classify({ writer: w }).flags.metaApi, true, w);
  assert.equal(classify({ lineage: { writer: "muse-glimmer-30b" } }).flags.modelWritten, true);
  assert.equal(classify(glimmer).flags.modelWritten, true);
  assert.equal(classify(template).flags.modelWritten, false);
  assert.equal(classify(evalRow).flags.modelWritten, false);
  assert.equal(classify({ writer_model: "person" }).flags.modelWritten, false);
  assert.equal(classify(labelled).flags.modelWritten, true, "a template reply the tuned model picked counts as model-made");
  assert.equal(classify({ messages: [] }).flags.unknownWriter, true);
  assert.equal(classify({ messages: [] }, { writer: "muse-spark-1.3-contributor" }).flags.metaApi, true);
});

test("drop options pick the first reason in order, and NC beats a writer reason", () => {
  assert.equal(classify(sparkBaseten, { dropModelWritten: true }).reason, "model-written");
  assert.equal(classify(sparkBaseten, { dropFireworks: true }).reason, null);
  assert.equal(classify(measured, { dropFireworks: true, dropModelWritten: true }).reason, "fireworks");
  assert.equal(classify(nc, { dropFireworks: true }).reason, "nc");
  assert.equal(classify({ writer: "muse-wonder-1.0" }, { dropMetaApi: true }).reason, "meta-api");
  assert.equal(classify({ messages: [] }, { dropUnknownWriter: true }).reason, "unknown-writer");
  assert.equal(classify({ messages: [] }, { dropUnknownLicense: true }).reason, "unknown-license");
});

test("raw rows join their source record's license", async () => {
  assert.equal(recordIdOf({ source: "source:s3-pmc:PMC123:4" }), "s3-pmc:PMC123");
  assert.equal(recordIdOf({ source: "event:2026-01-04:0" }), null);
  const dir = mkdtempSync(path.join(tmpdir(), "rights-"));
  writeFileSync(path.join(dir, "s3-pmc.jsonl"), [{ id: "s3-pmc:PMC123", license: "CC-BY-NC-ND" }, { id: "s3-pmc:PMC9", license: "CC-BY" }].map((r) => JSON.stringify(r)).join("\n") + "\nnot json\n");
  writeFileSync(path.join(dir, "notes.txt"), "ignored");
  const records = await loadRecords([dir]);
  assert.equal(records.size, 2);
  const c = classify({ source: "source:s3-pmc:PMC123:0" }, { records });
  assert.equal(c.license.from, "source-record");
  assert.equal(c.reason, "nd");
  assert.equal(classify({ source: "source:s3-pmc:PMC9:1" }, { records }).reason, null);
  assert.equal(classify({ source: "source:s3-pmc:PMC404:1" }, { records }).flags.unknownLicense, true);
});

test("filterFile writes a filtered copy, keeps the input, and counts", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rights-"));
  const input = path.join(dir, "in.jsonl.gz");
  const rows = [nc, sparkBaseten, glimmer, template, measured, { license: "CC BY-ND 4.0" }];
  const raw = gzipSync(rows.map((r) => JSON.stringify(r)).join("\n") + "\n{broken\n");
  writeFileSync(input, raw);
  const out = path.join(dir, "out", "kept.jsonl.gz");
  const c = await filterFile(input, out, { dropFireworks: true });
  assert.deepEqual([c.read, c.kept, c.badLines], [6, 3, 1]);
  assert.deepEqual(c.dropped, { nc: 1, fireworks: 1, nd: 1 });
  assert.equal(c.flagged.fireworks, 2);
  const kept = gunzipSync(readFileSync(out)).toString().trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(kept.map((r) => r.release?.writer ?? null), ["muse-spark-open@baseten", "muse-glimmer-30b", "template"]);
  assert.deepEqual(readFileSync(input), raw, "input unchanged");
  await assert.rejects(filterFile(input, out, {}), /exists/);
  await assert.rejects(filterFile(input, input, { force: true }), /never changes its input/);
});

test("a .json array in, a .json array out; count-only writes nothing", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rights-"));
  const input = path.join(dir, "train.json");
  writeFileSync(input, JSON.stringify([{ messages: [{ role: "user", content: "hi" }] }, { messages: [], license: "CC BY-NC 4.0" }]));
  const out = path.join(dir, "train.kept.json");
  const c = await filterFile(input, out, { writer: "muse-spark-1.3-contributor" });
  assert.deepEqual([c.read, c.kept, c.flagged.metaApi], [2, 1, 2]);
  assert.equal(JSON.parse(readFileSync(out, "utf8")).length, 1);
  const counted = await filterFile(input, undefined, { dropMetaApi: true, writer: "muse-spark-1.3-contributor" });
  assert.deepEqual([counted.kept, counted.out], [0, null]);
});

test("parseArgs", () => {
  const o = parseArgs(["in.jsonl", "--out", "o.jsonl", "--drop-fireworks", "--source-records", "a", "--source-records", "b", "--writer", "w"]);
  assert.deepEqual([o.input, o.out, o.dropFireworks, o.sourceRecords, o.writer], ["in.jsonl", "o.jsonl", true, ["a", "b"], "w"]);
  assert.throws(() => parseArgs([]), /usage/);
  assert.throws(() => parseArgs(["a", "b"]), /one input/);
  assert.throws(() => parseArgs(["a", "--out"]), /needs a value/);
  assert.throws(() => parseArgs(["a", "--nope"]), /unknown option/);
});
