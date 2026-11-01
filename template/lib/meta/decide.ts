import { clientIpHeaders, gatewayEnv, type RequestLike } from "./client";

/**
 * One decision, through the Muse Muse gateway ({GATEWAY_URL}/decide). Server only. Use it only when the brief lists
 * muse-decide, or the gateway answers 403 decide_not_allowed.
 *
 * decide() picks one of the options for the state and gives each option a probability. `model` is "muse-decide" (pass
 * your own question and 2 to 4 options) or a trained decision model's id (it knows its own question and labels, so pass
 * only the state). A "None of the listed options matches" option is added last unless `none: false`; when it wins,
 * `decision` and `id` are null.
 *
 * During the build the gateway answers with a stand-in, not a model: the option whose words overlap the state's most,
 * every time, with `simulated: true` and `model: "stand-in"`, so tests are steady. standInDecision() below is the same
 * function, so a test can say what the build will answer. Live, a GPU answers only while the decision model is being
 * served: otherwise decide() throws DecideError with code "decide_offline", and isDecideOffline() says to show "The
 * decision model isn't running right now." with a manual choice instead.
 *
 * Say what is true: a small model trained on someone's examples, how it scored on their test set, and that it can be
 * wrong. Say a confidence as "about 9 in 10" only when `calibrated` is true.
 */

export type DecideOptionInput = string | { option: string; description?: string };

export interface DecideInput {
  /** The text to decide about, 1 to 3,000 characters, or a flat object (sent as its JSON). */
  state: string | Record<string, unknown>;
  /** What to decide, 5 to 300 characters. Required for muse-decide; a trained model has its own. */
  question?: string;
  /** 2 to 4 options for muse-decide. A trained model has its own labels. */
  options?: DecideOptionInput[];
  /** "muse-decide" (the default) or a trained decision model's id. */
  model?: string;
  /** Show "None of the listed options matches" as the last option (the default). */
  none?: boolean;
  /** The incoming request (or `await headers()`), so the gateway can rate limit each visitor. */
  request?: RequestLike | null;
}

export interface DecideProbability {
  option: string;
  id: string;
  p: number;
}

export interface Decision {
  /** The picked option's name, or null when "None of the listed options matches" won. */
  decision: string | null;
  /** The picked option's id, or null when none won. */
  id: string | null;
  /** The pick's probability (none's when none won). */
  confidence: number;
  /** Every option, in order. With none, they sum to 1 - none. */
  probabilities: DecideProbability[];
  /** The probability of none: 0 when it wasn't shown. */
  none: number;
}

export interface DecideReply extends Decision {
  /** "stand-in" during the build; live, the model that answered. */
  model: string;
  /** True only when the model's confidence was calibrated on held-out examples. */
  calibrated: boolean;
  /** True for the build-time stand-in, which is not a model. */
  simulated: boolean;
  ms: number;
  /** A sentence to show or log when something about the answer needs saying, else null. */
  note: string | null;
}

export class DecideError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "DecideError";
  }
}

/** True when no decision model is answering right now: say "The decision model isn't running right now." and offer a manual choice. */
export function isDecideOffline(err: unknown): boolean {
  return err instanceof DecideError && ["decide_offline", "decide_unavailable", "timeout"].includes(err.code);
}

/** How long decide() waits for the gateway, which itself gives up at 30 s. */
const WAIT_MS = 45_000;

function decideUrl(): string {
  // gatewayEnv() checks GATEWAY_URL and PRODUCT_TOKEN, and its baseURL ends in /v1.
  return gatewayEnv().baseURL.replace(/\/v1\/?$/, "/decide");
}

/** Asks the gateway for one decision. Throws DecideError: isDecideOffline(err) when no model is answering. */
export async function decide(input: DecideInput): Promise<DecideReply> {
  const { request, ...body } = input;
  const { apiKey } = gatewayEnv();
  let res: Response;
  try {
    res = await fetch(decideUrl(), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}`, ...clientIpHeaders(request) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(WAIT_MS),
    });
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    throw new DecideError(timedOut ? "The decision didn't come back in time." : "Couldn't reach the decision model.", timedOut ? "timeout" : "decide_unavailable", 0);
  }
  const reply = (await res.json().catch(() => null)) as (DecideReply & { error?: { code?: string; message?: string } }) | null;
  if (!res.ok || !reply || reply.error) {
    throw new DecideError(reply?.error?.message ?? `The decision failed (HTTP ${res.status}).`, reply?.error?.code ?? "decide_error", res.status);
  }
  return reply;
}

// ---------------------------------------------------------------------------------------------------------------
// The build-time stand-in: this template's own copy of the gateway's (standInDecision in Muse Muse's
// lib/decide/format.ts). A template test keeps the two equal.

/** The extra option shown last unless none is false. */
export const NONE_OPTION = "None of the listed options matches";

/** Text folded as the gateway folds it: accents and case gone, anything but letters and digits a single space. */
function fold(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function words(text: string): Set<string> {
  return new Set(fold(text).split(" ").filter(Boolean));
}

/** An option's id as the gateway makes it: "Sign-in issues" is "sign-in-issues". */
export function optionId(name: string): string {
  return fold(name).replaceAll(" ", "-");
}

function softmax(values: readonly number[]): number[] {
  if (!values.length) return [];
  const max = Math.max(...values);
  const e = values.map((v) => Math.exp(v - max));
  const sum = e.reduce((s, x) => s + x, 0);
  return e.map((x) => x / sum);
}

/**
 * What the gateway answers a build with, without calling it: the option whose name and description share the most
 * distinct words with the state (ties to the first), probabilities from a softmax over those counts, and none (when
 * shown) at 0, so it is never picked. It is not a model, and says nothing about how a real one would decide.
 */
export function standInDecision(input: { state: string | Record<string, unknown>; options: DecideOptionInput[]; none?: boolean }): Decision {
  if (!input.options.length) throw new Error("A decision has options.");
  const none = input.none ?? true;
  const state = typeof input.state === "string" ? input.state.trim() : JSON.stringify(input.state);
  const seen = words(state);
  const options = input.options.map((o) => (typeof o === "string" ? { option: o.trim(), description: "" } : { option: o.option.trim(), description: (o.description ?? "").trim() }));
  const scores = options.map((o) => {
    let shared = 0;
    for (const w of words(`${o.option} ${o.description}`)) if (seen.has(w)) shared += 1;
    return shared;
  });
  const p = softmax(none ? [...scores, 0] : scores);
  const probabilities = options.map((o, i) => ({ option: o.option, id: optionId(o.option), p: p[i]! }));
  const noneP = none ? p.at(-1)! : 0;
  let best = 0;
  probabilities.forEach((x, i) => {
    if (x.p > probabilities[best]!.p) best = i;
  });
  const top = probabilities[best]!;
  if (noneP > top.p) return { decision: null, id: null, confidence: noneP, probabilities, none: noneP };
  return { decision: top.option, id: top.id, confidence: top.p, probabilities, none: noneP };
}
