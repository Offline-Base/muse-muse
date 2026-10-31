import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { BRIDGE_METHODS, METHOD_TIMEOUT_MS } from "../protocol";
import { validateParams } from "../validate";

const here = (path: string) => new URL(path, import.meta.url);

describe("protocol", () => {
  it("is the same file products copy", () => {
    assert.equal(readFileSync(here("../protocol.ts"), "utf8"), readFileSync(here("../../../../bridge/protocol.ts"), "utf8"));
  });

  it("has no imports, so products can copy it with no dependencies", () => {
    assert.doesNotMatch(readFileSync(here("../protocol.ts"), "utf8"), /^\s*import\s/m);
  });

  it("has a timeout for every method", () => {
    for (const method of BRIDGE_METHODS) assert.ok(METHOD_TIMEOUT_MS[method] > 0, method);
  });
});

describe("validateParams", () => {
  it("defaults takePhoto and caps its size", () => {
    assert.deepEqual(validateParams("takePhoto", undefined), { ok: true, params: { source: "camera", maxSize: 1600 } });
    assert.equal(validateParams("takePhoto", { maxSize: 99_999 }).ok, false);
    assert.equal(validateParams("takePhoto", { source: "files" }).ok, false);
  });

  it("only shares web links", () => {
    assert.equal(validateParams("share", { url: "https://a.example" }).ok, true);
    for (const url of ["javascript:alert(1)", "file:///x", "intent://x", "nope"]) {
      assert.equal(validateParams("share", { url }).ok, false, url);
    }
    assert.equal(validateParams("share", {}).ok, false);
  });

  it("needs a notification title, and limits its delay", () => {
    assert.equal(validateParams("notify", {}).ok, false);
    assert.equal(validateParams("notify", { title: "x".repeat(121) }).ok, false);
    assert.equal(validateParams("notify", { title: "Hi", delaySeconds: -1 }).ok, false);
    assert.deepEqual(validateParams("notify", { title: "Hi" }), {
      ok: true,
      params: { title: "Hi", body: undefined, delaySeconds: 0 },
    });
  });

  it("refuses options that aren't objects", () => {
    for (const raw of ["x", 5, true, []]) assert.equal(validateParams("share", raw).ok, false);
  });

  it("checks glasses options", () => {
    assert.equal(validateParams("glasses.preview", {}).ok, false);
    assert.equal(validateParams("glasses.startRecording", {}).ok, false);
    assert.equal(validateParams("glasses.startRecording", { maxSeconds: 61 }).ok, false);
    assert.equal(validateParams("glasses.speak", { text: "" }).ok, false);
    assert.deepEqual(validateParams("glasses.capturePhoto", undefined), { ok: true, params: { maxSize: 1600 } });
  });
});
