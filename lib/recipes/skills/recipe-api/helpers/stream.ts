/**
 * Streaming a Responses reply to the page as NDJSON, one event per line. Pure, with no imports.
 *
 * Server: `return new Response(ndjsonStream(await meta.responses.create({ ..., stream: true })), { headers: NDJSON_HEADERS })`.
 * Page: `const end = await readNdjson(res, (e) => { if (e.type === "delta") setText((t) => t + e.text) })`.
 */
export type StreamEvent =
  | { type: "delta"; text: string }
  /** usage is the reply's raw `usage`, read from response.completed. */
  | { type: "done"; usage: unknown; status: string }
  /** The stream broke or Meta stopped it. The text sent before it stays on the page, marked as cut off. */
  | { type: "error"; message: string };

export const NDJSON_HEADERS = { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" } as const;

type UpstreamEvent = { type: string; delta?: unknown; response?: { usage?: unknown; status?: unknown; error?: { message?: unknown } | null } | null; message?: unknown };

/** Forwards text deltas, then one done or error line. Em dashes in the text become commas. */
export function ndjsonStream(events: AsyncIterable<UpstreamEvent>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const line = (e: StreamEvent) => encoder.encode(`${JSON.stringify(e)}\n`);
  return new ReadableStream({
    async start(controller) {
      let ended = false;
      try {
        for await (const ev of events) {
          if (ev.type === "response.output_text.delta" && typeof ev.delta === "string") {
            controller.enqueue(line({ type: "delta", text: ev.delta.replace(/\u2014/g, ", ") }));
          } else if (ev.type === "response.completed" || ev.type === "response.incomplete") {
            ended = true;
            controller.enqueue(line({ type: "done", usage: ev.response?.usage ?? null, status: String(ev.response?.status ?? (ev.type === "response.completed" ? "completed" : "incomplete")) }));
          } else if (ev.type === "response.failed" || ev.type === "error") {
            ended = true;
            const said = ev.response?.error?.message ?? ev.message;
            controller.enqueue(line({ type: "error", message: typeof said === "string" && said ? said : "The model stopped before finishing." }));
          }
        }
        if (!ended) controller.enqueue(line({ type: "error", message: "The stream ended before the reply finished." }));
      } catch (err) {
        controller.enqueue(line({ type: "error", message: err instanceof Error && err.message ? err.message : "The stream broke." }));
      }
      controller.close();
    },
  });
}

export interface StreamEnd {
  text: string;
  /** True when the reply never finished: show the text with "Cut off" and a retry, which starts over. */
  cutOff: boolean;
  usage: unknown;
  error?: string;
  /** Milliseconds from the call to the first text, and to the end. The first is what streaming improves. */
  firstTextMs: number | null;
  totalMs: number;
}

/** Reads an NDJSON response from ndjsonStream. A dropped connection ends as cut off, never as a finished reply. */
export async function readNdjson(res: Response, onEvent: (e: StreamEvent) => void, now: () => number = () => Date.now()): Promise<StreamEnd> {
  const started = now();
  const end: StreamEnd = { text: "", cutOff: true, usage: null, firstTextMs: null, totalMs: 0 };
  const handle = (raw: string) => {
    if (!raw.trim()) return;
    let e: StreamEvent;
    try {
      e = JSON.parse(raw) as StreamEvent;
    } catch {
      return;
    }
    if (e.type === "delta") {
      if (end.firstTextMs === null) end.firstTextMs = now() - started;
      end.text += e.text;
    } else if (e.type === "done") {
      end.cutOff = e.status !== "completed";
      end.usage = e.usage;
    } else if (e.type === "error") {
      end.cutOff = true;
      end.error = e.message;
    }
    onEvent(e);
  };
  if (!res.body) {
    end.error = `The server answered ${res.status} with no stream.`;
  } else {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        lines.forEach(handle);
      }
      handle(buffer + decoder.decode());
    } catch (err) {
      end.cutOff = true;
      end.error = err instanceof Error && err.name === "AbortError" ? "Stopped." : "The connection dropped.";
    }
  }
  end.totalMs = now() - started;
  return end;
}
