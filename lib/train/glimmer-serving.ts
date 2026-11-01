/**
 * Serving Muse Glimmer for products (docs/TRAINING.md "Products call the hosted tuned Glimmer"): the single source of
 * how the platform asks a glimmer-serve job's GPU for a chat answer, base Glimmer's or a tuned adapter's. Wave 3's unit
 * 11 imports GlimmerChatBackend, serveJobChatBackend, GLIMMER_SAMPLING and GLIMMER_EOS_IDS from here and never
 * reimplements them; its gateway route, serving windows, daily cap and fallback to Muse Wonder are its own.
 *
 * Meta's guidance (content/meta-docs/pages/muse-glimmer/deploy.md), followed here and in the serve job's Python
 * (lib/train/recipes/serve.ts, which has the same numbers; a test keeps them equal):
 * - Sampling: temperature 1.0, top_p 0.95 and top_k 64, all three on every request, never greedy (lines 239 and 243).
 * - Stops: eos_token_id [200001, 200008], <|end_of_text|> and <|eot|> (line 317; lines 1015 to 1025 for Transformers).
 * - Never stop on <|eom|> (lines 319 to 321): it is taken out of any stop a caller asks for and never added, for base
 *   Glimmer or a trainChannel 1 adapter. An adapter trained before trainChannel (trainChannel 0, every adapter so far)
 *   answers on a final channel the prompt opens, as it was trained, and only there the GPU also stops at <|eom|> and
 *   <|start|>, server side (followups.md, the trainChannel stop rule): they catch it drifting into a second message, and
 *   can't cut reasoning, since none follows a prefilled final channel.
 * - Reasoning needs headroom (line 22): 1,024 new tokens by default for a final-only answer, 4,096 for one that reasons
 *   first, and never more than 4,096. A reasoning answer cut off mid-thought comes back empty with finish "length"
 *   (line 690).
 * The lab's eval and the Try it live box (/generate) stay greedy, so their answers compare with the scores.
 *
 * Server only.
 */
import { askChat, ServeError, serveKeyFor, serveTiming, type ChatAnswer } from "@/lib/train/serve";
import { liveChatServeTarget, releaseDemoSlot, takeDemoSlot, type ChatServeTargetRow } from "@/lib/train/store";

/** Meta's published sampling for Muse Glimmer, sent on every chat request (deploy.md lines 239 and 243). */
export const GLIMMER_SAMPLING = { temperature: 1.0, top_p: 0.95, top_k: 64 } as const;
/** Meta's eos_token_id: <|end_of_text|> and <|eot|> (deploy.md line 317). The GPU checks its tokenizer agrees. */
export const GLIMMER_EOS_IDS: readonly [200001, 200008] = [200001, 200008];
/** The end-of-message token: never a stop (deploy.md lines 319 to 321). */
export const GLIMMER_EOM = "<|eom|>";
/** The stops only a trainChannel 0 adapter's tuned model gets, on the GPU, with its final channel prefilled. */
export const GLIMMER_FINAL_ONLY_STOPS = ["<|eom|>", "<|start|>"] as const;
/** New tokens: the default for a final-only answer and for one that reasons first, and the most any request gets. */
export const GLIMMER_MAX_TOKENS = { final: 1024, reasoning: 4096, cap: 4096 } as const;
/** The serve job's "model" for base Glimmer (the adapter off). The adapter's job id asks for the tuned model. */
export const GLIMMER_BASE_MODEL = "muse-glimmer";
/** The serve job's chat route. */
export const GLIMMER_CHAT_PATH = "/v1/chat/completions";

/** One chat answer's time on the GPU (the Python's CHAT_ANSWER_SECONDS), inside serveTiming.chatMs less its connect. */
export const CHAT_ANSWER_SECONDS = 135;
/** The longest prompt the GPU takes, in tokens: past it, 422 too_long (a bad_prompt ServeError). */
export const CHAT_PROMPT_TOKENS_MAX = 4096;
/** A chat request's messages: at most this many, with at most CHAT_CHARS_MAX characters of content in all. */
export const CHAT_MESSAGES_MAX = 64;
export const CHAT_CHARS_MAX = 32_000;
/** Stops a caller may ask for, and the longest one. */
export const CHAT_STOPS_MAX = 4;
export const CHAT_STOP_CHARS_MAX = 64;

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface GlimmerChatInput {
  messages: ChatMessage[];
  /** null for base Glimmer; the adapter's job id for its tuned model, which must be the one this backend's window serves. */
  adapter: string | null;
  /** New tokens; GLIMMER_MAX_TOKENS's default for the answer's channel when left out, never more than the cap. */
  maxTokens?: number;
  /** Optional, added after the contract: stops for the answer's text, with <|eom|> taken out (glimmerStops). */
  stop?: string | readonly string[];
  signal?: AbortSignal;
}

export interface GlimmerChatReply {
  text: string;
  finish: "stop" | "length";
  usage: { input: number; output: number };
  ms: number;
}

/** What wave 3's gateway calls for a hosted Glimmer answer. Throws ServeError (glimmerErrorReply maps it). */
export interface GlimmerChatBackend {
  chat(i: GlimmerChatInput): Promise<GlimmerChatReply>;
}

/** "final": a trainChannel 0 adapter's tuned model, on a prefilled final channel. "reasoning": base Glimmer, or trainChannel 1. */
export type GlimmerChannel = "final" | "reasoning";

export function glimmerChannel(tuned: boolean, trainChannel: 0 | 1): GlimmerChannel {
  return tuned && trainChannel === 0 ? "final" : "reasoning";
}

/** The new tokens to ask for: the channel's default when none is asked, held to the cap; null for anything but a whole number from 1. */
export function glimmerMaxTokens(requested: number | undefined, channel: GlimmerChannel): number | null {
  if (requested === undefined) return GLIMMER_MAX_TOKENS[channel];
  if (!Number.isInteger(requested) || requested < 1) return null;
  return Math.min(requested, GLIMMER_MAX_TOKENS.cap);
}

/**
 * A caller's stops as the GPU gets them: <|eom|> taken out of each (deploy.md lines 319 to 321), the ones left empty
 * and repeats dropped. Null when there are more than CHAT_STOPS_MAX, or one is over CHAT_STOP_CHARS_MAX characters.
 */
export function glimmerStops(requested: string | readonly string[] | undefined): string[] | null {
  if (requested === undefined) return [];
  const list = typeof requested === "string" ? [requested] : [...requested];
  if (list.length > CHAT_STOPS_MAX || list.some((s) => typeof s !== "string" || s.length > CHAT_STOP_CHARS_MAX)) return null;
  const kept: string[] = [];
  for (const s of list) {
    const stop = s.split(GLIMMER_EOM).join("");
    if (stop && !kept.includes(stop)) kept.push(stop);
  }
  return kept;
}

/**
 * Why the GPU would refuse these messages (the Python's chat_request checks the same), or null: 1 to CHAT_MESSAGES_MAX
 * of {role, content}, roles system, user or assistant, content text, a system message only first, the last a user
 * message with text, and CHAT_CHARS_MAX characters in all.
 */
export function chatMessagesProblem(messages: unknown): string | null {
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > CHAT_MESSAGES_MAX) {
    return `Send 1 to ${CHAT_MESSAGES_MAX} messages.`;
  }
  let chars = 0;
  for (const [i, m] of messages.entries()) {
    const role = (m as { role?: unknown } | null)?.role;
    const content = (m as { content?: unknown } | null)?.content;
    if ((role !== "system" && role !== "user" && role !== "assistant") || typeof content !== "string") {
      return "Each message needs a role (system, user or assistant) and text.";
    }
    if (role === "system" && i !== 0) return "Only the first message may be the system message.";
    chars += content.length;
  }
  const last = messages[messages.length - 1] as ChatMessage;
  if (last.role !== "user" || !last.content.trim()) return "The last message must be the user's, with text.";
  if (chars > CHAT_CHARS_MAX) return `Keep the messages under ${CHAT_CHARS_MAX} characters in all.`;
  return null;
}

/** The body of one POST /v1/chat/completions: OpenAI's chat shape, with Meta's sampling always in it. */
export function glimmerChatBody(i: { model: string; messages: readonly ChatMessage[]; maxTokens: number; stop: readonly string[] }): Record<string, unknown> {
  return {
    model: i.model,
    messages: i.messages.map((m) => ({ role: m.role, content: m.content })),
    max_tokens: i.maxTokens,
    ...GLIMMER_SAMPLING,
    ...(i.stop.length ? { stop: [...i.stop] } : {}),
    stream: false,
  };
}

/**
 * A ServeError as the gateway answers it (the contract in docs/TRAINING.md "Fine-tune like a build"): busy 409,
 * stopping 503 glimmer_closed (the window is closing), timeout 504, a request the GPU refused 400 bad_request (the
 * caller's to fix, so no fallback is needed), and unreachable, pin_mismatch, refused or bad_answer 502.
 */
export function glimmerErrorReply(err: ServeError): { status: number; code: string } {
  switch (err.code) {
    case "busy":
      return { status: 409, code: "busy" };
    case "stopping":
      return { status: 503, code: "glimmer_closed" };
    case "timeout":
      return { status: 504, code: "timeout" };
    case "bad_prompt":
      return { status: 400, code: "bad_request" };
    default:
      return { status: 502, code: "glimmer_unavailable" };
  }
}

export interface ChatWindowDeps {
  /** The live serve job of a chat adapter (or for null any chat adapter's), as liveChatServeTarget answers. */
  target(adapterJobId: string | null, now: Date): Promise<ChatServeTargetRow | null>;
  takeSlot(serveJobId: string): Promise<Date | null>;
  releaseSlot(serveJobId: string, window: Date): Promise<void>;
  /** askChat unless a test says otherwise. */
  ask?: (target: { ip: string; port: number; certSha256: string }, key: string, body: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal) => Promise<ChatAnswer>;
  /** serveKeyFor unless a test says otherwise. */
  keyFor?: (jobId: string, tokenHash: string) => string;
  slotWaitMs?: number;
  slotPollMs?: number;
}

/** How long a chat call waits for the window's one slot (the Try it live box or another product may hold it), and how often it looks. */
export const CHAT_SLOT_WAIT_MS = 8_000;
export const CHAT_SLOT_POLL_MS = 250;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const bad = (message: string) => new ServeError("bad_prompt", message, 400);

/**
 * serveJobChatBackend on given deps (the tests' fakes): the backend of the live window for an adapter (or for null any
 * chat adapter's, for base Glimmer), or null when none is live. Its chat() checks the request before the GPU sees it
 * (bad_prompt), takes the window's one slot (busy after CHAT_SLOT_WAIT_MS), sends the GPU's /v1/chat/completions the
 * messages with Meta's sampling, and gives the slot back. The slot wait counts against serveTiming.chatMs, so the call
 * ends by then and the slot (the Try it live box's too) is never held past it. A ServeError's message never names the
 * GPU's address.
 */
export function chatWindowBackends(deps: ChatWindowDeps): (adapterJobId: string | null, now?: Date) => Promise<GlimmerChatBackend | null> {
  const ask = deps.ask ?? askChat;
  const keyFor = deps.keyFor ?? serveKeyFor;
  return async (adapterJobId, now = new Date()) => {
    const target = await deps.target(adapterJobId, now);
    if (!target) return null;
    const scrub = (message: string) => message.split(target.ip).join("[Glimmer GPU]");
    return {
      async chat(i) {
        const problem = chatMessagesProblem(i.messages);
        if (problem) throw bad(problem);
        const adapter = typeof i.adapter === "string" ? i.adapter.trim().toLowerCase() : i.adapter;
        if (adapter !== null && adapter !== target.adapterJobId) throw bad("This window serves another adapter's model.");
        const tuned = adapter !== null;
        const maxTokens = glimmerMaxTokens(i.maxTokens, glimmerChannel(tuned, target.trainChannel));
        if (maxTokens === null) throw bad("maxTokens must be a whole number from 1.");
        const stop = glimmerStops(i.stop);
        if (stop === null) throw bad(`Send at most ${CHAT_STOPS_MAX} stops of up to ${CHAT_STOP_CHARS_MAX} characters.`);
        const body = glimmerChatBody({ model: tuned ? target.adapterJobId : GLIMMER_BASE_MODEL, messages: i.messages, maxTokens, stop });

        const began = Date.now();
        const giveUp = began + (deps.slotWaitMs ?? CHAT_SLOT_WAIT_MS);
        let window: Date | null = null;
        for (;;) {
          window = await deps.takeSlot(target.jobId);
          if (window || i.signal?.aborted || Date.now() >= giveUp) break;
          await sleep(deps.slotPollMs ?? CHAT_SLOT_POLL_MS);
        }
        if (!window) {
          if (i.signal?.aborted) throw new ServeError("timeout", "The caller stopped waiting.");
          throw new ServeError("busy", "Muse Glimmer's GPU stayed on another request.", 409);
        }
        try {
          const left = serveTiming.chatMs - (Date.now() - began);
          if (i.signal?.aborted || left <= 0) throw new ServeError("timeout", "The caller stopped waiting.");
          const got = await ask({ ip: target.ip, port: target.port, certSha256: target.certSha256 }, keyFor(target.jobId, target.tokenHash), body, left, i.signal);
          return { text: got.text, finish: got.finish, usage: got.usage, ms: got.ms };
        } catch (err) {
          // Node's connection errors name the address; the caller's log never sees it.
          if (err instanceof ServeError) throw new ServeError(err.code, scrub(err.message), err.status);
          throw new Error(scrub(err instanceof Error ? err.message : String(err)));
        } finally {
          await deps.releaseSlot(target.jobId, window).catch((e) =>
            console.error("[glimmer-serving] releasing the window's slot failed", e instanceof Error ? e.message : e),
          );
        }
      },
    };
  };
}

const storeBackends = chatWindowBackends({
  target: liveChatServeTarget,
  takeSlot: (serveJobId) => takeDemoSlot(serveJobId),
  releaseSlot: releaseDemoSlot,
});

/**
 * The contract: a GlimmerChatBackend on the live glimmer-serve job of `adapterJobId` (its tuned model, and base Glimmer
 * with adapter null), or for null any chat adapter's window (base Glimmer only), or null when no window serves it. The
 * same GPU, serving key, certificate pin and one-at-a-time lock as the room's Try it live box (/generate) and decision
 * models' /decide, and the same platform slot (takeDemoSlot), so the two never contend for the GPU. Throws ServeError:
 * busy, stopping, timeout, bad_prompt, unreachable, pin_mismatch, refused, bad_answer (glimmerErrorReply maps each).
 * Whether a serving window is open for products (glimmer_windows, GPU_GLIMMER_SHARED) is unit 11's to check first.
 */
export function serveJobChatBackend(adapterJobId: string | null, now: Date = new Date()): Promise<GlimmerChatBackend | null> {
  return storeBackends(adapterJobId, now);
}
