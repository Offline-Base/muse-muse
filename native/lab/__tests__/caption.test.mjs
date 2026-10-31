import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { captionFor, labFailureSummary, noteFor, summaryFor } from "../lib/caption.mjs";
import { KINDS } from "../lib/validate.mjs";

describe("captionFor", () => {
  test("says what really ran", () => {
    assert.equal(captionFor("android_emu", { name: "Pixel 7", os: "15" }), "On an Android emulator (Pixel 7, Android 15)");
    assert.equal(captionFor("ios_sim", { os: "18.4" }), "On an iPhone simulator (iOS 18.4)");
    assert.equal(captionFor("ios_sim", { name: "iPhone 16", os: "18.4" }), "On an iPhone simulator (iPhone 16, iOS 18.4)");
    assert.equal(captionFor("glasses_sim", { os: "18.4" }), "On an iPhone simulator with simulated Meta glasses (iOS 18.4)");
    assert.equal(captionFor("desktop_mac", { os: "15.5" }), "On a Mac in the AWS device lab (macOS 15.5)");
    assert.equal(captionFor("desktop_windows", { os: "Windows Server 2022" }), "On Windows in the AWS device lab (Windows Server 2022)");
  });
  test("leaves out what isn't known", () => {
    assert.equal(captionFor("android_emu", {}), "On an Android emulator");
    assert.equal(captionFor("ios_sim"), "On an iPhone simulator");
  });
  test("nothing from a device string can inject odd text", () => {
    const caption = captionFor("android_emu", { name: "Pixel:\n%{pts}'evil'", os: "15" });
    assert.ok(!/[\n%{}':]/.test(caption), caption);
  });
  test("no em dashes, and never a claim of a real device", () => {
    for (const kind of KINDS) {
      for (const text of [captionFor(kind, { name: "x", os: "1" }), noteFor(kind), labFailureSummary(kind, {})]) {
        assert.ok(!text.includes("\u2014"), text);
      }
    }
    assert.match(captionFor("ios_sim", {}), /simulator/);
    assert.match(captionFor("android_emu", {}), /emulator/);
    assert.match(captionFor("glasses_sim", {}), /simulated/);
  });
});

describe("noteFor", () => {
  test("the glasses note says the photo is a sample, and every note disclaims Meta", () => {
    assert.match(noteFor("glasses_sim"), /sample photo/);
    for (const kind of KINDS) assert.match(noteFor(kind), /Not an official Meta product\./);
  });
});

describe("summaryFor", () => {
  test("passed, with and without a time", () => {
    assert.equal(summaryFor("android_emu", { name: "Pixel 7", os: "15" }, { passed: true, loadMs: 2100 }), "Checked on an Android emulator (Pixel 7, Android 15): opened in 2.1 s.");
    assert.equal(summaryFor("ios_sim", {}, { passed: true }), "Checked on an iPhone simulator.");
  });
  test("failed, with the first reason", () => {
    assert.equal(summaryFor("desktop_mac", {}, { passed: false, reasons: ["The screen stayed blank."] }), "Didn't pass on a Mac in the AWS device lab: The screen stayed blank.");
    assert.equal(summaryFor("desktop_mac", {}, { passed: false }), "Didn't pass on a Mac in the AWS device lab.");
  });
  test("a lab failure doesn't blame the product", () => {
    assert.equal(labFailureSummary("android_emu", {}), "Not checked on an Android emulator: the device lab ran into a problem.");
  });
});
