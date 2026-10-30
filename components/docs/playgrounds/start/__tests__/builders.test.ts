/**
 * The "start" group's builders and readers: the SDK clients (code, wire request, what each prints, against real
 * replies), the reference data (Models schemas, the status reply, the endpoint catalog), the quickstart's request,
 * response reader and OpenCode config, the auth snippets, and the model comparison. No network.
 *
 *   npx tsx --test --experimental-test-module-mocks components/docs/playgrounds/start/__tests__/builders.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { isAllowedEndpoint } from "@/lib/docs/client/endpoints";
import { messagesBlockTypes, readReply, SDK_CLIENTS, wireRequest } from "@/components/docs/playgrounds/start/clients";
import {
  allUndated,
  catalogRows,
  checkSchema,
  createdLabel,
  ENDPOINTS,
  endpointsByResource,
  inDocumentedOrder,
  isMetaModelNotFound,
  listOrderNote,
  modelsOf,
  searchSchemas,
  statusReport,
  type ModelObject,
} from "@/components/docs/playgrounds/start/reference";
import {
  configCheckRequest,
  FIRST_CALL_PRESETS,
  firstCallBody,
  OPENCODE_DEFAULTS,
  openCodeConfig,
  presetMatching,
  providerPrompt,
  readResponse,
} from "@/components/docs/playgrounds/start/quickstart";
import { AUTH_CLIENTS, authSnippet, envSetup, SHELLS } from "@/components/docs/playgrounds/start/auth";
import { bodyDifferences, compareBody, compareLine, COMPARE_PRESETS, listWords, WONDER_COMPARE_CAP } from "@/components/docs/playgrounds/start/compare";
import { capWonder, SPARK_TEXT_MODELS, WONDER_OUTPUT_CAP } from "@/components/docs/playgrounds/start/wonder";
import { DEFAULT_TEXT_MODEL } from "@/lib/docs/client/models";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8")) as Record<string, unknown>;
const M = "muse-spark-1.3-contributor";
const KEYLIKE = /\bLLM_\d{6}|\bsk-[A-Za-z0-9]{8}|Bearer [A-Za-z0-9_]{12}/;

describe("SDK clients", () => {
  it("every snippet takes the key from MODEL_API_KEY, the right base URL and the model", () => {
    for (const c of SDK_CLIENTS) {
      const code = c.code(M, "Explain mixture-of-experts in two sentences.");
      assert.match(code, /MODEL_API_KEY/, c.id);
      assert.match(code, new RegExp(M.replace(/\./g, "\\.")), c.id);
      assert.doesNotMatch(code, KEYLIKE, c.id);
      if (c.protocol === "messages") {
        assert.match(code, /https:\/\/api\.meta\.ai"/, `${c.id}: no /v1 for the Anthropic SDK`);
        assert.match(code, /auth_token|authToken/, c.id);
      } else {
        assert.match(code, /https:\/\/api\.meta\.ai\/v1/, c.id);
      }
    }
    assert.match(SDK_CLIENTS.find((c) => c.id === "litellm")!.code(M, "x"), /"openai\/muse-spark-1\.3-contributor"/);
  });

  it("puts each protocol's request on the wire", () => {
    assert.deepEqual(wireRequest("responses", M, "Hi"), { path: "responses", body: { model: M, input: "Hi" } });
    assert.deepEqual(wireRequest("chat", M, "Hi"), { path: "chat/completions", body: { model: M, messages: [{ role: "user", content: "Hi" }] } });
    assert.deepEqual(wireRequest("messages", M, "Hi").body, { model: M, max_tokens: 1024, messages: [{ role: "user", content: "Hi" }] });
    for (const c of SDK_CLIENTS) assert.ok(isAllowedEndpoint("POST", wireRequest(c.protocol, M, "x").path), c.id);
  });

  it("reads real replies the way each client does", () => {
    assert.equal(readReply("responses", fixture("responses-first-call")), "The capital of France is Paris!");
    assert.equal(readReply("chat", fixture("chat-reply")), "Hello! I'm Muse Spark. How can I help you today?");
    const msg = fixture("messages-reply");
    assert.deepEqual(messagesBlockTypes(msg), ["redacted_thinking", "text"]);
    assert.match(readReply("messages", msg)!, /^Mixture-of-Experts is an architecture/);
    assert.equal(readReply("chat", fixture("responses-first-call")), null, "a reply of another protocol has nothing where the client looks");
  });
});

describe("reference data", () => {
  it("sets the models page's order claim against the live list, where every model says created 0", () => {
    const models = modelsOf(fixture("models-list"));
    assert.equal(allUndated(models), true);
    assert.equal(inDocumentedOrder(models), false, "the live order is neither by created nor by id");
    const note = listOrderNote(models)!;
    assert.match(note, /^The models page says the list comes newest first by created, the id breaking ties\./);
    assert.match(note, /carries no meaning/);
    assert.match(note, /don't read data\[0\] as the newest model/);
    const at = (id: string, created: number): ModelObject => ({ id, object: "model", created, owned_by: "meta" });
    assert.equal(inDocumentedOrder([at("b", 2), at("a", 1)]), true);
    assert.equal(inDocumentedOrder([at("a", 1), at("b", 2)]), false, "oldest first");
    assert.equal(inDocumentedOrder([at("a", 5), at("b", 5), at("c", 1)]), true, "the id breaks ties");
    assert.equal(listOrderNote([at("b", 2), at("a", 1)]), "Newest first by created, the id breaking ties, as the models page says.");
    assert.match(listOrderNote([at("a", 1), at("b", 2)])!, /isn't in that order/);
    assert.match(listOrderNote([at("a", 0), at("b", 0)])!, /only the id orders them/);
    assert.equal(listOrderNote([at("a", 0)]), null, "one model has no order to speak of");
  });

  it("tells Meta's 404 for a made-up model id from other failures", () => {
    const body = fixture("model-not-found");
    assert.equal(isMetaModelNotFound(404, { "x-request-id": "abc" }, body), true);
    assert.equal(isMetaModelNotFound(404, {}, body), false, "the docs proxy's own 404 has no request id");
    assert.equal(isMetaModelNotFound(429, { "x-request-id": "abc" }, body), false);
    assert.equal(isMetaModelNotFound(404, { "x-request-id": "abc" }, { error: { code: "unknown_endpoint" } }), false);
  });

  it("lists the live models in the API's order, with their cards", () => {
    const list = fixture("models-list");
    const models = modelsOf(list);
    assert.equal(models.length, 9);
    assert.equal(models[0].id, "muse-wonder-1.0");
    assert.ok(catalogRows(list).every((r) => r.card), "every live id has a card from the models page");
    assert.equal(createdLabel(0), "0 (no date)");
    assert.equal(createdLabel(1_700_000_000), "2023-11-14 22:13:20 UTC");
    assert.equal(createdLabel(null), "not sent");
  });

  it("checks objects against the page's schemas field by field", () => {
    const list = checkSchema("list-models-response", fixture("models-list"));
    assert.ok(list.every((c) => c.ok), list.filter((c) => !c.ok).map((c) => `${c.path}: ${c.note}`).join("; "));
    assert.equal(list.length, 2 + 9 * 5, "object and data, then 5 fields for each of 9 models");
    assert.ok(list.some((c) => c.path === "data[0].metadata" && c.note === "optional, not sent"));
    const bad = checkSchema("model", { id: "x", object: "thing", owned_by: 3 });
    assert.deepEqual(
      bad.filter((c) => !c.ok).map((c) => `${c.path}: ${c.note}`),
      ['object: expected "model", got "thing"', "created: missing", "owned_by: expected string, got integer"],
    );
  });

  it("searches fields by name, type and description", () => {
    assert.deepEqual(searchSchemas("unix").map((s) => s.fields.map((f) => f.name)), [["created"]]);
    assert.equal(searchSchemas("").length, 2);
    assert.equal(searchSchemas("zzz").length, 0);
  });

  it("reads the status reply, with tones that don't mistake unavailable for available", () => {
    const ok = statusReport(fixture("status"))!;
    assert.equal(ok.tone, "ok");
    assert.equal(ok.alive, true);
    assert.deepEqual(ok.models, []);
    assert.equal(statusReport({ is_alive: true, service_status: "unavailable" })!.tone, "bad");
    assert.equal(statusReport({ is_alive: true, service_status: "partial outage" })!.tone, "warn");
    assert.equal(statusReport({ is_alive: false, service_status: "operational" })!.tone, "bad");
    const models = statusReport({ service_status: "degraded", model_statuses: [{ model: "sam-3.1", status: "operational" }, "junk"] })!;
    assert.deepEqual(models.models, [{ model: "sam-3.1", status: "operational", tone: "ok" }]);
    assert.equal(statusReport("nope"), null);
  });

  it("covers every endpoint in the reference, each runnable one allowed by the proxy", () => {
    assert.deepEqual(
      endpointsByResource().map((g) => g.resource),
      ["Responses", "Chat completions", "Messages", "Files", "Models", "Status", "Images", "Voice"],
    );
    assert.equal(ENDPOINTS.length, 20);
    for (const e of ENDPOINTS) {
      if (e.runnable) assert.ok(isAllowedEndpoint(e.method, e.path), `${e.method} ${e.path}`);
      else assert.equal(e.id, "asr.realtime");
    }
    const edit = ENDPOINTS.find((e) => e.id === "images.edits")!;
    assert.equal(edit.fileSlots?.[0].pointer, "/images/0/image_url");
  });
});

describe("quickstart", () => {
  it("sends the page's request, plus only what the reader turns on", () => {
    assert.deepEqual(firstCallBody({ model: M, prompt: "What is the capital of France?" }), { model: M, input: "What is the capital of France?" });
    assert.deepEqual(firstCallBody({ model: M, prompt: "x", effort: "low", summary: true, webSearch: true, stream: true }), {
      model: M,
      input: "x",
      reasoning: { effort: "low", summary: "auto" },
      tools: [{ type: "web_search" }],
      stream: true,
    });
    assert.equal(FIRST_CALL_PRESETS[0].prompt, "What is the capital of France?");
    assert.ok(FIRST_CALL_PRESETS.every((p) => p.shows));
  });

  it("caps Muse Wonder's output in the first call, and only there", () => {
    assert.deepEqual(firstCallBody({ model: "muse-wonder-1.0", prompt: "x", effort: "low" }), {
      model: "muse-wonder-1.0",
      input: "x",
      reasoning: { effort: "low" },
      max_output_tokens: WONDER_OUTPUT_CAP,
    });
    assert.equal(firstCallBody({ model: M, prompt: "x" }).max_output_tokens, undefined);
    const wonder = FIRST_CALL_PRESETS.find((p) => p.model === "muse-wonder-1.0")!;
    assert.match(wonder.shows, /max_output_tokens: 800/);
  });

  it("highlights a preset only while the form still matches it", () => {
    FIRST_CALL_PRESETS.forEach((p, i) => {
      const form = { model: p.model ?? DEFAULT_TEXT_MODEL, prompt: p.prompt, effort: p.effort ?? null, summary: !!p.summary, webSearch: !!p.webSearch, stream: !!p.stream };
      assert.equal(presetMatching(FIRST_CALL_PRESETS, form), i, p.label);
      assert.equal(presetMatching(FIRST_CALL_PRESETS, { ...form, prompt: `${p.prompt}  ` }), i, `${p.label}: Run trims the prompt`);
    });
    const first = { model: M, prompt: "What is the capital of France?", effort: null, summary: false, webSearch: false, stream: false };
    assert.equal(presetMatching(FIRST_CALL_PRESETS, { ...first, summary: true }), null, "a toggle lets go of the preset");
    assert.equal(presetMatching(FIRST_CALL_PRESETS, { ...first, model: "muse-spark-1.2" }), null, "so does the model menu");
    assert.equal(presetMatching(FIRST_CALL_PRESETS, { ...first, effort: "low" }), null, "so does the effort menu");
    assert.equal(presetMatching(FIRST_CALL_PRESETS, { ...first, prompt: "Something else" }), null);
  });

  it("uses a puzzle where low effort visibly reasons less, and says single runs vary", () => {
    const less = FIRST_CALL_PRESETS.find((p) => p.label === "Less reasoning")!;
    assert.equal(less.effort, "low");
    assert.notEqual(less.prompt, FIRST_CALL_PRESETS[0].prompt, "not the one-step capital question, where the two overlap");
    assert.match(less.shows, /single runs vary/);
  });

  it("walks a real response the way the page's 'Read the response' does", () => {
    const r = readResponse(fixture("responses-first-call"))!;
    assert.equal(r.outputText, "The capital of France is Paris!");
    assert.deepEqual(r.items.map((i) => i.type), ["reasoning", "message"]);
    assert.match(r.items[0].detail, /^summary: \[\]/);
    assert.deepEqual(r.usage, { input: 15, cached: 0, output: 701, reasoning: 685, total: 716 });
    assert.equal(r.effort, "high");
    assert.equal(r.incompleteReason, null);
    const cut = readResponse({ ...fixture("responses-first-call"), status: "incomplete", incomplete_details: { reason: "max_output_tokens" } })!;
    assert.equal(cut.status, "incomplete");
    assert.equal(cut.incompleteReason, "max_output_tokens");
    assert.equal(readResponse(fixture("chat-reply")), null);
  });

  it("builds the coding-agents page's opencode.json and provider prompt, on the Contributor id", () => {
    const config = openCodeConfig(OPENCODE_DEFAULTS) as { provider: { meta: Record<string, unknown> } };
    const meta = config.provider.meta;
    assert.equal(meta.npm, "@ai-sdk/openai");
    assert.deepEqual(meta.options, { baseURL: "https://api.meta.ai/v1" });
    assert.deepEqual((meta.models as Record<string, unknown>)[M], {
      name: M,
      reasoning: true,
      limit: { context: 1048576, output: 131072 },
      modalities: { input: ["text", "image", "pdf", "video"], output: ["text"] },
      options: { reasoningEffort: "high", reasoningSummary: "auto", include: ["reasoning.encrypted_content"] },
    });
    const fallback = openCodeConfig({ ...OPENCODE_DEFAULTS, adapter: "@ai-sdk/openai-compatible" }) as { provider: { meta: { models: Record<string, unknown> } } };
    assert.deepEqual(fallback.provider.meta.models[M], { name: M, limit: { context: 1048576, output: 131072 } });
    const prompt = providerPrompt(OPENCODE_DEFAULTS);
    assert.match(prompt, /^Add a new provider to my config for Meta Model API:/);
    assert.match(prompt, /- Reasoning: true, with reasoningEffort "high", reasoningSummary "auto", and include \["reasoning\.encrypted_content"\]/);
    assert.match(prompt, /- Read the key from the MODEL_API_KEY environment variable$/);
    assert.doesNotMatch(prompt, /"muse-spark-1\.3"/);
  });

  it("checks the config's settings with a request that has exactly them", () => {
    assert.deepEqual(configCheckRequest(OPENCODE_DEFAULTS), {
      path: "responses",
      body: { model: M, input: "Reply with the single word: connected", reasoning: { effort: "high", summary: "auto" }, include: ["reasoning.encrypted_content"] },
    });
    assert.equal(configCheckRequest({ ...OPENCODE_DEFAULTS, adapter: "@ai-sdk/openai-compatible" }).path, "chat/completions");
  });

  it("caps Muse Wonder in the settings check, under each endpoint's own field", () => {
    const wonder = { ...OPENCODE_DEFAULTS, model: "muse-wonder-1.0" };
    assert.equal(configCheckRequest(wonder).body.max_output_tokens, WONDER_OUTPUT_CAP);
    const chat = configCheckRequest({ ...wonder, adapter: "@ai-sdk/openai-compatible" }).body;
    assert.equal(chat.max_completion_tokens, WONDER_OUTPUT_CAP);
    assert.equal(chat.max_output_tokens, undefined, "Chat Completions names it max_completion_tokens");
    assert.equal(configCheckRequest(OPENCODE_DEFAULTS).body.max_output_tokens, undefined);
  });
});

describe("auth builder", () => {
  it("sets the variable on each shell and reads it in each client, without a key in sight", () => {
    assert.equal(envSetup("unix").code, 'export MODEL_API_KEY="your-api-key-here"');
    assert.equal(envSetup("powershell").code, '$env:MODEL_API_KEY = "your-api-key-here"');
    assert.equal(envSetup("cmd").code, "set MODEL_API_KEY=your-api-key-here");
    for (const shell of SHELLS) {
      for (const client of AUTH_CLIENTS) {
        const code = authSnippet(client.id, shell.id, M);
        assert.match(code, /MODEL_API_KEY/, `${client.id} on ${shell.id}`);
        assert.doesNotMatch(code, KEYLIKE);
      }
    }
    assert.match(authSnippet("curl", "unix", M), /-H "Authorization: Bearer \$MODEL_API_KEY"/);
    assert.match(authSnippet("curl", "powershell", M), /curl\.exe .*`\n.*\$env:MODEL_API_KEY/s);
    assert.match(authSnippet("curl", "cmd", M), /%MODEL_API_KEY%/);
    assert.match(authSnippet("curl", "cmd", M), /^echo \{"model": "muse-spark-1\.3-contributor"/);
  });
});

describe("Muse Wonder's cap", () => {
  it("adds the cap to Muse Wonder bodies only, never over a limit the body sets", () => {
    assert.deepEqual(capWonder({ model: "muse-wonder-1.0", input: "x" }), { model: "muse-wonder-1.0", input: "x", max_output_tokens: 800 });
    assert.deepEqual(capWonder({ model: "muse-wonder-1.0", messages: [] }, "max_completion_tokens"), { model: "muse-wonder-1.0", messages: [], max_completion_tokens: 800 });
    assert.deepEqual(capWonder({ model: "muse-wonder-1.0", max_output_tokens: 300 }), { model: "muse-wonder-1.0", max_output_tokens: 300 });
    assert.deepEqual(capWonder({ model: M, input: "x" }), { model: M, input: "x" });
    assert.equal(WONDER_COMPARE_CAP, WONDER_OUTPUT_CAP);
  });

  it("leaves Muse Wonder out of the menu where the code can't carry the cap", () => {
    assert.ok(!SPARK_TEXT_MODELS.includes("muse-wonder-1.0"));
    assert.equal(SPARK_TEXT_MODELS[0], M);
    assert.ok(SPARK_TEXT_MODELS.includes("muse-spark-1.2"), "a Standard model stays on offer");
  });
});

describe("model comparison", () => {
  it("caps Muse Wonder's output and fits the effort to each model", () => {
    assert.deepEqual(compareBody("muse-wonder-1.0", "Hi", "max"), {
      model: "muse-wonder-1.0",
      input: "Hi",
      reasoning: { effort: "max" },
      max_output_tokens: WONDER_COMPARE_CAP,
      stream: true,
    });
    assert.deepEqual(compareBody(M, "Hi", "max").reasoning, { effort: "xhigh" }, "Contributor has no max");
    assert.equal(compareBody(M, "Hi", null).reasoning, undefined);
    assert.ok(COMPARE_PRESETS.every((p) => p.left !== p.right));
  });

  it("names everything the other side's request does differently, for the code caption", () => {
    const spark = compareBody(M, "Hi", "low");
    const wonder = compareBody("muse-wonder-1.0", "Hi", "low");
    assert.deepEqual(bodyDifferences(spark, wonder), ["the model", "Muse Wonder's output cap"]);
    assert.deepEqual(bodyDifferences(compareBody("muse-spark-1.2", "Hi", "low"), compareBody("muse-spark-1.2-contributor", "Hi", "low")), ["the model"]);
    assert.deepEqual(bodyDifferences(compareBody(M, "Hi", "max"), compareBody("muse-wonder-1.0", "Hi", "max")), [
      "the model",
      "the reasoning effort, fitted to each model",
      "Muse Wonder's output cap",
    ]);
    assert.deepEqual(bodyDifferences(spark, spark), []);
    assert.equal(listWords(["the model"]), "the model");
    assert.equal(listWords(["a", "b", "c"]), "a, b and c");
  });

  it("says how two runs compare", () => {
    const line = compareLine(
      { model: "a", label: "Muse Wonder 1.0", ms: 4200, usd: 0.009, outputTokens: 400 },
      { model: "b", label: "Muse Spark 1.3 Contributor", ms: 2000, usd: 0.0001, outputTokens: 500 },
    );
    assert.equal(line, "Muse Wonder 1.0 took 2.1x as long as Muse Spark 1.3 Contributor; Muse Wonder 1.0 cost 90x as much.");
    assert.equal(compareLine({ model: "a", label: "A", ms: 0, usd: 1, outputTokens: 0 }, { model: "b", label: "B", ms: 1, usd: 1, outputTokens: 0 }), null);
  });
});
