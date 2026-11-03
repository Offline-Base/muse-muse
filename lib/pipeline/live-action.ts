/**
 * The live action check's pure parts. After deploy, the platform calls a product's primary action once on its live link
 * with the manifest's example, the way a visitor's first tap would, and reads the reply. Nothing else checked the
 * deployed app: verify and the judge run on the build machine, and the route check (ENGINE_LIVE_SMOKE) makes no call.
 *
 * - Which action: the first one Prove it would call (planChecks in lib/outputs/prove.ts), under its rules for the live
 *   product, where other people's data is: never an action marked as changing things, and an unmarked one only with an
 *   example. So both checks call the same action with the same input.
 * - Shortened files: a manifest example often shortens a file to "data:image/png;base64,AAA". Like Prove's runner, the
 *   check swaps such a value for the product's own sample of the same kind from fixtures/, the file its tests use.
 * - What fails it: an HTTP error other than a refused input, no answer in time, or a reply that says it is a stand-in
 *   (fallback: true, estimate: true), carries an error, or says model: false with an error. A refused sample (400, 413,
 *   422), a busy product (429) or a bare model: false says nothing sure about the product, so it neither passes nor fails.
 */
import { planChecks } from "@/lib/outputs/prove";
import type { Manifest } from "@/lib/types";

/** The longest the check waits for the action. Prove's calls get 130 s. */
export const LIVE_ACTION_TIMEOUT_MS = 120_000;
/** A run estimated above this isn't called by the check: one call of a costly product could cost more than its build. */
export const LIVE_ACTION_MAX_RUN_USD = 2;
/** The largest sample swapped in: a Vercel Function takes a 4.5 MB body, and base64 adds a third. */
export const SAMPLE_MAX_BYTES = 3 * 1024 * 1024;

export interface LiveCall {
  name: string;
  args: Record<string, unknown>;
}

/** The call to make, or why there is none. */
export function pickLiveCall(manifest: Manifest | null, liveUrl: string): { call: LiveCall } | { skip: string } {
  if (!manifest) return { skip: "it has no musemuse.json to read its actions from" };
  if ((manifest.estimatedCostPerRunUsd ?? 0) > LIVE_ACTION_MAX_RUN_USD) {
    return { skip: `a run is estimated at $${manifest.estimatedCostPerRunUsd.toFixed(2)}, above the check's $${LIVE_ACTION_MAX_RUN_USD.toFixed(2)}` };
  }
  const product = { slug: manifest.slug, name: manifest.name, tagline: manifest.tagline, liveUrl, manifest };
  const planned = planChecks({ product, origin: "https://musemuse.invalid", dir: "/", capUsd: Number.POSITIVE_INFINITY, estimatedCostPerRunUsd: 0, fetchable: false });
  const first = planned.calls[0];
  if (first) return { call: { name: first.name, args: first.args } };
  if (!manifest.actions.length) return { skip: "it has no actions" };
  const why = planned.notCalled[0]?.why.replace(/\.$/, "");
  return { skip: why ? `no action was safe to call (${planned.notCalled[0]!.name}: ${why.charAt(0).toLowerCase()}${why.slice(1)})` : "no action was safe to call" };
}

// ---------- Shortened data URLs ----------

const EXT_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  wav: "audio/wav",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  mp4: "video/mp4",
  mov: "video/quicktime",
  pdf: "application/pdf",
};

/** The media type a fixture's name says it holds, or null. */
export function fixtureType(path: string): string | null {
  return EXT_TYPES[path.split(".").pop()?.toLowerCase() ?? ""] ?? null;
}

/** A data URL in an example that was cut short, as prove-runner.mjs reads one. */
export function isPlaceholderDataUrl(value: string): boolean {
  const m = /^data:([\w.+-]+\/[\w.+-]+)(;[^,]*)?,(.*)$/s.exec(value);
  if (!m) return false;
  const body = m[3]!;
  return body.length < 200 || /(\.\.\.|…)$/.test(body.trim());
}

/** The media types of every shortened data URL in the args, so only those fixtures are read. */
export function placeholderTypes(value: unknown, out = new Set<string>()): Set<string> {
  if (typeof value === "string" && isPlaceholderDataUrl(value)) out.add(/^data:([^;,]+)/.exec(value)![1]!);
  else if (Array.isArray(value)) for (const v of value) placeholderTypes(v, out);
  else if (value && typeof value === "object") for (const v of Object.values(value)) placeholderTypes(v, out);
  return out;
}

export interface Sample {
  path: string;
  type: string;
  bytes: Buffer;
}

/** The sample for a media type: the smallest of the exact type, else of the same kind (image, audio), under the size cap. */
export function pickSample(mime: string, samples: readonly Sample[]): Sample | null {
  const fits = samples.filter((s) => s.bytes.length > 0 && s.bytes.length <= SAMPLE_MAX_BYTES);
  const exact = fits.filter((s) => s.type === mime);
  const kind = mime.split("/")[0];
  const pool = exact.length ? exact : fits.filter((s) => s.type.split("/")[0] === kind);
  return [...pool].sort((a, b) => a.bytes.length - b.bytes.length)[0] ?? null;
}

/** The args with each shortened data URL swapped for a sample. A value with no sample of its kind is left as it is. */
export function withSamples(value: unknown, samples: readonly Sample[]): unknown {
  if (typeof value === "string" && isPlaceholderDataUrl(value)) {
    const sample = pickSample(/^data:([^;,]+)/.exec(value)![1]!, samples);
    return sample ? `data:${sample.type};base64,${sample.bytes.toString("base64")}` : value;
  }
  if (Array.isArray(value)) return value.map((v) => withSamples(v, samples));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, withSamples(v, samples)]));
  return value;
}

// ---------- The reply ----------

/** What the call showed. `inconclusive` says why it neither passed nor failed. */
export interface LiveActionVerdict {
  ok: boolean;
  /** Set when it failed: the known issue, in plain words. */
  reason?: string;
  /** Set when the reply said nothing either way about the product. */
  inconclusive?: string;
}

/** What a product answers when the sample input is wrong or it is busy, and not when it is broken. */
const NOT_ABOUT_THE_PRODUCT = [400, 413, 422, 429];

const quote = (text: string, max = 160) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}...` : flat;
};

function errorText(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value;
  if (value && typeof value === "object") {
    const message = (value as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  return null;
}

/**
 * Reads one reply. `body` is the parsed JSON, or null when it wasn't JSON. The markers are read at the top level only,
 * where the template's actions put them, so a list of items that each say `model: false` doesn't count.
 */
export function judgeLiveReply(input: { action: string; status: number | null; body: unknown; timeoutMs?: number; timedOut?: boolean }): LiveActionVerdict {
  const { action, status, body } = input;
  if (input.timedOut) return { ok: false, reason: `${action} gave no answer within ${Math.round((input.timeoutMs ?? LIVE_ACTION_TIMEOUT_MS) / 1000)} seconds` };
  if (status === null) return { ok: false, reason: `${action} couldn't be reached` };
  const obj = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  const error = obj ? errorText(obj.error) : null;
  if (NOT_ABOUT_THE_PRODUCT.includes(status)) {
    return { ok: true, inconclusive: status === 429 ? `${action} was busy (HTTP 429)` : `${action} refused the sample input (HTTP ${status})` };
  }
  if (status < 200 || status >= 300) return { ok: false, reason: `${action} answered HTTP ${status}${error ? `: ${quote(error)}` : ""}` };
  if (!obj) return { ok: true };
  // model: false with an error is a model call that failed and was covered up. On its own it can be an honest action
  // that needs no model, so it is noted, not failed.
  if (obj.model === false && error) return { ok: false, reason: `${action} answered without its AI model (model: false): ${quote(error)}` };
  if (obj.fallback === true) return { ok: false, reason: `${action} answered with a stand-in instead of its AI model (fallback: true)${error ? `: ${quote(error)}` : ""}` };
  if (obj.estimate === true || obj.estimated === true) return { ok: false, reason: `${action} answered with an estimate instead of its AI model` };
  if (error) return { ok: false, reason: `${action} answered with an error: ${quote(error)}` };
  if (obj.model === false) return { ok: true, inconclusive: `${action} said it used no AI model for this call` };
  return { ok: true };
}

/**
 * What this build's Prove it run found when it called the action through its MCP server, after the build's last
 * deploy: { ok } from its "Call <action>" check, or null when it hasn't called it. Prove it starts once a build is
 * final, so on a first ship this is null and the live check makes the call. It keeps a step that runs again on the
 * same deploy from paying for the same call twice.
 */
export function provedCall(events: ReadonlyArray<Record<string, unknown>>, action: string): { ok: boolean } | null {
  let found: { ok: boolean } | null = null;
  for (const e of events) {
    if (e.type === "deploy") found = null;
    else if (e.type === "prove" && e.item === "mcp" && Array.isArray(e.checks)) {
      const check = (e.checks as Array<{ ok?: unknown; label?: unknown }>).find((c) => c?.label === `Call ${action}`);
      if (check) found = { ok: check.ok === true };
    }
  }
  return found;
}
