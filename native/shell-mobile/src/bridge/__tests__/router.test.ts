import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";

import { MUSE_NATIVE_VERSION } from "../protocol";
import type { BridgeReply } from "../protocol";
import { BridgeError, createRouter, originOf } from "../router";
import type { BridgeHandlers, RouterOptions } from "../router";

const ORIGIN = "https://demo.vercel.app";
const PAGE = `${ORIGIN}/start`;
const NONCE = "nonce-abc";

function harness(handlers: BridgeHandlers, extra: Partial<RouterOptions> = {}) {
  const replies: BridgeReply[] = [];
  let url: string | null = PAGE;
  const router = createRouter({
    handlers,
    nonce: NONCE,
    isAllowedOrigin: (origin) => origin === ORIGIN,
    currentUrl: () => url,
    send: (reply) => replies.push(reply),
    ...extra,
  });
  return { router, replies, setUrl: (next: string | null) => (url = next) };
}

const message = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ v: MUSE_NATIVE_VERSION, id: "m1", method: "hello", nonce: NONCE, ...over });

describe("origin allowlist", () => {
  it("answers the allowed origin", async () => {
    const { router, replies } = harness({ hello: () => ({ hi: true }) });
    assert.deepEqual(await router.receive(message(), PAGE), { status: "replied", ok: true });
    assert.deepEqual(replies, [{ v: 1, id: "m1", ok: true, result: { hi: true } }]);
  });

  it("drops any other origin with no reply and never runs the handler", async () => {
    const handler = mock.fn(() => null);
    const { router, replies } = harness({ hello: handler });
    for (const source of ["https://evil.example/", "https://demo.vercel.app.evil.example/", "http://demo.vercel.app/"]) {
      assert.deepEqual(await router.receive(message(), source), { status: "dropped", reason: "origin" });
    }
    assert.equal(handler.mock.callCount(), 0);
    assert.equal(replies.length, 0);
  });

  it("drops pages with no web origin", async () => {
    const { router } = harness({ hello: () => null });
    for (const source of ["about:blank", "file:///etc/passwd", "data:text/html,hi", "", "not a url"]) {
      assert.deepEqual(await router.receive(message(), source), { status: "dropped", reason: "origin" });
    }
  });

  it("drops a message with the wrong or a missing nonce", async () => {
    const handler = mock.fn(() => null);
    const { router, replies } = harness({ hello: handler });
    assert.deepEqual(await router.receive(message({ nonce: "guess-abc" }), PAGE), { status: "dropped", reason: "nonce" });
    assert.deepEqual(await router.receive(message({ nonce: undefined }), PAGE), { status: "dropped", reason: "nonce" });
    assert.equal(handler.mock.callCount(), 0);
    assert.equal(replies.length, 0);
  });

  it("doesn't reply once the page has moved to another site", async () => {
    let finish: (value: unknown) => void = () => {};
    const { router, replies, setUrl } = harness({ hello: () => new Promise((resolve) => (finish = resolve)) });
    const outcome = router.receive(message(), PAGE);
    setUrl("https://evil.example/");
    finish("secret");
    assert.deepEqual(await outcome, { status: "unsent", reason: "origin" });
    assert.equal(replies.length, 0);
  });

  it("doesn't reply after the page goes away", async () => {
    let finish: (value: unknown) => void = () => {};
    const { router, replies } = harness({ hello: () => new Promise((resolve) => (finish = resolve)) });
    const outcome = router.receive(message(), PAGE);
    router.dispose();
    finish("late");
    assert.deepEqual(await outcome, { status: "unsent", reason: "disposed" });
    assert.equal(replies.length, 0);
    assert.deepEqual(await router.receive(message({ id: "m2" }), PAGE), { status: "dropped", reason: "disposed" });
  });
});

describe("ids and message shape", () => {
  it("replies with the id it was asked with", async () => {
    const { router, replies } = harness({ hello: () => 1 });
    await router.receive(message({ id: "abc_DEF-1" }), PAGE);
    assert.equal(replies[0].id, "abc_DEF-1");
  });

  it("drops ids that aren't plain tokens, so they can't reach the reply script", async () => {
    const { router, replies } = harness({ hello: () => 1 });
    for (const id of ["", "a b", "x'); alert(1); ('", "é", "a".repeat(65), 5, null, undefined]) {
      assert.deepEqual(await router.receive(message({ id }), PAGE), { status: "dropped", reason: "malformed" });
    }
    assert.equal(replies.length, 0);
  });

  it("drops a second request with an id that's still waiting", async () => {
    let finish: (value: unknown) => void = () => {};
    const { router, replies } = harness({ hello: () => new Promise((resolve) => (finish = resolve)) });
    const first = router.receive(message(), PAGE);
    assert.deepEqual(await router.receive(message(), PAGE), { status: "dropped", reason: "duplicate" });
    finish(1);
    await first;
    assert.equal(replies.length, 1);
  });

  it("allows an id again once its request has finished", async () => {
    const { router, replies } = harness({ hello: () => 1 });
    await router.receive(message(), PAGE);
    await router.receive(message(), PAGE);
    assert.equal(replies.length, 2);
  });

  it("drops bad JSON, wrong versions and oversized messages", async () => {
    const { router } = harness({ hello: () => 1 });
    for (const raw of ["{", "[]", "null", '"x"', message({ v: 2 })]) {
      assert.deepEqual(await router.receive(raw, PAGE), { status: "dropped", reason: "malformed" });
    }
    assert.deepEqual(await router.receive("x".repeat(256_001), PAGE), { status: "dropped", reason: "too_large" });
  });

  it("answers unknown methods without touching object internals", async () => {
    const { router, replies } = harness({ hello: () => 1 });
    for (const [id, method] of [["a", "nope"], ["b", "constructor"], ["c", "__proto__"], ["d", 5]]) {
      assert.deepEqual(await router.receive(message({ id, method }), PAGE), { status: "replied", ok: false, code: "unsupported" });
    }
    assert.equal(replies.length, 4);
  });

  it("answers unsupported for a known method this build doesn't have", async () => {
    const { router } = harness({ hello: () => 1 });
    const outcome = await router.receive(message({ method: "glasses.connect" }), PAGE);
    assert.deepEqual(outcome, { status: "replied", ok: false, code: "unsupported" });
  });

  it("refuses bad params before the handler runs", async () => {
    const handler = mock.fn(() => null);
    const { router } = harness({ share: handler });
    const outcome = await router.receive(message({ method: "share", params: { url: "file:///etc/passwd" } }), PAGE);
    assert.deepEqual(outcome, { status: "replied", ok: false, code: "bad_request" });
    assert.equal(handler.mock.callCount(), 0);
  });

  it("passes the handler only cleaned params", async () => {
    let seen: unknown;
    const { router } = harness({
      haptic: ((params: unknown) => {
        seen = params;
      }) as never,
    });
    await router.receive(message({ method: "haptic", params: { kind: "heavy", extra: "drop me" } }), PAGE);
    assert.deepEqual(seen, { kind: "heavy" });
  });
});

describe("timeouts and failures", () => {
  it("answers timeout when a handler hangs, and frees the slot", async () => {
    const { router, replies } = harness({ hello: () => new Promise(() => {}) }, { timeouts: { hello: 10 } });
    const outcome = await router.receive(message(), PAGE);
    assert.deepEqual(outcome, { status: "replied", ok: false, code: "timeout" });
    assert.equal(router.inFlight(), 0);
    assert.equal(replies.length, 1);
    assert.equal(replies[0].ok, false);
  });

  it("sends one reply when a handler finishes after its timeout", async () => {
    let finish: (value: unknown) => void = () => {};
    const { router, replies } = harness(
      { hello: () => new Promise((resolve) => (finish = resolve)) },
      { timeouts: { hello: 5 } },
    );
    await router.receive(message(), PAGE);
    finish("late");
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(replies.length, 1);
  });

  it("gives the page a BridgeError's code and message", async () => {
    const { router, replies } = harness({
      hello: () => {
        throw new BridgeError("denied", "Photo access is off.");
      },
    });
    await router.receive(message(), PAGE);
    assert.deepEqual(replies[0], { v: 1, id: "m1", ok: false, error: { code: "denied", message: "Photo access is off." } });
  });

  it("hides other errors behind a plain message", async () => {
    const { router, replies } = harness({
      hello: () => {
        throw new Error("/private/var/secret/path exploded");
      },
    });
    await router.receive(message(), PAGE);
    const reply = replies[0];
    assert.ok(!reply.ok);
    assert.equal(reply.error.code, "failed");
    assert.ok(!reply.error.message.includes("secret"));
  });

  it("limits how many calls wait at once", async () => {
    const { router } = harness({ hello: () => new Promise(() => {}) }, { maxInFlight: 1, timeouts: { hello: 20 } });
    const first = router.receive(message({ id: "a" }), PAGE);
    assert.deepEqual(await router.receive(message({ id: "b" }), PAGE), { status: "replied", ok: false, code: "busy" });
    await first;
  });

  it("rate limits within the window, then allows calls again", async () => {
    let clock = 1_000;
    const { router } = harness(
      { hello: () => 1 },
      { limits: { hello: { max: 2, perMs: 100 } }, now: () => clock },
    );
    await router.receive(message({ id: "a" }), PAGE);
    await router.receive(message({ id: "b" }), PAGE);
    assert.deepEqual(await router.receive(message({ id: "c" }), PAGE), { status: "replied", ok: false, code: "rate_limited" });
    clock += 101;
    assert.deepEqual(await router.receive(message({ id: "d" }), PAGE), { status: "replied", ok: true });
  });
});

describe("originOf", () => {
  it("only gives web origins", () => {
    assert.equal(originOf("https://a.example:8443/x?y#z"), "https://a.example:8443");
    assert.equal(originOf("http://localhost:3000/"), "http://localhost:3000");
    assert.equal(originOf("about:blank"), null);
    assert.equal(originOf("javascript:alert(1)"), null);
    assert.equal(originOf(null), null);
  });
});
