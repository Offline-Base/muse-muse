/**
 * Lambda: the lab's own glimmer-serve job, as a demo window starts it (lib/caps/gpu/windows.ts), with its GPU, TLS pin, key,
 * one-at-a-time lock and every lab cap. Nothing here reimplements them. Its address isn't a plain URL, so chat goes through
 * serveJobChatBackend. Whole-instance billing with no scale to zero, so idling is on the sweep, and the job's own deadline
 * stops the GPU whether or not the sweep runs. It carries the job's own dollar limit, so that's what is reserved.
 */
import { glimmerErrorReply, type GlimmerChatBackend } from "@/lib/train/glimmer-serving";
import { ServeError } from "@/lib/train/serve";
import { HostError, type HostAdapter, type HostHealth } from "@/lib/train/host/types";
import type { LaunchInput, LaunchResult } from "@/lib/train/launch";
import { SERVE_ADAPTER_PARAM, SERVE_BOOT_MINUTES, SERVE_MINUTES_DEFAULT, SERVE_MINUTES_PARAM, SERVE_RECIPE } from "@/lib/train/logic";

/** The recipe's first GPU, at Lambda's list price; the job's real price is what settles it. */
export const LAMBDA_HOURLY_USD = 3.29;

export interface LambdaJob {
  status: string;
  costUsd: number;
  instanceId: string | null;
  terminatedAt: Date | null;
}

export function lambdaAdapter(deps: {
  apiKey: () => string | undefined;
  ceilings: () => { maxMinutes: number; maxUsd: number };
  launch: (input: LaunchInput, caller: { userId: string }) => Promise<LaunchResult>;
  /** The adapter's serve job as the live demo reads it. */
  liveState: (adapterJobId: string) => Promise<"starting" | "live" | null>;
  job: (serveJobId: string) => Promise<LambdaJob | null>;
  stopJob: (serveJobId: string) => Promise<unknown>;
  /** The adapter's serve job with a GPU not yet down: what a crash before the ref was saved may have started. */
  serveJobOf: (adapterJobId: string) => Promise<string | null>;
  backend: (adapterJobId: string) => Promise<GlimmerChatBackend | null>;
  isTerminal: (status: string) => boolean;
}): HostAdapter {
  return {
    id: "lambda",
    label: "Lambda",
    missingKeys: () => (deps.apiKey() ? [] : ["LAMBDA_API_KEY"]),
    cantServe: (f) => (f.lambdaProblem ? `Lambda can't: ${f.lambdaProblem}` : null),
    price: () => ({ hourlyUsd: LAMBDA_HOURLY_USD, gpu: "H100", capUsd: deps.ceilings().maxUsd, maxMinutes: SERVE_MINUTES_DEFAULT + SERVE_BOOT_MINUTES }),
    async deploy({ facts, capUsd, callerId }) {
      const started = await deps.launch(
        {
          recipe: SERVE_RECIPE,
          title: "Hosted tuned model",
          params: { [SERVE_ADAPTER_PARAM]: facts.adapterJobId, [SERVE_MINUTES_PARAM]: SERVE_MINUTES_DEFAULT },
          ...(capUsd !== undefined ? { maxUsd: capUsd } : {}),
        },
        { userId: callerId },
      );
      if (!started.ok) {
        const words: Record<string, string> = {
          too_many_active: "Lambda's one slot is busy with a training or serving job. Wait for it, or stop it first.",
          demo_running: "A live demo of this model is already using its GPU. Stop it first.",
          no_capacity: "Lambda has no free GPU in this model's region right now. Try again soon.",
          daily_cap: "The lab's daily training cap wouldn't cover this.",
        };
        throw new HostError(started.status >= 500 ? 503 : 409, started.code, words[started.code] ?? "Lambda's GPU couldn't start.");
      }
      return { serveJobId: started.job.id, adapterJobId: facts.adapterJobId };
    },
    async status(ref): Promise<HostHealth> {
      const state = await deps.liveState(ref.adapterJobId ?? "");
      if (state === "live") return "ready";
      if (state === "starting") return "starting";
      return "failed";
    },
    async stop(ref) {
      const serveJobId = ref.serveJobId ?? (ref.adapterJobId ? await deps.serveJobOf(ref.adapterJobId) : null);
      // No job means it never launched, so nothing bills.
      if (!serveJobId) return { done: true, costUsd: 0 };
      const job = await deps.job(serveJobId);
      if (!job) return { done: true, costUsd: 0 };
      if (deps.isTerminal(job.status) && (job.terminatedAt || !job.instanceId)) return { done: true, costUsd: job.costUsd };
      await deps.stopJob(serveJobId);
      return { done: false };
    },
    inferenceUrl: () => null,
    async chat(ref, input) {
      const backend = await deps.backend(ref.adapterJobId ?? "");
      if (!backend) throw new HostError(503, "endpoint_closed", "This model's GPU isn't serving right now.");
      try {
        return await backend.chat({ messages: input.messages, adapter: input.adapterJobId, maxTokens: input.maxTokens, stop: input.stop, signal: input.signal });
      } catch (err) {
        const reply = err instanceof ServeError ? glimmerErrorReply(err) : { status: 502, code: "endpoint_unavailable" };
        throw new HostError(reply.status, reply.code, reply.status === 409 ? "The model is answering someone else. Try again in a moment." : "The model's GPU didn't answer. Try again soon.");
      }
    },
  };
}
