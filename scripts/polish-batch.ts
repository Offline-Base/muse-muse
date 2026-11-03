/**
 * Polishes a batch's builds as they ship: polls each build's public status, and when one is live or partial starts its
 * polish (POST /api/builds/<id>/polish, the final Muse Wonder UI pass, a refinement), at most --concurrency at once,
 * and stops starting new ones when the spend ledger (scripts/spend-ledger.ts) says the budget is used. A failed polish
 * leaves the live product as it was (lib/pipeline/workflow.ts, refinements).
 *   npm run polish-batch -- .data/demo-batch-A.json .data/demo-batch-B.json
 *   npm run polish-batch -- <buildId> <buildId>
 *   --dry                 read the statuses and the ledger and print the plan; start nothing (no key needed)
 *   --concurrency=8       polishes in flight at once
 *   --budget=200          Meta dollars for the builds and their polishes together
 *   --reserve=2           dollars held for each polish in flight and for the next one, since a polish's cost lands as it runs
 *   --poll=60             seconds between rounds
 *   --focus-file=<path>   an audit file from scripts/audit-batch.ts (or {buildId or slug: text}); each failing product's
 *                         focus text goes with its polish
 *   --resume=<path>       carry on from an earlier polish file (keeps what started, never polishes a build twice)
 *   --max-hours=8         stop polling after this long (resume later)
 *   --url=<site>          another deployment
 * Uses AUTOMATION_SECRET from .env.local (scripts/automation.ts), sent only as the Authorization header and never printed.
 * Saves progress to .data/polish-<time>.json after every change.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { env } from "@/lib/env";
import { arg, postJson, resultsFile, siteArg, type PostResult } from "./automation";
import {
  focusFor,
  focusMap,
  mapLimit,
  nextState,
  parsePolishAnswer,
  planStarts,
  queueDone,
  stateCounts,
  type BatchBuild,
  type BuildView,
  type Ledger,
  type PolishItem,
} from "./batch/logic";
import { budgetArg, collectLedger, readBatchArgs, siteFetcher, type StatusFetcher } from "./spend-ledger";

/** States a round still reads: everything else is final, and its last answer is kept for the ledger. */
const LIVE_STATES = new Set(["waiting", "ready", "polishing"]);
/** A build that keeps answering 409 or 5xx is given up on after this many tries. */
export const MAX_ATTEMPTS = 6;
/** How long a polish that answered with no build id counts as in flight. */
export const UNTRACKED_MINUTES = 30;

function num(name: string, fallback: number, min = 0): number {
  const raw = arg(name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min) throw new Error(`--${name}=${raw} isn't a number of at least ${min}.`);
  return n;
}

/** The items for these builds, carrying over what a resumed file recorded for the same build ids. */
export function initialItems(builds: readonly BatchBuild[], resumed: readonly PolishItem[] = []): PolishItem[] {
  const prior = new Map(resumed.map((i) => [i.buildId, i]));
  return builds.map((b) => {
    const p = prior.get(b.buildId);
    // A ready item from an earlier run is read again; anything that started stays started.
    return p ? { ...p, label: b.label, state: p.state === "ready" ? "waiting" : p.state } : { label: b.label, buildId: b.buildId, state: "waiting", refineIds: [], attempts: 0 };
  });
}

/** One round: read what may have changed into `cache`, update each item's state, and return the ledger. */
export async function readRound(items: PolishItem[], builds: readonly BatchBuild[], cache: Map<string, BuildView | { error: string }>, fetch: StatusFetcher, budgetUsd: number, now: Date): Promise<Ledger> {
  const toRead = new Set<string>();
  for (const i of items) {
    if (LIVE_STATES.has(i.state) || !cache.has(i.buildId)) toRead.add(i.buildId);
    for (const r of i.refineIds) {
      const seen = cache.get(r);
      if (!seen || !("terminal" in seen) || !seen.terminal) toRead.add(r);
    }
  }
  const ids = [...toRead];
  const views = await mapLimit(ids, 8, fetch);
  ids.forEach((id, k) => cache.set(id, views[k]));
  for (const i of items) {
    const b = cache.get(i.buildId);
    const refines = i.refineIds.map((r) => cache.get(r)).filter((x): x is BuildView | { error: string } => Boolean(x));
    i.state = nextState(i, b, refines, now);
    if (b && "status" in b) {
      i.buildStatus = b.status;
      i.slug = b.slug;
      i.liveUrl = b.liveUrl;
    } else if (b && i.state === "error") i.note = `build: ${b.error}`;
    if (i.refineIds.length) i.refineStatus = Object.fromEntries(i.refineIds.map((r) => { const v = cache.get(r); return [r, v && "status" in v ? v.status : "unread"]; }));
  }
  const refineIds = new Map(items.map((i) => [i.buildId, i.refineIds]));
  return collectLedger(builds, refineIds, fetch, budgetUsd, cache);
}

export interface StartOutcome {
  /** Stop the whole run: the route isn't there, or the key is refused. */
  stop?: { message: string; exitCode: number };
  /** No polish may start before this (a 429 or 503 for the site). */
  pauseUntil?: Date;
}

/** Applies one polish answer to its item. */
export function applyAnswer(item: PolishItem, res: PostResult, site: string, now: Date): StartOutcome {
  const a = parsePolishAnswer(res.status, res.json, site);
  item.attempts += 1;
  if (a.kind === "started") {
    item.state = "polishing";
    item.startedAt = now.toISOString();
    item.refineIds = [...new Set([...item.refineIds, ...a.refineIds])];
    item.notBefore = undefined;
    if (!a.refineIds.length) {
      item.untrackedUntil = new Date(now.getTime() + UNTRACKED_MINUTES * 60_000).toISOString();
      item.note = `started, but the answer named no build id to follow; counted in flight for ${UNTRACKED_MINUTES} minutes`;
    } else item.note = undefined;
    return {};
  }
  if (a.kind === "route_missing") {
    item.attempts -= 1;
    return { stop: { message: a.message, exitCode: 2 } };
  }
  if (a.kind === "fatal") {
    item.attempts -= 1;
    return { stop: { message: `Polish refused for ${item.label}: ${a.reason}`, exitCode: 1 } };
  }
  if (a.kind === "retry") {
    if (item.attempts >= MAX_ATTEMPTS) {
      item.state = "refused";
      item.note = `gave up after ${item.attempts} tries: ${a.reason}`;
      return {};
    }
    const at = new Date(now.getTime() + a.afterSeconds * 1000);
    item.notBefore = at.toISOString();
    item.note = `retry after ${a.afterSeconds}s: ${a.reason}`;
    return res.status === 429 || res.status === 503 ? { pauseUntil: at } : {};
  }
  item.state = "refused";
  item.note = a.reason;
  return {};
}

function saver(resume: string | undefined): { path: string; save(data: unknown): void } {
  if (!resume) return resultsFile("polish");
  return {
    path: resume,
    save(data: unknown) {
      mkdirSync(dirname(resume), { recursive: true });
      writeFileSync(resume, `${JSON.stringify(data, null, 2)}\n`);
    },
  };
}

const money = (n: number) => `$${n.toFixed(2)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const dry = process.argv.includes("--dry");
  const builds = readBatchArgs();
  const site = siteArg();
  const concurrency = Math.floor(num("concurrency", 8, 1));
  const budgetUsd = budgetArg();
  const reserveUsd = num("reserve", 2);
  const pollMs = num("poll", 60, 5) * 1000;
  const deadline = Date.now() + num("max-hours", 8, 0.01) * 3_600_000;
  const focusPath = arg("focus-file");
  const focus = focusPath ? focusMap(JSON.parse(readFileSync(focusPath, "utf8")) as unknown) : new Map<string, string>();
  const resume = arg("resume");
  if (resume && !existsSync(resume)) throw new Error(`--resume=${resume} doesn't exist.`);
  const resumed = resume ? (((JSON.parse(readFileSync(resume, "utf8")) as { items?: PolishItem[] }).items ?? []) as PolishItem[]) : [];
  const secret = env.automationSecret;
  if (!dry && !secret) throw new Error("AUTOMATION_SECRET isn't in .env.local. It must match the one on Vercel Production.");

  const items = initialItems(builds, resumed);
  const cache = new Map<string, BuildView | { error: string }>();
  const fetch = siteFetcher(site);
  const file = dry ? null : saver(resume);
  const startedAt = new Date().toISOString();
  let ledger: Ledger | null = null;
  const save = () => file?.save({ site, budgetUsd, reserveUsd, concurrency, startedAt, updatedAt: new Date().toISOString(), spentUsd: ledger?.spentUsd, remainingUsd: ledger?.remainingUsd, items });
  let pausedUntil: Date | undefined;

  if (focusPath) console.log(`Focus text for ${new Set([...focus.values()]).size} product(s) from ${focusPath}.`);
  for (;;) {
    const now = new Date();
    ledger = await readRound(items, builds, cache, fetch, budgetUsd, now);
    const move = planStarts(items, { concurrency, budgetUsd, reserveUsd, spentUsd: ledger.spentUsd, now, pausedUntil });
    const line = `${now.toLocaleTimeString()}  ${stateCounts(items)}  spent ${money(ledger.spentUsd)} of ${money(budgetUsd)}${move.held ? `  (held: ${move.held})` : ""}`;

    if (dry) {
      console.log(line);
      for (const i of items) {
        const starts = move.start.includes(i);
        console.log(`  ${i.state.padEnd(13)} ${i.label.padEnd(34)} ${i.buildStatus ?? "?"}${starts ? "  -> would start now" : ""}${focusFor(focus, i) ? "  (with focus text)" : ""}${i.note ? `  ${i.note}` : ""}`);
      }
      const ready = items.filter((i) => i.state === "ready").length;
      console.log(`\n${move.start.length} would start now (of ${ready} ready, ${move.inFlight} in flight, limit ${concurrency}). Each start holds ${money(reserveUsd)} of the ${money(ledger.remainingUsd)} left. --dry started nothing.`);
      return;
    }

    for (const item of move.start) {
      const text = focusFor(focus, item);
      const res = await postJson(site, `/api/builds/${item.buildId}/polish`, text ? { focus: text } : {}, secret!).catch(
        (err: unknown): PostResult => ({ status: 0, json: { error: "network", message: err instanceof Error ? err.message : String(err) } }),
      );
      const out = applyAnswer(item, res, site, new Date());
      save();
      if (out.stop) {
        console.error(`\n${out.stop.message}`);
        console.error(`Progress saved in ${file!.path}.`);
        process.exitCode = out.stop.exitCode;
        return;
      }
      if (out.pauseUntil) pausedUntil = out.pauseUntil;
      console.log(`  ${item.state === "polishing" ? "polish   " : "not yet  "} ${item.label}${item.refineIds.length ? ` ${site}/b/${item.refineIds.at(-1)}` : ""}${item.note ? `  ${item.note}` : ""}`);
    }
    save();
    console.log(line);

    if (queueDone(items, move)) {
      if (move.held === "budget") console.log(`\nStopped starting polishes: ${money(ledger.spentUsd)} spent plus ${money(reserveUsd)} for the next one would pass the ${money(budgetUsd)} budget.`);
      break;
    }
    if (Date.now() > deadline) {
      console.log(`\n--max-hours reached with work left. Carry on with --resume=${file!.path}.`);
      process.exitCode = 3;
      break;
    }
    await sleep(pollMs);
  }
  ledger = await readRound(items, builds, cache, fetch, budgetUsd, new Date());
  save();
  const polished = items.filter((i) => i.state === "polished").length;
  console.log(`\n${stateCounts(items)}. ${polished} polished. Spent ${money(ledger.spentUsd)} of ${money(budgetUsd)}. Saved in ${file!.path}.`);
  console.log(`For the full table: npx tsx scripts/spend-ledger.ts ${builds.length > 6 ? "<the same files>" : builds.map((b) => b.buildId).join(" ")} --polish=${file!.path}`);
  if (ledger.over) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
