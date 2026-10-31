// Shared by the agent kit's tests: resolves @/ the way a product does, with the overlay's files on top of the template,
// and a fake gateway that serves Meta's SSE and the tool routes. The event shapes are copied from real runs on
// muse-wonder-1.0 (Oct 31, 2026). Nothing here reaches the network.
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const TEMPLATE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const TARGET = path.join(TEMPLATE, "targets/agent");
export const FILES = path.join(TARGET, "files");

registerHooks({
  resolve(specifier, context, next) {
    if (!specifier.startsWith("@/")) return next(specifier, context);
    const spec = specifier.slice(2);
    for (const root of [FILES, TEMPLATE]) {
      for (const ext of [".ts", ".tsx"]) {
        const file = path.join(root, spec + ext);
        if (existsSync(file)) return { url: pathToFileURL(file).href, format: "module", shortCircuit: true };
      }
    }
    return next(specifier, context);
  },
});

export const TOKEN = "tok_test_product";

export function useEnv() {
  process.env.GATEWAY_URL = "https://gateway.example/api/gateway";
  process.env.PRODUCT_TOKEN = TOKEN;
}

/** One SSE stream: `event:` and `data:` lines, as Meta sends them, then [DONE]. */
export function sseBody(events) {
  const lines = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  return `${lines.join("")}data: [DONE]\n\n`;
}

export const usage = (input = 1000, output = 200) => ({ input_tokens: input, input_tokens_details: { cached_tokens: 0 }, output_tokens: output, total_tokens: input + output });

export const message = (text, extra = {}) => ({ id: extra.id ?? `msg_${text.length}`, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: extra.annotations ?? [], logprobs: [] }], ...(extra.phase ? { phase: extra.phase } : {}) });

export const search = (id, query, results = [], status = "completed") => ({ id, type: "web_search_call", status, action: { type: "search", queries: [query], query }, results });

export const hit = (url, title) => ({ type: "text_result", title, url, snippet: "" });

export const call = (callId, name, args = {}) => ({ id: `fc_${callId}`, type: "function_call", call_id: callId, name, arguments: JSON.stringify(args), status: "completed" });

/**
 * A turn as Meta streams it: created, then each output item added and done, text deltas for messages, then completed.
 * Pass `{ cutAfter: n }` to stop after n events and hold the stream open until the request is aborted.
 */
export function turn(id, output, opts = {}) {
  const events = [{ type: "response.created", response: { id, status: "in_progress" } }];
  for (const item of output) {
    events.push({ type: "response.output_item.added", item: { ...item, status: "in_progress", ...(item.type === "message" ? { content: [] } : {}), ...(item.type === "web_search_call" ? { results: undefined } : {}) } });
    if (item.type === "message") {
      const text = item.content.map((c) => c.text).join("");
      events.push({ type: "response.output_text.delta", item_id: item.id, delta: text });
      for (const annotation of item.content.flatMap((c) => c.annotations)) events.push({ type: "response.output_text.annotation.added", item_id: item.id, annotation });
    }
    events.push({ type: "response.output_item.done", item });
  }
  // Meta leaves a failed call over max_tool_calls out of the final output, as the real runs showed.
  const final = output.filter((o) => !(o.type === "web_search_call" && o.status === "failed"));
  events.push({ type: opts.terminal ?? "response.completed", response: { id, status: "completed", output: final, usage: opts.usage ?? usage(), ...(opts.response ?? {}) } });
  return { ...opts, events };
}

export const errorReply = (status, code, message) => ({ status, json: { error: { type: "rate_limit_error", code, message, param: null } }, headers: { "x-should-retry": "false" } });

/**
 * Replaces fetch. `turns` are served in order to POST /v1/responses: a turn(), an errorReply(), or a function of the
 * request. `execute(body, request)` answers /tools/execute, `tools` answers GET /tools. Every request is recorded.
 */
export function fakeGateway({ turns = [], execute, tools, routes = {} } = {}) {
  const requests = [];
  const queue = turns.slice();
  const saved = globalThis.fetch;
  let modelInFlight = 0;
  const seen = { maxModelInFlight: 0, maxExecuteInFlight: 0 };
  let executeInFlight = 0;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : (input.url ?? String(input)));
    const headers = new Headers(init.headers);
    const body = typeof init.body === "string" ? JSON.parse(init.body) : null;
    const request = { path: url.pathname.replace("/api/gateway", ""), query: url.searchParams, method: init.method ?? "GET", headers, body, signal: init.signal };
    requests.push(request);
    if (request.path === "/v1/responses") {
      modelInFlight++;
      seen.maxModelInFlight = Math.max(seen.maxModelInFlight, modelInFlight);
      let next = queue.shift();
      if (typeof next === "function") next = await next(request);
      if (!next) throw new Error(`The fake gateway has no turn left (request ${requests.length}).`);
      if (next.json) {
        modelInFlight--;
        return Response.json(next.json, { status: next.status, headers: next.headers });
      }
      return sseResponse(next, init.signal, () => modelInFlight--);
    }
    if (request.path === "/tools/execute") {
      executeInFlight++;
      seen.maxExecuteInFlight = Math.max(seen.maxExecuteInFlight, executeInFlight);
      try {
        const reply = await execute(body, request);
        if (reply?.status) return Response.json(reply.json, { status: reply.status });
        return Response.json(reply);
      } finally {
        executeInFlight--;
      }
    }
    if (request.path === "/tools" && tools) return Response.json(tools);
    const route = routes[request.path];
    if (route) {
      const reply = typeof route === "function" ? await route(request) : route;
      return Response.json(reply.json ?? reply, { status: reply.status ?? 200 });
    }
    throw new Error(`The fake gateway has no route for ${request.path}`);
  };
  return {
    requests,
    seen,
    model: () => requests.filter((r) => r.path === "/v1/responses"),
    executes: () => requests.filter((r) => r.path === "/tools/execute"),
    left: () => queue.length,
    restore: () => {
      globalThis.fetch = saved;
    },
  };
}

function sseResponse(next, signal, closed) {
  const encoder = new TextEncoder();
  const events = next.cutAfter === undefined ? next.events : next.events.slice(0, next.cutAfter);
  let finished = false;
  const finish = () => {
    if (!finished) {
      finished = true;
      closed();
    }
  };
  const stream = new ReadableStream({
    start(controller) {
      for (const event of events) controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
      if (next.cutAfter === undefined) {
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
        finish();
        return;
      }
      if (next.onHeld) next.onHeld();
      const abort = () => {
        finish();
        const err = new Error("This operation was aborted");
        err.name = "AbortError";
        controller.error(err);
      };
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort);
    },
    cancel: finish,
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream", ...(next.headers ?? {}) } });
}

/** Every event of a run, as a list. */
export async function collect(events) {
  const out = [];
  for await (const event of events) out.push(event);
  return out;
}

export const doneOf = (events) => events.findLast((e) => e.type === "done");
export const ofType = (events, type) => events.filter((e) => e.type === type);

/** The tool list the gateway gives for these public tools. */
export function toolList(entries) {
  return {
    simulated: true,
    principal: "build",
    toolSearch: false,
    tools: entries.map(([id, access = "read", slug = id.toUpperCase()]) => ({
      id,
      label: `${id} records`,
      stepTitle: `Looking up ${id}`,
      tier: "public",
      access,
      functions: [{ type: "function", name: slug, description: `Does ${id}`, parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] }, strict: false }],
    })),
  };
}
