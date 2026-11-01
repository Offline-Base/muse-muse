/**
 * The public Try box on a tuned model's page (TRY_TUNED, also needs HOST_TUNED; docs/TRAINING.md "Try a tuned model").
 * Anyone may ask the model that runs, and wake one that doesn't, on the hosted endpoints of service.ts and under all of
 * their limits. A visitor has no account, so every paid step has limits of its own on top, and each leans toward refusing:
 *
 * - One wake per visitor per UTC day, two per model, TRY_TUNED_WAKES_PER_DAY in all.
 * - A wake's whole possible cost is taken from TRY_TUNED_DAILY_USD before anything starts, in one atomic statement, and
 *   comes back only when nothing started. Stopping early gives nothing back. So that budget can't be passed under a race.
 * - Its stop time is set SWEEP_LAG_MINUTES early, since the sweep that stops it runs every 5 minutes.
 * - No provider's words reach a visitor: they can hold dollar amounts, setting names and advice meant for an admin.
 * - Never Lambda, whose whole-instance jobs share the lab's one slot and need an account.
 * - The owner token is thrown away, so a visitor can only use this box.
 *
 * The visitor is their network address (clientIpKey), the same as the lab's live demo: a cookie could just be dropped.
 */
import type { HostedGatewayDeps } from "@/lib/train/host/gateway";
import { chatOnEndpoint, deployEndpoint, providerRefusal } from "@/lib/train/host/service";
// dayWindow is the end of the UTC day: the hourly prune deletes any window that began over an hour ago, so a day counter at the
// start of the day would reset within the hour.
import { dayWindow } from "@/lib/docs/proxy/limits";
import { TRY_MESSAGES_MAX, TRY_PROMPT_CHARS, type TryState, type TryView } from "@/lib/train/host/try-view";
import { HOST_OPEN, HostError, type HostEndpoint, type HostFacts, type HostProvider } from "@/lib/train/host/types";

export { TRY_MESSAGES_MAX, TRY_PROMPT_CHARS };

/** A question to both models is two answers, so these are 5 questions in 10 minutes and 20 a day. */
export const TRY_ANSWERS_PER_TEN_MINUTES = 10;
export const TRY_ANSWERS_PER_DAY = 40;
export const TRY_MODEL_ANSWERS_PER_DAY = 300;
export const TRY_WAKES_PER_VISITOR = 1;
export const TRY_WAKES_PER_MODEL = 2;
/** Only these may be woken by a visitor. */
export const TRY_PROVIDERS: readonly HostProvider[] = ["modal", "baseten", "fireworks"];

/** Refusals that mean nothing started, so what the wake took from the day's budget comes back. */
const NOTHING_STARTED = new Set(["cant_host", "cant_serve", "provider_unavailable", "hosting_paused", "deploy_busy", "already_hosted", "too_many_live", "budget_exceeded"]);

/** The cron that stops an endpoint at its stop time runs this often, so a wake can bill this long past it. */
export const SWEEP_LAG_MINUTES = 5;

const BUSY_WORDS = "All the GPUs Muse Muse pays for are in use right now. Look again soon.";
const SPENT_WORDS = "Today's free wake-ups are used up. Try again after midnight UTC.";
const VISITOR_WORDS: Record<string, string> = {
  deploy_busy: "Another model is starting right now. Try again in a minute.",
  too_many_live: BUSY_WORDS,
  budget_exceeded: SPENT_WORDS,
  hosting_paused: SPENT_WORDS,
  already_hosted: "It's already starting or shutting down. Look again in a few minutes.",
};

const TEN_MINUTES = 600_000;
const tenMinuteWindow = (now: Date) => new Date(Math.floor(now.getTime() / TEN_MINUTES) * TEN_MINUTES);
const toCents = (usd: number) => Math.ceil(usd * 100 - 1e-9);

export const BUDGET_KEY = "try:usd-cents";
export const WAKES_KEY = "try:wakes";

export interface TryLimits {
  dailyUsd: number;
  wakesPerDay: number;
  minutes: number;
}

export interface TryDeps extends HostedGatewayDeps {
  /** TRY_TUNED and HOST_TUNED. Apart from on(), which stops whatever runs when it is false. */
  tryOn(): boolean;
  tryLimits(): TryLimits;
  reserveCounter(key: string, windowStart: Date, amount: number, limit: number): Promise<number | null>;
  adjustCounter(key: string, windowStart: Date, delta: number): Promise<void>;
  counterValue(key: string, windowStart: Date): Promise<number>;
}

/** The cheapest provider a visitor may wake this model on, with its price. */
function cheapest(facts: HostFacts, deps: TryDeps) {
  const offers = TRY_PROVIDERS.map((id) => deps.adapter(id))
    .filter((a) => !providerRefusal(facts, a))
    .map((a) => ({ adapter: a, price: a.price(facts) }))
    .filter((o) => o.price.hourlyUsd > 0 && o.price.capUsd === undefined)
    .sort((x, y) => x.price.hourlyUsd - y.price.hourlyUsd);
  return offers[0] ?? null;
}

/** What one wake takes from the day's budget: its whole possible run. */
function wakeCost(hourlyUsd: number, limits: TryLimits): number {
  return toCents((limits.minutes / 60) * hourlyUsd);
}

export async function tryView(facts: HostFacts, deps: TryDeps, now: Date = new Date()): Promise<TryView> {
  const rows = await deps.rows(now);
  const open = rows.find((e) => e.adapterJobId === facts.adapterJobId && (e.status === "starting" || e.status === "live" || e.status === "stopping"));
  const duties = { line: facts.duties.line, license: facts.duties.license, points: [...facts.duties.points] };
  if (open) {
    const label = deps.adapter(open.provider).label;
    const state: TryState = open.status === "live" ? "live" : open.status === "starting" ? "waking" : "stopping";
    return { state, provider: label, cantWake: null, duties };
  }
  return { state: "asleep", provider: null, cantWake: await whyCantWake(facts, rows, deps, now), duties };
}

const openCount = (rows: readonly HostEndpoint[]) => rows.filter((e) => HOST_OPEN.includes(e.status)).length;

async function whyCantWake(facts: HostFacts, rows: readonly HostEndpoint[], deps: TryDeps, now: Date): Promise<string | null> {
  if (facts.problem) return facts.problem;
  const offer = cheapest(facts, deps);
  if (!offer) return "No hosting provider can run this model right now.";
  const limits = deps.tryLimits();
  const day = dayWindow(now);
  const [cents, wakes] = await Promise.all([deps.counterValue(BUDGET_KEY, day), deps.counterValue(WAKES_KEY, day)]);
  if (wakes >= limits.wakesPerDay || cents + wakeCost(offer.price.hourlyUsd, limits) > toCents(limits.dailyUsd)) {
    return SPENT_WORDS;
  }
  return openCount(rows) >= deps.limits().maxLive ? BUSY_WORDS : null;
}

/**
 * Starts this model for a visitor, or says why not. Every limit is taken before any provider is called, and deployEndpoint
 * then checks hosting's own: the live count, one per model, HOST_TUNED_DAILY_USD and the platform's daily cap.
 */
export async function wakeForVisitor(input: { facts: HostFacts; visitor: string }, deps: TryDeps, now: Date = new Date()): Promise<void> {
  const { facts, visitor } = input;
  if (!deps.tryOn()) throw new HostError(404, "not_found", "This isn't on.");
  if (facts.problem) throw new HostError(409, "cant_host", facts.problem);
  const open = await deps.byModel(facts.adapterJobId);
  if (open) return;
  const limits = deps.tryLimits();
  const offer = cheapest(facts, deps);
  if (!offer) throw new HostError(409, "provider_unavailable", "No hosting provider can run this model right now.");

  // Read before anything is counted, so a wake that can't start spends nobody's allowance.
  const rows = await deps.rows(now);
  if (rows.some((e) => e.adapterJobId === facts.adapterJobId && HOST_OPEN.includes(e.status))) throw new HostError(409, "already_hosted", VISITOR_WORDS.already_hosted!);
  if (openCount(rows) >= deps.limits().maxLive) throw new HostError(429, "too_many_live", BUSY_WORDS);

  const day = dayWindow(now);
  // The visitor is counted first, and alone: someone already refused must not use up the model's wakes for everyone else.
  const visitorKey = `try:wake:ip:${visitor}`;
  const modelKey = `try:wake:model:${facts.adapterJobId}`;
  const seen = await deps.hitRateLimits([visitorKey], day);
  if ((seen[visitorKey] ?? 0) > TRY_WAKES_PER_VISITOR) throw new HostError(429, "try_wake_limit", "You've used your wake-up for today. Try again after midnight UTC.");
  const seenModel = await deps.hitRateLimits([modelKey], day);
  if ((seenModel[modelKey] ?? 0) > TRY_WAKES_PER_MODEL) throw new HostError(429, "try_wake_limit", "This model has used its wake-ups for today. Try again after midnight UTC.");

  const spentOut = () => new HostError(429, "try_budget", SPENT_WORDS);
  const cents = wakeCost(offer.price.hourlyUsd, limits);
  if ((await deps.reserveCounter(WAKES_KEY, day, 1, limits.wakesPerDay)) === null) throw spentOut();
  if ((await deps.reserveCounter(BUDGET_KEY, day, cents, toCents(limits.dailyUsd))) === null) {
    await deps.adjustCounter(WAKES_KEY, day, -1);
    throw spentOut();
  }
  try {
    const held = { ...deps, limits: () => ({ ...deps.limits(), maxMinutes: Math.min(deps.limits().maxMinutes, limits.minutes - SWEEP_LAG_MINUTES) }) };
    // The owner token it returns is dropped here on purpose.
    await deployEndpoint({ provider: offer.adapter.id, facts, callerId: null }, held, now);
  } catch (err) {
    if (err instanceof HostError && NOTHING_STARTED.has(err.code)) {
      await deps.adjustCounter(BUDGET_KEY, day, -cents);
      await deps.adjustCounter(WAKES_KEY, day, -1);
    }
    if (err instanceof HostError) throw new HostError(err.status, err.code, VISITOR_WORDS[err.code] ?? "It couldn't be woken right now. Try again later.", err.retryAfterSeconds);
    throw err;
  }
}

/** What a visitor's messages must be: their own turns only. The system message is the server's. */
export function tryMessagesProblem(messages: unknown): string | null {
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > TRY_MESSAGES_MAX) return `Send 1 to ${TRY_MESSAGES_MAX} messages.`;
  for (const m of messages) {
    const { role, content } = (m ?? {}) as { role?: unknown; content?: unknown };
    if ((role !== "user" && role !== "assistant") || typeof content !== "string") return "Each message needs a role (user or assistant) and text.";
    if (!content.trim() && role === "user") return "Type something first.";
    if ([...content].length > (role === "user" ? TRY_PROMPT_CHARS : TRY_PROMPT_CHARS * 8)) return `Keep each message to ${TRY_PROMPT_CHARS} characters.`;
  }
  if ((messages[messages.length - 1] as { role: string }).role !== "user") return "The last message must be yours.";
  return null;
}

export interface TryAsk {
  facts: HostFacts;
  visitor: string;
  variant: "tuned" | "base";
  messages: { role: "user" | "assistant"; content: string }[];
  /** The system message this model trained with, when the job recorded one. */
  system: string | null;
  signal?: AbortSignal;
}

/** One answer for a visitor from the model's running endpoint. It never starts one. */
export async function askAsVisitor(ask: TryAsk, deps: TryDeps, now: Date = new Date()): Promise<{ text: string; finish: "stop" | "length" }> {
  if (!deps.tryOn()) throw new HostError(404, "not_found", "This isn't on.");
  if (ask.facts.problem) throw new HostError(409, "cant_host", ask.facts.problem);
  const endpoint = await deps.byModel(ask.facts.adapterJobId);
  if (!endpoint) throw new HostError(503, "asleep", "This model is asleep. Wake it up first.");

  const short = `try:ask:ip:${ask.visitor}`;
  const long = `try:ask-day:ip:${ask.visitor}`;
  const model = `try:ask:model:${ask.facts.adapterJobId}`;
  const shortCount = await deps.hitRateLimits([short], tenMinuteWindow(now));
  if ((shortCount[short] ?? 0) > TRY_ANSWERS_PER_TEN_MINUTES) throw new HostError(429, "rate_limited", "That's the limit for now: 5 questions in 10 minutes. Try again soon.", 600);
  const dayCount = await deps.hitRateLimits([long], dayWindow(now));
  if ((dayCount[long] ?? 0) > TRY_ANSWERS_PER_DAY) throw new HostError(429, "rate_limited", "That's the limit for today: 20 questions. Try again after midnight UTC.");
  const modelCount = await deps.hitRateLimits([model], dayWindow(now));
  if ((modelCount[model] ?? 0) > TRY_MODEL_ANSWERS_PER_DAY) throw new HostError(429, "rate_limited", "This model has answered all it can for today. Try again after midnight UTC.");

  const messages = [...(ask.system ? [{ role: "system" as const, content: ask.system }] : []), ...ask.messages];
  const reply = await chatOnEndpoint(endpoint, { messages, stop: [], signal: ask.signal, variant: ask.variant, baseRepo: ask.facts.servingBase?.repo ?? null }, deps, now);
  await deps
    .recordUsage({ source: "hosted", endpoint: "/models/try" }, [{ model: `hosted-${endpoint.provider}`, inputTokens: reply.usage.input, cachedInputTokens: 0, outputTokens: reply.usage.output, units: 1, costUsd: 0 }])
    .catch((err) => console.error("[try] metering failed:", err instanceof Error ? err.name : "error"));
  return { text: reply.text, finish: reply.finish };
}
