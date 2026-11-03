/**
 * Sums the Meta spend of a set of builds and their polish refinements, from the public build route
 * (GET /api/builds/<id> gives each build's costUsd, refinements included, since a refinement is a build of kind
 * "refine"). Prints a table and what is left of the budget, and exits 1 when over. No key, no model call, no spend.
 *   npx tsx scripts/spend-ledger.ts .data/demo-batch-A.json .data/demo-batch-B.json
 *   npx tsx scripts/spend-ledger.ts <buildId> <buildId> --budget=200
 *   --polish=<file,file>   polish results to take refinement ids from (default: every .data/polish-*.json)
 *   --url=<site>           another deployment
 *   --json                 print the ledger as JSON instead of the table
 * The public route doesn't list a product's refinements, so refinement ids come from polish files, plus each product's
 * latest build when that is a later build than the batch's.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { arg, getJson, siteArg, words } from "./automation";
import { batchBuilds, ledgerOf, ledgerTable, mapLimit, parseBuildStatus, refineIdsFrom, type BatchBuild, type BuildView, type Ledger, type LedgerRow } from "./batch/logic";

export const DEFAULT_BUDGET_USD = 200;

export type StatusFetcher = (buildId: string) => Promise<BuildView | { error: string }>;

/** Reads one build's public status. */
export function siteFetcher(site: string): StatusFetcher {
  return async (buildId) => {
    const r = await getJson(site, `/api/builds/${buildId}`);
    return parseBuildStatus(buildId, r.status, r.json);
  };
}

/**
 * The ledger for these builds: each build's cost, plus each refinement in `refineIds` and the product's latest build when
 * it is newer than the batch's build. `known` is views already fetched this round, so polish-batch doesn't read twice.
 */
export async function collectLedger(
  builds: readonly BatchBuild[],
  refineIds: ReadonlyMap<string, readonly string[]>,
  fetch: StatusFetcher,
  budgetUsd: number,
  known: ReadonlyMap<string, BuildView | { error: string }> = new Map(),
): Promise<Ledger> {
  const read = (id: string) => (known.has(id) ? Promise.resolve(known.get(id)!) : fetch(id));
  const views = await mapLimit(builds, 8, (b) => read(b.buildId));
  const rows: Array<Omit<LedgerRow, "totalUsd" | "unknown">> = await mapLimit(builds, 4, async (b, i) => {
    const v = views[i];
    const view = "status" in v ? (v as BuildView) : null;
    const ids = [...(refineIds.get(b.buildId) ?? [])];
    if (view?.latestBuildId && view.latestBuildId !== b.buildId && !ids.includes(view.latestBuildId)) ids.push(view.latestBuildId);
    const refinements = await mapLimit(ids, 4, async (id) => {
      const r = await read(id);
      return "status" in r ? { buildId: id, status: (r as BuildView).status, costUsd: (r as BuildView).costUsd } : { buildId: id, status: null, costUsd: null };
    });
    return { label: b.label, buildId: b.buildId, slug: view?.slug ?? null, status: view?.status ?? ("error" in v ? String(v.error) : null), buildCostUsd: view?.costUsd ?? null, refinements };
  });
  return ledgerOf(rows, budgetUsd);
}

/** The ids and files on the command line: words ending in .json are demo-batch files, the rest build ids. */
export function readBatchArgs(argv: readonly string[] = process.argv): BatchBuild[] {
  const w = words(argv).map((x) => x.trim()).filter(Boolean);
  const files = w.filter((x) => x.endsWith(".json")).map((path) => {
    if (!existsSync(path)) throw new Error(`${path} doesn't exist.`);
    return { path, json: JSON.parse(readFileSync(path, "utf8")) as unknown };
  });
  const builds = batchBuilds(files, w.filter((x) => !x.endsWith(".json")));
  if (!builds.length) throw new Error("Give one or more .data/demo-batch-*.json files or build ids.");
  return builds;
}

/** The polish files to read refinement ids from: --polish, or every .data/polish-*.json. */
export function polishFiles(argv: readonly string[] = process.argv): unknown[] {
  const given = arg("polish", argv);
  const paths = given !== undefined ? given.split(",").filter(Boolean) : existsSync(".data") ? readdirSync(".data").filter((f) => /^polish-.*\.json$/.test(f)).map((f) => join(".data", f)) : [];
  return paths.map((p) => JSON.parse(readFileSync(p, "utf8")) as unknown);
}

export function budgetArg(argv: readonly string[] = process.argv): number {
  const raw = arg("budget", argv);
  if (raw === undefined) return DEFAULT_BUDGET_USD;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`--budget=${raw} isn't a dollar amount.`);
  return n;
}

async function main(): Promise<void> {
  const builds = readBatchArgs();
  const site = siteArg();
  const ledger = await collectLedger(builds, refineIdsFrom(polishFiles()), siteFetcher(site), budgetArg());
  console.log(process.argv.includes("--json") ? JSON.stringify(ledger, null, 2) : ledgerTable(ledger));
  if (ledger.over) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
