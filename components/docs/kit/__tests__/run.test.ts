/**
 * What a demo run does, without React: performRun sends through docsCall or docsStream (lib/docs/client/api) to a
 * fake fetch, reads the stream with its protocol's collector, decides what error to show and what state to end in,
 * and builds the record for the copy prompt. Nothing reaches the network.
 *
 *   npx tsx --test --experimental-test-module-mocks components/docs/kit/__tests__/run.test.ts
 */
import assert from "node:assert/strict";
import { afterEach, before, describe, it } from "node:test";

type FakeCall = { url: string; init: RequestInit };
let calls: FakeCall[] = [];
const realFetch = globalThis.fetch;
let performRun: typeof import("@/components/docs/kit/useDocsRun").performRun;

before(async () => {
  ({ performRun } = await import("@/components/docs/kit/useDocsRun"));
});

afterEach(() => {
  globalThis.fetch = realFetch;
  calls = [];
});

const enc = new TextEncoder();

/** A fetch that answers every call with `make()`, remembering what it was asked. */
function fakeFetch(make: (signal?: AbortSignal | null) => Response) {
  calls = [];
  globalThis.fetch = (async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return make(init.signal);
  }) as typeof fetch;
}

function sseResponse(events: Array<Record<string, unknown> | string>, headers: Record<string, string> = {}) {
  const text = events.map((e) => (typeof e === "string" ? `data: ${e}\n\n` : `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)).join("");
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      // Split mid-event, as a network read would.
      for (let i = 0; i < text.length; i += 37) c.enqueue(enc.encode(text.slice(i, i + 37)));
      c.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream", ...headers } });
}

function jsonResponse(json: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json", ...headers } });
}

const signal = () => new AbortController().signal;

describe("performRun", () => {
  it("streams a Responses call, hands each event over, and records the start of the answer", async () => {
    fakeFetch(() =>
      sseResponse(
        [
          { type: "response.created", response: { id: "resp_9", status: "in_progress", model: "muse-spark-1.3-contributor" } },
          { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: "The capital of France " },
          { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: "is Paris." },
          { type: "response.completed", response: { id: "resp_9", object: "response", status: "completed", output: [], usage: { input_tokens: 12, output_tokens: 30 } } },
          "[DONE]",
        ],
        { "x-docs-model": "muse-spark-1.3-contributor" },
      ),
    );
    const seen: string[] = [];
    const body = { model: "muse-spark-1.3", input: "What is the capital of France?", stream: true };
    const out = await performRun("responses", { body, stream: true, onEvent: (e) => seen.push(String(e.json?.type ?? e.data)) }, signal());

    assert.equal(calls[0].url, "/api/docs/v1/responses");
    assert.equal(calls[0].init.method, "POST");
    assert.equal(calls[0].init.credentials, "same-origin");
    assert.deepEqual(JSON.parse(String(calls[0].init.body)), body);
    assert.deepEqual(seen, ["response.created", "response.output_text.delta", "response.output_text.delta", "response.completed", "[DONE]"]);
    assert.equal(out.state, "done");
    assert.equal(out.error, null);
    assert.equal(out.reply?.text, "The capital of France is Paris.");
    assert.deepEqual(out.reply?.usage, { input_tokens: 12, output_tokens: 30 });
    assert.deepEqual(out.record, {
      method: "POST",
      path: "responses",
      body,
      model: "muse-spark-1.3-contributor",
      status: 200,
      outcome: "output_text: The capital of France is Paris.",
    });
  });

  it("records a plain JSON reply, and leaves the model out when it's the one the body named", async () => {
    fakeFetch(() =>
      jsonResponse(
        { id: "chatcmpl-1", object: "chat.completion", model: "muse-spark-1.2", choices: [{ index: 0, message: { role: "assistant", content: "Hi there." }, finish_reason: "stop" }] },
        200,
        { "x-docs-model": "muse-spark-1.2" },
      ),
    );
    const out = await performRun("chat/completions", { body: { model: "muse-spark-1.2", messages: [{ role: "user", content: "Hi" }] } }, signal());
    assert.equal(out.state, "done");
    assert.equal(out.reply, null, "plain calls aren't read by a collector");
    assert.equal(out.record?.outcome, "content: Hi there.");
    assert.equal("model" in (out.record ?? {}), false);
  });

  it("turns a 429 into an error with retry-after, and records it", async () => {
    fakeFetch(() =>
      jsonResponse({ error: { type: "rate_limit_error", code: "rate_limited", message: "Live demos are limited to 20 runs a minute. Try again in 12 s." } }, 429, {
        "retry-after": "12",
      }),
    );
    const out = await performRun("responses", { body: { model: "m", input: "x" } }, signal());
    assert.equal(out.state, "error");
    assert.deepEqual(out.error, {
      type: "rate_limit_error",
      code: "rate_limited",
      message: "Live demos are limited to 20 runs a minute. Try again in 12 s.",
      retryAfterSec: 12,
    });
    assert.equal(out.record?.outcome, "error 429: Live demos are limited to 20 runs a minute. Try again in 12 s.");
  });

  it("shows an error the stream reported even though the HTTP status was 200", async () => {
    fakeFetch(() =>
      sseResponse([
        { type: "response.created", response: { id: "resp_f", status: "in_progress" } },
        { type: "response.failed", response: { id: "resp_f", object: "response", status: "failed", output: [], error: { code: "server_error", message: "Something broke upstream." } } },
      ]),
    );
    const out = await performRun("responses", { body: { model: "m", input: "x", stream: true }, stream: true }, signal());
    assert.equal(out.result.ok, true);
    assert.equal(out.state, "error");
    assert.deepEqual(out.error, { code: "server_error", message: "Something broke upstream." });
    assert.equal(out.record?.outcome, "error: Something broke upstream.");
  });

  it("stops mid-stream, keeps what arrived, and goes back to idle", async () => {
    fakeFetch((sig) => {
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(enc.encode(`event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", item_id: "m", output_index: 0, content_index: 0, delta: "Partial" })}\n\n`));
          sig?.addEventListener("abort", () => c.error(new DOMException("The operation was aborted.", "AbortError")));
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    });
    const ctrl = new AbortController();
    let got = "";
    const pending = performRun(
      "responses",
      {
        body: { model: "m", input: "x", stream: true },
        stream: true,
        onEvent: (e) => {
          got += String(e.json?.delta ?? "");
          ctrl.abort();
        },
      },
      ctrl.signal,
    );
    const out = await pending;
    assert.equal(got, "Partial");
    assert.equal(out.state, "idle");
    assert.equal(out.error, null, "a stop isn't shown as an error");
    assert.equal(out.result.error?.code, "aborted");
    assert.equal(out.reply?.text, "Partial");
    assert.equal(out.record?.outcome, "stopped before the reply finished");
  });

  it("records nothing with record: false, or for routes outside the mirror unless asked", async () => {
    fakeFetch(() => sseResponse([{ type: "response.output_text.delta", item_id: "m", output_index: 0, content_index: 0, delta: "Answer" }]));
    const ask = await performRun("", { base: "/api/docs/ask", stream: true, body: { slug: "tool-calling", messages: [{ role: "user", content: "Hi" }] } }, signal());
    assert.equal(calls[0].url, "/api/docs/ask");
    assert.equal(ask.record, null);
    const off = await performRun("models", { record: false }, signal());
    assert.equal(off.record, null);
    const asked = await performRun("", { base: "/api/docs/asr-realtime", raw: { data: new ArrayBuffer(4), contentType: "audio/wav" }, record: { method: "POST", path: "asr/realtime" } }, signal());
    assert.equal(asked.record?.path, "asr/realtime");
  });

  it("describes a multipart body in a line and a GET with no body", async () => {
    fakeFetch(() => jsonResponse({ id: "file-abc", object: "file", filename: "photo.jpg", status: "uploaded" }));
    const form = new FormData();
    form.append("purpose", "user_data");
    form.append("file", new File([new Uint8Array(3072)], "photo.jpg", { type: "image/jpeg" }));
    const up = await performRun("files", { method: "POST", form }, signal());
    assert.equal(calls[0].init.body, form);
    assert.equal(up.record?.body, "multipart: purpose=user_data, file=photo.jpg (3 KB)");
    assert.equal(up.record?.outcome, "file-abc (file, photo.jpg, uploaded)");

    fakeFetch(() => jsonResponse({ object: "list", data: [{ id: "muse-spark-1.2" }] }));
    const list = await performRun("/v1/models", {}, signal());
    assert.equal(calls[0].init.method, "GET");
    assert.deepEqual(list.record, { method: "GET", path: "models", status: 200, outcome: "data: 1 item (muse-spark-1.2)" });
  });

  it("says when the proxy can't be reached", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    const out = await performRun("status", {}, signal());
    assert.equal(out.state, "error");
    assert.equal(out.error?.message, "Couldn't reach Muse Muse. Check your connection and try again.");
  });
});
