/**
 * The small client helpers: model menus and efforts, what gets recorded for the copy prompt, error explanations,
 * the endpoint allowlist, JSON error positions, the event log, ask starters, recent ids and upload limits.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/docs/client/__tests__/helpers.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { starterQuestions, titleFromSlug, trimHistory } from "@/lib/docs/client/ask";
import {
  idKindOf,
  isAllowedEndpoint,
  isBinaryReply,
  isStreamable,
  modelKindFor,
  placeholderKind,
} from "@/lib/docs/client/endpoints";
import { errorKind, explainError, waitLabel } from "@/lib/docs/client/errors";
import { eventType, logEvent, type EventLogEntry } from "@/lib/docs/client/events";
import { sampleKindOf, sizeLabel, uploadProblem } from "@/lib/docs/client/files";
import { mimeOfName, placeholderFileName } from "@/lib/docs/client/form";
import { lineColumn, parseJsonText } from "@/lib/docs/client/json";
import {
  DEFAULT_TEXT_MODEL,
  docsModelLabel,
  effortsFor,
  fitEffort,
  isContributor,
  kindOfModel,
  modelsFor,
  runsAs,
} from "@/lib/docs/client/models";
import { recentIds, rememberReply } from "@/lib/docs/client/recent";
import { describeForm, outcomeOfReply, trimForRecord } from "@/lib/docs/client/record";

describe("models", () => {
  it("defaults text demos to Spark 1.3 Contributor and never offers Spark 1.3 itself", () => {
    assert.equal(DEFAULT_TEXT_MODEL, "muse-spark-1.3-contributor");
    const ids = modelsFor("text").map((m) => m.id);
    assert.deepEqual(ids, ["muse-spark-1.3-contributor", "muse-spark-1.2", "muse-wonder-1.0", "muse-spark-1.2-contributor", "muse-spark-1.1"]);
    assert.equal(ids.includes("muse-spark-1.3"), false);
    assert.deepEqual(modelsFor("text").slice(0, 3).map((m) => m.label), ["Muse Spark 1.3 Contributor", "Muse Spark 1.2", "Muse Wonder 1.0"]);
    assert.deepEqual(modelsFor("image").map((m) => m.id), ["muse-image-1.0"]);
    assert.deepEqual(modelsFor("text", ["muse-wonder-1.0", "muse-spark-1.3"]).map((m) => m.id), ["muse-spark-1.3-contributor", "muse-wonder-1.0"]);
  });

  it("knows which models are Contributor mode, Spark 1.3 included since it runs as Contributor", () => {
    assert.equal(runsAs("muse-spark-1.3"), "muse-spark-1.3-contributor");
    assert.equal(isContributor("muse-spark-1.3"), true);
    assert.equal(isContributor("muse-spark-1.2-contributor"), true);
    assert.equal(isContributor("muse-spark-1.2"), false);
    assert.equal(isContributor(null), false);
    assert.equal(docsModelLabel("muse-spark-1.3"), "Muse Spark 1.3");
    assert.equal(docsModelLabel("muse-image-1.0"), "Muse Image 1.0");
    assert.equal(docsModelLabel("other"), "other");
    assert.equal(kindOfModel("sam-3.1"), "sam");
    assert.equal(kindOfModel("muse-spark-1.3"), "text");
  });

  it("offers max effort only where it exists", () => {
    assert.equal(effortsFor("muse-wonder-1.0").includes("max"), true);
    assert.equal(effortsFor("muse-spark-1.3-contributor").includes("max"), false);
    assert.equal(effortsFor("muse-spark-1.3").includes("max"), false, "it runs as Contributor");
    assert.deepEqual(effortsFor("muse-spark-1.2"), ["minimal", "low", "medium", "high", "xhigh"]);
    assert.equal(fitEffort("muse-spark-1.3-contributor", "max"), "xhigh", "max after a switch to Contributor sends the highest it takes");
    assert.equal(fitEffort("muse-wonder-1.0", "max"), "max");
    assert.equal(fitEffort("muse-spark-1.2", null), null);
  });
});

describe("recording", () => {
  it("shortens data URLs and long strings", () => {
    const trimmed = trimForRecord({
      model: "m",
      input: [{ type: "input_image", image_url: `data:image/png;base64,${"A".repeat(4096)}` }],
      note: "word ".repeat(140),
    }) as { input: Array<{ image_url: string }>; note: string };
    assert.equal(trimmed.input[0].image_url, "data:image/png;base64,<3 KB of base64>");
    assert.match(trimmed.note, /\.\.\. \(100 more characters\)$/);
  });

  it("describes multipart bodies in a line", () => {
    assert.equal(
      describeForm([{ name: "purpose", value: "user_data" }, { name: "file", value: "photo.jpg", file: { label: "Photo" } }]),
      "multipart: purpose=user_data, file=photo.jpg",
    );
    const form = new FormData();
    form.append("purpose", "user_data");
    form.append("file", new File([new Uint8Array(2048)], "photo.jpg", { type: "image/jpeg" }));
    assert.equal(describeForm(form), "multipart: purpose=user_data, file=photo.jpg (2 KB)");
  });

  it("starts the outcome with the field a reader would read", () => {
    assert.equal(
      outcomeOfReply({ object: "response", output: [{ type: "message", content: [{ type: "output_text", text: "Paris." }] }] }),
      "output_text: Paris.",
    );
    assert.equal(outcomeOfReply({ object: "chat.completion", choices: [{ message: { content: "Hi there" } }] }), "content: Hi there");
    assert.equal(outcomeOfReply({ sessionId: "s", transcript: "Hello world​", audioDurationMs: 1000, turns: [] }), "transcript: Hello world");
    assert.equal(outcomeOfReply({ object: "response.input_tokens", input_tokens: 14 }), "input_tokens: 14");
    assert.equal(outcomeOfReply({ data: [{ b64_json: "x" }] }), "data: 1 image");
    assert.equal(outcomeOfReply({ object: "list", data: [{ id: "muse-spark-1.2" }, { id: "sam-3.1" }] }), "data: 2 items (muse-spark-1.2, sam-3.1)");
    assert.equal(outcomeOfReply({ id: "file-abc", object: "file", filename: "a.pdf", status: "uploaded" }), "file-abc (file, a.pdf, uploaded)");
    assert.equal(outcomeOfReply(null, 429, "Live demos are limited to 20 runs a minute."), "error 429: Live demos are limited to 20 runs a minute.");
  });
});

describe("errors", () => {
  it("explains rate limits, budgets, pauses and the rest by code and type", () => {
    assert.equal(errorKind({ type: "rate_limit_error", code: "rate_limited", message: "" }), "rate_limit");
    assert.equal(errorKind({ type: "rate_limit_error", code: "too_many_in_flight", message: "" }), "rate_limit");
    assert.equal(errorKind({ type: "insufficient_quota", code: "budget_exceeded", message: "" }), "budget");
    assert.equal(errorKind({ type: "server_error", code: "docs_paused", message: "" }), "paused");
    assert.equal(errorKind({ type: "invalid_request_error", code: "body_too_large", message: "" }), "too_large");
    assert.equal(errorKind({ type: "invalid_request_error", code: "model_not_found", message: "" }), "model");
    assert.equal(errorKind({ type: "invalid_request_error", code: "media_url_origin_error", message: "" }), "invalid");
    assert.equal(errorKind({ type: "permission_error", code: "cross_site", message: "" }), "forbidden");
    assert.equal(errorKind({ message: "Couldn't reach Muse Muse. Check your connection and try again." }), "network");
    assert.equal(errorKind({ type: "not_found_error", code: "not_found", message: "" }), "not_found");
    assert.equal(errorKind({ type: "not_found_error", code: "unknown_endpoint", message: "" }), "endpoint");
    assert.equal(errorKind({ type: "server_error", code: "docs_budget", message: "" }), "budget");
    assert.equal(errorKind({ type: "insufficient_quota", code: "ip_budget", message: "" }), "budget");
    assert.equal(errorKind({ type: "server_error", code: "upstream_auth", message: "" }), "auth");
    assert.equal(errorKind({ type: "server_error", code: "platform_paused", message: "" }), "paused");
    assert.equal(explainError({ code: "budget_exceeded", message: "" }).title, "Today's live demo budget is used up");
    assert.equal(waitLabel(12.2), "13 s");
    assert.equal(waitLabel(125), "2 min 5 s");
  });
});

describe("endpoints", () => {
  it("mirrors the proxy's allowlist", () => {
    assert.equal(isAllowedEndpoint("POST", "responses"), true);
    assert.equal(isAllowedEndpoint("POST", "/v1/responses/resp_1/cancel"), true);
    assert.equal(isAllowedEndpoint("GET", "responses/resp_1?stream=true"), true);
    assert.equal(isAllowedEndpoint("GET", "files/file-1/content"), true);
    assert.equal(isAllowedEndpoint("DELETE", "models/m"), false);
    assert.equal(isAllowedEndpoint("POST", "fine_tuning/jobs"), false);
    assert.equal(isAllowedEndpoint("GET", "responses/input_tokens"), false);
  });

  it("knows which endpoints stream, return files and take which models", () => {
    assert.equal(isStreamable("chat/completions"), true);
    assert.equal(isStreamable("asr/transcribe"), false);
    assert.equal(isBinaryReply("files/file-1/content"), true);
    assert.equal(modelKindFor("responses", "sam-3.1"), "sam");
    assert.equal(modelKindFor("images/edits"), "image");
    assert.equal(modelKindFor("messages/count_tokens"), "text");
    assert.equal(modelKindFor("files"), null);
    assert.equal(idKindOf("resp_abc"), "response");
    assert.equal(idKindOf("file-abc"), "file");
    assert.equal(placeholderKind("responses/resp_abc123/cancel"), "response");
    assert.equal(placeholderKind("files/{file_id}/content"), "file");
    assert.equal(placeholderKind("files/file-9f8e"), null);
  });
});

describe("json, events, ask, recent ids, files", () => {
  it("points JSON errors at a line and column", () => {
    const bad = parseJsonText('{\n  "model": "m",\n  "input": }');
    assert.equal(bad.ok, false);
    if (!bad.ok) {
      assert.equal(bad.line, 3);
      assert.match(bad.message, /^Line 3, column \d+: /);
    }
    const unexpected = parseJsonText('{\n  "model": "m",\n  "input": }');
    if (!unexpected.ok) assert.equal(unexpected.message, "Line 3, column 12: Unexpected token '}'");
    const trailing = parseJsonText('{"a": 1,}');
    if (!trailing.ok) assert.equal(trailing.column, 9);
    assert.deepEqual(parseJsonText('{"a":1}'), { ok: true, value: { a: 1 } });
    assert.equal(parseJsonText("  ").ok, false);
    assert.deepEqual(lineColumn("ab\ncd", 4), { line: 2, column: 2 });
  });

  it("folds runs of one event type and shortens base64 in samples", () => {
    let log: EventLogEntry[] = [];
    const ev = (type: string, extra: Record<string, unknown> = {}) => {
      const json = { type, ...extra };
      return { event: type, data: JSON.stringify(json), json };
    };
    log = logEvent(log, ev("response.created"));
    log = logEvent(log, ev("response.output_text.delta", { delta: "a" }));
    log = logEvent(log, ev("response.output_text.delta", { delta: "b" }));
    log = logEvent(log, ev("response.output_item.done", { item: { result: "Q".repeat(4000) } }));
    assert.deepEqual(log.map((e) => [e.type, e.count]), [["response.created", 1], ["response.output_text.delta", 2], ["response.output_item.done", 1]]);
    assert.match(log[2].sample, /<3 KB base64>/);
    assert.equal(eventType({ event: null, data: "[DONE]", json: null }), "[DONE]");
    assert.equal(eventType({ event: null, data: "{}", json: { object: "chat.completion.chunk" } }), "chat.completion.chunk");
  });

  it("suggests three starters from the page title, by kind of page", () => {
    assert.deepEqual(starterQuestions("Tool calling", "tool-calling"), [
      'Summarize "Tool calling" in three bullet points.',
      'Show me the smallest working request for "Tool calling".',
      'What limits or gotchas does "Tool calling" mention?',
    ]);
    assert.match(starterQuestions("Create a response", "api-reference/responses/create-response")[0], /request to "Create a response" need/);
    assert.match(starterQuestions("Prompt caching", "cookbook/prompt-caching")[0], /"Prompt caching" recipe/);
    assert.deepEqual(starterQuestions("", "muse-spark-open/get-the-model"), [
      "What hardware does this need?",
      'What\'s the quickest way to run "Get the model" on my own machine?',
      'Which settings in "Get the model" matter most?',
    ]);
    // Pages that aren't about one request get questions about what they are.
    assert.match(starterQuestions("Responses schemas", "api-reference/responses/schemas")[0], /^Which fields does the main object in "Responses schemas" have\?$/);
    assert.match(starterQuestions("Responses", "api-reference/responses")[0], /^Which endpoints does "Responses" cover\?$/);
    assert.match(starterQuestions("API reference", "api-reference")[0], /^Which endpoints does "API reference" cover\?$/);
    assert.match(starterQuestions("Status", "api-reference/status")[0], /request to "Status" need/, "a one-endpoint page stays an endpoint");
    assert.equal(starterQuestions("Cookbook", "cookbook")[0], "Which recipe should I start with?");
    assert.equal(starterQuestions("Changelog", "muse-code/changelog")[0], "What changed in the latest release?");
    assert.equal(starterQuestions("Deploy", "muse-glimmer/deploy")[0], "What hardware does this need?");
    assert.equal(titleFromSlug("api-reference/files/upload-file"), "Upload file");
    for (const q of starterQuestions("Reasoning", "reasoning")) assert.equal(q.includes(String.fromCharCode(0x2014)), false);
  });

  it("keeps a short ask history that starts with a question", () => {
    const turns = Array.from({ length: 9 }, (_, i) => ({ role: (i % 2 ? "assistant" : "user") as "user" | "assistant", content: `m${i}` }));
    const kept = trimHistory(turns, 6);
    assert.equal(kept[0].role, "user");
    assert.deepEqual(kept.map((m) => m.content), ["m4", "m5", "m6", "m7", "m8"]);
  });

  it("remembers the responses and files a reader created, and forgets deleted ones", () => {
    rememberReply({ id: "resp_1", object: "response", model: "muse-spark-1.3-contributor" }, 1);
    rememberReply({ id: "file-1", object: "file", filename: "a.pdf" }, 2);
    rememberReply({ id: "chatcmpl-1", object: "chat.completion" }, 3);
    assert.deepEqual(recentIds().map((r) => r.id), ["file-1", "resp_1"]);
    assert.equal(recentIds("file")[0].label, "a.pdf");
    rememberReply({ id: "file-1", object: "file", deleted: true }, 4);
    assert.deepEqual(recentIds("file"), []);
  });

  it("matches samples to accept lists and keeps uploads under 3 MB", () => {
    assert.equal(sampleKindOf("image/*"), "image");
    assert.equal(sampleKindOf("audio/wav,.wav"), "audio");
    assert.equal(sampleKindOf("application/pdf"), "pdf");
    assert.equal(sampleKindOf(undefined), null);
    assert.equal(uploadProblem({ size: 1024 }), null);
    assert.match(uploadProblem({ size: 5 * 1024 * 1024, name: "big.mov" }) ?? "", /^big\.mov is 5 MB\. Live demos take files up to 3 MB\.$/);
    assert.equal(sizeLabel(1536), "2 KB");
    assert.equal(placeholderFileName("audio/wav"), "recording.wav");
    assert.equal(mimeOfName("photo.JPG"), "image/jpeg");
  });
});
