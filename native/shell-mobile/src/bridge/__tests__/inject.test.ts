import assert from "node:assert/strict";
import { describe, it } from "node:test";
import vm from "node:vm";

import { buildDelivery, buildShim } from "../inject";
import type { ShimConfig } from "../inject";

const CONFIG: ShimConfig = {
  platform: "ios",
  capabilities: { haptics: true, share: true, camera: true, notifications: true, glasses: false, frames: false },
  nonce: "n once",
  origin: "https://demo.vercel.app",
};

function page(config: ShimConfig = CONFIG, over: { origin?: string; framed?: boolean } = {}) {
  const posted: Array<Record<string, unknown>> = [];
  const self = {} as Record<string, unknown>;
  const context = {
    console,
    setTimeout,
    clearTimeout,
    Promise,
    window: self,
  } as Record<string, unknown>;
  Object.assign(self, {
    self,
    top: over.framed ? {} : self,
    location: { origin: over.origin ?? config.origin },
    ReactNativeWebView: { postMessage: (raw: string) => posted.push(JSON.parse(raw)) },
    addEventListener() {},
  });
  vm.createContext(context);
  vm.runInContext(buildShim(config), context);
  const run = (script: string) => vm.runInContext(script, context);
  return { window: self as Record<string, any>, posted, run };
}

describe("buildShim", () => {
  it("exposes the synchronous facts before any page code runs", () => {
    const { window } = page();
    assert.equal(window.MuseNative.version, 1);
    assert.equal(window.MuseNative.platform, "ios");
    assert.equal(window.MuseNative.capabilities.share, true);
    assert.equal(window.MuseNative.glasses, undefined);
  });

  it("does nothing in an inner frame", () => {
    assert.equal(page(CONFIG, { framed: true }).window.MuseNative, undefined);
  });

  it("does nothing on another site, so that site never sees the nonce", () => {
    assert.equal(page(CONFIG, { origin: "https://evil.example" }).window.MuseNative, undefined);
  });

  it("can't be replaced by the page", () => {
    const { window, run } = page();
    const before = window.MuseNative;
    try {
      run('"use strict"; window.MuseNative = { fake: true };');
    } catch {
      // Strict mode throws. The value not changing is what matters.
    }
    assert.equal(window.MuseNative, before);
    assert.ok(Object.isFrozen(window.MuseNative));
  });

  it("posts a request with the nonce and settles from the reply", async () => {
    const { window, posted, run } = page();
    const answer = window.MuseNative.share({ text: "hi" });
    const request = posted[0];
    assert.equal(request.v, 1);
    assert.equal(request.method, "share");
    assert.equal(request.nonce, CONFIG.nonce);
    assert.deepEqual(request.params, { text: "hi" });
    run(buildDelivery({ v: 1, id: request.id as string, ok: true, result: { shared: true } }));
    // The shim runs in its own realm in this test, so compare the field and not the object.
    assert.equal((await answer).shared, true);
  });

  it("gives each call its own id, and rejects with the shell's code", async () => {
    const { window, posted, run } = page();
    const a = window.MuseNative.hello();
    const b = window.MuseNative.takePhoto();
    assert.notEqual(posted[0].id, posted[1].id);
    run(buildDelivery({ v: 1, id: posted[1].id as string, ok: false, error: { code: "canceled", message: "No photo." } }));
    await assert.rejects(b, (error: Error & { code?: string }) => error.code === "canceled" && error.message === "No photo.");
    run(buildDelivery({ v: 1, id: posted[0].id as string, ok: true, result: null }));
    assert.equal(await a, undefined);
  });

  it("ignores replies for ids it never asked about", () => {
    const { run } = page();
    run(buildDelivery({ v: 1, id: "unknown", ok: true, result: 1 }));
  });

  it("only adds glasses when the build has them, and delivers status events", () => {
    const { window, run } = page({ ...CONFIG, capabilities: { ...CONFIG.capabilities, glasses: true, frames: true } });
    const seen: unknown[] = [];
    const stop = window.MuseNative.glasses.onStatus((status: unknown) => seen.push(status));
    const status = { state: "ready", mode: "mock", device: null, error: null } as const;
    run(buildDelivery({ v: 1, event: "glasses.status", data: status }));
    stop();
    run(buildDelivery({ v: 1, event: "glasses.status", data: status }));
    assert.equal(seen.length, 1);
  });

  it("keeps the selftest and autopilot calls out of normal pages", () => {
    assert.equal(page().window.__museNative.report, undefined);
    assert.equal(page().window.__museNative.checkpoint, undefined);
    assert.equal(typeof page({ ...CONFIG, selftest: true }).window.__museNative.report, "function");
    assert.equal(typeof page({ ...CONFIG, autopilot: true }).window.__museNative.checkpoint, "function");
  });
});

describe("buildDelivery", () => {
  it("can't break out of the script, whatever the result holds", () => {
    const { window, posted, run } = page();
    const answer = window.MuseNative.hello();
    const nasty = '"); globalThis.hacked = 1; ("  </script>';
    run(buildDelivery({ v: 1, id: posted[0].id as string, ok: true, result: nasty }));
    return answer.then((value: string) => {
      assert.equal(value, nasty);
      assert.equal((globalThis as Record<string, unknown>).hacked, undefined);
    });
  });
});
