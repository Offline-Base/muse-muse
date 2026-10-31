// Tests for app/api/musemuse/[...path]/route.ts, the owner's sign-in and account connections. Run from the repo root:
//   npx tsx --test template/scripts/__tests__/*.test.mjs
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { fakeGateway, TOKEN, useEnv } from "./agent-kit.mjs";

const { GET, POST } = await import("../../targets/agent/files/app/api/musemuse/[...path]/route.ts");
const { samePath } = await import("../../targets/agent/files/lib/platform/identity.ts");

const SESSION = "os1.prod123.ownerhash.1800000000.signature_value";
let gateway;

beforeEach(useEnv);
afterEach(() => gateway?.restore());

const ctx = (...path) => ({ params: Promise.resolve({ path }) });
const req = (path, init = {}) => new Request(`https://product.example/api/musemuse/${path}`, init);
const post = (path, body, headers = {}) => req(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

test("the owner's link trades its code, sets the HttpOnly session and lands on the product", async () => {
  gateway = fakeGateway({ routes: { "/identity/owner": { session: SESSION, expiresAt: "later" } } });
  const res = await GET(req("owner?code=oc1.abc", { headers: { "x-forwarded-for": "203.0.113.9" } }), ctx("owner"));
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/");
  const cookie = res.headers.get("set-cookie");
  assert.match(cookie, new RegExp(`^mm_owner=${SESSION.replaceAll(".", "\\.")};`));
  for (const part of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/", "Max-Age=43200"]) assert.ok(cookie.includes(part), part);
  const [call] = gateway.requests;
  assert.equal(call.body.code, "oc1.abc");
  assert.equal(call.headers.get("authorization"), `Bearer ${TOKEN}`);
  assert.equal(call.headers.get("x-musemuse-client-ip"), "203.0.113.9");
});

test("a used code, a missing code or a strange reply lands on the product with no session", async () => {
  gateway = fakeGateway({ routes: { "/identity/owner": { status: 403, json: { error: { code: "sign_in_required", message: "That link has been used." } } } } });
  for (const url of ["owner?code=used", "owner"]) {
    const res = await GET(req(url), ctx("owner"));
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), "/");
    assert.equal(res.headers.get("set-cookie"), null);
  }
  gateway.restore();
  gateway = fakeGateway({ routes: { "/identity/owner": { session: "bad session; Domain=evil.example" } } });
  assert.equal((await GET(req("owner?code=x"), ctx("owner"))).headers.get("set-cookie"), null);
});

test("sign-out clears the session", async () => {
  const res = await POST(req("sign-out", { method: "POST" }), ctx("sign-out"));
  assert.equal(res.status, 204);
  assert.match(res.headers.get("set-cookie"), /^mm_owner=; .*Max-Age=0/);
});

test("connect sends the person's identity and a path on this site to the gateway", async () => {
  gateway = fakeGateway({ routes: { "/tools/connect": { url: "https://connect.example/link" } } });
  const res = await POST(
    post("connect", { toolkit: "gmail", returnTo: "/plan?x=1" }, { cookie: `mm_vid=abcdefghijklmnop1234; mm_owner=${SESSION}`, "x-forwarded-for": "203.0.113.9" }),
    ctx("connect"),
  );
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { url: "https://connect.example/link" });
  const [call] = gateway.requests;
  assert.deepEqual(call.body, { toolkit: "gmail", returnTo: "/plan?x=1" });
  assert.equal(call.headers.get("x-musemuse-owner"), SESSION);
  assert.equal(call.headers.get("x-musemuse-visitor"), "abcdefghijklmnop1234");
  assert.equal(call.headers.get("x-musemuse-client-ip"), "203.0.113.9");
});

test("connect never passes on a return address that leaves the site", async () => {
  gateway = fakeGateway({ routes: { "/tools/connect": { url: "https://connect.example/link" } } });
  await POST(post("connect", { toolkit: "gmail", returnTo: "https://evil.example/" }), ctx("connect"));
  assert.equal(gateway.requests[0].body.returnTo, "/");
});

test("the gateway's refusal comes through in its own words and status", async () => {
  gateway = fakeGateway({ routes: { "/tools/connect": { status: 403, json: { error: { code: "sign_in_required", message: "Only this app's owner can connect Gmail for now." } } } } });
  const res = await POST(post("connect", { toolkit: "gmail" }), ctx("connect"));
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: "Only this app's owner can connect Gmail for now.", code: "sign_in_required" });
});

test("disconnect and connections go to the gateway with the person's identity", async () => {
  gateway = fakeGateway({ routes: { "/tools/disconnect": { ok: true }, "/tools/connections": { connections: [{ toolkit: "gmail" }] } } });
  assert.equal((await POST(post("disconnect", { toolkit: "gmail" }, { cookie: `mm_owner=${SESSION}` }), ctx("disconnect"))).status, 200);
  assert.deepEqual(gateway.requests[0].body, { toolkit: "gmail" });
  assert.equal(gateway.requests[0].headers.get("x-musemuse-owner"), SESSION);
  const list = await GET(req("connections", { headers: { cookie: `mm_owner=${SESSION}` } }), ctx("connections"));
  assert.deepEqual(await list.json(), { connections: [{ toolkit: "gmail" }] });
  assert.equal(list.headers.get("cache-control"), "no-store");
});

test("a page on another site can't use these", async () => {
  gateway = fakeGateway();
  const crossSite = { "sec-fetch-site": "cross-site" };
  for (const [path, route] of [["connect", "connect"], ["disconnect", "disconnect"], ["sign-out", "sign-out"]]) {
    assert.equal((await POST(post(path, { toolkit: "gmail" }, crossSite), ctx(route))).status, 403, path);
  }
  assert.equal((await GET(req("connections", { headers: crossSite }), ctx("connections"))).status, 403);
  assert.equal(gateway.requests.length, 0);
});

test("the owner's link and the way back from connecting work when they come from another site", async () => {
  gateway = fakeGateway({ routes: { "/identity/owner": { session: SESSION } } });
  const crossSite = { "sec-fetch-site": "cross-site" };
  assert.ok((await GET(req("owner?code=x", { headers: crossSite }), ctx("owner"))).headers.get("set-cookie"));
  const back = await GET(req("connected?toolkit=gmail&returnTo=/plan", { headers: crossSite }), ctx("connected"));
  assert.equal(back.headers.get("location"), "/plan?connected=gmail");
  const failed = await GET(req("connected?toolkit=gmail&returnTo=/plan&error=connect_failed", { headers: crossSite }), ctx("connected"));
  assert.equal(failed.headers.get("location"), "/plan?connect_failed=gmail");
  const again = await GET(req(`connected?toolkit=gmail&returnTo=${encodeURIComponent("/plan?connect_failed=gmail")}`, { headers: crossSite }), ctx("connected"));
  assert.equal(again.headers.get("location"), "/plan?connected=gmail", "a second try that works isn't still a failure");
});

test("coming back from connecting stays on this site, whatever the address says", async () => {
  for (const returnTo of ["https://evil.example/", "//evil.example/", "/\\evil.example", "javascript:alert(1)", "evil.example"]) {
    const res = await GET(req(`connected?toolkit=gmail&returnTo=${encodeURIComponent(returnTo)}`), ctx("connected"));
    assert.equal(res.headers.get("location"), "/?connected=gmail", returnTo);
  }
});

test("a toolkit name that isn't one is refused before the gateway", async () => {
  gateway = fakeGateway();
  for (const toolkit of [undefined, "", "a/b", "../x", 7, "x".repeat(65)]) {
    assert.equal((await POST(post("connect", { toolkit }), ctx("connect"))).status, 400);
  }
  assert.equal((await POST(req("connect", { method: "POST", body: "not json" }), ctx("connect"))).status, 400);
  assert.equal(gateway.requests.length, 0);
});

test("a body over the limit is refused", async () => {
  gateway = fakeGateway();
  assert.equal((await POST(post("connect", { toolkit: "gmail", returnTo: "x".repeat(9000) }), ctx("connect"))).status, 400);
  assert.equal(gateway.requests.length, 0);
});

test("other paths don't exist", async () => {
  assert.equal((await GET(req("nope"), ctx("nope"))).status, 404);
  assert.equal((await POST(req("nope", { method: "POST" }), ctx("nope"))).status, 404);
  assert.equal((await GET(req("owner/extra"), ctx("owner", "extra"))).status, 404);
});

test("samePath keeps a path and its query, and turns everything else into /", () => {
  assert.equal(samePath("/a/b?c=1#d"), "/a/b?c=1#d");
  for (const bad of [null, 7, "", "a", "//x", "/\\x", "https://x", "/\u0000x", "/\nx", "/.//evil.example/x", "/..//evil.example", "/a/..//evil.example"]) assert.equal(samePath(bad), "/");
});
