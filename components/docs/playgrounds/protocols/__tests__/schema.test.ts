/**
 * The schemas explorer's data: the three schemas pages parsed from the mirror's Markdown (raw, and as /docs/md serves
 * it without the {#id} anchors), their type cells read as alternatives, and real replies from the docs proxy held up
 * against the tables. Nothing reaches the network.
 *
 *   npx tsx --test --experimental-test-module-mocks components/docs/playgrounds/protocols/__tests__/schema.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { checkSchema, fitsSchema } from "@/components/docs/playgrounds/protocols/schema-check";
import { describeType, parseSchemaPage, parseTypeExpr, schemaKind, tableCells } from "@/components/docs/playgrounds/protocols/schema-parse";
import { markdownForCopy } from "@/lib/docs/markdown-text";

const ROOT = path.resolve(import.meta.dirname, "../../../../..");
const FIX = path.join(import.meta.dirname, "fixtures");
const raw = (slug: string) => readFileSync(path.join(ROOT, "content/meta-docs/pages", `${slug}.md`), "utf8");
const fixture = (name: string) => JSON.parse(readFileSync(path.join(FIX, name), "utf8")) as Record<string, unknown>;

const PAGES = {
  responses: "api-reference/responses/schemas",
  chat: "api-reference/chat-completions/schemas",
  messages: "api-reference/messages/schemas",
} as const;

const responses = parseSchemaPage(raw(PAGES.responses));
const chat = parseSchemaPage(raw(PAGES.chat));
const messages = parseSchemaPage(raw(PAGES.messages));

describe("parseSchemaPage", () => {
  it("finds every schema on the three pages, with the page's anchors", () => {
    for (const [slug, page, count] of [
      [PAGES.responses, responses, 146],
      [PAGES.chat, chat, 43],
      [PAGES.messages, messages, 53],
    ] as const) {
      assert.equal(page.schemas.length, count, slug);
      const anchors = [...raw(slug).matchAll(/^### .+? \{#([^}]+)\}$/gm)].map((m) => m[1]);
      assert.deepEqual(page.schemas.map((s) => s.anchor), anchors, `${slug} anchors`);
      // /docs/md serves the page without {#id}: the anchors come out the same from the headings.
      const copy = parseSchemaPage(markdownForCopy(raw(slug), slug));
      assert.deepEqual(copy.schemas.map((s) => s.anchor), anchors, `${slug} without anchors`);
      assert.deepEqual(copy.schemas.map((s) => s.fields.length), page.schemas.map((s) => s.fields.length));
    }
    assert.equal(responses.title, "Responses schemas");
    assert.match(responses.intro, /full schema and model definitions/);
  });

  it("reads a table's fields with escaped pipes restored and required flags", () => {
    const create = responses.byAnchor["create-response"];
    assert.equal(create.name, "Create Response");
    assert.equal(create.code, "CreateResponse");
    assert.equal(create.fields.length, 28);
    const prev = create.fields.find((f) => f.name === "previous_response_id")!;
    assert.equal(prev.type, "`string` | `null`");
    assert.equal(prev.required, false);
    assert.match(prev.description, /server-managed state/);
    const usage = responses.byAnchor["response-usage"];
    assert.ok(usage.fields.some((f) => f.name === "input_tokens_details.cached_tokens" && f.required));
    assert.deepEqual(tableCells("| `a` | `string` \\| `null` | Yes | x \\| y |"), ["`a`", "`string` | `null`", "Yes", "x | y"]);
  });

  it("keeps descriptions, list items and Type lines, and links schemas both ways", () => {
    const include = responses.byAnchor["include-enum"];
    assert.match(include.description, /^Specify additional output data.*\n- `web_search_call\.action\.sources`/s);
    assert.match(include.typeLine ?? "", /^`enum \('file_search_call\.results'/);
    const computer = responses.byAnchor["computer-tool-call"];
    assert.match(computer.description, /A tool call to a computer use tool\. See the \[computer use guide\]/, "a wrapped paragraph joins into one");
    const output = responses.byAnchor["output-item"];
    assert.ok(output.refs.includes("output-message") && output.refs.includes("function-tool-call"));
    assert.ok(responses.usedBy["output-message"].includes("output-item"));
    assert.ok(responses.usedBy["response"]?.includes("response-completed-event"));
    assert.equal(chat.codeToAnchor.ChatCompletionRequestMessage, "chat-completion-request-message");
  });

  it("counts schemas a cell names in code, not only the linked ones, both ways", () => {
    // "Type: `array of InputTextContentParam | InputImageContentParamAutoParam | InputFileContentParam`" has no links.
    const list = responses.byAnchor["function-call-output-content-list-param"];
    for (const a of ["input-text-content-param", "input-image-content-param-auto-param", "input-file-content-param"]) {
      assert.ok(list.refs.includes(a), `${a} is referenced`);
      assert.ok(responses.usedBy[a]?.includes("function-call-output-content-list-param"), `${a} is used by the list`);
    }
    for (const page of [responses, chat, messages]) {
      for (const s of page.schemas) {
        assert.equal(new Set(s.refs).size, s.refs.length, `${s.name}: each reference once`);
        assert.ok(!s.refs.includes(s.anchor), `${s.name}: not its own reference`);
        for (const r of s.refs) assert.ok(page.byAnchor[r], `${s.name}: ${r} is on the page`);
      }
    }
  });

  it("sorts schemas into objects, events, unions, enums and aliases", () => {
    assert.equal(schemaKind(responses.byAnchor["response"]), "object");
    assert.equal(schemaKind(responses.byAnchor["response-text-delta-event"]), "event");
    assert.equal(schemaKind(responses.byAnchor["output-item"]), "union");
    assert.equal(schemaKind(responses.byAnchor["service-tier"]), "enum");
    assert.equal(schemaKind(responses.byAnchor["metadata"]), "alias");
    assert.equal(schemaKind(responses.byAnchor["input-param"]), "union");
    assert.equal(schemaKind(messages.byAnchor["anthropic-stream-event"]), "event");
  });

  it("parses the 226 KB Responses page quickly", () => {
    const md = raw(PAGES.responses);
    const started = performance.now();
    for (let i = 0; i < 10; i++) parseSchemaPage(md);
    assert.ok((performance.now() - started) / 10 < 60, "well under a frame's worth of work per parse");
  });
});

describe("parseTypeExpr", () => {
  it("reads primitives, formats, enums, arrays, links and code names", () => {
    assert.deepEqual(parseTypeExpr("`string` | `null`"), [{ kind: "string" }, { kind: "null" }]);
    assert.deepEqual(parseTypeExpr("`integer (int64)`"), [{ kind: "integer" }]);
    assert.deepEqual(parseTypeExpr("`enum ('auto', 'standard_only')`"), [{ kind: "enum", values: ["auto", "standard_only"] }]);
    assert.deepEqual(parseTypeExpr("array of [`OutputItem`](https://dev.meta.ai/docs/api-reference/responses/schemas#output-item)"), [
      { kind: "array", of: [{ kind: "ref", code: "OutputItem", anchor: "output-item" }] },
    ]);
    assert.deepEqual(parseTypeExpr("`array of enum ('text', 'audio')` | `null`"), [{ kind: "array", of: [{ kind: "enum", values: ["text", "audio"] }] }, { kind: "null" }]);
    assert.deepEqual(parseTypeExpr("`array of ChatCompletionTool`", chat.codeToAnchor), [{ kind: "array", of: [{ kind: "ref", code: "ChatCompletionTool", anchor: "chat-completion-tool" }] }]);
    assert.deepEqual(parseTypeExpr(""), [{ kind: "any" }]);
    assert.equal(describeType(parseTypeExpr("[`Reasoning`](#reasoning) | `null`")), "Reasoning or null");
    assert.equal(describeType(parseTypeExpr("`enum ('message')`")), "'message'");
  });

  it("parses every type cell and Type line on the three pages without an unknown", () => {
    for (const page of [responses, chat, messages]) {
      for (const s of page.schemas) {
        const cells = [...(s.typeLine ? [s.typeLine] : []), ...s.fields.map((f) => f.type).filter(Boolean)];
        for (const cell of cells) {
          const alts = parseTypeExpr(cell, page.codeToAnchor);
          const unknown = JSON.stringify(alts).includes('"kind":"any"');
          assert.equal(unknown, false, `${s.name}: ${cell}`);
          const refs = JSON.stringify(alts).match(/"anchor":null/);
          assert.equal(refs, null, `${s.name}: every reference resolves (${cell})`);
        }
      }
    }
  });
});

describe("checkSchema on real replies", () => {
  it("holds a Responses reply up to Response, its usage, its message and its text", () => {
    const basic = fixture("responses-basic.json");
    const check = checkSchema(responses.byAnchor["response"], basic, responses);
    const byField = Object.fromEntries(check.fields.map((f) => [f.field, f]));
    assert.equal(byField.id.status, "ok");
    assert.equal(byField.output.status, "ok", "every output item fits one of OutputItem's members");
    assert.equal(byField.error.status, "ok", "null fits ResponseError (object or null)");
    assert.equal(byField.metadata.status, "missing", "the table marks metadata required; this reply leaves it out");
    assert.ok(check.extra.includes("top_logprobs") === false);
    assert.match(check.summary, /fields match the table/);

    const usage = checkSchema(responses.byAnchor["response-usage"], basic.usage, responses);
    assert.ok(usage.fields.filter((f) => f.required).every((f) => f.status === "ok"), JSON.stringify(usage.fields));
    const message = (basic.output as unknown[])[1];
    const msg = checkSchema(responses.byAnchor["output-message"], message, responses);
    assert.equal(msg.fields.find((f) => f.field === "content")!.status, "ok");
    assert.equal(fitsSchema(responses.byAnchor["output-item"], message, responses), true);
    assert.equal(fitsSchema(responses.byAnchor["function-tool-call"], message, responses), false, "told apart by type");
  });

  it("checks a function call, a cancel, a delete and a token count", () => {
    const call = fixture("responses-function-call.json");
    const fc = (call.output as Array<Record<string, unknown>>).find((o) => o.type === "function_call");
    const c = checkSchema(responses.byAnchor["function-tool-call"], fc, responses);
    assert.ok(c.fields.filter((f) => f.required).every((f) => f.status === "ok"));
    const cancel = checkSchema(responses.byAnchor["cancel-response-response"], fixture("responses-cancel.json"), responses);
    assert.ok(cancel.fields.every((f) => f.status === "ok"), JSON.stringify(cancel.fields));
    const del = checkSchema(responses.byAnchor["delete-response-response"], fixture("responses-delete.json"), responses);
    assert.ok(del.fields.every((f) => f.status === "ok"));
    const count = checkSchema(responses.byAnchor["token-counts-resource"], fixture("responses-input-tokens.json"), responses);
    assert.ok(count.fields.every((f) => f.status === "ok"));
  });

  it("checks Chat Completions and Messages replies, nested rows included", () => {
    const basic = fixture("chat-basic.json");
    const r = checkSchema(chat.byAnchor["create-chat-completion-response"], basic, chat);
    const finish = r.fields.find((f) => f.field === "choices[].finish_reason")!;
    assert.equal(finish.status, "ok");
    const usage = checkSchema(chat.byAnchor["completion-usage"], basic.usage, chat);
    assert.ok(usage.fields.every((f) => f.status !== "mismatch"));
    const tools = fixture("chat-tool-calls.json");
    const message = (tools.choices as Array<Record<string, unknown>>)[0].message;
    const m = checkSchema(chat.byAnchor["chat-completion-response-message"], message, chat);
    assert.equal(m.fields.find((f) => f.field === "tool_calls")!.status, "ok");
    const msg = checkSchema(messages.byAnchor["anthropic-message"], fixture("messages-basic.json"), messages);
    assert.ok(msg.fields.every((f) => f.status === "ok"), JSON.stringify(msg.fields));
    const count = checkSchema(messages.byAnchor["anthropic-count-tokens-response"], fixture("messages-count-tokens.json"), messages);
    assert.equal(count.fields[0].status, "ok");
  });

  it("checks a request body, calls out a wrong type, and reads a Type line", () => {
    const body = { model: "muse-spark-1.3-contributor", input: "Hi", max_output_tokens: "400", store: true };
    const c = checkSchema(responses.byAnchor["create-response"], body, responses);
    const byField = Object.fromEntries(c.fields.map((f) => [f.field, f]));
    assert.equal(byField.model.status, "ok");
    assert.equal(byField.max_output_tokens.status, "mismatch");
    assert.match(byField.max_output_tokens.actual, /string/);
    assert.equal(byField.tools.status, "absent");
    assert.match(c.summary, /1 field of another type/);
    const union = checkSchema(responses.byAnchor["output-item"], (fixture("responses-basic.json").output as unknown[])[1], responses);
    assert.equal(union.member, "output-message", "a union value is checked as the member its type names");
    assert.match(union.summary, /^Matches OutputMessage, one of the \d+ alternatives\./);
    assert.ok(union.fields.some((f) => f.field === "content" && f.status === "ok"));
    const none = checkSchema(responses.byAnchor["output-item"], { type: "mystery" }, responses);
    assert.equal(none.fits, false);
    const tier = checkSchema(responses.byAnchor["service-tier"], "auto", responses);
    assert.equal(tier.fits, true);
    assert.equal(checkSchema(responses.byAnchor["service-tier"], "fastest", responses).fits, false);
  });

  it("says so, rather than passing, when none of a table's optional fields are in the value", () => {
    const mixin = chat.byAnchor["create-model-response-properties"];
    const none = checkSchema(mixin, { model: "muse-spark-1.3-contributor", messages: [{ role: "user", content: "Hi" }] }, chat);
    assert.ok(none.fields.every((f) => f.status === "absent"));
    assert.match(none.summary, /^None of this table's fields are in this example\./);
    const some = checkSchema(mixin, { model: "m", messages: [], prompt_cache_key: "docs-schemas", service_tier: "auto" }, chat);
    assert.match(some.summary, /^2 fields match the table\.$/);
  });
});
