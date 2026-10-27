// Real calls to api.meta.ai through the gateway handler, with a fake token lookup and an in-memory usage log.
// Needs MODEL_API_KEY: npx tsx --env-file=.env.local --test lib/gateway/__tests__/live.test.ts
// Costs well under a cent per run, plus $0.01 for the one Muse Image call.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import OpenAI from "openai";
import { handleGateway } from "@/lib/gateway/handler";
import { fakeGateway, gatewayRequest, json, TEST_TOKEN, type FakeGateway } from "./helpers";

const key = process.env.MODEL_API_KEY;
const skip = key ? false : "MODEL_API_KEY is not set";
const fixtures = path.join(import.meta.dirname, "fixtures");
const BLOB_URL = "https://teststore.public.blob.vercel-storage.com/uploads/speech-abc123.wav";

/** Real fetch for api.meta.ai; the fake Blob URL serves the WAV fixture (Blob isn't provisioned yet). */
function liveGateway(): FakeGateway {
  const wav = readFileSync(path.join(fixtures, "speech.wav"));
  return fakeGateway({
    upstreamKey: key,
    fetch: async (input, init) => {
      if (String(input) === BLOB_URL) {
        return new Response(new Uint8Array(wav), { headers: { "content-type": "audio/wav", "content-length": String(wav.length) } });
      }
      return fetch(input, init);
    },
  });
}

/** An OpenAI SDK client whose HTTP calls go straight into handleGateway, like a product's lib/meta/client.ts. */
function sdkThroughGateway(g: FakeGateway): OpenAI {
  return new OpenAI({
    baseURL: "https://platform.example/api/gateway/v1",
    apiKey: TEST_TOKEN,
    maxRetries: 0,
    fetch: async (url: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(url, init);
      const segments = new URL(req.url).pathname.replace(/^\/api\/gateway\/v1\//, "").split("/");
      return handleGateway(req, segments, g.deps);
    },
  });
}

test("responses JSON through the OpenAI SDK: body passes through, usage recorded", { skip }, async () => {
  const g = liveGateway();
  const meta = sdkThroughGateway(g);
  const res = await meta.responses.create({
    model: "muse-spark-1.3",
    input: "Reply with exactly one word: pong",
    reasoning: { effort: "low" },
  });
  assert.match(res.output_text.toLowerCase(), /pong/);
  await g.settled();
  assert.equal(g.usage.length, 1);
  const [item] = g.usage[0].items;
  assert.equal(item.model, "muse-spark-1.3");
  assert.equal(item.inputTokens, res.usage?.input_tokens);
  assert.equal(item.outputTokens, res.usage?.output_tokens);
  assert.equal(item.cachedInputTokens, res.usage?.input_tokens_details?.cached_tokens ?? 0);
  assert.ok(item.costUsd > 0);
  assert.equal(g.usage[0].ctx.tokenId, "00000000-0000-4000-8000-000000000001");
});

test("responses stream:true through the OpenAI SDK: SSE passes through, usage from response.completed", { skip }, async () => {
  const g = liveGateway();
  const meta = sdkThroughGateway(g);
  const stream = await meta.responses.create({
    model: "muse-spark-1.3",
    input: "Count from 1 to 5, separated by spaces.",
    reasoning: { effort: "low" },
    stream: true,
  });
  let text = "";
  let completed: OpenAI.Responses.Response | null = null;
  for await (const event of stream) {
    if (event.type === "response.output_text.delta") text += event.delta;
    if (event.type === "response.completed") completed = event.response;
  }
  assert.match(text, /1.*2.*3.*4.*5/s);
  assert.ok(completed?.usage, "the client saw response.completed");
  await g.settled();
  const [item] = g.usage[0].items;
  assert.equal(item.inputTokens, completed.usage.input_tokens);
  assert.equal(item.outputTokens, completed.usage.output_tokens);
});

test("raw stream bytes reach the client unchanged", { skip }, async () => {
  const g = liveGateway();
  const res = await handleGateway(
    gatewayRequest("responses", json({ model: "muse-spark-1.3", input: "Say hi.", reasoning: { effort: "low" }, stream: true }), {
      "content-type": "application/json",
    }),
    ["responses"],
    g.deps,
  );
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
  const raw = await res.text();
  assert.match(raw, /^event: response\.created\n/);
  assert.match(raw, /event: response\.completed\n/);
  await g.settled();
  assert.equal(g.usage.length, 1);
  const completed = raw.split("\n").find((l) => l.startsWith("data: ") && l.includes('"response.completed"'))!;
  const usage = JSON.parse(completed.slice(6)).response.usage;
  assert.equal(g.usage[0].items[0].outputTokens, usage.output_tokens);
});

test("SAM 3.1 stream through the gateway is metered by images_processed", { skip }, async () => {
  const g = liveGateway();
  const png = readFileSync(path.join(fixtures, "circle.png")).toString("base64");
  const res = await handleGateway(
    gatewayRequest(
      "responses",
      json({
        model: "sam-3.1",
        stream: true,
        metadata: { mask_encoding: "one_bit" },
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: "circle" },
              { type: "input_image", image_url: `data:image/png;base64,${png}`, detail: "auto" },
            ],
          },
        ],
      }),
      { "content-type": "application/json" },
    ),
    ["responses"],
    g.deps,
  );
  assert.equal(res.status, 200);
  assert.match(await res.text(), /<\|box;/);
  await g.settled();
  assert.equal(g.usage[0].items[0].images, 1);
});

test("asr/transcribe JSON extension -> multipart against the real API", { skip }, async () => {
  const g = liveGateway();
  const res = await handleGateway(
    gatewayRequest("asr/transcribe", json({ model: "muse-voice-transcribe-1.0", audioUrl: BLOB_URL, language: "en" }), {
      "content-type": "application/json",
    }),
    ["asr", "transcribe"],
    g.deps,
  );
  const body = (await res.json()) as { transcript: string; audioDurationMs: number; sessionId: string };
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.match(body.transcript.toLowerCase(), /gateway/);
  assert.ok(body.sessionId);
  await g.settled();
  const [item] = g.usage[0].items;
  assert.equal(item.model, "muse-voice-transcribe-1.0");
  assert.equal(item.audioSeconds, body.audioDurationMs / 1000);
  // The upstream call was multipart, built by the gateway.
  const upstream = g.upstreamCalls.find((c) => c.url.endsWith("/asr/transcribe"))!;
  assert.ok(upstream.init?.body instanceof FormData);
});

test("asr/transcribe multipart passthrough for small files", { skip }, async () => {
  const g = liveGateway();
  const form = new FormData();
  form.set("request", JSON.stringify({ model: "muse-voice-transcribe-1.0", audioEncoding: "WAV" }));
  form.set("audio", new Blob([readFileSync(path.join(fixtures, "speech.wav"))], { type: "audio/wav" }), "speech.wav");
  const res = await handleGateway(gatewayRequest("asr/transcribe", form), ["asr", "transcribe"], g.deps);
  const body = (await res.json()) as { transcript: string; audioDurationMs: number };
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.match(body.transcript.toLowerCase(), /test/);
  await g.settled();
  assert.ok(g.usage[0].items[0].audioSeconds! > 3);
});

test("images/generations: one real image, metered at $0.01", { skip }, async () => {
  const g = liveGateway();
  const meta = sdkThroughGateway(g);
  const res = await meta.images.generate({ model: "muse-image-1.0", prompt: "a small red apple on a white table", n: 1 });
  assert.equal(res.data?.length, 1);
  await g.settled();
  assert.equal(g.usage[0].items[0].images, 1);
  assert.ok(Math.abs(g.usage[0].items[0].costUsd - 0.01) < 1e-12);
});

test("the gateway rejects a model the token allows but the endpoint doesn't, before any upstream call", { skip }, async () => {
  const g = liveGateway();
  const meta = sdkThroughGateway(g);
  await assert.rejects(
    meta.responses.create({ model: "muse-voice-transcribe-1.0", input: "hi" }),
    (err: InstanceType<typeof OpenAI.APIError>) => err.status === 404 && err.code === "model_not_found",
  );
  assert.equal(g.upstreamCalls.length, 0);
});
