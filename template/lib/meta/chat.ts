import { metaClient, type RequestLike } from "./client";
import { plain } from "./text";

/** The model a chat runs on. The brief must list it. On a test build, and while the platform says so, the gateway serves it on Spark 1.3 Contributor. */
export const CHAT_MODEL = "muse-wonder-1.0";

/** What one reply may carry. Older turns go first: a long chat costs more on every reply. */
export const CHAT_LIMITS = { turns: 20, charsPerTurn: 4_000, maxOutputTokens: 1_200 } as const;

export interface ChatTurn {
  role: "user" | "assistant";
  text: string;
}

export interface ChatOptions {
  /** What the chatbot is for and how it talks. Server only, so visitors can't change it. */
  instructions: string;
  /** The conversation so far, oldest first, ending with the visitor's message. It comes from the browser, so it's checked here. */
  turns: unknown;
}

/** Turns the browser sent, kept to the known shape and CHAT_LIMITS. Throws when there's no message to answer. */
export function chatInput(turns: unknown): Array<{ role: ChatTurn["role"]; content: string }> {
  const clean = (Array.isArray(turns) ? turns : [])
    .filter((t): t is ChatTurn => Boolean(t) && (t.role === "user" || t.role === "assistant") && typeof t.text === "string" && t.text.trim().length > 0)
    .slice(-CHAT_LIMITS.turns)
    .map((t) => ({ role: t.role, content: t.text.trim().slice(0, CHAT_LIMITS.charsPerTurn) }));
  if (clean.at(-1)?.role !== "user") throw new Error("A chat needs a message to answer.");
  return clean;
}

/** One whole reply. Use it in tests and when the screen doesn't need words as they come. */
export async function chatReply(request: RequestLike | null | undefined, options: ChatOptions): Promise<string> {
  const res = await metaClient(request).responses.create({
    model: CHAT_MODEL,
    instructions: options.instructions,
    input: chatInput(options.turns),
    max_output_tokens: CHAT_LIMITS.maxOutputTokens,
    reasoning: { effort: "low" },
  });
  return plain(res.output_text);
}

/** The reply as plain text, as it's written. Return it from a route: `new Response(await chatStream(request, options))`. */
export async function chatStream(request: RequestLike | null | undefined, options: ChatOptions): Promise<ReadableStream<Uint8Array>> {
  const events = await metaClient(request).responses.create({
    model: CHAT_MODEL,
    instructions: options.instructions,
    input: chatInput(options.turns),
    max_output_tokens: CHAT_LIMITS.maxOutputTokens,
    reasoning: { effort: "low" },
    stream: true,
  });
  const encoder = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      try {
        for await (const event of events) {
          if (event.type === "response.output_text.delta") controller.enqueue(encoder.encode(event.delta.replace(/—/g, ", ")));
        }
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });
}
