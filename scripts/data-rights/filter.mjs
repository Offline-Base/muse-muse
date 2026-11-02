#!/usr/bin/env node
/**
 * Data-rights filter for training files. Reads a training file, writes a COPY without the rows the owner may not want
 * to train on, and prints counts. It never changes the input, never uploads and never trains. See docs/DATA_RIGHTS.md.
 *
 *   node scripts/data-rights/filter.mjs IN [--out OUT] [options]
 *
 * IN is JSONL, JSONL.gz, or a .json array (the lab's train.json). Without --out it only counts.
 *
 * Always dropped from the copy:
 *   nd        a license with No Derivatives (CC BY-ND, BY-NC-ND, "NoDerivatives")
 *   no-reuse  "no-reuse" (authors kept their rights; only the preprint server has a license)
 *   nc        a non-commercial license (CC BY-NC, BY-NC-SA, "non-commercial", FAIR Noncommercial Research License)
 * Dropped only when asked:
 *   --drop-fireworks      rows a model served by Fireworks wrote (writer "...@fireworks"), for Fireworks terms 2.2(c)
 *   --drop-meta-api       rows Muse Wonder or Muse Spark 1.x wrote through Meta's Model API, for Model API Terms 10.1(ix)
 *   --drop-model-written  every model-written row (templates, a person's rows and repo-written evals stay)
 *   --drop-unknown-writer rows with no writer on the row and no --writer for the file
 *   --drop-unknown-license rows with no license on the row, no joined source record and no --license
 *
 * Where the license and writer come from, first found wins:
 *   license: row.release.row_license and row.release.source_license (the public Knowledge-Data release), row.row_license,
 *            row.source_license, row.license, then the source record joined by --source-records, then --license.
 *   writer:  row.release.writer, row.lineage.writer, row.writer, row.writer_model, row.writerModel, then --writer.
 * --source-records FILE_OR_DIR (repeatable) reads SourceRecord JSONL ({id, license}); a raw training row's
 * source ("source:<record id>:<n>") or passageId joins to it. That is how raw files such as train-stage1-frozen.jsonl,
 * whose rows carry no license, get one: pass .data/knowledge/sources/.
 *
 * Other options: --force (overwrite an existing OUT), --json (counts as JSON).
 */
import { createReadStream, createWriteStream, existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { createGunzip, createGzip } from "node:zlib";

export const NC = /\bBY[- ]NC\b|\bcc-by-nc\b|\bnon[- ]?commercial\b|\bNC[- ](?:SA|ND)\b/i;
export const ND = /\bBY[- ](?:NC[- ])?(?:SA[- ])?ND\b|\bcc-by(?:-nc)?-nd\b|\bno[- ]?derivatives?\b|\bNoDerivs\b/i;
export const NO_REUSE = /\bno[- ]reuse\b/i;
export const FIREWORKS = /fireworks/i;
/** Meta Model API writers: Muse Wonder, Muse Spark 1.x and its Contributor tier. Not Spark Open, which is open weights. */
export const META_API = /\bmuse-wonder|\bwonder-\d|\bmuse-spark-1\.\d|\bspark[- ]1\.\d|\bcontributor\b/i;
/** Rows no model wrote: code templates, a person's own rows, public imports, evals written in the repo. */
export const NOT_MODEL = /^(?:template\b(?!, labelled)|person$|public$|human$)|no model writer|written by the coding agent or a script/i;

const str = (v) => (typeof v === "string" && v.trim() ? v : null);

/** The source record id a raw row points at, or null. "source:us-bls:abc:3" -> "us-bls:abc". */
export function recordIdOf(row) {
  for (const v of [row?.source, row?.passageId]) {
    const s = str(v);
    if (s && s.startsWith("source:") && s.lastIndexOf(":") > 7) return s.slice(7, s.lastIndexOf(":"));
  }
  return null;
}

export function licenseOf(row, { records, license } = {}) {
  const rel = row?.release ?? {};
  const own = [rel.row_license, rel.source_license, row?.row_license, row?.source_license, row?.license].map(str).filter(Boolean);
  if (own.length) return { text: own.join(" | "), from: "row" };
  const id = recordIdOf(row);
  if (id && records?.has(id)) return { text: records.get(id), from: "source-record" };
  if (str(license)) return { text: license, from: "--license" };
  return { text: null, from: "none" };
}

export function writerOf(row, { writer } = {}) {
  const w = [row?.release?.writer, row?.lineage?.writer, row?.writer, row?.writer_model, row?.writerModel].map(str).find(Boolean);
  if (w) return { text: w, from: "row" };
  if (str(writer)) return { text: writer, from: "--writer" };
  return { text: null, from: "none" };
}

/** Every flag that applies to a row, and the first reason it would be dropped under `opts`. */
export function classify(row, opts = {}) {
  const lic = licenseOf(row, opts);
  const wr = writerOf(row, opts);
  const l = lic.text ?? "";
  const w = wr.text ?? "";
  const flags = {
    nd: ND.test(l),
    noReuse: NO_REUSE.test(l),
    nc: NC.test(l),
    fireworks: FIREWORKS.test(w),
    metaApi: META_API.test(w),
    modelWritten: !!wr.text && !NOT_MODEL.test(w),
    unknownWriter: !wr.text,
    unknownLicense: !lic.text,
  };
  const order = [
    ["nd", flags.nd],
    ["no-reuse", flags.noReuse],
    ["nc", flags.nc],
    ["fireworks", opts.dropFireworks && flags.fireworks],
    ["meta-api", opts.dropMetaApi && flags.metaApi],
    ["model-written", opts.dropModelWritten && flags.modelWritten],
    ["unknown-writer", opts.dropUnknownWriter && flags.unknownWriter],
    ["unknown-license", opts.dropUnknownLicense && flags.unknownLicense],
  ];
  const reason = order.find(([, hit]) => hit)?.[0] ?? null;
  return { flags, reason, license: lic, writer: wr };
}

/** Reads SourceRecord JSONL files (or every .jsonl in a folder) into id -> license. */
export async function loadRecords(paths) {
  const map = new Map();
  for (const p of paths) {
    const files = statSync(p).isDirectory() ? readdirSync(p).filter((f) => /\.jsonl(\.gz)?$/.test(f)).sort().map((f) => path.join(p, f)) : [p];
    for (const f of files) {
      for await (const line of lines(f)) {
        if (!line.trim()) continue;
        try {
          const r = JSON.parse(line);
          if (str(r?.id) && str(r?.license)) map.set(r.id, r.license);
        } catch {
          // A broken record line can't name a license; rows that point at it count as unknown.
        }
      }
    }
  }
  return map;
}

async function* lines(file) {
  const raw = createReadStream(file);
  const input = file.endsWith(".gz") ? raw.pipe(createGunzip()) : raw;
  yield* createInterface({ input, crlfDelay: Infinity });
}

/** Rows of IN, in order. A .json file must be an array. Bad JSONL lines come back as { bad: line }. */
async function* rows(file) {
  if (file.endsWith(".json")) {
    const data = JSON.parse(readFileSync(file, "utf8"));
    if (!Array.isArray(data)) throw new Error(`${file}: a .json input must be an array of rows`);
    for (const r of data) yield { row: r };
    return;
  }
  for await (const line of lines(file)) {
    if (!line.trim()) continue;
    try {
      yield { row: JSON.parse(line), line };
    } catch {
      yield { bad: line };
    }
  }
}

function sameFile(a, b) {
  const real = (p) => (existsSync(p) ? realpathSync(p) : path.resolve(p));
  return real(a) === real(b);
}

/** Filters IN into OUT (or only counts, without OUT). Returns the counts. */
export async function filterFile(input, out, opts = {}) {
  if (out && sameFile(input, out)) throw new Error("--out is the input file; this filter never changes its input");
  if (out && existsSync(out) && !opts.force) throw new Error(`${out} exists; pass --force to replace it`);
  const counts = { input, out: out ?? null, read: 0, kept: 0, badLines: 0, dropped: {}, flagged: {}, licenseFrom: {}, writerFrom: {}, writers: {} };
  const kept = [];
  let sink = null;
  if (out && !out.endsWith(".json")) {
    await mkdir(path.dirname(path.resolve(out)), { recursive: true });
    const file = createWriteStream(out);
    sink = out.endsWith(".gz") ? createGzip() : null;
    if (sink) sink.pipe(file);
    sink = sink ?? file;
    sink.done = new Promise((resolve, reject) => file.on("finish", resolve).on("error", reject));
  }
  for await (const { row, line, bad } of rows(input)) {
    if (bad !== undefined) {
      counts.badLines++;
      continue;
    }
    counts.read++;
    const c = classify(row, opts);
    for (const [k, v] of Object.entries(c.flags)) if (v) counts.flagged[k] = (counts.flagged[k] ?? 0) + 1;
    counts.licenseFrom[c.license.from] = (counts.licenseFrom[c.license.from] ?? 0) + 1;
    counts.writerFrom[c.writer.from] = (counts.writerFrom[c.writer.from] ?? 0) + 1;
    const w = c.writer.text ?? "(none)";
    counts.writers[w] = (counts.writers[w] ?? 0) + 1;
    if (c.reason) {
      counts.dropped[c.reason] = (counts.dropped[c.reason] ?? 0) + 1;
      continue;
    }
    counts.kept++;
    if (sink) {
      if (!sink.write((line ?? JSON.stringify(row)) + "\n")) await new Promise((r) => sink.once("drain", r));
    } else if (out) kept.push(row);
  }
  if (sink) {
    sink.end();
    await sink.done;
  } else if (out) {
    await mkdir(path.dirname(path.resolve(out)), { recursive: true });
    await new Promise((resolve, reject) => createWriteStream(out).on("error", reject).end(JSON.stringify(kept), resolve));
  }
  return counts;
}

export function parseArgs(argv) {
  const opts = { sourceRecords: [] };
  const take = (i, name) => {
    if (i + 1 >= argv.length || argv[i + 1].startsWith("--")) throw new Error(`${name} needs a value`);
    return argv[i + 1];
  };
  const bool = { "--drop-fireworks": "dropFireworks", "--drop-meta-api": "dropMetaApi", "--drop-model-written": "dropModelWritten", "--drop-unknown-writer": "dropUnknownWriter", "--drop-unknown-license": "dropUnknownLicense", "--force": "force", "--json": "json" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (bool[a]) opts[bool[a]] = true;
    else if (a === "--out") opts.out = take(i++, a);
    else if (a === "--writer") opts.writer = take(i++, a);
    else if (a === "--license") opts.license = take(i++, a);
    else if (a === "--source-records") opts.sourceRecords.push(take(i++, a));
    else if (a.startsWith("--")) throw new Error(`unknown option ${a}`);
    else if (!opts.input) opts.input = a;
    else throw new Error(`one input file at a time; got ${opts.input} and ${a}`);
  }
  if (!opts.input) throw new Error("usage: node scripts/data-rights/filter.mjs IN [--out OUT] [options]; see the header of this file");
  return opts;
}

function report(c) {
  const fmt = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v.toLocaleString("en-US")}`).join(", ") || "none";
  const lines = [
    `${c.input}: read ${c.read.toLocaleString("en-US")}, kept ${c.kept.toLocaleString("en-US")}${c.out ? ` (written to ${c.out})` : " (count only, nothing written)"}`,
    `  dropped by first reason: ${fmt(c.dropped)}`,
    `  flagged, a row can carry several: ${fmt(c.flagged)}`,
    `  license from: ${fmt(c.licenseFrom)}; writer from: ${fmt(c.writerFrom)}`,
    `  writers: ${fmt(c.writers)}`,
  ];
  if (c.badLines) lines.push(`  unreadable lines skipped: ${c.badLines}`);
  if (c.licenseFrom.none) lines.push(`  warning: ${c.licenseFrom.none.toLocaleString("en-US")} rows have no license, so NC and ND can't be seen on them. Pass --source-records or --license, or --drop-unknown-license.`);
  return lines.join("\n");
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  opts.records = opts.sourceRecords.length ? await loadRecords(opts.sourceRecords) : null;
  const counts = await filterFile(opts.input, opts.out, opts);
  console.log(opts.json ? JSON.stringify(counts, null, 2) : report(counts));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((e) => {
    console.error(`filter: ${e.message}`);
    process.exit(1);
  });
}
