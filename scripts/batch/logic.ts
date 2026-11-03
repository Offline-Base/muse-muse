/**
 * The pure parts of the batch tools (scripts/polish-batch.ts, scripts/spend-ledger.ts, scripts/audit-batch.ts): reading
 * the build ids a batch started, reading the public build status route, the spend ledger's math and table, the polish
 * answer, and the polish queue's next move under the concurrency limit and the budget. Nothing here does I/O, so the
 * tests run it on made-up answers.
 */

/** Statuses after which a build never changes again (lib/types.ts TERMINAL_STATUSES). */
export const TERMINAL = new Set(["refused", "live", "partial", "failed"]);
/** A build that shipped a product a refinement can change (the messages route's rule). */
export const SHIPPED = new Set(["live", "partial"]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);

/** One build a batch started: a label (the demo note's id, or the id itself) and the build id. */
export interface BatchBuild {
  label: string;
  buildId: string;
}

/**
 * The builds in one or more demo-batch results files (`{site, started: [{id, buildId?}]}`, scripts/demo-batch.ts),
 * plus bare ids. Notes that failed to start have no buildId and are left out. The same build twice is kept once.
 */
export function batchBuilds(files: ReadonlyArray<{ path: string; json: unknown }>, ids: readonly string[] = []): BatchBuild[] {
  const out: BatchBuild[] = [];
  const seen = new Set<string>();
  const add = (label: string, buildId: string) => {
    if (seen.has(buildId)) return;
    seen.add(buildId);
    out.push({ label, buildId });
  };
  for (const f of files) {
    const started = (f.json as { started?: unknown } | null)?.started;
    if (!Array.isArray(started)) throw new Error(`${f.path} has no "started" list. Give a .data/demo-batch-*.json file.`);
    for (const s of started as Array<Record<string, unknown>>) {
      if (isUuid(s?.buildId)) add(typeof s.id === "string" ? s.id : s.buildId, s.buildId);
    }
  }
  for (const id of ids) {
    if (!isUuid(id)) throw new Error(`${id} isn't a build id or a .json file.`);
    add(id, id);
  }
  return out;
}

/** What the scripts need from GET /api/builds/<id>. */
export interface BuildView {
  buildId: string;
  kind: "build" | "refine";
  status: string;
  terminal: boolean;
  shipped: boolean;
  /** Null when the answer had no number for it. */
  costUsd: number | null;
  error: string | null;
  productId: string | null;
  slug: string | null;
  name: string | null;
  liveUrl: string | null;
  productStatus: string | null;
  latestBuildId: string | null;
}

/**
 * Reads the public build status answer ({build, product, inspiration, viewer}). Returns an error string for a missing
 * build, a network failure or an answer of another shape, so a bad id never reads as "still building".
 */
export function parseBuildStatus(buildId: string, status: number, json: Record<string, unknown> | null): BuildView | { error: string } {
  if (status === 0) return { error: `network: ${String(json?.message ?? "no answer")}` };
  if (status === 404) return { error: "not_found" };
  if (status !== 200 || !json) return { error: `status ${status}` };
  const build = json.build as Record<string, unknown> | undefined;
  if (!build || typeof build !== "object" || typeof build.status !== "string") return { error: "the answer has no build status" };
  const product = (json.product ?? null) as Record<string, unknown> | null;
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  const cost = typeof build.costUsd === "number" && Number.isFinite(build.costUsd) ? build.costUsd : typeof build.costUsd === "string" && build.costUsd.trim() !== "" && Number.isFinite(Number(build.costUsd)) ? Number(build.costUsd) : null;
  return {
    buildId,
    kind: build.kind === "refine" ? "refine" : "build",
    status: build.status,
    terminal: TERMINAL.has(build.status),
    shipped: SHIPPED.has(build.status),
    costUsd: cost,
    error: str(build.error),
    productId: str(build.productId),
    slug: str(product?.slug),
    name: str(product?.name),
    liveUrl: str(product?.liveUrl),
    productStatus: str(product?.status),
    latestBuildId: str(product?.latestBuildId),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// The spend ledger

/** One refinement's line in the ledger. A null cost is one the API didn't give (unknown id, not answered yet). */
export interface LedgerRefine {
  buildId: string;
  status: string | null;
  costUsd: number | null;
}

export interface LedgerRow {
  label: string;
  buildId: string;
  slug: string | null;
  status: string | null;
  buildCostUsd: number | null;
  refinements: LedgerRefine[];
  totalUsd: number;
  /** Some cost on the row wasn't readable, so the total may be low. */
  unknown: boolean;
}

export interface Ledger {
  rows: LedgerRow[];
  spentUsd: number;
  budgetUsd: number;
  remainingUsd: number;
  over: boolean;
  unknownCount: number;
}

const cents = (n: number) => Math.round(n * 1e6) / 1e6;

/** Sums builds and their refinements against a budget. A refinement listed twice, or a refinement that is also a row, counts once. */
export function ledgerOf(rows: ReadonlyArray<Omit<LedgerRow, "totalUsd" | "unknown">>, budgetUsd: number): Ledger {
  const counted = new Set<string>(rows.map((r) => r.buildId));
  const out: LedgerRow[] = rows.map((r) => {
    const refinements = r.refinements.filter((x) => !counted.has(x.buildId) && (counted.add(x.buildId), true));
    const parts = [r.buildCostUsd, ...refinements.map((x) => x.costUsd)];
    return { ...r, refinements, totalUsd: cents(parts.reduce<number>((s, c) => s + (c ?? 0), 0)), unknown: parts.some((c) => c === null) };
  });
  const spentUsd = cents(out.reduce((s, r) => s + r.totalUsd, 0));
  return { rows: out, spentUsd, budgetUsd, remainingUsd: cents(budgetUsd - spentUsd), over: spentUsd > budgetUsd, unknownCount: out.filter((r) => r.unknown).length };
}

const usd = (n: number | null) => (n === null ? "?" : `$${n.toFixed(n !== 0 && Math.abs(n) < 0.1 ? 3 : 2)}`);

/** The ledger as a plain text table, widest spender first, with the totals under it. */
export function ledgerTable(l: Ledger): string {
  const rows = [...l.rows].sort((a, b) => b.totalUsd - a.totalUsd);
  const head = ["build", "status", "build $", "polish $", "total $"];
  const body = rows.map((r) => [
    `${r.label}${r.slug && r.slug !== r.label ? ` (${r.slug})` : ""}`,
    r.status ?? "?",
    usd(r.buildCostUsd),
    r.refinements.length ? `${usd(r.refinements.reduce<number | null>((s, x) => (s === null || x.costUsd === null ? null : s + x.costUsd), 0))} (${r.refinements.length})` : "-",
    `${usd(r.totalUsd)}${r.unknown ? "*" : ""}`,
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
  const line = (cells: string[]) => cells.map((c, i) => (i >= 2 ? c.padStart(widths[i]) : c.padEnd(widths[i]))).join("  ");
  const lines = [line(head), widths.map((w) => "-".repeat(w)).join("  "), ...body.map(line), ""];
  lines.push(`Spent ${usd(l.spentUsd)} of ${usd(l.budgetUsd)} on ${l.rows.length} builds. ${l.over ? `Over by ${usd(-l.remainingUsd)}.` : `${usd(l.remainingUsd)} left.`}`);
  if (l.unknownCount) lines.push(`* ${l.unknownCount} row(s) have a cost the API didn't give, so the total may be low.`);
  lines.push("Counts what the build API records (costUsd: brief, Muse Code, judge, smoke tests). A product's own model calls after it ships, like an audit's sample runs, aren't in it.");
  return lines.join("\n");
}

/** The refinement ids polish files recorded for each build: `{items: [{buildId, refineIds}]}` (scripts/polish-batch.ts). */
export function refineIdsFrom(files: readonly unknown[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const f of files) {
    const items = (f as { items?: unknown } | null)?.items;
    if (!Array.isArray(items)) continue;
    for (const it of items as Array<Record<string, unknown>>) {
      if (!isUuid(it?.buildId) || !Array.isArray(it.refineIds)) continue;
      const list = out.get(it.buildId) ?? [];
      // A build polished again (--again) keeps its earlier polishes in earlierRefineIds: they cost money too.
      const earlier = Array.isArray(it.earlierRefineIds) ? it.earlierRefineIds : [];
      for (const id of [...earlier, ...it.refineIds]) if (isUuid(id) && !list.includes(id)) list.push(id);
      out.set(it.buildId, list);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Polish: the answer, and the queue

/** The look a polish may switch a product to (lib/polish/logic.ts POLISH_LOOKS). */
export const POLISH_BATCH_LOOKS = ["meta"] as const;
export type PolishBatchLook = (typeof POLISH_BATCH_LOOKS)[number];

/** What one run of the polish queue asks for: --look=meta and --again (scripts/polish-batch.ts). */
export interface PolishPass {
  look?: PolishBatchLook;
  /** Polish a product that already had a polish (the route's again: true). */
  again?: boolean;
  /** --model: "contributor" or "wonder"; the route's default when absent (Wonder for a UI pass, Contributor for width). */
  model?: "contributor" | "wonder";
  /** --scope=width: change only the desktop layout. */
  scope?: "width";
}

/** --look's value: "meta" or nothing. Anything else is an error, as the route would refuse it with a 400. */
export function polishLookArg(raw: string | undefined): PolishBatchLook | undefined {
  if (raw === undefined) return undefined;
  if ((POLISH_BATCH_LOOKS as readonly string[]).includes(raw)) return raw as PolishBatchLook;
  throw new Error(`--look=${raw} isn't a look the polish route takes. Use --look=meta, or leave it out to keep each product's look.`);
}

/** The body of POST /api/builds/<id>/polish: focus when there is some, look and again: true when this pass asks. */
export function polishBody(focus: string | null | undefined, pass: PolishPass = {}): Record<string, unknown> {
  return { ...(focus ? { focus } : {}), ...(pass.look ? { look: pass.look } : {}), ...(pass.again ? { again: true } : {}), ...(pass.model ? { model: pass.model } : {}), ...(pass.scope ? { scope: pass.scope } : {}) };
}

export type PolishAnswer =
  | { kind: "started"; refineIds: string[]; maxUsd?: number }
  /** A 409 that names the product's polish already running or done: follow that one, start nothing. */
  | { kind: "adopt"; refineIds: string[]; reason: string; look?: PolishBatchLook }
  /** --again: the product's earlier polish still runs. Try again after it, without counting a try. */
  | { kind: "wait"; reason: string; afterSeconds: number }
  | { kind: "route_missing"; message: string }
  | { kind: "retry"; reason: string; afterSeconds: number }
  | { kind: "fatal"; reason: string }
  | { kind: "refused"; reason: string };

/**
 * What POST /api/builds/<id>/polish said. A polish only goes to a build the public status route just read as shipped,
 * so any 404 means the route can't take it on that site: not deployed (Next's HTML page, no JSON) or POLISH_ENABLED off
 * (the route's own {"error":"not_found"}). Either stops the run rather than marking every build refused. A 409 that
 * names a buildId (busy with a polish, already_polished) is followed instead of retried, so nothing is polished twice.
 * Other 409s (busy with another build, not shipped yet), 429 and 503 come back later; 503 polish_budget_off
 * (POLISH_MAX_USD at 0) and 401 or 403 (a wrong key) stop the run, since every other build would hit them too.
 */
export function parsePolishAnswer(
  status: number,
  json: Record<string, unknown>,
  site: string,
  opts: { again?: boolean; own?: readonly string[]; look?: PolishBatchLook } = {},
): PolishAnswer {
  const reason = String(json.message ?? json.error ?? `status ${status}`);
  const other = status === 409 && isUuid(json.buildId) && !(opts.own ?? []).includes(json.buildId);
  // --look: a polish the route says is in this pass's look already gives the product that look, and may be this pass's
  // own start whose answer was lost, so it is followed rather than run twice.
  if (other && opts.look && json.look === opts.look) return { kind: "adopt", refineIds: [json.buildId as string], reason: String(json.error ?? "busy"), look: opts.look };
  // --again: an earlier polish of the product is never followed in place of this pass. Only one this run started is.
  if (other && opts.again) {
    if (json.error === "already_polished") {
      return { kind: "refused", reason: `409 already_polished although again: true was sent: ${site} has a polish route from before again. Deploy the current one, then run this again with --resume=<this file>.` };
    }
    return { kind: "wait", reason: `409 ${reason}: the product's earlier polish ${json.buildId} still runs, so this one starts after it`, afterSeconds: 300 };
  }
  // --look without --again: a polish in another look never stands in for this one, and the route won't run a second.
  if (other && opts.look) {
    if (json.error === "already_polished") {
      return { kind: "refused", reason: `409 already_polished: the product's polish ${json.buildId} was in another look, and this pass didn't send again: true. Run with --again (and --resume=<this file>) to switch it to look ${opts.look}.` };
    }
    return { kind: "wait", reason: `409 ${reason}: the product's polish ${json.buildId} in another look still runs, so this pass asks again after it`, afterSeconds: 300 };
  }
  if (status >= 200 && status < 300) {
    const ids = new Set<string>();
    for (const key of ["buildId", "refineBuildId", "polishBuildId"]) if (isUuid(json[key])) ids.add(json[key] as string);
    for (const key of ["buildIds", "refineIds", "refinements", "passes"]) {
      const list = json[key];
      if (Array.isArray(list)) for (const x of list) { const id = isUuid(x) ? x : (x as Record<string, unknown> | null)?.buildId; if (isUuid(id)) ids.add(id); }
    }
    const maxUsd = typeof json.maxUsd === "number" && Number.isFinite(json.maxUsd) && json.maxUsd > 0 ? json.maxUsd : undefined;
    return maxUsd === undefined ? { kind: "started", refineIds: [...ids] } : { kind: "started", refineIds: [...ids], maxUsd };
  }
  if (status === 409 && isUuid(json.buildId)) return { kind: "adopt", refineIds: [json.buildId], reason: String(json.error ?? "busy") };
  if (status === 404 && json.error === "not_found") {
    return { kind: "route_missing", message: `POST ${site}/api/builds/<id>/polish answered not_found for a build ${site}'s status route knows: the polish route is off there (POLISH_ENABLED). Turn it on, then run this again with --resume=<this file>.` };
  }
  if (status === 503 && json.error === "polish_budget_off") return { kind: "fatal", reason: `503 ${reason}` };
  if (status === 404) return { kind: "route_missing", message: `POST ${site}/api/builds/<id>/polish answered 404 without the app's JSON: the polish route isn't deployed on ${site} yet. Deploy it (or pass --url= a deployment that has it), then run this again with --resume=<this file>.` };
  if (status === 409 || status === 429 || status === 503 || status === 0 || status >= 500) {
    const after = typeof json.retryAfterSeconds === "number" && json.retryAfterSeconds > 0 ? json.retryAfterSeconds : status === 429 || status === 503 ? 300 : 60;
    return { kind: "retry", reason: `${status} ${reason}`, afterSeconds: after };
  }
  if (status === 401 || status === 403) return { kind: "fatal", reason: `${status} ${reason}. Check that AUTOMATION_SECRET matches Vercel Production.` };
  if (status >= 300 && status < 400) return { kind: "fatal", reason };
  return { kind: "refused", reason: `${status} ${reason}` };
}

export type PolishState =
  | "waiting" // the build is still running
  | "ready" // shipped, polish not started
  | "skipped" // the build failed or was refused: nothing to polish
  | "polishing" // a refinement is running
  | "polished" // the refinement shipped
  | "polish_failed" // the refinement failed; the live product is left as it was
  | "refused" // the polish route said no for this build
  | "error"; // the build couldn't be read

export interface PolishItem {
  label: string;
  buildId: string;
  state: PolishState;
  slug?: string | null;
  liveUrl?: string | null;
  buildStatus?: string | null;
  refineIds: string[];
  /** Refinement ids by their last status, for the state and the ledger. */
  refineStatus?: Record<string, string>;
  startedAt?: string;
  /** The polish answered with no id to follow: counted in flight until this time. */
  untrackedUntil?: string;
  attempts: number;
  /** The most this polish may spend, from the route's answer (POLISH_MAX_USD); the queue holds this much while it runs. */
  maxUsd?: number;
  /** Don't try this one again before this time (a 409 or a retry after). */
  notBefore?: string;
  note?: string;
  /** The look this item's polish was started with (--look), absent for one that kept the product's look. */
  look?: PolishBatchLook;
  /**
   * With look "meta": true when it meant the Meta AI app look, muse-app-ui (from the evening of Nov 3). A file from
   * before has look "meta" without it, which was meta-ui, so --again polishes that build again (resumedItem).
   */
  appLook?: boolean;
  /** --again: the polishes an earlier pass started on this build, kept for the ledger and never followed. */
  earlierRefineIds?: string[];
  /** One of earlierRefineIds still runs (readRound): the queue holds a reserve for it, as for a polish in flight. */
  earlierInFlight?: boolean;
}

/** The look an item was polished in: look "meta" without appLook is the meta-ui pass of the afternoon of Nov 3. */
function itemLook(item: PolishItem): string | null {
  if (item.look === "meta" && item.appLook !== true) return "meta-ui";
  return item.look ?? null;
}

/**
 * A resumed item for this pass. With --again, a build an earlier pass polished in another look (or one the route
 * refused) starts over as waiting, its earlier polishes kept in earlierRefineIds. Anything this same pass started, or
 * any run without --again, is kept as it is, so a resumed file never polishes a build twice in the same pass.
 */
export function resumedItem(prior: PolishItem, pass: PolishPass = {}): PolishItem {
  const started = ["polishing", "polished", "polish_failed"].includes(prior.state);
  // A refused item started nothing, so with --again it is tried again whatever its look (its note may say to resume).
  const again = pass.again && (prior.state === "refused" || (started && itemLook(prior) !== (pass.look ?? null)));
  if (!again) return { ...prior, state: prior.state === "ready" ? "waiting" : prior.state };
  return {
    label: prior.label,
    buildId: prior.buildId,
    state: "waiting",
    refineIds: [],
    attempts: 0,
    earlierRefineIds: [...new Set([...(prior.earlierRefineIds ?? []), ...prior.refineIds])],
    note: `${prior.state}${itemLook(prior) ? ` with look ${itemLook(prior)}` : ""} before; polishing again${pass.look ? ` with look ${pass.look}` : ""}`,
  };
}

/** The item's state from its build's view and its refinements' views. Never moves a started polish back to ready. */
export function nextState(item: PolishItem, build: BuildView | { error: string } | undefined, refines: ReadonlyArray<BuildView | { error: string }>, now: Date): PolishState {
  if (item.state === "refused") return "refused";
  if (item.refineIds.length) {
    const views = refines.filter((r): r is BuildView => "status" in r);
    if (views.length < item.refineIds.length || views.some((v) => !v.terminal)) return "polishing";
    return views.every((v) => v.shipped) ? "polished" : "polish_failed";
  }
  if (item.untrackedUntil) return new Date(item.untrackedUntil) > now ? "polishing" : "polished";
  if (!build) return item.state;
  if ("error" in build && !("status" in build)) return build.error === "not_found" ? "error" : item.state;
  const b = build as BuildView;
  if (!b.terminal) return "waiting";
  return b.shipped ? "ready" : "skipped";
}

export interface QueueLimits {
  concurrency: number;
  budgetUsd: number;
  /**
   * Held for each polish in flight and for the next one, since a refinement's cost lands only as it runs. A polish whose
   * answer named its cap (maxUsd) holds that instead, and the next one holds the larger of the two.
   */
  reserveUsd: number;
  spentUsd: number;
  now: Date;
  /** No polish starts before this time (a 429 or 503 for the whole site). */
  pausedUntil?: Date;
}

export interface QueueMove {
  start: PolishItem[];
  inFlight: number;
  /** Why nothing more starts, when something is ready but left. */
  held?: "concurrency" | "budget" | "paused";
}

/**
 * Which ready items to start now: as many as the concurrency limit leaves, while what is spent, plus the reserve for
 * each polish in flight, plus one more reserve, stays within the budget. Items with a notBefore in the future wait.
 */
export function planStarts(items: readonly PolishItem[], limits: QueueLimits): QueueMove {
  const flyingItems = items.filter((i) => i.state === "polishing");
  const inFlight = flyingItems.length;
  // An earlier pass's polish that still runs spends too, so it holds a reserve until it ends.
  const earlierFlying = items.filter((i) => i.state !== "polishing" && i.earlierInFlight).length;
  const ready = items.filter((i) => i.state === "ready" && (!i.notBefore || new Date(i.notBefore) <= limits.now));
  if (!ready.length) return { start: [], inFlight };
  if (limits.pausedUntil && limits.pausedUntil > limits.now) return { start: [], inFlight, held: "paused" };
  const caps = items.map((i) => i.maxUsd).filter((n): n is number => typeof n === "number" && Number.isFinite(n) && n > 0);
  const perNext = Math.max(limits.reserveUsd, ...caps);
  let held = flyingItems.reduce((s, i) => s + (i.maxUsd ?? perNext), 0) + earlierFlying * perNext;
  const start: PolishItem[] = [];
  let flying = inFlight;
  for (const item of ready) {
    if (flying >= limits.concurrency) return { start, inFlight, held: "concurrency" };
    if (limits.spentUsd + held + perNext > limits.budgetUsd) return { start, inFlight, held: "budget" };
    start.push(item);
    flying += 1;
    held += perNext;
  }
  return { start, inFlight };
}

/** True when nothing can change any more: nothing waiting or in flight, and nothing ready that the budget allows. */
export function queueDone(items: readonly PolishItem[], move: QueueMove): boolean {
  if (items.some((i) => i.state === "waiting" || i.state === "polishing" || i.earlierInFlight)) return false;
  const ready = items.some((i) => i.state === "ready");
  return !ready || move.held === "budget";
}

/** A count of items by state, for the one line printed each round. */
export function stateCounts(items: readonly PolishItem[]): string {
  const counts = new Map<string, number>();
  for (const i of items) counts.set(i.state, (counts.get(i.state) ?? 0) + 1);
  return [...counts].map(([k, v]) => `${v} ${k}`).join(", ");
}

/**
 * Per-build focus text from --focus-file: an audit file (`{products: [{buildId, slug?, pass, focus?}]}`, scripts/audit-batch.ts)
 * or a plain object of build id or slug to text. Only failing products' focus is taken from an audit file.
 */
export function focusMap(json: unknown): Map<string, string> {
  const out = new Map<string, string>();
  const products = (json as { products?: unknown } | null)?.products;
  if (Array.isArray(products)) {
    for (const p of products as Array<Record<string, unknown>>) {
      if (p?.pass === true || typeof p?.focus !== "string" || !p.focus.trim()) continue;
      if (isUuid(p.buildId)) out.set(p.buildId, p.focus.trim());
      if (typeof p.slug === "string" && p.slug) out.set(p.slug, p.focus.trim());
    }
    return out;
  }
  if (json && typeof json === "object" && !Array.isArray(json)) {
    for (const [k, v] of Object.entries(json)) if (typeof v === "string" && v.trim()) out.set(k, v.trim());
    return out;
  }
  throw new Error("The focus file must be an audit file ({products: [...]}) or an object of build id or slug to text.");
}

/** The most focus text sent with one polish (the polish route refuses past POLISH_MAX_FOCUS_CHARS, 2000, with a 400). */
export const MAX_FOCUS_CHARS = 2000;

export function focusFor(map: ReadonlyMap<string, string>, item: Pick<PolishItem, "buildId" | "slug">): string | undefined {
  const text = map.get(item.buildId) ?? (item.slug ? map.get(item.slug) : undefined);
  if (!text) return undefined;
  return text.length > MAX_FOCUS_CHARS ? `${text.slice(0, MAX_FOCUS_CHARS - 1).trimEnd()}…` : text;
}

/** Runs `fn` over `items` with at most `limit` at once, keeping their order in the result. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}
