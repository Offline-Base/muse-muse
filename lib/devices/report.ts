/**
 * The device results as one table, one line per phone tier and Mac, and a small summary the run-locally page's device
 * picker can import (docs/DEVICES.md "From the verdict to the picker" and "Reading results"). scripts/devices/report.ts
 * reads every result.json under devices/results/ and writes devices/results/report.md and devices/results/picker.json
 * from these.
 *
 * A tier changes only when its best file is usable or slow on every device tested in it, by the newest run of each
 * device and file. Smoke results only show that the path works, so they stay out of the tiers.
 */
import { PHONE_RAM_TIERS_GIB, resultDir } from "@/lib/devices/subjects";
import type { Backend, Cloud, DeviceOs, Rating, Result, StepEnd, SubjectKind } from "@/lib/devices/types";

/** What the picker says for each rating. */
export const PICKER_WORDS: Readonly<Record<Rating, string>> = {
  usable: "Runs",
  slow: "Runs slowly",
  unusable: "Won't run here: use Try it live",
  failed: "Won't run here: use Try it live",
};

const RATING_ORDER: readonly Rating[] = ["usable", "slow", "unusable", "failed"];

export interface ReportRow {
  cloud: Cloud;
  device: string;
  slug: string;
  os: DeviceOs;
  ramGiB: number;
  soc: string | null;
  subjectId: string;
  kind: SubjectKind;
  quant: string;
  fileBytes: number;
  status: Result["status"];
  rating: Rating;
  /** The picker's words for the rating. */
  words: string;
  backend: Backend | null;
  genTps: number | null;
  promptTps: number | null;
  answersRight: number;
  answersTotal: number;
  /** The largest peak resident memory of any bench or answer, the lowest MemAvailable and the largest drop in it. */
  peakBytes: number | null;
  minAvailableBytes: number | null;
  availDropBytes: number | null;
  maxTempC: number | null;
  /** Each backend in a few words: "gpu 13.2 t/s, 3/3 right", "npu not run: device not here". */
  backends: string[];
  reasons: string[];
  notes: string[];
  stamp: string;
  /** resultDir(...), relative to the repo's root. */
  path: string;
}

const fmt = (n: number) => (n >= 100 ? String(Math.round(n)) : n >= 10 ? n.toFixed(1) : n.toFixed(2));

/** Bytes as "16.8 GB" or "92 MB". */
export function sizeText(bytes: number | null): string {
  if (bytes === null) return "";
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`;
}

function endShort(end: StepEnd, why: string | null): string {
  if (end === "killed") return why === "lmk" ? "killed by the low-memory killer" : "killed";
  if (end === "crashed") return `crashed (${why ?? "signal"})`;
  if (end === "timeout") return "out of time";
  if (end === "error") return "error";
  if (end === "skipped") {
    const words: Record<string, string> = {
      unavailable: "device not here",
      nobuild: "no build",
      android_sdk: "needs Android 14",
      time: "out of time",
      model: "model check failed",
      ram: "not enough RAM",
      stopped: "kit stopped first",
    };
    return `not run: ${words[why ?? ""] ?? why ?? "skipped"}`;
  }
  return "ok";
}

const maxOf = (values: Array<number | null>) => {
  const vs = values.filter((v): v is number => v !== null);
  return vs.length ? Math.max(...vs) : null;
};
const minOf = (values: Array<number | null>) => {
  const vs = values.filter((v): v is number => v !== null);
  return vs.length ? Math.min(...vs) : null;
};

/** One row per result: phones by RAM, then Linux boards, then Macs, each by device, file size and time. */
export function reportRows(results: Result[]): ReportRow[] {
  const rows = results.map((r): ReportRow => {
    const backends = r.backends.map((b) => {
      if (b.genTps !== null) {
        const right = r.completions.filter((c) => c.backend === b.backend && c.right).length;
        const asked = r.completions.filter((c) => c.backend === b.backend && c.end !== "skipped").length;
        const tail = b.end === "ok" ? "" : `, bench ${endShort(b.end, b.why)}`;
        return `${b.backend} ${fmt(b.genTps)} t/s, ${right}/${asked} right${tail}`;
      }
      return `${b.backend} ${endShort(b.end, b.why)}`;
    });
    return {
      cloud: r.cloud,
      device: r.device.name,
      slug: r.device.slug,
      os: r.device.os,
      ramGiB: r.device.marketedRamGiB,
      soc: r.device.soc ?? null,
      subjectId: r.subject.id,
      kind: r.subject.kind,
      quant: r.subject.quant,
      fileBytes: r.subject.bytes,
      status: r.status,
      rating: r.verdict.rating,
      words: PICKER_WORDS[r.verdict.rating],
      backend: r.verdict.backend,
      genTps: r.verdict.genTps,
      promptTps: r.verdict.promptTps,
      answersRight: r.verdict.answersRight,
      answersTotal: r.verdict.answersTotal,
      peakBytes: maxOf([...r.backends.map((b) => b.peakRssBytes), ...r.completions.map((c) => c.peakRssBytes)]),
      minAvailableBytes: minOf(r.backends.map((b) => b.minAvailableBytes)),
      availDropBytes: maxOf(r.backends.map((b) => b.availDropBytes)),
      maxTempC: maxOf(r.backends.map((b) => b.maxTempC)),
      backends,
      reasons: r.verdict.reasons,
      notes: r.notes,
      stamp: r.stamp,
      path: resultDir(r.cloud, r.device.slug, r.subject.id, r.stamp),
    };
  });
  const osOrder: Record<DeviceOs, number> = { android: 0, ios: 1, linux: 2, macos: 3 };
  return rows.sort(
    (a, b) =>
      osOrder[a.os] - osOrder[b.os] ||
      a.ramGiB - b.ramGiB ||
      a.device.localeCompare(b.device) ||
      a.fileBytes - b.fileBytes ||
      a.stamp.localeCompare(b.stamp),
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Tiers

export interface TierDevice {
  slug: string;
  name: string;
  cloud: Cloud;
  subjectId: string;
  rating: Rating;
  backend: Backend | null;
  genTps: number | null;
}

export interface PickerTier {
  os: "android" | "macos";
  ramGiB: number;
  /** True when the picker should change for this tier: its best file ran usable or slow on every device tested. */
  changes: boolean;
  /** Null when nothing was tested in this tier: the picker keeps what it says today. */
  rating: Rating | null;
  words: string | null;
  /** The picker's line with its evidence in a few words: "Runs slowly: about 3.01 tokens a second (Q3_K_M)". */
  line: string | null;
  /** The best file that ran usable or slow on every device tested, or null. */
  subjectId: string | null;
  /** "base" when a public stand-in made the case, "tuned" for our own file. */
  kind: SubjectKind | null;
  quant: string | null;
  fileBytes: number | null;
  /** That file's slowest device's generation speed. */
  genTps: number | null;
  /** The devices tested: with the best file when there is one, otherwise each device's best run. */
  devices: TierDevice[];
  /** One plain sentence with the evidence. */
  evidence: string;
}

export interface PickerSummary {
  schema: 1;
  /** How many results the summary read (smoke runs included) and the newest one's stamp. */
  results: number;
  newest: string | null;
  tiers: PickerTier[];
}

/** The newest row per device and file, without smoke runs. */
function latestRuns(rows: ReportRow[]): ReportRow[] {
  const byKey = new Map<string, ReportRow>();
  for (const row of rows) {
    if (row.kind === "smoke") continue;
    const key = `${row.slug}\n${row.subjectId}`;
    const seen = byKey.get(key);
    if (!seen || seen.stamp < row.stamp) byKey.set(key, row);
  }
  return [...byKey.values()];
}

function tierDevice(r: ReportRow): TierDevice {
  return { slug: r.slug, name: r.device, cloud: r.cloud, subjectId: r.subjectId, rating: r.rating, backend: r.backend, genTps: r.genTps };
}

function tier(rows: ReportRow[], os: "android" | "macos", ramGiB: number): PickerTier {
  const pool = latestRuns(rows.filter((r) => r.os === os && r.ramGiB === ramGiB));
  const slugs = [...new Set(pool.map((r) => r.slug))];
  const kind = os === "android" ? "phone" : "Mac";
  const empty = { subjectId: null, kind: null, quant: null, fileBytes: null, genTps: null };
  if (slugs.length === 0) {
    return {
      os, ramGiB, changes: false, rating: null, words: null, line: null, ...empty, devices: [],
      evidence: `No ${kind} with ${ramGiB} GB tested yet.`,
    };
  }
  const plural = (n: number) => `${n} ${kind}${n === 1 ? "" : "s"}`;
  const works = [...new Set(pool.map((r) => r.subjectId))]
    .map((id) => {
      const runs = slugs.map((slug) => pool.find((r) => r.slug === slug && r.subjectId === id));
      const ok = runs.every((r) => r && (r.rating === "usable" || r.rating === "slow"));
      return { id, runs: runs.filter((r): r is ReportRow => Boolean(r)), ok };
    })
    .filter((s) => s.ok)
    .sort((a, b) => b.runs[0].fileBytes - a.runs[0].fileBytes);
  const best = works[0];
  if (best) {
    const rating: Rating = best.runs.some((r) => r.rating === "slow") ? "slow" : "usable";
    const slowest = best.runs.reduce((a, b) => ((b.genTps ?? 0) < (a.genTps ?? 0) ? b : a));
    const first = best.runs[0];
    const speeds = best.runs.map((r) => `${r.device} ${fmt(r.genTps ?? 0)} on ${r.backend}`).join(", ");
    return {
      os,
      ramGiB,
      changes: true,
      rating,
      words: PICKER_WORDS[rating],
      line: `${PICKER_WORDS[rating]}: about ${fmt(slowest.genTps ?? 0)} tokens a second (${first.quant})`,
      subjectId: best.id,
      kind: first.kind,
      quant: first.quant,
      fileBytes: first.fileBytes,
      genTps: slowest.genTps,
      devices: best.runs.map(tierDevice),
      evidence:
        `${best.id} (${sizeText(first.fileBytes)}) ran ${rating === "slow" ? "slowly" : "well"} on all ${plural(slugs.length)} ` +
        `tested, in tokens a second: ${speeds}.`,
    };
  }
  // Nothing works everywhere: each device's best run is the evidence, and the tier keeps "Won't run here".
  const bestPer = slugs.map((slug) => {
    const runs = pool.filter((r) => r.slug === slug);
    return runs.reduce((a, b) => (RATING_ORDER.indexOf(b.rating) < RATING_ORDER.indexOf(a.rating) ? b : a));
  });
  const rating: Rating = bestPer.some((r) => r.rating !== "failed") ? "unusable" : "failed";
  const said = bestPer
    .map((r) => `${r.device} with ${r.subjectId}: ${r.rating} (${r.reasons[r.reasons.length - 1] ?? "no reason given"})`)
    .join("; ");
  return {
    os,
    ramGiB,
    changes: false,
    rating,
    words: PICKER_WORDS[rating],
    line: PICKER_WORDS[rating],
    ...empty,
    devices: bestPer.map(tierDevice),
    evidence: `No file ran usable or slow on all ${plural(slugs.length)} tested. ${said}`,
  };
}

/** One tier per phone RAM size in the test matrix (and any other tested), then one per Mac RAM size tested. */
export function pickerTiers(rows: ReportRow[]): PickerTier[] {
  const tested = (os: DeviceOs) => rows.filter((r) => r.os === os && r.kind !== "smoke").map((r) => r.ramGiB);
  const phoneSizes = [...new Set([...PHONE_RAM_TIERS_GIB, ...tested("android")])].sort((a, b) => a - b);
  const macSizes = [...new Set(tested("macos"))].sort((a, b) => a - b);
  return [...phoneSizes.map((gib) => tier(rows, "android", gib)), ...macSizes.map((gib) => tier(rows, "macos", gib))];
}

/** The picker's summary: deterministic for the same results (it carries the newest result's stamp, not the time). */
export function pickerSummary(rows: ReportRow[]): PickerSummary {
  const newest = rows.reduce<string | null>((a, r) => (a === null || r.stamp > a ? r.stamp : a), null);
  return { schema: 1, results: rows.length, newest, tiers: pickerTiers(rows) };
}

// ---------------------------------------------------------------------------------------------------------------
// Markdown

const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\n/g, " ");
const CLOUD_NAMES: Readonly<Record<Cloud, string>> = { local: "this Mac", devicefarm: "Device Farm", qdc: "QDC" };

function table(rows: ReportRow[], linksFrom: string): string[] {
  const out = [
    "| Device | Where | RAM | File | Rating | Best backend | Generation | Prompt | Answers | Peak memory | Lowest free | Backends | Run |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  const link = (p: string) => (linksFrom && p.startsWith(`${linksFrom}/`) ? p.slice(linksFrom.length + 1) : p);
  for (const r of rows) {
    out.push(
      `| ${cell(r.device)} | ${CLOUD_NAMES[r.cloud]} | ${r.ramGiB} GB | ${cell(r.subjectId)} (${sizeText(r.fileBytes)}) | ${r.rating} | ` +
        `${r.backend ?? ""} | ${r.genTps === null ? "" : `${fmt(r.genTps)} t/s`} | ` +
        `${r.promptTps === null ? "" : `${fmt(r.promptTps)} t/s`} | ${r.answersTotal ? `${r.answersRight}/${r.answersTotal}` : ""} | ` +
        `${sizeText(r.peakBytes)} | ${sizeText(r.minAvailableBytes)} | ${cell(r.backends.join("; "))} | [${r.stamp}](${link(r.path)}) |`,
    );
  }
  return out;
}

/**
 * The report: the picker's line per tier with its evidence, every run with why it got its rating, then the smoke runs.
 * Its links to the run folders are relative to `linksFrom`, the report's own folder (devices/results, where
 * scripts/devices/report.ts writes report.md); "" keeps them relative to the repo's root.
 */
export function reportMarkdown(rows: ReportRow[], { linksFrom = "devices/results" }: { linksFrom?: string } = {}): string {
  const real = rows.filter((r) => r.kind !== "smoke");
  const smoke = rows.filter((r) => r.kind === "smoke");
  const out: string[] = ["# Device results", ""];
  out.push(
    `${real.length} run${real.length === 1 ? "" : "s"} of Muse Glimmer 30B files and ${smoke.length} smoke ` +
      `run${smoke.length === 1 ? "" : "s"}. Made by \`npx tsx scripts/devices/report.ts --write\` (docs/DEVICES.md "Reading results").`,
    "",
    "## What the picker says",
    "",
  );
  for (const t of pickerTiers(rows)) {
    const label = t.os === "android" ? `${t.ramGiB} GB phones` : `${t.ramGiB} GB Macs`;
    const head = t.rating === null ? "No change (nothing tested)." : `${t.changes ? "" : "No change: "}${t.line}.`;
    out.push(`- **${label}:** ${head}${t.rating === null ? "" : ` ${t.evidence}`}`);
  }
  out.push("");
  if (real.length) {
    out.push("## Every run", "", ...table(real, linksFrom), "");
    out.push("### Why each run got its rating", "");
    for (const r of real) {
      const notes = r.notes.length ? ` Notes: ${r.notes.join(" ")}` : "";
      out.push(`- ${r.device}, ${r.subjectId}, ${r.stamp}: ${r.rating}. ${r.reasons.join(" ")}${notes}`);
    }
    out.push("");
  }
  if (smoke.length) {
    out.push("## Smoke runs", "", "These only show that the path works on a device; their ratings say nothing about Glimmer.", "");
    out.push(...table(smoke, linksFrom), "");
  }
  return `${out.join("\n").trimEnd()}\n`;
}
