import type { DecideBackend, DecideServeItem } from "@/lib/decide/types";
import { DecideBackendError } from "@/lib/gateway/decide";
import { askDecide, ServeError, serveKeyFor, serveTiming, type ServeTarget } from "@/lib/train/serve";

/**
 * {GATEWAY_URL}/decide's backend on the lab's own serving windows (docs/DECISION_MODELS.md, "The gateway route"): a
 * glimmer-serve job serving a decision model's adapter scores the gateway's prompts at its POST /decide, the tuned
 * model's scores for that model and base Glimmer's (the adapter off) for muse-decide zero-shot. One request at a time
 * per window, through the same slot the Try it live box takes (takeDemoSlot), so the GPU's lock is never contended.
 * Wave 3 unit 11's shared endpoint is another DecideBackend; the gateway's route picks.
 */

/** A serve job's demo server, with the token hash its serving key is derived from. */
export interface WindowTarget extends ServeTarget {
  jobId: string;
  tokenHash: string;
}

export interface WindowDeps {
  /** The live serve job of this decision model (its job id), or for null any decision model's (base Glimmer). */
  target(adapter: string | null): Promise<WindowTarget | null>;
  takeSlot(serveJobId: string): Promise<Date | null>;
  releaseSlot(serveJobId: string, window: Date): Promise<void>;
  /** askDecide unless a test says otherwise. */
  ask?: typeof askDecide;
  /** serveKeyFor unless a test says otherwise. */
  keyFor?: (jobId: string, tokenHash: string) => string;
  slotWaitMs?: number;
  slotPollMs?: number;
}

/** How long a call waits for the window's slot (a decision takes well under 2 s), and how often it looks. */
export const SLOT_WAIT_MS = 8_000;
export const SLOT_POLL_MS = 250;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The slot's window once taken, or null when it stayed taken for waitMs or the signal aborted. */
async function waitForSlot(deps: WindowDeps, jobId: string, signal: AbortSignal | undefined): Promise<Date | null> {
  const giveUp = Date.now() + (deps.slotWaitMs ?? SLOT_WAIT_MS);
  for (;;) {
    const window = await deps.takeSlot(jobId);
    if (window) return window;
    if (signal?.aborted || Date.now() >= giveUp) return null;
    await sleep(deps.slotPollMs ?? SLOT_POLL_MS);
  }
}

/**
 * The gateway's deps.backend on serving windows: the backend of the live window for an adapter (or for null, any
 * decision model's window, for base Glimmer), or null when none is live. Its score() takes the window's slot (busy
 * after SLOT_WAIT_MS), sends the prompts' messages and letters to the GPU's /decide, and gives back the tuned model's
 * log-probabilities for an adapter and base Glimmer's for null. A ServeError becomes a DecideBackendError (busy,
 * offline for a window shutting down, timeout, too_long for a prompt the GPU refused as over 2,048 tokens) or an Error
 * whose message never names the GPU's address.
 */
export function windowBackends(deps: WindowDeps): (adapter: string | null) => Promise<DecideBackend | null> {
  const ask = deps.ask ?? askDecide;
  const keyFor = deps.keyFor ?? serveKeyFor;
  return async (adapter) => {
    const target = await deps.target(adapter);
    if (!target) return null;
    return {
      async score(input) {
        const began = Date.now();
        const window = await waitForSlot(deps, target.jobId, input.signal);
        if (!window) {
          if (input.signal?.aborted) throw new DecideBackendError("timeout", "The caller stopped waiting.");
          throw new DecideBackendError("busy", "The decision model's GPU stayed on another request.");
        }
        try {
          // The slot wait counts against the call's time, so the GPU call ends by the time the gateway gives up on it
          // and the window's one slot (the Try it live box's too) is never held past that.
          const left = serveTiming.decideMs - (Date.now() - began);
          if (input.signal?.aborted || left <= 0) throw new DecideBackendError("timeout", "The caller stopped waiting.");
          const items: DecideServeItem[] = input.prompts.map((p, i) => ({ messages: p.messages, letters: [...(input.letters[i] ?? [])] }));
          const got = await ask({ ip: target.ip, port: target.port, certSha256: target.certSha256 }, keyFor(target.jobId, target.tokenHash), items, left);
          return { logprobs: input.adapter ? got.tuned : got.base, ms: got.ms };
        } catch (err) {
          if (err instanceof DecideBackendError) throw err;
          if (err instanceof ServeError) {
            if (err.code === "busy") throw new DecideBackendError("busy", err.message);
            if (err.code === "stopping") throw new DecideBackendError("offline", err.message);
            if (err.code === "timeout") throw new DecideBackendError("timeout", err.message);
            if (err.code === "bad_prompt" && err.status === 422) throw new DecideBackendError("too_long", err.message);
          }
          // Node's connection errors name the address; the gateway's log never sees it.
          const message = err instanceof Error ? err.message : String(err);
          throw new Error(message.split(target.ip).join("[decision GPU]"));
        } finally {
          await deps.releaseSlot(target.jobId, window).catch((e) =>
            console.error("[decide] releasing the window's slot failed", e instanceof Error ? e.message : e),
          );
        }
      },
    };
  };
}
