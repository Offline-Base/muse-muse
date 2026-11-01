import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { claimableKinds, downloadUrlProblem, KINDS, LANE_OF, targetUrlProblem, validateJob } from "../lib/validate.mjs";
import { makeJob } from "./helpers.mjs";

const check = (job, lane = "mac", extra = {}) => validateJob(job, { lane, platformOrigin: "https://muse-muse.vercel.app", ...extra });
const withInput = (kind, input) => makeJob(kind, { input });

describe("validateJob", () => {
  for (const kind of KINDS) {
    test(`accepts a good ${kind} job on its lane`, () => {
      const result = check(makeJob(kind), LANE_OF[kind]);
      assert.equal(result.ok, true, result.error);
      assert.equal(result.job.kind, kind);
      // A tuned model's emulator run has no page to open.
      if (kind !== "gguf_emu") assert.equal(result.job.input.target.origin, "https://demo-product.vercel.app");
    });
  }

  test("refuses a kind on the wrong lane", () => {
    assert.match(check(makeJob("desktop_windows"), "mac").error, /can't run on the mac lab/);
    assert.match(check(makeJob("ios_sim"), "windows").error, /can't run on the windows lab/);
  });

  test("refuses an unknown kind, a bad id and a bad token", () => {
    assert.equal(check(makeJob("ios_sim", { kind: "shell" })).ok, false);
    assert.equal(check(makeJob("ios_sim", { id: "../../etc" })).ok, false);
    assert.equal(check(makeJob("ios_sim", { token: "short" })).ok, false);
    assert.equal(check(makeJob("ios_sim", { token: "has spaces in the token here" })).ok, false);
    assert.equal(check(null).ok, false);
  });

  test("fills in defaults", () => {
    const { job } = check(withInput("android_emu", { recordSeconds: undefined, shots: undefined }));
    assert.equal(job.input.recordSeconds, 15);
    assert.equal(job.input.shots, 2);
    const desktop = check(makeJob("desktop_mac"));
    assert.equal(desktop.job.input.selftestSeconds, 12);
  });

  test("holds numbers to their limits", () => {
    assert.equal(check(withInput("ios_sim", { limitSeconds: 5 })).ok, false);
    assert.equal(check(withInput("ios_sim", { limitSeconds: 901 })).ok, false);
    assert.equal(check(withInput("ios_sim", { limitSeconds: undefined })).ok, false);
    assert.equal(check(withInput("ios_sim", { recordSeconds: 26 })).ok, false);
    assert.equal(check(withInput("ios_sim", { shots: 5 })).ok, false);
    assert.equal(check(withInput("ios_sim", { shots: 1.5 })).ok, false);
    assert.equal(check(withInput("desktop_mac", { selftestSeconds: 21 })).ok, false);
  });

  test("needs input version 1", () => {
    assert.match(check(withInput("ios_sim", { v: 2 })).error, /input\.v/);
  });

  test("the app must match the kind", () => {
    const app = makeJob("ios_sim").input.app;
    assert.match(check(withInput("android_emu", { app })).error, /input\.app\.kind/);
    assert.match(check(withInput("ios_sim", { app: { ...app, variant: "product" } })).error, /variant/);
    assert.match(check(withInput("ios_sim", { app: { ...app, bundleId: "bad id; rm -rf" } })).error, /bundleId/);
    assert.match(check(withInput("ios_sim", { app: { ...app, sha256: "abc" } })).error, /sha256/);
    assert.match(check(withInput("ios_sim", { app: { ...app, sha256: undefined } })).error, /sha256/);
    assert.match(check(withInput("ios_sim", { app: { ...app, url: "https://evil.example/a.tgz" } })).error, /Vercel Blob/);
    const apk = makeJob("android_emu").input.app;
    assert.match(check(withInput("android_emu", { app: { ...apk, packageName: "x; reboot" } })).error, /packageName/);
  });

  test("a Windows exe name can't be a path", () => {
    const app = makeJob("desktop_windows").input.app;
    assert.equal(check(withInput("desktop_windows", { app: { ...app, exeName: "Demo.exe" } }), "windows").ok, true);
    assert.equal(check(withInput("desktop_windows", { app: { ...app, exeName: "..\\evil.exe" } }), "windows").ok, false);
  });

  test("the selftest token and platform are checked", () => {
    assert.equal(check(withInput("ios_sim", { selftest: null })).job.input.selftest, null);
    assert.equal(check(withInput("ios_sim", { selftest: { token: "x" } })).ok, false);
    assert.equal(check(withInput("ios_sim", { selftest: { token: "a".repeat(20), platformUrl: "http://evil.example" } })).ok, false);
  });

  test("glasses need a photo and a known scenario", () => {
    assert.match(check(withInput("glasses_sim", { media: undefined })).error, /input\.media/);
    assert.match(check(withInput("glasses_sim", { scenario: "other" })).error, /scenario/);
    assert.equal(check(makeJob("glasses_sim")).job.input.scenario, "capture-and-ask");
  });

  test("a product name is cut short, and a missing one is fine", () => {
    assert.equal(check(withInput("ios_sim", { product: { name: "x".repeat(200) } })).job.input.product.name.length, 80);
    assert.deepEqual(check(withInput("ios_sim", { product: null })).job.input.product, { name: "", slug: null });
  });
});

describe("targetUrlProblem", () => {
  test("takes public https and refuses the rest", () => {
    assert.equal(targetUrlProblem("https://a.vercel.app/p?x=1"), null);
    for (const bad of [
      "",
      "http://a.vercel.app",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "https://user:pw@a.vercel.app",
      "https://a.vercel.app:8443",
      "https://169.254.169.254/latest/meta-data",
      "https://[::1]/",
      "https://localhost/",
      "https://box.local/",
      "https://intranet/",
      "not a url",
      `https://a.vercel.app/${"x".repeat(2100)}`,
    ]) {
      assert.notEqual(targetUrlProblem(bad), null, bad);
    }
  });

  test("allows loopback only when asked", () => {
    assert.notEqual(targetUrlProblem("http://localhost:3000"), null);
    assert.equal(targetUrlProblem("http://localhost:3000", { allowInsecure: true }), null);
    assert.notEqual(targetUrlProblem("http://evil.example", { allowInsecure: true }), null);
  });
});

describe("downloadUrlProblem", () => {
  test("only Blob and the platform", () => {
    assert.equal(downloadUrlProblem("https://x.public.blob.vercel-storage.com/a.apk"), null);
    assert.equal(downloadUrlProblem("https://muse-muse.vercel.app/a", { platformOrigin: "https://muse-muse.vercel.app" }), null);
    assert.notEqual(downloadUrlProblem("https://blob.vercel-storage.com.evil.example/a"), null);
    assert.notEqual(downloadUrlProblem("http://x.public.blob.vercel-storage.com/a"), null);
    assert.notEqual(downloadUrlProblem("https://u:p@x.public.blob.vercel-storage.com/a"), null);
    assert.notEqual(downloadUrlProblem("https://evil.example/a"), null);
  });
});

describe("claimableKinds", () => {
  const all = ["ios_sim", "glasses_sim", "android_emu", "desktop_mac"];
  test("offers everything when free", () => assert.deepEqual(claimableKinds(all, [], 1), all));
  test("offers nothing with no open slot", () => assert.deepEqual(claimableKinds(all, ["ios_sim"], 1), []));
  test("two jobs never share a resource", () => {
    assert.deepEqual(claimableKinds(all, ["ios_sim"], 2), ["android_emu", "desktop_mac"]);
    assert.deepEqual(claimableKinds(all, ["android_emu"], 2), ["ios_sim", "glasses_sim", "desktop_mac"]);
  });
});
