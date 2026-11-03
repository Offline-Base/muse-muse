import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { builtInToolCap, noteHeaderValue, productSafetyIdentifier, rewriteResponsesRequest, STRUCTURED_OUTPUT_MIN_TOKENS } from "@/lib/gateway/rewrite";

const PRODUCT = "00000000-0000-4000-8000-000000000002";
const token = (scope: "build" | "live", agent = false) => ({
  productId: PRODUCT,
  scope,
  allowedModels: agent ? ["muse-wonder-1.0", "agent"] : ["muse-wonder-1.0"],
});
const live = token("live");
const search = [{ type: "web_search" }];
const wonder = (extra: Record<string, unknown> = {}) => ({ model: "muse-wonder-1.0", input: "hi", ...extra });

test("background runs are refused for every token, with what to do instead", () => {
  for (const t of [token("build"), live, token("live", true)]) {
    for (const background of [true, "true", 1]) {
      const r = rewriteResponsesRequest(wonder({ background }), { token: t });
      assert.equal(r.refusal?.status, 400);
      assert.equal(r.refusal?.code, "background_unsupported");
      assert.match(r.refusal?.message ?? "", /Stream it with stream: true instead\./);
      assert.equal(r.changed, false);
    }
  }
  for (const background of [false, null, undefined]) {
    assert.equal(rewriteResponsesRequest(wonder({ background }), { token: live }).refusal, null, String(background));
  }
});

test("max_tool_calls is capped per token: 2 for builds, 5 for live, 8 for live agents", () => {
  const cases = [
    [token("build"), 2],
    [token("build", true), 2],
    [live, 5],
    [token("live", true), 8],
  ] as const;
  for (const [t, cap] of cases) {
    assert.equal(builtInToolCap(t), cap);
    for (const bad of [undefined, null, 0, -1, 1.5, cap + 1, 1e9, "3", JSON.parse("1e400"), [], {}]) {
      const r = rewriteResponsesRequest(wonder({ tools: search, max_tool_calls: bad }), { token: t });
      assert.equal(r.json.max_tool_calls, cap, `${t.scope} ${String(bad)}`);
      assert.match(r.notes.join(" "), new RegExp(`Set max_tool_calls to ${cap}`));
    }
    const kept = rewriteResponsesRequest(wonder({ tools: search, max_tool_calls: 1 }), { token: t });
    assert.equal(kept.json.max_tool_calls, 1, "a smaller limit stays");
    assert.deepEqual(kept.notes, []);
    const atCap = rewriteResponsesRequest(wonder({ tools: search, max_tool_calls: cap }), { token: t });
    assert.deepEqual(atCap.notes, []);
  }
});

test("the clamp sees every built-in tool and leaves function tools alone", () => {
  for (const type of ["web_search", "web_search_preview", "tool_search"]) {
    assert.equal(rewriteResponsesRequest(wonder({ tools: [{ type }] }), { token: live }).json.max_tool_calls, 5, type);
  }
  const fn = rewriteResponsesRequest(wonder({ tools: [{ type: "function", name: "f" }], max_tool_calls: 99 }), { token: live });
  assert.equal(fn.json.max_tool_calls, 99, "max_tool_calls doesn't limit function tools");
  assert.deepEqual(fn.notes, []);
  assert.equal(rewriteResponsesRequest(wonder(), { token: live }).json.max_tool_calls, undefined);
});

test("web_search stays allowed for a product without the agent marker", () => {
  const r = rewriteResponsesRequest(wonder({ tools: search }), { token: live });
  assert.equal(r.refusal, null);
  assert.deepEqual(r.json.tools, search);
});

test("safety_identifier is a hash scoped to the product: its own value, else the visitor, else anon", () => {
  const expected = (subject: string) => `p_${createHash("sha256").update(`${PRODUCT}:${subject}`).digest("hex").slice(0, 40)}`;
  const id = (body: Record<string, unknown>, visitorKey?: string | null) =>
    rewriteResponsesRequest(wonder(body), { token: live, visitorKey }).json.safety_identifier;
  assert.equal(id({ safety_identifier: "me" }, "visitor"), expected("me"), "a product's own value wins");
  assert.equal(id({ user: "them" }, "visitor"), expected("them"), "the deprecated user names the person too");
  assert.equal(id({}, "visitor"), expected("visitor"));
  assert.equal(id({}, null), expected("anon"));
  assert.equal(id({ safety_identifier: "", user: 7 }, null), expected("anon"), "values that name nobody are skipped");

  const value = id({ safety_identifier: "constant" }) as string;
  assert.match(value, /^p_[0-9a-f]{40}$/);
  assert.ok(value.length <= 64, "Meta takes up to 64 characters");
  const other = rewriteResponsesRequest(wonder({ safety_identifier: "constant" }), {
    token: { ...live, productId: "00000000-0000-4000-8000-000000000009" },
  }).json.safety_identifier;
  assert.notEqual(value, other, "a constant doesn't join two products' users");
  assert.equal(productSafetyIdentifier(PRODUCT, "x"), expected("x"));
});

test("agent tokens never run on Contributor; other tokens still do", () => {
  for (const model of ["muse-spark-1.3-contributor", "muse-spark-1.3"]) {
    for (const t of [token("live", true), token("build", true)]) {
      const r = rewriteResponsesRequest(wonder({ model }), { token: t });
      assert.equal(r.refusal?.code, "model_not_for_agents", model);
      assert.match(r.refusal?.message ?? "", /Use muse-wonder-1\.0 instead/);
    }
    assert.equal(rewriteResponsesRequest(wonder({ model }), { token: live }).refusal, null);
  }
  assert.equal(rewriteResponsesRequest(wonder(), { token: token("live", true) }).refusal, null);
});

test("the input is not changed, and the safety identifier means the body always changes", () => {
  const input: Record<string, unknown> = wonder({ tools: search });
  const r = rewriteResponsesRequest(input, { token: live });
  assert.equal(r.changed, true);
  assert.equal(input.safety_identifier, undefined);
  assert.deepEqual(input, wonder({ tools: search }));
});

test("user-facing words have no em dashes", () => {
  const refused = rewriteResponsesRequest(wonder({ background: true }), { token: live }).refusal?.message ?? "";
  const agent = rewriteResponsesRequest(wonder({ model: "muse-spark-1.3" }), { token: token("live", true) }).refusal?.message ?? "";
  const note = rewriteResponsesRequest(wonder({ tools: search }), { token: live }).notes.join(" ");
  for (const text of [refused, agent, note]) assert.ok(text && !text.includes("—"), text);
});

test("the note header is one printable line, capped, and absent when nothing was noted", () => {
  assert.equal(noteHeaderValue([]), null);
  assert.equal(noteHeaderValue(["a\nb", "café"]), "a b caf");
  assert.equal(noteHeaderValue(["x".repeat(2000)])?.length, 1000);
});

test("a structured reply gets room to finish: a low max_output_tokens is raised to 4,000, with a note", () => {
  assert.equal(STRUCTURED_OUTPUT_MIN_TOKENS, 4_000);
  const schema = { text: { format: { type: "json_schema", name: "file_memo", strict: true, schema: { type: "object" } } } };
  // The Nov 3 audit's two products: file_memo and prove_item at 900, sim-desk's step at 400.
  for (const asked of [400, 900, 3_999]) {
    for (const t of [token("build"), live, token("live", true)]) {
      const r = rewriteResponsesRequest(wonder({ ...schema, max_output_tokens: asked }), { token: t });
      assert.equal(r.json.max_output_tokens, 4_000, `${t.scope} ${asked}`);
      assert.match(r.notes.join(" "), new RegExp(`Set max_output_tokens to 4000 \\(it was ${asked}\\): reasoning counts against it`));
    }
  }
  const jsonObject = rewriteResponsesRequest(wonder({ text: { format: { type: "json_object" } }, max_output_tokens: 600 }), { token: live });
  assert.equal(jsonObject.json.max_output_tokens, 4_000, "json_object is cut off the same way");
});

test("the structured floor leaves everything else as it was", () => {
  const schema = { text: { format: { type: "json_schema", name: "x", schema: { type: "object" } } } };
  const cases: Array<[string, Record<string, unknown>, unknown]> = [
    ["plain text keeps a low cap", { max_output_tokens: 300 }, 300],
    ["text format type text keeps it", { text: { format: { type: "text" } }, max_output_tokens: 300 }, 300],
    ["a structured call with no cap stays without one", { ...schema }, undefined],
    ["a structured call at the floor stays", { ...schema, max_output_tokens: 4_000 }, 4_000],
    ["a structured call above it stays", { ...schema, max_output_tokens: 12_000 }, 12_000],
    ["a value it can't read is Meta's to refuse", { ...schema, max_output_tokens: "900" }, "900"],
  ];
  for (const [name, extra, want] of cases) {
    const r = rewriteResponsesRequest(wonder(extra), { token: live });
    assert.equal(r.json.max_output_tokens, want, name);
    assert.ok(!r.notes.some((n) => n.includes("max_output_tokens")), name);
  }
  const input: Record<string, unknown> = wonder({ ...schema, max_output_tokens: 900 });
  rewriteResponsesRequest(input, { token: live });
  assert.equal(input.max_output_tokens, 900, "the input object isn't changed");
});
