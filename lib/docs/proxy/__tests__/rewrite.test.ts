import { test } from "node:test";
import assert from "node:assert/strict";
import { matchEndpoint, type DocsEndpoint } from "@/lib/docs/proxy/endpoints";
import { estimateDocsCost } from "@/lib/docs/proxy/estimate";
import { bodyReferences, formReferences, FormRewriteError, rewriteForm, rewriteJson, SPARK_NOTE } from "@/lib/docs/proxy/rewrite";

const at = (method: string, path: string) => matchEndpoint(method, path.split("/")) as DocsEndpoint;
const responses = at("POST", "responses");
const chat = at("POST", "chat/completions");
const messages = at("POST", "messages");
const images = at("POST", "images/generations");
const edits = at("POST", "images/edits");
const asr = at("POST", "asr/transcribe");

test("muse-spark-1.3 runs as muse-spark-1.3-contributor, and the note says so", () => {
  const r = rewriteJson(responses, { model: "muse-spark-1.3", input: "hi" });
  assert.equal(r.model, "muse-spark-1.3-contributor");
  assert.equal(r.body.model, "muse-spark-1.3-contributor");
  assert.ok(r.notes.includes(SPARK_NOTE));
  assert.match(SPARK_NOTE, /never call muse-spark-1\.3/);
  for (const endpoint of [chat, messages, at("POST", "responses/input_tokens"), at("POST", "messages/count_tokens")]) {
    assert.equal(rewriteJson(endpoint, { model: "muse-spark-1.3" }).model, "muse-spark-1.3-contributor", endpoint.id);
  }
  const untouched = { model: "muse-spark-1.2", input: "hi" };
  assert.equal(rewriteJson(responses, untouched).body.model, "muse-spark-1.2");
  assert.equal(untouched.model, "muse-spark-1.2", "the input object is not changed");
});

test("output tokens: set when missing, lowered when over the model's cap, kept when under", () => {
  const caps: Record<string, number> = {
    "muse-wonder-1.0": 4096,
    "muse-spark-1.2": 8192,
    "muse-spark-1.1": 8192,
    "muse-spark-1.3-contributor": 16384,
    "muse-spark-1.2-contributor": 16384,
  };
  for (const [model, cap] of Object.entries(caps)) {
    const set = rewriteJson(responses, { model, input: "hi" });
    assert.equal(set.body.max_output_tokens, cap, model);
    assert.match(set.notes.join(" "), new RegExp(`Set max_output_tokens to ${cap}`));
    const lowered = rewriteJson(responses, { model, input: "hi", max_output_tokens: 100_000 });
    assert.equal(lowered.body.max_output_tokens, cap);
    assert.match(lowered.notes.join(" "), new RegExp(`Lowered max_output_tokens from 100000 to ${cap}`));
    const kept = rewriteJson(responses, { model, input: "hi", max_output_tokens: 64 });
    assert.equal(kept.body.max_output_tokens, 64);
    assert.deepEqual(kept.notes, []);
  }
  // A numeric string is read as a number; anything that isn't a limit in range is replaced by the cap.
  assert.equal(rewriteJson(responses, { model: "muse-wonder-1.0", max_output_tokens: "90000" }).body.max_output_tokens, 4096);
  assert.equal(rewriteJson(responses, { model: "muse-wonder-1.0", max_output_tokens: "lots" }).body.max_output_tokens, 4096);
  // Spark 1.3 is clamped at its stand-in's cap.
  assert.equal(rewriteJson(responses, { model: "muse-spark-1.3" }).body.max_output_tokens, 16384);
});

test("output tokens the proxy can't read as a limit in range become the cap, never the model's own maximum", () => {
  const bodies = (field: string) =>
    [
      // JSON.parse reads 1e400 as Infinity, which JSON.stringify would send to Meta as null: the model's maximum.
      ["1e400", JSON.parse(`{"${field}":1e400}`)[field]],
      ["-1e400", JSON.parse(`{"${field}":-1e400}`)[field]],
      ["null", null],
      ["a word", "lots"],
      ["an empty string", ""],
      ["true", true],
      ["zero", 0],
      ["negative", -5],
      ["an object", { n: 5 }],
    ] as const;
  const cases = [
    { endpoint: responses, field: "max_output_tokens" },
    { endpoint: chat, field: "max_completion_tokens" },
    { endpoint: chat, field: "max_tokens" },
    { endpoint: messages, field: "max_tokens" },
  ];
  for (const { endpoint, field } of cases) {
    for (const [name, value] of bodies(field)) {
      const r = rewriteJson(endpoint, { model: "muse-wonder-1.0", [field]: value });
      const sent = JSON.parse(JSON.stringify(r.body)) as Record<string, unknown>;
      assert.equal(sent[field], 4096, `${endpoint.id} ${field} ${name}`);
      assert.ok(r.notes.some((n) => n.includes(`${field} to 4096`)), `${endpoint.id} ${field} ${name}: ${r.notes.join(" ")}`);
      // The estimate counts the same cap the request now carries.
      const estimate = estimateDocsCost(endpoint, { kind: "json", json: r.body, model: "muse-wonder-1.0" }, 0);
      assert.ok(estimate >= 4096 * 20e-6 - 1e-12, `${endpoint.id} ${name}: ${estimate}`);
    }
  }
  // Chat Completions: a null beside a real limit is dropped, so the request doesn't carry both.
  const mixed = rewriteJson(chat, { model: "muse-wonder-1.0", max_tokens: null, max_completion_tokens: 100 });
  assert.equal(mixed.body.max_completion_tokens, 100);
  assert.equal("max_tokens" in mixed.body, false);
  const bothNull = rewriteJson(chat, { model: "muse-wonder-1.0", max_tokens: null, max_completion_tokens: null });
  assert.equal(bothNull.body.max_completion_tokens, 4096);
  assert.equal("max_tokens" in bothNull.body, false, "one limit, never two");
  // A numeric string in range goes as the number it reads as; a number in range is left alone.
  const text = rewriteJson(responses, { model: "muse-wonder-1.0", max_output_tokens: " 300 " });
  assert.equal(text.body.max_output_tokens, 300);
  assert.match(text.notes.join(" "), /Sent max_output_tokens as the number 300/);
  assert.deepEqual(rewriteJson(responses, { model: "muse-wonder-1.0", max_output_tokens: 300 }).notes, []);
  // Notes stay printable ASCII, as a header must be.
  const huge = rewriteJson(responses, { model: "muse-wonder-1.0", max_output_tokens: JSON.parse("1e400") });
  assert.match(huge.notes.join(" "), /a number too large to read isn't a limit from 1 to 4096/);
});

test("image and SAM models get no output limit", () => {
  for (const model of ["muse-image-1.0", "sam-3.1"]) {
    const r = rewriteJson(responses, { model, input: "a fox" });
    assert.equal(r.body.max_output_tokens, undefined, model);
    assert.deepEqual(r.notes, []);
  }
});

test("chat completions: max_completion_tokens set when neither is set; the deprecated max_tokens is clamped in place", () => {
  const none = rewriteJson(chat, { model: "muse-wonder-1.0", messages: [] });
  assert.equal(none.body.max_completion_tokens, 4096);
  assert.equal(none.body.max_tokens, undefined);
  const old = rewriteJson(chat, { model: "muse-wonder-1.0", messages: [], max_tokens: 9000 });
  assert.equal(old.body.max_tokens, 4096);
  assert.equal(old.body.max_completion_tokens, undefined, "never adds a second limit");
  const both = rewriteJson(chat, { model: "muse-spark-1.2", messages: [], max_tokens: 9000, max_completion_tokens: 10_000 });
  assert.equal(both.body.max_tokens, 8192);
  assert.equal(both.body.max_completion_tokens, 8192);
});

test("messages: max_tokens set when missing", () => {
  const r = rewriteJson(messages, { model: "muse-spark-1.3-contributor", messages: [{ role: "user", content: "hi" }] });
  assert.equal(r.body.max_tokens, 16384);
  assert.equal(rewriteJson(messages, { model: "muse-wonder-1.0", max_tokens: 1024 }).body.max_tokens, 1024);
  // Count tokens takes no output limit.
  assert.equal(rewriteJson(at("POST", "messages/count_tokens"), { model: "muse-wonder-1.0" }).body.max_tokens, undefined);
  assert.equal(rewriteJson(at("POST", "responses/input_tokens"), { model: "muse-wonder-1.0" }).body.max_output_tokens, undefined);
});

test("images: n at most 2", () => {
  const r = rewriteJson(images, { model: "muse-image-1.0", prompt: "a fox", n: 4 });
  assert.equal(r.body.n, 2);
  assert.match(r.notes.join(" "), /Lowered n from 4 to 2/);
  assert.equal(rewriteJson(images, { model: "muse-image-1.0", prompt: "a fox", n: 2 }).body.n, 2);
  assert.equal(rewriteJson(images, { model: "muse-image-1.0", prompt: "a fox" }).body.n, undefined, "Meta's default of 1 stays");
  assert.equal(rewriteJson(edits, { model: "muse-image-1.0", prompt: "a hat", images: [], n: "10" }).body.n, 2);
});

test("images: n the proxy can't read as a count ends up 1 or 2, never past the cap", () => {
  const sent = (n: unknown) => {
    const r = rewriteJson(images, { model: "muse-image-1.0", prompt: "a fox", n });
    return { n: (JSON.parse(JSON.stringify(r.body)) as { n?: unknown }).n, notes: r.notes.join(" ") };
  };
  assert.deepEqual(sent(JSON.parse('{"n":1e400}').n).n, 2, "Infinity is lowered to the cap");
  assert.equal(sent(JSON.parse('{"n":-1e400}').n).n, 1);
  assert.equal(sent("lots").n, 1);
  assert.equal(sent(0).n, 1);
  assert.equal(sent(true).n, 1);
  assert.equal(sent("2").n, 2, "a numeric string goes as its number");
  const nulled = sent(null);
  assert.equal(nulled.n, undefined, "null is dropped, so Meta makes its default of one");
  assert.match(nulled.notes, /Dropped n: null/);
  // The estimate agrees with what goes up.
  for (const n of [JSON.parse('{"n":1e400}').n, "lots", null]) {
    const r = rewriteJson(images, { model: "muse-image-1.0", prompt: "a fox", n });
    const estimate = estimateDocsCost(images, { kind: "json", json: r.body, model: "muse-image-1.0" }, 0);
    assert.ok(estimate <= 0.02 + 1e-12, `${String(n)}: ${estimate}`);
    assert.ok(estimate >= (Number(r.body.n ?? 1) * 0.01) - 1e-12);
  }
});

test("built-in tools: max_tool_calls is set to 5 when it's missing, null, over 5 or not a whole number", () => {
  const search = [{ type: "web_search" }];
  const at5 = (body: Record<string, unknown>) => rewriteJson(responses, { model: "muse-spark-1.3-contributor", input: "news", tools: search, ...body });
  assert.equal(at5({}).body.max_tool_calls, 5);
  assert.match(at5({}).notes.join(" "), /Set max_tool_calls to 5/);
  assert.equal(at5({ max_tool_calls: null }).body.max_tool_calls, 5);
  assert.equal(at5({ max_tool_calls: 50 }).body.max_tool_calls, 5);
  assert.equal(at5({ max_tool_calls: JSON.parse("1e400") }).body.max_tool_calls, 5);
  assert.equal(at5({ max_tool_calls: "3" }).body.max_tool_calls, 5);
  assert.equal(at5({ max_tool_calls: 2 }).body.max_tool_calls, 2, "a smaller limit stays");
  assert.equal(rewriteJson(responses, { model: "muse-wonder-1.0", tools: [{ type: "tool_search" }] }).body.max_tool_calls, 5);
  // Only built-in tools count toward it, so function tools alone leave it unset.
  assert.equal(rewriteJson(responses, { model: "muse-wonder-1.0", tools: [{ type: "function", name: "f" }] }).body.max_tool_calls, undefined);
  assert.equal(rewriteJson(chat, { model: "muse-wonder-1.0", tools: search }).body.max_tool_calls, undefined, "Responses only");
});

test("streamed chat completions ask for usage, keeping other stream options", () => {
  const r = rewriteJson(chat, { model: "muse-wonder-1.0", messages: [], stream: true, stream_options: { other: 1 } });
  assert.deepEqual(r.body.stream_options, { other: 1, include_usage: true });
  assert.match(r.notes.join(" "), /include_usage/);
  const already = rewriteJson(chat, { model: "muse-wonder-1.0", messages: [], stream: true, stream_options: { include_usage: true } });
  assert.equal(already.notes.some((n) => n.includes("include_usage")), false);
  assert.equal(rewriteJson(chat, { model: "muse-wonder-1.0", messages: [] }).body.stream_options, undefined);
  // Responses streams always carry usage, so nothing is added there.
  assert.equal(rewriteJson(responses, { model: "muse-wonder-1.0", stream: true }).body.stream_options, undefined);
});

test("safety identifiers are added only where the reader set none", () => {
  const id = "docs-0123";
  assert.equal(rewriteJson(responses, { model: "muse-wonder-1.0" }, id).body.safety_identifier, id);
  assert.equal(rewriteJson(responses, { model: "muse-wonder-1.0", safety_identifier: "mine" }, id).body.safety_identifier, "mine");
  assert.equal(rewriteJson(chat, { model: "muse-wonder-1.0", user: "u1" }, id).body.safety_identifier, undefined);
  assert.deepEqual(rewriteJson(messages, { model: "muse-wonder-1.0" }, id).body.metadata, { user_id: id });
  assert.deepEqual(rewriteJson(messages, { model: "muse-wonder-1.0", metadata: { a: "b" } }, id).body.metadata, { a: "b", user_id: id });
  assert.deepEqual(rewriteJson(messages, { model: "muse-wonder-1.0", metadata: { user_id: "x" } }, id).body.metadata, { user_id: "x" });
  assert.equal(rewriteJson(images, { model: "muse-image-1.0" }, id).body.user, id);
  assert.equal(rewriteJson(at("POST", "responses/input_tokens"), { model: "muse-wonder-1.0" }, id).body.safety_identifier, undefined);
});

test("multipart: the model field and asr's request part are rewritten; unchanged forms say so", async () => {
  const edit = new FormData();
  edit.set("model", "muse-spark-1.3");
  edit.set("prompt", "a hat");
  edit.set("n", "5");
  edit.set("image", new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }), "fox.png");
  const r = await rewriteForm(edits, edit);
  assert.equal(r.changed, true);
  assert.equal(r.model, "muse-spark-1.3-contributor");
  assert.equal(r.body.get("model"), "muse-spark-1.3-contributor");
  assert.equal(r.body.get("n"), "2");
  assert.ok(r.body.get("image") instanceof File, "files stay files");

  const transcribe = new FormData();
  transcribe.set("request", new Blob([JSON.stringify({ model: "muse-spark-1.3", audioEncoding: "WAV" })], { type: "application/json" }));
  transcribe.set("audio", new Blob([new Uint8Array(8)], { type: "audio/wav" }), "a.wav");
  const t = await rewriteForm(asr, transcribe);
  assert.equal(t.model, "muse-spark-1.3-contributor");
  assert.deepEqual(JSON.parse(String(t.body.get("request"))), { model: "muse-spark-1.3-contributor", audioEncoding: "WAV" });

  const plain = new FormData();
  plain.set("request", JSON.stringify({ model: "muse-voice-transcribe-1.0", audioEncoding: "WAV" }));
  const p = await rewriteForm(asr, plain);
  assert.equal(p.model, "muse-voice-transcribe-1.0");
  assert.equal(p.changed, false);
  assert.deepEqual(p.notes, []);

  const bad = new FormData();
  bad.set("request", "{not json");
  await assert.rejects(rewriteForm(asr, bad), FormRewriteError);
});

test("multipart: a field the proxy checks may come only once", async () => {
  const twice = (name: string, a: string, b: string) => {
    const form = new FormData();
    form.set("model", "muse-image-1.0");
    form.set("prompt", "a hat");
    form.append(name, a);
    form.append(name, b);
    return form;
  };
  await assert.rejects(rewriteForm(edits, twice("n", "1", "10")), (err: Error) => err instanceof FormRewriteError && /Send n once/.test(err.message));
  await assert.rejects(rewriteForm(edits, twice("model", "muse-image-1.0", "muse-wonder-1.0")), FormRewriteError);
  await assert.rejects(rewriteForm(asr, twice("request", "{}", "{}")), FormRewriteError);
  const upload = twice("purpose", "user_data", "batch");
  upload.set("file", new Blob(["x"]), "a.txt");
  await assert.rejects(rewriteForm(at("POST", "files"), upload), FormRewriteError);
  const expiry = twice("expires_after[seconds]", "3600", "2592000");
  await assert.rejects(rewriteForm(at("POST", "files"), expiry), FormRewriteError);
  // Several images are how images/edits composes, so they may repeat.
  const images = new FormData();
  images.set("model", "muse-image-1.0");
  images.append("image", new Blob([new Uint8Array([1])], { type: "image/png" }), "a.png");
  images.append("image", new Blob([new Uint8Array([2])], { type: "image/png" }), "b.png");
  assert.equal((await rewriteForm(edits, images)).model, "muse-image-1.0");
});

test("multipart: n the proxy can't read as a count is replaced", async () => {
  const form = (n: string) => {
    const f = new FormData();
    f.set("model", "muse-image-1.0");
    f.set("n", n);
    return f;
  };
  assert.equal((await rewriteForm(edits, form("1e400"))).body.get("n"), "2");
  assert.equal((await rewriteForm(edits, form("lots"))).body.get("n"), "1");
  assert.equal((await rewriteForm(edits, form("2"))).changed, false, "a count in range goes byte for byte");
});

test("uploads: purpose user_data, an hour's expiry set by the proxy, the file last", async () => {
  const files = at("POST", "files");
  const form = new FormData();
  form.set("file", new Blob(["hello"], { type: "text/plain" }), "notes.txt");
  form.set("purpose", "user_data");
  const r = await rewriteForm(files, form);
  assert.equal(r.changed, true);
  assert.deepEqual([...r.body.keys()], ["purpose", "expires_after[anchor]", "expires_after[seconds]", "file"]);
  assert.equal(r.body.get("expires_after[anchor]"), "created_at");
  assert.equal(r.body.get("expires_after[seconds]"), "3600");
  assert.equal((r.body.get("file") as File).name, "notes.txt");
  assert.match(r.notes.join(" "), /Added expires_after, 3600 s from created_at/);

  // A longer expiry, like the file-handling page's 30 days, is shortened to the hour.
  const long = new FormData();
  long.set("purpose", "user_data");
  long.set("expires_after[anchor]", "created_at");
  long.set("expires_after[seconds]", "2592000");
  long.set("file", new Blob(["x"]), "a.pdf");
  const shortened = await rewriteForm(files, long);
  assert.equal(shortened.body.get("expires_after[seconds]"), "3600");
  assert.match(shortened.notes.join(" "), /Set expires_after to 3600 s/);
  // Other spellings of an expiry are dropped, so only the proxy's reaches Meta.
  const odd = new FormData();
  odd.set("purpose", "user_data");
  odd.set("expires_after", '{"anchor":"created_at","seconds":2592000}');
  odd.set("file", new Blob(["x"]), "a.pdf");
  assert.deepEqual((await rewriteForm(files, odd)).body.getAll("expires_after"), []);
  // Asking for the hour already says nothing.
  const hour = new FormData();
  hour.set("purpose", "user_data");
  hour.set("expires_after[anchor]", "created_at");
  hour.set("expires_after[seconds]", "3600");
  hour.set("file", new Blob(["x"]), "a.pdf");
  assert.deepEqual((await rewriteForm(files, hour)).notes, []);

  const batch = new FormData();
  batch.set("purpose", "batch");
  batch.set("file", new Blob(["{}"]), "batch.jsonl");
  await assert.rejects(rewriteForm(files, batch), /purpose "user_data"/);
  const none = new FormData();
  none.set("purpose", "user_data");
  await assert.rejects(rewriteForm(files, none), /"file" part/);
});

test("formReferences: a multipart field naming a file_id is checked like a JSON one", () => {
  const form = new FormData();
  form.set("model", "muse-image-1.0");
  form.set("images[0][file_id]", "file-theirs");
  form.set("prompt", "a hat with file_id in the prompt is just text");
  assert.deepEqual(formReferences(form), { fileIds: ["file-theirs"], responseIds: [], refused: null });
});

test("bodyReferences finds every file_id and the previous response, and refuses stored prompts and item references", () => {
  const refs = bodyReferences(responses, {
    model: "muse-wonder-1.0",
    previous_response_id: "resp_prev",
    input: [
      { role: "user", content: [{ type: "input_file", file_id: "file-1" }, { type: "input_video", file_id: "file-2" }] },
      { role: "user", content: [{ type: "input_image", file_id: "file-1" }] },
    ],
  });
  assert.deepEqual(refs.fileIds.sort(), ["file-1", "file-2"]);
  assert.deepEqual(refs.responseIds, ["resp_prev"]);
  assert.equal(refs.refused, null);

  assert.deepEqual(bodyReferences(messages, { messages: [{ role: "user", content: [{ type: "image", source: { type: "file", file_id: "file-7" } }] }] }).fileIds, [
    "file-7",
  ]);
  assert.deepEqual(bodyReferences(chat, { messages: [{ role: "user", content: [{ type: "file", file: { file_id: "file-8" } }] }] }).fileIds, ["file-8"]);
  assert.deepEqual(bodyReferences(edits, { images: [{ file_id: "file-9" }] }).fileIds, ["file-9"]);
  // previous_response_id means nothing outside the Responses API.
  assert.deepEqual(bodyReferences(chat, { previous_response_id: "resp_x" }).responseIds, []);

  assert.match(bodyReferences(responses, { conversation: "conv_1" }).refused ?? "", /conversations/);
  assert.match(bodyReferences(responses, { prompt: { id: "pmpt_1" } }).refused ?? "", /prompt templates/);
  assert.match(bodyReferences(responses, { input: [{ type: "item_reference", id: "msg_1" }] }).refused ?? "", /item references/);
  // An image's prompt is just text.
  assert.equal(bodyReferences(images, { prompt: "a fox" }).refused, null);
});
