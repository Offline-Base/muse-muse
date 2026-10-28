/**
 * The live demo's two calls from the browser (docs/TRAINING.md "Live demo"), kept apart from React so tests can run
 * them against a faked fetch: one app idea to POST /api/lab/{id}/try (anyone), and an admin's Start a live demo to
 * POST /api/train/jobs with the glimmer-serve recipe. Neither ever sees the GPU's address, key or certificate.
 */
import { errorCode, startErrorText, TRY_WAIT_MS, tryAnswerOf, tryErrorText } from "@/components/train/format";
import { SERVE_ADAPTER_PARAM, SERVE_MINUTES_PARAM, SERVE_RECIPE } from "@/lib/train/logic";
import type { TryLiveAnswer } from "@/lib/train/types";

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

const OFFLINE = "Couldn't reach Muse Muse. Check your connection and try again.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TITLE_MAX = 200;

export type TryResult =
  | { ok: true; answer: TryLiveAnswer }
  /** `ended`: the route said no_live_demo, so the demo is over and the box should close. */
  | { ok: false; message: string; ended: boolean };

/**
 * Sends one app idea to the adapter's live demo and returns both answers, or the sentence to show. Gives up after
 * `waitMs` (TRY_WAIT_MS: the proxy's 120 s plus the trip) and says so as a timeout.
 */
export async function askLiveDemo(
  adapterJobId: string,
  prompt: string,
  opts: { fetch?: Fetch; waitMs?: number } = {},
): Promise<TryResult> {
  const text = prompt.trim();
  if (!text) return { ok: false, message: "Type an app idea first.", ended: false };
  const send = opts.fetch ?? ((input, init) => fetch(input, init));
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.waitMs ?? TRY_WAIT_MS);
  const timedOut = (): TryResult => ({ ok: false, message: tryErrorText(504, { error: "timeout" }), ended: false });
  try {
    const res = await send(`/api/lab/${encodeURIComponent(adapterJobId)}/try`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: text }),
      cache: "no-store",
      signal: ac.signal,
    });
    const data: unknown = await res.json().catch(() => ({}));
    if (ac.signal.aborted) return timedOut();
    if (!res.ok) return { ok: false, message: tryErrorText(res.status, data), ended: errorCode(data) === "no_live_demo" };
    const answer = tryAnswerOf(data);
    if (!answer) return { ok: false, message: "The live demo's answer didn't come back whole. Try again.", ended: false };
    return { ok: true, answer };
  } catch {
    return ac.signal.aborted ? timedOut() : { ok: false, message: OFFLINE, ended: false };
  } finally {
    clearTimeout(timer);
  }
}

export type StartResult =
  | { ok: true; jobId: string | null }
  /** `running`: a demo for this adapter is already open (demo_running), so the page should show it. */
  | { ok: false; message: string; running: boolean };

/**
 * Starts a live demo of a trained adapter: POST /api/train/jobs with the glimmer-serve recipe, the adapter and the
 * minutes, and no limits, so the route sizes them from the minutes (recipeDefaults under the ceilings). Returns the new
 * job's id, or the New job card's sentence for a refusal.
 */
export async function startLiveDemo(
  demo: { adapterJobId: string; adapterTitle: string; minutes: number },
  limits: { maxActive: number; dailyUsd: number },
  opts: { fetch?: Fetch } = {},
): Promise<StartResult> {
  const send = opts.fetch ?? ((input, init) => fetch(input, init));
  try {
    const res = await send("/api/train/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        recipe: SERVE_RECIPE,
        title: `Live demo: ${demo.adapterTitle}`.slice(0, TITLE_MAX),
        params: { [SERVE_ADAPTER_PARAM]: demo.adapterJobId, [SERVE_MINUTES_PARAM]: demo.minutes },
      }),
    });
    const data: unknown = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, message: startErrorText(res.status, data, limits), running: errorCode(data) === "demo_running" };
    }
    const id = (data as { job?: { id?: unknown } } | null)?.job?.id;
    return { ok: true, jobId: typeof id === "string" && UUID.test(id) ? id : null };
  } catch {
    return { ok: false, message: OFFLINE, running: false };
  }
}
