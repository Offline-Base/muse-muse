// Tests for the sealed state a paused agent run waits in. Run from the repo root:
//   npx tsx --test template/scripts/__tests__/*.test.mjs
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { TOKEN, useEnv } from "./agent-kit.mjs";

const { AgentStateError, STATE_TTL_MS, openState, sealState, sealToResume } = await import("../../targets/agent/files/lib/agent/state.ts");

const scope = "agent:abc";
const state = { previousResponseId: "resp_1", outputs: ["a tool's private result"] };

beforeEach(useEnv);

const refused = (fn, code) => assert.throws(fn, (err) => err instanceof AgentStateError && err.code === code);

test("a sealed state opens to what went in", () => {
  assert.deepEqual(openState(sealState(state, { scope }), { scope }), state);
});

test("a sealed state hides what it holds", () => {
  const sealed = sealState(state, { scope });
  assert.ok(!sealed.includes("resp_1"));
  for (const part of sealed.split(".")) assert.ok(!Buffer.from(part, "base64url").toString("utf8").includes("resp_1"));
});

test("two seals of the same state differ", () => {
  assert.notEqual(sealState(state, { scope }), sealState(state, { scope }));
});

test("one changed character is refused, wherever it is", () => {
  const sealed = sealState(state, { scope });
  for (const at of [4, 10, 20, sealed.length - 2]) {
    const swapped = sealed[at] === "A" ? "B" : "A";
    refused(() => openState(sealed.slice(0, at) + swapped + sealed.slice(at + 1), { scope }), "invalid");
  }
});

test("a state from another product is refused", () => {
  const sealed = sealState(state, { scope });
  process.env.PRODUCT_TOKEN = `${TOKEN}_other`;
  refused(() => openState(sealed, { scope }), "invalid");
});

test("a state from a route with other tools is refused", () => {
  refused(() => openState(sealState(state, { scope }), { scope: "agent:def" }), "invalid");
});

test("a state lasts an hour", () => {
  const now = 1_800_000_000_000;
  const sealed = sealState(state, { scope, now });
  assert.deepEqual(openState(sealed, { scope, now: now + STATE_TTL_MS - 1 }), state);
  refused(() => openState(sealed, { scope, now: now + STATE_TTL_MS }), "expired");
});

test("anything that isn't a sealed state is refused", () => {
  for (const junk of [undefined, null, 7, {}, "", "rs1", "rs1.a.b", "rs1.a.b.c.d", "rs9.a.b.c", "x".repeat(600_000)]) {
    refused(() => openState(junk, { scope }), "invalid");
  }
});

test("sealing needs the product's token, and never falls back to a known key", () => {
  delete process.env.PRODUCT_TOKEN;
  assert.throws(() => sealState(state, { scope }), /Missing PRODUCT_TOKEN/);
});

test("a tag cut short is refused, so a forgery can't get by on a few bytes", () => {
  const [prefix, iv, body, tag] = sealState(state, { scope }).split(".");
  for (const bytes of [4, 8, 12, 15]) {
    const short = Buffer.from(tag, "base64url").subarray(0, bytes).toString("base64url");
    refused(() => openState([prefix, iv, body, short].join("."), { scope }), "invalid");
  }
});

test("a state too big to open again isn't handed out", () => {
  assert.equal(sealToResume({ photo: "A".repeat(700_000) }, { scope }), undefined);
  assert.deepEqual(openState(sealToResume(state, { scope }), { scope }), state);
});
