import type { RequestLike } from "@/lib/meta/client";
import { newVisitorId, visitorCookie, visitorId } from "@/lib/platform/identity";
import { IDLE_VIEW, reduceAgent, stopMessage, type AgentEvent, type AgentView } from "./events";

/** Turns a run's events into a route's reply: a live stream for the page, or one JSON value for an action. */

const NDJSON = "application/x-ndjson";

type Start = (signal: AbortSignal, visitor: string | null) => AsyncGenerator<AgentEvent, void>;

function requestSignal(request: RequestLike | null | undefined): AbortSignal | null {
  const signal = (request as { signal?: unknown } | null | undefined)?.signal;
  return signal instanceof AbortSignal ? signal : null;
}

function headerOf(request: RequestLike | null | undefined, name: string): string | null {
  if (!request) return null;
  const headers = "get" in request && typeof request.get === "function" ? request : (request as { headers: { get(n: string): string | null } }).headers;
  return headers.get(name);
}

/** A run spends the product's budget and can act as its owner, so only its own pages can start one. */
function crossSite(request: RequestLike | null | undefined): Response | null {
  return headerOf(request, "sec-fetch-site") === "cross-site"
    ? Response.json({ error: "This only works from this product's own pages." }, { status: 403 })
    : null;
}

/** The browser's visitor id, and a cookie to set when this is its first run. */
function visitorFor(request: RequestLike | null | undefined): { visitor: string | null; cookie: string | null } {
  if (!request) return { visitor: null, cookie: null };
  const known = visitorId(request);
  if (known) return { visitor: known, cookie: null };
  const fresh = newVisitorId();
  return { visitor: fresh, cookie: visitorCookie(fresh) };
}

export function streamResponse(request: RequestLike | null | undefined, signal: AbortSignal | undefined, start: Start): Response {
  const refused = crossSite(request);
  if (refused) return refused;
  const { visitor, cookie } = visitorFor(request);
  const cancel = new AbortController();
  const fromRequest = requestSignal(request);
  const combined = AbortSignal.any([cancel.signal, ...(signal ? [signal] : []), ...(fromRequest ? [fromRequest] : [])]);
  const events = start(combined, visitor);
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await events.next();
        // The page left while this event was on its way, so the stream is already closed.
        if (cancel.signal.aborted) return;
        if (next.done) controller.close();
        else controller.enqueue(encoder.encode(`${JSON.stringify(next.value)}\n`));
      } catch (err) {
        if (cancel.signal.aborted) return;
        console.error("[agent] the run's stream failed:", err);
        const message = stopMessage("error");
        const ended: AgentEvent = { type: "done", status: "failed", reason: "error", text: "", costUsd: 0, message };
        controller.enqueue(encoder.encode(`${JSON.stringify(ended)}\n`));
        controller.close();
      }
    },
    async cancel() {
      cancel.abort();
      await events.return(undefined).catch(() => {});
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": `${NDJSON}; charset=utf-8`,
      "cache-control": "no-store",
      "x-accel-buffering": "no",
      ...(cookie ? { "set-cookie": cookie } : {}),
    },
  });
}

/** `{ answer, sources, steps, stopped, status }`, or the live events for a caller that asks for them. */
export async function actionResponse(request: Request, signal: AbortSignal | undefined, start: Start): Promise<Response> {
  if (request.headers.get("accept")?.includes(NDJSON)) return streamResponse(request, signal, start);
  const refused = crossSite(request);
  if (refused) return refused;
  // A connector's caller keeps no cookie, so a new id per call would only hide it from the per-person limits.
  const visitor = visitorId(request);
  const combined = AbortSignal.any([request.signal, ...(signal ? [signal] : [])]);
  let view: AgentView = IDLE_VIEW;
  for await (const event of start(combined, visitor)) view = reduceAgent(view, event);
  const status = view.status === "idle" || view.status === "running" ? "failed" : view.status;
  const stopped = status !== "completed";
  const message = stopped ? (view.message ?? stopMessage(view.reason)) : undefined;
  return Response.json(
    {
      answer: view.answer,
      sources: view.sources.filter((s) => s.cited).map((s) => ({ title: s.title, url: s.href })),
      steps: view.steps.map((s) => ({ title: s.title, state: s.state })),
      stopped,
      status,
      ...(message ? { message } : {}),
    },
    { status: status === "failed" && view.reason !== "no_answer" ? 502 : 200 },
  );
}
