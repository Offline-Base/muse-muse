import assert from "node:assert/strict";
import { test } from "node:test";
import { NOW, PRODUCT, OTHER_PRODUCT } from "@/lib/tools/__tests__/helpers";
import { argumentsHash, canonicalJson, checkApproval, mac, mintApproval, mintConnectState, readConnectState } from "@/lib/tools/sign";

const scope = { productId: PRODUCT, subject: "owner-a", slug: "GMAIL_SEND_EMAIL", args: { recipient_email: "a@example.com", subject: "Hi" } };
const later = (ms: number) => new Date(NOW.getTime() + ms);

test("arguments hash the same in any key order, and differently when anything changes", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: null } }), '{"a":{"c":null,"d":[1,{"x":1,"y":2}]},"b":1}');
  assert.equal(argumentsHash({ a: 1, b: 2 }), argumentsHash({ b: 2, a: 1 }));
  assert.notEqual(argumentsHash({ a: 1 }), argumentsHash({ a: 2 }));
});

test("an approval passes only for its product, person, tool and exact arguments, for 10 minutes", () => {
  const id = mintApproval(scope, NOW);
  const ok = checkApproval(id, { ...scope, args: { subject: "Hi", recipient_email: "a@example.com" } }, later(599_000));
  assert.ok(ok);
  assert.equal(ok.exp.getTime(), NOW.getTime() + 600_000);
  assert.equal(checkApproval(id, { ...scope, args: { ...scope.args, recipient_email: "b@example.com" } }, NOW), null);
  assert.equal(checkApproval(id, { ...scope, productId: OTHER_PRODUCT }, NOW), null);
  assert.equal(checkApproval(id, { ...scope, subject: "owner-b" }, NOW), null);
  assert.equal(checkApproval(id, { ...scope, slug: "GMAIL_CREATE_EMAIL_DRAFT" }, NOW), null);
  assert.equal(checkApproval(id, scope, later(600_000)), null);
  assert.equal(checkApproval(`${id}x`, scope, NOW), null);
  assert.equal(checkApproval("ap1.a.b", scope, NOW), null);
  assert.equal(checkApproval("", scope, NOW), null);
});

test("each approval has its own nonce, so it can be spent once", () => {
  const a = checkApproval(mintApproval(scope, NOW), scope, NOW);
  const b = checkApproval(mintApproval(scope, NOW), scope, NOW);
  assert.ok(a && b);
  assert.notEqual(a.nonce, b.nonce);
});

test("connect state round-trips, expires in 15 minutes and rejects any change", () => {
  const token = mintConnectState({ productId: PRODUCT, composioUserId: "mmo_x", toolkit: "gmail", returnTo: "/settings" }, NOW);
  const state = readConnectState(token, later(899_000));
  assert.ok(state);
  assert.equal(state.toolkit, "gmail");
  assert.equal(state.returnTo, "/settings");
  assert.equal(state.composioUserId, "mmo_x");
  assert.equal(readConnectState(token, later(900_000)), null);
  const [prefix, body, sig] = token.split(".");
  const forged = Buffer.from(JSON.stringify({ ...state, composioUserId: "mmo_someone_else" })).toString("base64url");
  assert.equal(readConnectState(`${prefix}.${forged}.${sig}`, NOW), null);
  assert.equal(readConnectState(`${prefix}.${body}.${sig}x`, NOW), null);
  assert.equal(readConnectState("nonsense", NOW), null);
});

test("each use signs with its own key", () => {
  assert.notEqual(mac("approvals", ["x"]), mac("connect-state", ["x"]));
  assert.notEqual(mac("approvals", ["ab", "c"]), mac("approvals", ["a", "bc"]));
});
