/**
 * The spend ledger for the native lane (docs/NATIVE.md): every reservation, commitment and release goes in native_spend,
 * native_budget keeps the running totals in cents, and "total" is the $150 cap over the other three budgets.
 *
 * - The Mac host is a fixed cost, committed in full: its rate times the hours from allocation to release.
 * - Each Windows start reserves 2 hours, and the sweep commits the hours it really ran (lib/native/lab-box.ts).
 * - Each Device Farm run reserves its worst case, then commits the metered minutes.
 *
 * Neon's HTTP driver has no interactive transactions, so a reservation is one batch: it locks both budget rows, then
 * makes one conditional change. Each statement in a batch sees what committed before it, so two callers can't both take
 * the last of a cap. Every call that changes a budget takes those locks first and in the same order, so no two can
 * deadlock. Commits aren't refused, since the money is already spent: going over a cap shows on the admin card, and every
 * later reservation is refused.
 */
import { type SQL, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { env } from "@/lib/env";
import { NATIVE_BUDGET_LANES, type NativeBudgetLane } from "@/lib/native/types";

/** Device Farm's metered price. */
export const DEVICE_FARM_USD_PER_MINUTE = 0.17;
/** How many hours each Windows start reserves. */
export const WINDOWS_HOLD_HOURS = 2;
/** A dedicated Mac host bills for at least this long once it's allocated. */
const MAC_MINIMUM_HOURS = 24;
/** The event's end, when NATIVE_MAC_RELEASE_AT isn't set: Nov 4, 9 PM ET. */
const MAC_DEFAULT_RELEASE = "2026-11-05T02:00:00Z";

export type SpendLane = Exclude<NativeBudgetLane, "total">;

/** The cap for each budget in USD. The Mac has none of its own: it's a fixed cost inside the total. */
export function spendCaps(): Record<NativeBudgetLane, number | null> {
  return {
    mac: null,
    windows: env.nativeWindowsCapUsd,
    device_farm: env.nativeDeviceFarmCapUsd,
    total: env.nativeSpendCapUsd,
  };
}

export function toCents(usd: number): number {
  return Math.ceil(Math.round(usd * 1e6) / 1e4);
}

/** What the Mac host will cost by its release, or 0 until it has been allocated. */
export function macProjectedUsd(): number {
  const allocated = Date.parse(env.nativeMacAllocatedAt ?? "");
  if (!Number.isFinite(allocated)) return 0;
  const release = Date.parse(env.nativeMacReleaseAt ?? MAC_DEFAULT_RELEASE);
  const hours = Number.isFinite(release) ? (release - allocated) / 3_600_000 : 0;
  return Math.max(MAC_MINIMUM_HOURS, hours) * env.nativeMacHourlyUsd;
}

/** What `hours` on the Windows box costs. */
export function windowsUsd(hours: number): number {
  return Math.max(0, hours) * env.nativeWindowsHourlyUsd;
}

/** What one Windows hold takes, in whole cents, so a session's holds add up to exactly what the ledger holds. */
export function windowsHoldUsd(): number {
  return toCents(windowsUsd(WINDOWS_HOLD_HOURS)) / 100;
}

function ensureBudgets() {
  return db()
    .insert(schema.nativeBudget)
    .values(NATIVE_BUDGET_LANES.map((lane) => ({ lane })))
    .onConflictDoNothing();
}

/** Both rows a change to `lane` touches, always in the same order. The first step of every batch that changes a budget. */
function lockBudgets(lane: SpendLane) {
  return db().execute(sql`select lane from native_budget where lane in (${lane}, 'total') order by lane for update`);
}

function rowsOf(result: unknown): unknown[] {
  if (Array.isArray(result)) return result;
  const rows = (result as { rows?: unknown })?.rows;
  return Array.isArray(rows) ? rows : [];
}

export interface SpendNote {
  /** What it's for: a Device Farm run's ARN, a Windows start. */
  ref?: string | null;
  runId?: string | null;
  note?: string | null;
}

function spendRow(lane: NativeBudgetLane, kind: "reserve" | "commit" | "release", usd: number, note: SpendNote) {
  return { lane, kind, usd, ref: note.ref ?? null, runId: note.runId ?? null, note: note.note ?? null };
}

export type ReserveResult = { ok: true; usd: number } | { ok: false; reason: "lane_cap" | "total_cap" | "bad_amount"; message: string };

/**
 * Holds `usd` on a budget and on the total, or on neither. A cap of its own and the total's cap both have to allow it.
 * Hold in USD, in the same amount you later pass to commit or release.
 */
export async function reserve(lane: SpendLane, usd: number, note: SpendNote = {}): Promise<ReserveResult> {
  if (!(usd > 0) || !Number.isFinite(usd)) return { ok: false, reason: "bad_amount", message: "A hold has to be more than nothing." };
  const caps = spendCaps();
  const cents = toCents(usd);
  const total = toCents(caps.total ?? 0);
  // A budget with no cap of its own is limited only by the total.
  const laneCap = caps[lane] === null ? total : toCents(caps[lane] ?? 0);
  const fits = sql`(select count(*) from native_budget where
      (lane = 'total' and reserved_cents + committed_cents + ${cents} <= ${total}) or
      (lane = ${lane} and reserved_cents + committed_cents + ${cents} <= ${laneCap})) = 2`;
  const [, , moved] = await db().batch([
    ensureBudgets(),
    lockBudgets(lane),
    db().execute(sql`with moved as (
        update native_budget set reserved_cents = reserved_cents + ${cents}, updated_at = now()
        where lane in (${lane}, 'total') and ${fits}
        returning lane
      ), logged as (
        insert into native_spend (lane, kind, usd, ref, run_id, note)
        select ${lane}, 'reserve', ${usd}::real, ${note.ref ?? null}::text, ${note.runId ?? null}::uuid, ${note.note ?? null}::text
        where ${fits}
        returning id
      )
      select lane from moved`),
  ]);
  if (rowsOf(moved).length) return { ok: true, usd };
  const view = await spendView();
  if (view.lanes.total.usedUsd + usd > (caps.total ?? 0)) {
    return { ok: false, reason: "total_cap", message: `That would pass the $${caps.total} limit on all device lab spend.` };
  }
  return { ok: false, reason: "lane_cap", message: `That would pass the $${caps[lane]} limit for ${LANE_NAMES[lane]}.` };
}

/** Records what something really cost and gives back its hold. `usd` may be more or less than the hold. */
export async function commit(lane: SpendLane, input: { usd: number; holdUsd?: number } & SpendNote): Promise<void> {
  const cents = toCents(input.usd);
  const held = toCents(input.holdUsd ?? 0);
  await db().batch([
    ensureBudgets(),
    lockBudgets(lane),
    db().execute(sql`update native_budget
        set reserved_cents = greatest(0, reserved_cents - ${held}), committed_cents = committed_cents + ${cents}, updated_at = now()
        where lane in (${lane}, 'total')`),
    db()
      .insert(schema.nativeSpend)
      .values([
        spendRow(lane, "commit", input.usd, input),
        ...(input.holdUsd ? [spendRow(lane, "release", input.holdUsd, input)] : []),
      ]),
  ]);
}

/**
 * A commit that lands only if `claim` does, in one statement, so neither can happen without the other. `claim` is a
 * statement that returns a row when it takes effect, such as closing a session. True when it did. A failure changes
 * nothing, so the caller can simply try again.
 */
export async function commitIf(lane: SpendLane, input: { usd: number; holdUsd?: number } & SpendNote, claim: SQL): Promise<boolean> {
  const cents = toCents(input.usd);
  const holdUsd = input.holdUsd ?? 0;
  const [, , moved] = await db().batch([
    ensureBudgets(),
    lockBudgets(lane),
    db().execute(sql`with claimed as (${claim}), moved as (
        update native_budget
        set reserved_cents = greatest(0, reserved_cents - ${toCents(holdUsd)}), committed_cents = committed_cents + ${cents}, updated_at = now()
        where lane in (${lane}, 'total') and exists (select 1 from claimed)
        returning lane
      ), logged as (
        insert into native_spend (lane, kind, usd, ref, run_id, note)
        select ${lane}, v.kind, v.usd, ${input.ref ?? null}::text, ${input.runId ?? null}::uuid, ${input.note ?? null}::text
        from claimed cross join (values ('commit', ${input.usd}::real), ('release', ${holdUsd}::real)) as v(kind, usd)
        where v.kind = 'commit' or v.usd > 0
        returning id
      )
      select lane from moved`),
  ]);
  return rowsOf(moved).length > 0;
}

/** Gives back a hold that went unused. */
export async function release(lane: SpendLane, usd: number, note: SpendNote = {}): Promise<void> {
  const cents = toCents(usd);
  await db().batch([
    ensureBudgets(),
    lockBudgets(lane),
    db().execute(sql`update native_budget set reserved_cents = greatest(0, reserved_cents - ${cents}), updated_at = now()
        where lane in (${lane}, 'total')`),
    db().insert(schema.nativeSpend).values(spendRow(lane, "release", usd, note)),
  ]);
}

/** Whether a hold of `usd` would fit right now. For planning: only reserve() promises anything. */
export async function canSpend(lane: SpendLane, usd: number): Promise<boolean> {
  const view = await spendView();
  const caps = spendCaps();
  const laneCap = caps[lane];
  return view.lanes.total.usedUsd + usd <= (caps.total ?? 0) && (laneCap === null || view.lanes[lane].usedUsd + usd <= laneCap);
}

/**
 * Makes the Mac's committed amount match its projection, whatever earlier sweeps wrote. A later release date can lower
 * it as well as raise it, so the row's amount can be negative. Safe to repeat, and safe to run at the same time.
 */
export async function syncMacHost(): Promise<void> {
  const projected = toCents(macProjectedUsd());
  await db().batch([
    ensureBudgets(),
    lockBudgets("mac"),
    db().execute(sql`with delta as (
        select ${projected} - committed_cents as cents from native_budget where lane = 'mac' and committed_cents <> ${projected}
      ), moved as (
        update native_budget set committed_cents = committed_cents + delta.cents, updated_at = now()
        from delta where lane in ('mac', 'total')
        returning lane
      ), logged as (
        insert into native_spend (lane, kind, usd, ref, note)
        select 'mac', 'commit', delta.cents / 100.0, 'mac-host', 'The Mac host, from allocation to release.' from delta
        returning id
      )
      select lane from moved`),
  ]);
}

export const LANE_NAMES: Record<NativeBudgetLane, string> = {
  mac: "the Mac host",
  windows: "the Windows box",
  device_farm: "Device Farm",
  total: "all device lab spend",
};

export interface LaneSpend {
  reservedUsd: number;
  committedUsd: number;
  usedUsd: number;
  capUsd: number | null;
}

export interface SpendView {
  lanes: Record<NativeBudgetLane, LaneSpend>;
  alertUsd: number;
  /** True at or past the alert line. */
  alerting: boolean;
}

/** Where every budget stands. Budgets with no row yet read as zero. */
export async function spendView(): Promise<SpendView> {
  const rows = await db().select().from(schema.nativeBudget);
  const caps = spendCaps();
  const lanes = {} as Record<NativeBudgetLane, LaneSpend>;
  for (const lane of NATIVE_BUDGET_LANES) {
    const row = rows.find((r) => r.lane === lane);
    const reservedUsd = (row?.reservedCents ?? 0) / 100;
    const committedUsd = (row?.committedCents ?? 0) / 100;
    lanes[lane] = { reservedUsd, committedUsd, usedUsd: reservedUsd + committedUsd, capUsd: caps[lane] };
  }
  const alertUsd = env.nativeSpendAlertUsd;
  return { lanes, alertUsd, alerting: lanes.total.usedUsd >= alertUsd };
}
