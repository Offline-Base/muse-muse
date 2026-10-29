/**
 * The device results report (docs/DEVICES.md "Reading results"):
 *
 *   npx tsx scripts/devices/report.ts           prints the report for every result.json under devices/results/
 *   npx tsx scripts/devices/report.ts --write   also writes devices/results/report.md and devices/results/picker.json
 *
 * --dir <folder> reads results from another folder (the report's links stay relative to the repo's root).
 */
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { pickerSummary, reportMarkdown, reportRows } from "@/lib/devices/report";
import { readResult } from "@/lib/devices/result";
import type { Result } from "@/lib/devices/types";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** Every result.json under dir, read and schema-checked, in path order. */
export function readResults(dir: string): Result[] {
  const files: string[] = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile() && entry.name === "result.json") files.push(p);
    }
  };
  if (existsSync(dir)) walk(dir);
  return files.sort().map(readResult);
}

function main(argv: string[]): number {
  let dir = path.join(REPO_ROOT, "devices", "results");
  let write = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--write") write = true;
    else if (argv[i] === "--dir" && argv[i + 1]) dir = path.resolve(argv[++i]);
    else {
      console.error("Usage: npx tsx scripts/devices/report.ts [--write] [--dir <folder>]");
      return 2;
    }
  }
  const rows = reportRows(readResults(dir));
  const markdown = reportMarkdown(rows);
  process.stdout.write(markdown);
  if (write) {
    const out = path.join(REPO_ROOT, "devices", "results");
    writeFileSync(path.join(out, "report.md"), markdown);
    writeFileSync(path.join(out, "picker.json"), `${JSON.stringify(pickerSummary(rows), null, 2)}\n`);
    // Both files carry the newest result's stamp rather than the time, so a rerun on the same results changes nothing.
    console.error(`Wrote ${path.relative(REPO_ROOT, out)}/report.md and picker.json from ${rows.length} result${rows.length === 1 ? "" : "s"}.`);
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exit(main(process.argv.slice(2)));
}
