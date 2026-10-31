import assert from "node:assert/strict";
import { test } from "node:test";
import { NOW, OTHER_PRODUCT, PRODUCT } from "@/lib/tools/__tests__/helpers";
import {
  composioUserId,
  mintOwnerCode,
  mintOwnerSession,
  ownerSubject,
  productComposioUserId,
  readOwnerCode,
  readOwnerSession,
  resolvePrincipal,
  safeReturnPath,
  tierAllowed,
  visitorKeys,
} from "@/lib/tools/principal";

const later = (ms: number) => new Date(NOW.getTime() + ms);
const HOUR = 3_600_000;
const live = { productId: PRODUCT, scope: "live" };

function req(headers: Record<string, string> = {}) {
  return new Request("https://platform.test/x", { headers });
}

test("a build token is the build principal, whatever else it sends", () => {
  const session = mintOwnerSession({ productId: PRODUCT, subject: "s" }, NOW).session;
  assert.equal(resolvePrincipal(req({ "x-musemuse-owner": session }), { productId: PRODUCT, scope: "build" }, NOW).kind, "build");
});

test("no session is a product or a visitor, and neither reaches personal tools", () => {
  const product = resolvePrincipal(req(), live, NOW);
  const visitor = resolvePrincipal(req({ "x-musemuse-visitor": "v1" }), live, NOW);
  assert.equal(product.kind, "product");
  assert.equal(visitor.kind, "visitor");
  for (const p of [product, visitor]) {
    assert.equal(p.subject, null);
    assert.equal(tierAllowed(p, { tier: "public" }), true);
    assert.equal(tierAllowed(p, { tier: "personal" }), false);
  }
});

test("an owner session is good for 12 hours on its own product", () => {
  const { session, expiresAt } = mintOwnerSession({ productId: PRODUCT, subject: "s" }, NOW);
  assert.equal(expiresAt.getTime(), NOW.getTime() + 12 * HOUR);
  const owner = resolvePrincipal(req({ "x-musemuse-owner": session }), live, later(12 * HOUR - 1));
  assert.deepEqual(owner, { kind: "owner", subject: "s" });
  assert.equal(tierAllowed(owner, { tier: "personal" }), true);
});

test("an expired, forged or other product's owner session is only a visitor", () => {
  const { session } = mintOwnerSession({ productId: PRODUCT, subject: "s" }, NOW);
  const parts = session.split(".");
  const asOther = [parts[0], parts[1], "someone-else", parts[3], parts[4]].join(".");
  const signedByHand = [parts[0], parts[1], parts[2], String(NOW.getTime() + 99 * HOUR), parts[4]].join(".");
  const cases: Array<[string, string, string, Date]> = [
    ["expired", session, PRODUCT, later(12 * HOUR)],
    ["forged subject", asOther, PRODUCT, NOW],
    ["stretched expiry", signedByHand, PRODUCT, NOW],
    ["another product", session, OTHER_PRODUCT, NOW],
    ["garbage", "os1.a.b", PRODUCT, NOW],
    ["a code used as a session", mintOwnerCode({ productId: PRODUCT, subject: "s" }, NOW), PRODUCT, NOW],
  ];
  for (const [label, token, productId, at] of cases) {
    assert.equal(readOwnerSession(token, productId, at), null, label);
    const p = resolvePrincipal(req({ "x-musemuse-owner": token, "x-musemuse-visitor": "v" }), { productId, scope: "live" }, at);
    assert.equal(p.kind, "visitor", label);
    assert.equal(tierAllowed(p, { tier: "personal" }), false, label);
  }
});

test("an owner code lasts 5 minutes and can't pass as a session", () => {
  const code = mintOwnerCode({ productId: PRODUCT, subject: "s" }, NOW);
  const read = readOwnerCode(code, later(299_000));
  assert.ok(read);
  assert.equal(read.productId, PRODUCT);
  assert.equal(read.subject, "s");
  assert.ok(read.nonce);
  assert.equal(readOwnerCode(code, later(300_000)), null);
  assert.equal(readOwnerCode(`${code}x`, NOW), null);
  assert.equal(readOwnerCode(mintOwnerSession({ productId: PRODUCT, subject: "s" }, NOW).session, NOW), null);
});

test("composio user ids: same input the same, never shared across products or kinds, and in the agreed shape", () => {
  const a = composioUserId("o", PRODUCT, "s");
  assert.equal(a, composioUserId("o", PRODUCT, "s"));
  assert.notEqual(a, composioUserId("o", OTHER_PRODUCT, "s"));
  assert.notEqual(a, composioUserId("o", PRODUCT, "t"));
  assert.notEqual(a.slice(4), composioUserId("p", PRODUCT, "s").slice(4));
  assert.match(a, /^mmo_[a-z2-7]{32}$/);
  assert.match(productComposioUserId(PRODUCT), /^mmp_[a-z2-7]{32}$/);
  assert.ok(!a.includes(PRODUCT));
});

test("the subject is the person's, and hides their id", () => {
  assert.notEqual(ownerSubject("user-a"), ownerSubject("user-b"));
  assert.ok(!ownerSubject("user-a").includes("user-a"));
});

test("return paths stay on the product's own site", () => {
  assert.equal(safeReturnPath(undefined), "/");
  assert.equal(safeReturnPath(""), "/");
  assert.equal(safeReturnPath("/settings?tab=a#b"), "/settings?tab=a#b");
  for (const bad of ["//evil.example", "https://evil.example", "evil.example", "/\\evil.example", "/ok\nheader", "/\tx", "javascript:alert(1)", 5, {}, `/${"x".repeat(600)}`]) {
    assert.equal(safeReturnPath(bad), null, String(bad));
  }
});

test("visitor limits key on the IP and a hash of the visitor, per product", () => {
  const keys = visitorKeys(req({ "x-musemuse-client-ip": "203.0.113.9", "x-musemuse-visitor": "visitor-secret" }), PRODUCT);
  assert.equal(keys.length, 2);
  assert.ok(keys[0].includes("203.0.113.9"));
  assert.ok(!keys[1].includes("visitor-secret"));
  assert.deepEqual(visitorKeys(req(), PRODUCT), []);
});
