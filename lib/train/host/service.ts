/**
 * Starting, watching, stopping and talking to hosted endpoints, on injected deps. Every provider resource has its name
 * before any provider is called, so a crash at any point can still be stopped. A stop that can't be confirmed keeps its
 * reservation and stays "stopping": no traffic reaches it, and the next sweep tries again.
 */
import { randomBytes } from "node:crypto";
import {
  DEPLOY_WINDOW_MINUTES,
  excessEndpoints,
  freeSlot,
  heldToday,
  accruedUsd,
  planRun,
  spentToday,
  stopReasonFor,
  type HostLimits,
} from "@/lib/train/host/limits";
import { HostError, type HostAdapter, type HostChatInput, type HostChatReply, type HostEndpoint, type HostFacts, type HostProvider, type HostRef, type StopReason } from "@/lib/train/host/types";
import type { ModelUsage } from "@/lib/types";
import type { UsageContext } from "@/lib/usage";

export const HOST_MODEL = "hosted-endpoint";
const CTX: UsageContext = { source: "hosted", endpoint: "/hosted/endpoints" };

export type NewEndpoint = Pick<HostEndpoint, "id" | "adapterJobId" | "provider" | "slot" | "name" | "hourlyUsd" | "reservedUsd" | "reservationId" | "ownerTokenHash" | "createdBy" | "stopsAt" | "createdAt">;

export interface HostDeps {
  on(): boolean;
  limits(): HostLimits;
  platformCapUsd(): number;
  platformSpend(): Promise<number>;
  adapter(provider: HostProvider): HostAdapter;
  adapters(): HostAdapter[];
  /** Every open endpoint, and every endpoint created today. */
  rows(now: Date): Promise<HostEndpoint[]>;
  /** Null when a live slot or this model's one endpoint was taken in a race. */
  insert(row: NewEndpoint): Promise<HostEndpoint | null>;
  patch(id: string, patch: Partial<HostEndpoint>): Promise<void>;
  /** One start at a time across the platform: true for the first caller in this minute. */
  takeDeployLock(now: Date): Promise<boolean>;
  reserveSpend(ctx: UsageContext, model: string | null, costUsd: number): Promise<string>;
  settleSpend(id: string, item: ModelUsage | null): Promise<void>;
  hashToken(raw: string): string;
  newId(): string;
}

export function endpointName(id: string): string {
  return `mm-host-${id.replace(/-/g, "").slice(0, 20)}`;
}

const isServing = (e: HostEndpoint) => e.status === "starting" || e.status === "live";

function refusal(facts: HostFacts, adapter: HostAdapter): string | null {
  const missing = adapter.missingKeys();
  if (missing.length) return `${adapter.label} isn't set up here: ${missing.join(" and ")} ${missing.length === 1 ? "isn't" : "aren't"} set.`;
  return adapter.cantServe(facts);
}

export { refusal as providerRefusal };

/** Starts one. The owner token comes back here once: only its hash is kept. */
export async function deployEndpoint(
  input: { provider: HostProvider; facts: HostFacts; callerId: string },
  deps: HostDeps,
  now: Date = new Date(),
): Promise<{ endpoint: HostEndpoint; ownerToken: string }> {
  if (input.facts.problem) throw new HostError(409, "cant_host", input.facts.problem);
  const adapter = deps.adapter(input.provider);
  const reason = refusal(input.facts, adapter);
  if (reason) throw new HostError(409, "provider_unavailable", reason);
  const limits = deps.limits();
  if (limits.dailyUsd <= 0) throw new HostError(503, "hosting_paused", "HOST_TUNED_DAILY_USD is 0, so hosting is paused.");
  if (!(await deps.takeDeployLock(now))) throw new HostError(429, "deploy_busy", "Another endpoint just started. Try again in a minute.", 60);

  const rows = await deps.rows(now);
  const open = rows.filter((e) => e.status === "starting" || e.status === "live" || e.status === "stopping");
  if (open.some((e) => e.adapterJobId === input.facts.adapterJobId)) throw new HostError(409, "already_hosted", "This model already has an endpoint. Stop it first.");
  // A stopping endpoint still holds its slot: it may still be billing.
  const slot = freeSlot(open, limits.maxLive);
  if (slot === null) throw new HostError(429, "too_many_live", `${limits.maxLive} endpoints are already running, which is the limit. Stop one first.`);

  const price = adapter.price(input.facts);
  const plan = planRun(price, limits, { heldToday: heldToday(rows, now), platformSpend: await deps.platformSpend(), platformCap: deps.platformCapUsd() });
  if (!plan.ok) throw new HostError(429, plan.code, plan.message);

  const id = deps.newId();
  const name = endpointName(id);
  const ownerToken = `mmh_${randomBytes(24).toString("base64url")}`;
  const reservationId = await deps.reserveSpend({ ...CTX }, HOST_MODEL, plan.reserveUsd);
  let row: HostEndpoint | null;
  try {
    row = await deps.insert({
      id,
      adapterJobId: input.facts.adapterJobId,
      provider: input.provider,
      slot,
      name,
      hourlyUsd: price.hourlyUsd,
      reservedUsd: plan.reserveUsd,
      reservationId,
      ownerTokenHash: deps.hashToken(ownerToken),
      createdBy: input.callerId,
      stopsAt: new Date(now.getTime() + plan.minutes * 60_000),
      createdAt: now,
    });
  } catch (err) {
    await deps.settleSpend(reservationId, null).catch(() => undefined);
    throw err;
  }
  if (!row) {
    await deps.settleSpend(reservationId, null);
    throw new HostError(409, "already_hosted", "Another endpoint took that place just now. Try again.");
  }
  // Two starts either side of the lock's minute can both have read the money before either wrote. Each sees the other now.
  const held = heldToday(await deps.rows(now), now);
  if (held > limits.dailyUsd + 0.01) {
    await deps.patch(id, { status: "failed", stopReason: "deploy_failed", costUsd: 0, stoppedAt: now });
    await deps.settleSpend(reservationId, null);
    throw new HostError(429, "budget_exceeded", "Another endpoint started at the same moment and took the day's hosting budget. Nothing was started.");
  }

  try {
    const ref = await adapter.deploy({ name, endpointId: id, facts: input.facts, minutes: plan.minutes, capUsd: price.capUsd === undefined ? undefined : plan.reserveUsd, callerId: input.callerId });
    const duties = input.facts.duties;
    const saved: HostRef = {
      ...ref,
      family: input.facts.family,
      sparkOpen: input.facts.sparkOpen ? "1" : "",
      trainChannel: String(input.facts.trainChannel),
      ...(duties.line && !input.facts.sparkOpen ? { note: `${duties.line}. ${duties.license}` } : {}),
    };
    await deps.patch(id, { ref: saved });
    // A stop that came while this ran has waited for the ref (stopEndpoint): it happens now.
    const fresh = (await deps.rows(now)).find((e) => e.id === id);
    if (fresh && fresh.status !== "starting") {
      await stopEndpoint({ ...fresh, ref: saved }, fresh.stopReason ?? "person", deps, now, { deployEnded: true }).catch((e) => console.error("[host] stop after a deploy", e instanceof Error ? e.name : "error"));
      throw new HostError(409, "stopped_while_starting", "It was stopped while it was starting.");
    }
    return { endpoint: { ...row, ref: saved }, ownerToken };
  } catch (err) {
    if (err instanceof HostError && err.code === "stopped_while_starting") throw err;
    // It may have got partway, so it is stopped by name. A stop that fails stays "stopping" for the sweep, money still held.
    await stopEndpoint(row, "deploy_failed", deps, now, { deployEnded: true }).catch((e) => console.error("[host] stop after a failed deploy", e instanceof Error ? e.name : "error"));
    if (err instanceof HostError) throw err;
    console.error("[host] deploy failed", input.provider, err instanceof Error ? err.message.slice(0, 400) : "error");
    throw new HostError(502, "deploy_failed", `${adapter.label} couldn't deploy it. Nothing is left running, or the sweep will stop it.`);
  }
}

/**
 * Traffic is refused first, then the provider is asked. Settles once the provider says it's done: at what the provider
 * reports, else the clock's rate for the whole time, which a scale-to-zero provider can't exceed.
 *
 * With no ref yet and a deploy that may still be running, a stop by name could find nothing, call it done and free the
 * money while the deploy goes on to create it. So it only refuses traffic: the deploy stops it when it returns, or the
 * sweep does past the window.
 */
export async function stopEndpoint(row: HostEndpoint, reason: StopReason, deps: HostDeps, now: Date = new Date(), opts: { deployEnded?: boolean } = {}): Promise<HostEndpoint> {
  if (row.status === "stopped" || row.status === "failed") return row;
  const stopping: Partial<HostEndpoint> = { status: "stopping", stopReason: row.stopReason ?? reason };
  if (row.status !== "stopping") await deps.patch(row.id, stopping);
  const current = { ...row, ...stopping };
  if (!row.ref && !opts.deployEnded && now.getTime() - row.createdAt.getTime() < DEPLOY_WINDOW_MINUTES * 60_000) return current;
  const result = await deps.adapter(row.provider).stop({ adapterJobId: row.adapterJobId, hostedSince: row.createdAt.toISOString(), ...row.ref }, row.name);
  if (!result.done) return current;
  const costUsd = Math.round((result.costUsd ?? accruedUsd({ ...row, stoppedAt: now }, now)) * 1e4) / 1e4;
  if (row.reservationId) {
    await deps.settleSpend(row.reservationId, { model: HOST_MODEL, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, units: 1, costUsd });
  }
  const done: Partial<HostEndpoint> = { status: current.stopReason === "deploy_failed" ? "failed" : "stopped", costUsd, stoppedAt: now };
  await deps.patch(row.id, done);
  return { ...current, ...done };
}

/** A starting endpoint asked how it's doing. A provider that can't answer leaves it starting, under the start timeout. */
export async function refreshEndpoint(row: HostEndpoint, deps: HostDeps, now: Date = new Date()): Promise<HostEndpoint> {
  if (row.status !== "starting" || !row.ref) return row;
  let health;
  try {
    health = await deps.adapter(row.provider).status(row.ref, row.name);
  } catch (err) {
    console.error("[host] status", row.provider, err instanceof Error ? err.name : "error");
    return row;
  }
  if (health === "ready") {
    const live = { status: "live" as const, readyAt: now };
    await deps.patch(row.id, live);
    return { ...row, ...live };
  }
  return health === "failed" ? stopEndpoint(row, "provider_failed", deps, now) : row;
}

export interface SweepResult {
  stopped: string[];
  orphans: string[];
  errors: string[];
}

const words = (err: unknown) => (err instanceof Error ? err.name + ": " + err.message.slice(0, 200) : "error");

/**
 * Stops anything past its limits. Fails toward stopping: if the money can't be read, every endpoint stops; if the rows
 * can't be read, everything each provider holds under our prefix stops, whatever it is. Past the flag, everything stops.
 */
export async function sweepEndpoints(deps: HostDeps, now: Date = new Date()): Promise<SweepResult> {
  const result: SweepResult = { stopped: [], orphans: [], errors: [] };
  const on = deps.on();
  const limits = deps.limits();
  let rows: HostEndpoint[] | null = null;
  try {
    rows = await deps.rows(now);
  } catch (err) {
    result.errors.push(`Reading endpoints failed: ${words(err)}`);
  }

  if (rows) {
    const spent = spentToday(rows, now);
    const after: HostEndpoint[] = [];
    for (const row of rows) {
      if (row.status === "stopped" || row.status === "failed") continue;
      let current = row;
      try {
        if (current.status === "starting") current = await refreshEndpoint(current, deps, now);
        const reason = stopReasonFor(current, { limits, spent, on, now });
        if (reason || current.status === "stopping") {
          current = await stopEndpoint(current, current.stopReason ?? reason ?? "cant_check", deps, now);
          result.stopped.push(current.id);
        } else {
          after.push(current);
        }
      } catch (err) {
        result.errors.push(`Stopping ${row.id} failed: ${words(err)}`);
        // Refuse its traffic even if the provider couldn't be reached: a scale-to-zero endpoint then stops billing by itself.
        await deps.patch(row.id, { status: "stopping", stopReason: row.stopReason ?? "cant_check" }).catch(() => undefined);
      }
    }
    for (const extra of excessEndpoints(after.filter(isServing), limits.maxLive)) {
      await stopEndpoint(extra, "too_many", deps, now).then(
        (r) => result.stopped.push(r.id),
        (err) => result.errors.push(`Stopping ${extra.id} failed: ${words(err)}`),
      );
    }
  }

  // What a provider holds with no open row: a crash, or a database that can't be read at all.
  const openNames = (list: HostEndpoint[]) => new Set(list.filter((e) => e.status !== "stopped" && e.status !== "failed").map((e) => e.name));
  for (const adapter of deps.adapters()) {
    if (!adapter.listOwned || adapter.missingKeys().length) continue;
    try {
      const names = await adapter.listOwned();
      // Read after the listing: a deploy that began during this sweep wrote its row before calling the provider, so it is known here.
      const known = rows ? openNames(await deps.rows(now)) : new Set<string>();
      for (const name of names) {
        if (known.has(name)) continue;
        try {
          const stopped = await adapter.stop({}, name);
          if (stopped.done) result.orphans.push(name);
        } catch (err) {
          result.errors.push(`Stopping ${name} failed: ${words(err)}`);
        }
      }
    } catch (err) {
      result.errors.push(`Checking ${adapter.label} failed: ${words(err)}`);
    }
  }
  return result;
}

export interface HostChatDeps extends HostDeps {
  touch(id: string, now: Date): Promise<void>;
}

/** One answer. Every limit is checked again here, so a request can't reach anything the sweep hasn't got to yet. */
export async function chatOnEndpoint(row: HostEndpoint, input: Omit<HostChatInput, "family" | "adapterJobId">, deps: HostChatDeps, now: Date = new Date()): Promise<HostChatReply> {
  const current = await refreshEndpoint(row, deps, now);
  if (current.status === "starting") throw new HostError(503, "endpoint_starting", "This model's GPU is still starting. Try again soon.", 30);
  if (current.status !== "live") throw new HostError(503, "endpoint_closed", "This model's endpoint is stopped.");
  const reason = stopReasonFor(current, { limits: deps.limits(), spent: spentToday(await deps.rows(now), now), on: deps.on(), now });
  if (reason) {
    await stopEndpoint(current, reason, deps, now).catch((e) => console.error("[host] stop at a limit", e instanceof Error ? e.name : "error"));
    if (reason === "daily_cap") {
      // The cap covers every provider, so the rest stop as well. The sweep catches any that fail here.
      for (const other of await deps.rows(now)) {
        if (other.id !== current.id && isServing(other)) await stopEndpoint(other, "daily_cap", deps, now).catch(() => undefined);
      }
      throw new HostError(429, "budget_exceeded", "The daily hosting budget ran out, so hosted endpoints have stopped.");
    }
    throw new HostError(503, "endpoint_closed", "This model's endpoint reached a limit and stopped.");
  }
  // Touched before the call: a slow answer is still use, and the idle clock must not stop it mid-answer.
  await deps.touch(current.id, now);
  const family = (current.ref?.family as HostChatInput["family"] | undefined) ?? "glimmer";
  return deps.adapter(current.provider).chat(current.ref ?? {}, { ...input, family, adapterJobId: current.adapterJobId, trainChannel: current.ref?.trainChannel === "1" ? 1 : 0 });
}
