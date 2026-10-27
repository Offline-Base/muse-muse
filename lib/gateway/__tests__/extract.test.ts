import { test } from "node:test";
import assert from "node:assert/strict";
import { modelAllowed, parseBearer, parseEndpoint, parseGatewayRequest } from "@/lib/gateway/extract";
import { ENDPOINT_MODELS } from "@/lib/gateway/policy";

const enc = (s: string) => new Uint8Array(new TextEncoder().encode(s));

/** Serializes a FormData into raw multipart bytes plus its content type, the way a product would send it. */
async function multipart(form: FormData): Promise<{ body: Uint8Array<ArrayBuffer>; contentType: string }> {
  const req = new Request("http://x/", { method: "POST", body: form });
  return { body: new Uint8Array(await req.arrayBuffer()), contentType: req.headers.get("content-type")! };
}

test("parseEndpoint accepts only the mirrored endpoints", () => {
  assert.equal(parseEndpoint(["responses"]), "responses");
  assert.equal(parseEndpoint(["images", "generations"]), "images/generations");
  assert.equal(parseEndpoint(["images", "edits"]), "images/edits");
  assert.equal(parseEndpoint(["asr", "transcribe"]), "asr/transcribe");
  assert.equal(parseEndpoint(["files"]), "files");
  assert.equal(parseEndpoint(["models"]), null);
  assert.equal(parseEndpoint(["files", "file-123"]), null);
  assert.equal(parseEndpoint(["responses", ".."]), null);
});

test("parseBearer", () => {
  assert.equal(parseBearer("Bearer mm_live_abc"), "mm_live_abc");
  assert.equal(parseBearer("bearer   mm_live_abc "), "mm_live_abc");
  assert.equal(parseBearer("Basic abc"), null);
  assert.equal(parseBearer(null), null);
});

test("JSON body: model field", async () => {
  const parsed = await parseGatewayRequest("responses", "application/json", enc('{"model":"muse-spark-1.3","input":"hi"}'));
  assert.equal(parsed.kind, "json");
  assert.equal(parsed.model, "muse-spark-1.3");
  const charset = await parseGatewayRequest("images/generations", "application/json; charset=utf-8", enc('{"model":"muse-image-1.0"}'));
  assert.equal(charset.model, "muse-image-1.0");
  const none = await parseGatewayRequest("responses", "application/json", enc('{"input":"hi"}'));
  assert.equal(none.model, null);
});

test("JSON body: invalid JSON and arrays are rejected", async () => {
  await assert.rejects(parseGatewayRequest("responses", "application/json", enc("{nope")), /not valid JSON/);
  await assert.rejects(parseGatewayRequest("responses", "application/json", enc("[1]")), /JSON object/);
});

test("images/edits multipart: model field", async () => {
  const form = new FormData();
  form.set("model", "muse-image-1.0");
  form.set("prompt", "make it blue");
  form.set("image", new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }), "a.png");
  const { body, contentType } = await multipart(form);
  const parsed = await parseGatewayRequest("images/edits", contentType, body);
  assert.equal(parsed.kind, "multipart");
  assert.equal(parsed.model, "muse-image-1.0");
});

test("asr/transcribe multipart: model from the request part, as a string or a JSON file part", async () => {
  const req = JSON.stringify({ model: "muse-voice-transcribe-1.0", audioEncoding: "WAV" });
  const audio = new Blob([new Uint8Array(64)], { type: "audio/wav" });

  const a = new FormData();
  a.set("request", req);
  a.set("audio", audio, "a.wav");
  const one = await multipart(a);
  assert.equal((await parseGatewayRequest("asr/transcribe", one.contentType, one.body)).model, "muse-voice-transcribe-1.0");

  const b = new FormData();
  b.set("request", new Blob([req], { type: "application/json" }), "request.json");
  b.set("audio", audio, "a.wav");
  const two = await multipart(b);
  assert.equal((await parseGatewayRequest("asr/transcribe", two.contentType, two.body)).model, "muse-voice-transcribe-1.0");

  const c = new FormData();
  c.set("request", "{not json");
  const three = await multipart(c);
  await assert.rejects(parseGatewayRequest("asr/transcribe", three.contentType, three.body), /request/);
});

test("asr/transcribe JSON extension: model from the JSON body", async () => {
  const parsed = await parseGatewayRequest(
    "asr/transcribe",
    "application/json",
    enc('{"model":"muse-voice-transcribe-1.0","audioUrl":"https://x.public.blob.vercel-storage.com/a.wav"}'),
  );
  assert.equal(parsed.kind, "json");
  assert.equal(parsed.model, "muse-voice-transcribe-1.0");
});

test("files has no model", async () => {
  const form = new FormData();
  form.set("purpose", "user_data");
  form.set("model", "ignored");
  const { body, contentType } = await multipart(form);
  const parsed = await parseGatewayRequest("files", contentType, body);
  assert.equal(parsed.kind, "raw");
  assert.equal(parsed.model, null);
});

test("modelAllowed needs both the token and the endpoint", () => {
  const token = ["muse-spark-1.3", "muse-image-1.0"];
  assert.equal(modelAllowed("responses", "muse-spark-1.3", token, ENDPOINT_MODELS.responses), true);
  assert.equal(modelAllowed("responses", "muse-wonder-1.0", token, ENDPOINT_MODELS.responses), false);
  assert.equal(modelAllowed("images/generations", "muse-spark-1.3", token, ENDPOINT_MODELS["images/generations"]), false);
  assert.equal(modelAllowed("responses", "muse-spark-1.3-contributor", [...token, "muse-spark-1.3-contributor"], ENDPOINT_MODELS.responses), false);
  assert.equal(modelAllowed("files", "anything", [], ENDPOINT_MODELS.files), true);
});
