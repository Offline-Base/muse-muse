import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { buildConfig } from "../../app.config";
import { buildAutopilotScript, cleanCheckpoint } from "../glasses/autopilot";
import { deviceSummary, problemFromSessionError, problemFromStreamError, problemFromThrown } from "../glasses/status";
import { chooseLaunchTarget, isOpenableUrl, isValidSlug, launchArgsToRequest, parseDeepLink, targetForRunningApp } from "../launch";
import type { LaunchEnv } from "../launch";
import { decideNavigation } from "../navigation";
import { createResolveClient, createStubResolveClient, ResolveError } from "../resolve";
import { buildSelftestScript, cleanPageObservations, finishReport, postSelftestReport } from "../selftest";
import type { NativeObservations, PageObservations } from "../selftest";

const PRODUCTION: LaunchEnv = { variant: "production", glasses: false };
const LAB: LaunchEnv = { variant: "lab", glasses: false };

describe("decideNavigation", () => {
  const productOrigin = "https://demo.vercel.app";

  it("keeps the product's own pages in the app", () => {
    assert.equal(decideNavigation({ url: "https://demo.vercel.app/a?b=1", productOrigin }), "allow");
    assert.equal(decideNavigation({ url: "about:blank", productOrigin }), "allow");
  });

  it("sends other sites to the system browser", () => {
    assert.equal(decideNavigation({ url: "https://evil.example/", productOrigin }), "external");
    assert.equal(decideNavigation({ url: "http://demo.vercel.app/", productOrigin }), "external");
    assert.equal(decideNavigation({ url: "https://demo.vercel.app.evil.example/", productOrigin }), "external");
    assert.equal(decideNavigation({ url: "mailto:a@b.example", productOrigin }), "external");
  });

  it("refuses schemes that could open apps or files", () => {
    for (const url of ["intent://x#Intent;end", "file:///etc/passwd", "javascript:alert(1)", "market://x", "nonsense"]) {
      assert.equal(decideNavigation({ url, productOrigin }), "block", url);
    }
  });

  it("lets inner frames load web content in place, but not app links", () => {
    assert.equal(decideNavigation({ url: "https://other.example/", productOrigin, isTopFrame: false }), "allow");
    assert.equal(decideNavigation({ url: "intent://x", productOrigin, isTopFrame: false }), "block");
    assert.equal(decideNavigation({ url: "file:///x", productOrigin, isTopFrame: false }), "block");
  });
});

describe("launch", () => {
  it("reads slugs from each deep link form", () => {
    assert.deepEqual(parseDeepLink("musemuse://open?slug=dinner-split"), { slug: "dinner-split" });
    assert.deepEqual(parseDeepLink("exp://u.expo.dev/abc/--/open?slug=dinner-split"), { slug: "dinner-split" });
    assert.deepEqual(parseDeepLink("exp://u.expo.dev/abc/--/p/dinner-split?channel-name=production"), { slug: "dinner-split" });
  });

  it("reads lab options", () => {
    assert.deepEqual(parseDeepLink("musemuse://check?url=https%3A%2F%2Fa.example&selftest=1&token=t&mock=1&run=autopilot"), {
      url: "https://a.example",
      selftest: true,
      token: "t",
      mock: true,
      autopilot: true,
    });
  });

  it("ignores other links, including Meta AI's callback", () => {
    assert.equal(parseDeepLink("musemuse://open?metaWearablesAction=register"), null);
    assert.equal(parseDeepLink("https://evil.example/open?slug=x"), null);
    assert.equal(parseDeepLink("musemuse://other"), null);
    assert.equal(parseDeepLink("exp://u.expo.dev/abc"), null);
    assert.equal(parseDeepLink(null), null);
    assert.equal(parseDeepLink("::"), null);
  });

  it("reads iOS launch arguments", () => {
    assert.deepEqual(launchArgsToRequest({ museUrl: "https://a.example", museSelftest: "1" }), {
      url: "https://a.example",
      selftest: true,
    });
    assert.equal(launchArgsToRequest({}), null);
  });

  it("checks slugs the way the platform does", () => {
    assert.ok(isValidSlug("a-1"));
    for (const slug of ["", "A", "a--b", "-a", "a/b", "../x", "a".repeat(41), 5]) assert.equal(isValidSlug(slug), false);
  });

  it("only opens https, or http on the machine itself", () => {
    assert.ok(isOpenableUrl("https://a.example"));
    assert.ok(isOpenableUrl("http://localhost:3000"));
    assert.ok(isOpenableUrl("http://10.0.2.2:3000"));
    for (const url of ["http://a.example", "file:///x", "javascript:alert(1)", 5, null]) assert.equal(isOpenableUrl(url), false);
  });

  it("makes the production shell refuse raw URLs", () => {
    const target = chooseLaunchTarget(PRODUCTION, { deepLink: { url: "https://evil.example" } });
    assert.deepEqual(target, { kind: "list", notice: "This app only opens Muse Muse products." });
    const fromArgs = chooseLaunchTarget(PRODUCTION, { launchArgs: { url: "https://evil.example", selftest: true } });
    assert.equal(fromArgs.kind, "list");
  });

  it("opens production products by slug only", () => {
    assert.deepEqual(chooseLaunchTarget(PRODUCTION, { deepLink: { slug: "a-b" } }), { kind: "slug", slug: "a-b" });
    assert.equal(chooseLaunchTarget(PRODUCTION, { deepLink: { slug: "../x" } }).kind, "list");
    assert.deepEqual(chooseLaunchTarget(PRODUCTION, {}), { kind: "list" });
  });

  it("lets the lab open a URL with a selftest", () => {
    assert.deepEqual(
      chooseLaunchTarget(LAB, { launchArgs: { url: "https://a.example", selftest: true, token: "t", platform: "https://p.example" } }),
      { kind: "url", url: "https://a.example", selftest: { token: "t", platformUrl: "https://p.example" }, glasses: null },
    );
    assert.equal(chooseLaunchTarget(LAB, { launchArgs: { url: "http://a.example" } }).kind, "list");
  });

  it("drops a report platform that isn't a safe URL", () => {
    const target = chooseLaunchTarget(LAB, { deepLink: { url: "https://a.example", selftest: true, platform: "http://a.example" } });
    assert.ok(target.kind === "url");
    assert.equal(target.selftest?.platformUrl, null);
  });

  it("only honors mock glasses in a glasses build", () => {
    const request = { url: "https://a.example", mock: true, autopilot: true };
    const plain = chooseLaunchTarget(LAB, { deepLink: request });
    assert.ok(plain.kind === "url");
    assert.equal(plain.glasses, null);
    const glasses = chooseLaunchTarget({ ...LAB, glasses: true }, { deepLink: request });
    assert.ok(glasses.kind === "url");
    assert.deepEqual(glasses.glasses, { mock: true, autopilot: true });
  });

  it("keeps launch arguments ahead of a deep link", () => {
    const target = chooseLaunchTarget(LAB, { launchArgs: { url: "https://a.example" }, deepLink: { url: "https://b.example" } });
    assert.ok(target.kind === "url");
    assert.equal(target.url, "https://a.example");
  });

  it("pins a per-product app to its one URL", () => {
    const env = { ...PRODUCTION, productUrl: "https://one.example" };
    assert.deepEqual(chooseLaunchTarget(env, { deepLink: { url: "https://evil.example", slug: "x" } }), {
      kind: "url",
      url: "https://one.example",
      selftest: null,
      glasses: null,
    });
    assert.equal(targetForRunningApp(env, "musemuse://open?slug=other"), null);
  });
});

describe("resolve client", () => {
  const reply = (status: number, body: unknown) =>
    (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it("resolves a slug and works out its origin", async () => {
    let asked = "";
    const client = createResolveClient({
      platformUrl: "https://p.example/",
      fetch: (async (url: string) => {
        asked = url;
        return new Response(JSON.stringify({ slug: "a-b", name: "A", url: "https://a.example/x" }));
      }) as unknown as typeof fetch,
    });
    assert.deepEqual(await client.resolve("a-b"), { slug: "a-b", name: "A", url: "https://a.example/x", origin: "https://a.example" });
    assert.equal(asked, "https://p.example/api/native/resolve/a-b");
  });

  it("never asks about an invalid slug", async () => {
    const client = createResolveClient({
      platformUrl: "https://p.example",
      fetch: (() => assert.fail("no request")) as unknown as typeof fetch,
    });
    await assert.rejects(client.resolve("../admin"), (e: ResolveError) => e.code === "not_found");
  });

  it("refuses an answer for another slug or an unsafe URL", async () => {
    for (const body of [
      { slug: "other", name: "A", url: "https://a.example" },
      { slug: "a-b", name: "A", url: "http://a.example" },
      { slug: "a-b", name: "A", url: "javascript:alert(1)" },
      { slug: "a-b", url: "https://a.example" },
      "nope",
    ]) {
      const client = createResolveClient({ platformUrl: "https://p.example", fetch: reply(200, body) });
      await assert.rejects(client.resolve("a-b"), (e: ResolveError) => e.code === "bad_response");
    }
  });

  it("maps failures to plain codes", async () => {
    const missing = createResolveClient({ platformUrl: "https://p.example", fetch: reply(404, {}) });
    await assert.rejects(missing.resolve("a-b"), (e: ResolveError) => e.code === "not_found");
    const down = createResolveClient({ platformUrl: "https://p.example", fetch: reply(500, {}) });
    await assert.rejects(down.resolve("a-b"), (e: ResolveError) => e.code === "unavailable");
    const offline = createResolveClient({
      platformUrl: "https://p.example",
      fetch: (async () => {
        throw new TypeError("offline");
      }) as unknown as typeof fetch,
    });
    await assert.rejects(offline.catalog(), (e: ResolveError) => e.code === "unavailable");
  });

  it("gives up when the platform hangs", async () => {
    const client = createResolveClient({
      platformUrl: "https://p.example",
      timeoutMs: 5,
      fetch: ((_: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        })) as unknown as typeof fetch,
    });
    await assert.rejects(client.resolve("a-b"), (e: ResolveError) => e.code === "unavailable");
  });

  it("skips bad catalog rows", async () => {
    const client = createResolveClient({
      platformUrl: "https://p.example",
      fetch: reply(200, { products: [{ slug: "a-b", name: "A" }, { slug: "../x", name: "B" }, { slug: "c" }, 5] }),
    });
    assert.deepEqual(await client.catalog(), [{ slug: "a-b", name: "A", tagline: null }]);
  });

  it("has a stub that behaves like the routes", async () => {
    const stub = createStubResolveClient();
    const [first] = await stub.catalog();
    assert.equal((await stub.resolve(first.slug)).slug, first.slug);
    await assert.rejects(stub.resolve("missing"), (e: ResolveError) => e.code === "not_found");
  });
});

describe("selftest", () => {
  const native: NativeObservations = {
    variant: "lab",
    shellVersion: "1.0.0",
    platform: "android",
    capabilities: { haptics: true, share: true, camera: true, notifications: true, glasses: false, frames: false },
    url: "https://a.example/",
    finalUrl: "https://a.example/start",
    productOrigin: "https://a.example",
    httpStatus: null,
    loadMs: 900,
    crashed: false,
    loadError: null,
  };
  const page: PageObservations = {
    title: "A",
    textLength: 500,
    scrollHeight: 2000,
    viewportWidth: 390,
    viewportHeight: 844,
    handshake: true,
    errors: [],
  };
  const at = new Date("2026-10-31T00:00:00Z");

  it("passes a healthy load, and only warns on console errors", () => {
    const report = finishReport(native, { ...page, errors: ["boom"] }, at);
    assert.equal(report.ok, true);
    assert.deepEqual(report.problems, []);
    assert.deepEqual(report.warnings, ["boom"]);
  });

  it("fails each thing the plan names", () => {
    const cases: Array<[Partial<NativeObservations>, Partial<PageObservations>, RegExp]> = [
      [{ crashed: true }, {}, /crashed/],
      [{ loadError: "offline" }, {}, /didn't load/],
      [{ httpStatus: 500 }, {}, /answered 500/],
      [{ finalUrl: "https://evil.example/" }, {}, /another site/],
      [{ finalUrl: null }, {}, /another site/],
      [{}, { textLength: 3 }, /blank/],
      [{}, { handshake: false }, /talk to each other/],
    ];
    for (const [n, p, problem] of cases) {
      const report = finishReport({ ...native, ...n }, { ...page, ...p }, at);
      assert.equal(report.ok, false);
      assert.match(report.problems.join(" "), problem);
    }
  });

  it("cleans what the page sends", () => {
    const clean = cleanPageObservations({ title: "x".repeat(500), textLength: -4, handshake: "yes", errors: ["e".repeat(900), 5], extra: 1 });
    assert.equal(clean.title.length, 200);
    assert.equal(clean.textLength, 0);
    assert.equal(clean.handshake, false);
    assert.equal(clean.errors[0].length, 300);
    assert.equal(clean.errors[1], "");
    assert.equal("extra" in clean, false);
    assert.equal(cleanPageObservations("junk").textLength, 0);
  });

  it("posts with the token, and survives a failed post", async () => {
    let auth: string | null = null;
    const report = finishReport(native, page, at);
    const ok = await postSelftestReport({
      platformUrl: "https://p.example/",
      token: "t",
      report,
      fetch: (async (url: string, init: RequestInit) => {
        assert.equal(url, "https://p.example/api/native/selftest");
        auth = new Headers(init.headers).get("authorization");
        return new Response("{}");
      }) as unknown as typeof fetch,
    });
    assert.equal(ok, true);
    assert.equal(auth, "Bearer t");
    const failed = await postSelftestReport({
      platformUrl: "https://p.example",
      token: null,
      report,
      fetch: (async () => {
        throw new Error("offline");
      }) as unknown as typeof fetch,
    });
    assert.equal(failed, false);
  });

  it("builds a script that parses", () => {
    assert.doesNotThrow(() => new Function(buildSelftestScript(10)));
  });
});

describe("glasses helpers", () => {
  it("maps module errors to the bridge's codes", () => {
    assert.equal(problemFromSessionError("datAppOnTheGlassesUpdateRequired").code, "glasses_app_update_required");
    assert.equal(problemFromSessionError("noEligibleDevice").code, "no_eligible_device");
    assert.equal(problemFromSessionError("somethingNew").code, "session_ended");
    assert.equal(problemFromStreamError("hingesClosed").code, "hinges_closed");
    assert.equal(problemFromStreamError("somethingNew").code, "capture_failed");
    assert.equal(problemFromThrown(new Error("metaAINotInstalled")).code, "meta_ai_missing");
    assert.equal(problemFromThrown(new Error("thermalCritical")).code, "thermal");
  });

  it("summarizes a device, treating -1 battery as unknown", () => {
    assert.deepEqual(deviceSummary({ name: "RB", batteryLevel: 80, donState: "donned" }), { name: "RB", battery: 80, worn: true });
    assert.deepEqual(deviceSummary({ batteryLevel: -1 }), { name: "Meta glasses", battery: null, worn: null });
    assert.equal(deviceSummary(null), null);
  });

  it("only logs known autopilot steps", () => {
    const at = new Date("2026-10-31T00:00:00Z");
    assert.deepEqual(cleanCheckpoint({ step: "result", ok: true, detail: "x".repeat(400) }, at)?.detail?.length, 300);
    assert.equal(cleanCheckpoint({ step: "rm -rf", ok: true }, at), null);
    assert.equal(cleanCheckpoint("junk", at), null);
  });

  it("builds an autopilot script that parses", () => {
    assert.doesNotThrow(() => new Function(buildAutopilotScript(10)));
  });
});

describe("app config", () => {
  it("gives each variant its own id", () => {
    assert.equal(buildConfig({}).ios.bundleIdentifier, "ai.musemuse.app");
    assert.equal(buildConfig({ APP_VARIANT: "lab" }).android.package, "ai.musemuse.lab");
    assert.equal(buildConfig({ APP_VARIANT: "lab", MUSE_GLASSES: "1" }).ios.bundleIdentifier, "app.musemuse.glasses");
  });

  it("only carries the glasses SDK and its Info.plist keys in a glasses build", () => {
    const plain = JSON.stringify(buildConfig({ APP_VARIANT: "production" }));
    assert.doesNotMatch(plain, /wearables|external-accessory|NSBonjourServices/);
    const glasses = buildConfig({ MUSE_GLASSES: "1" });
    assert.ok(JSON.stringify(glasses.plugins).includes("@chrisgocode/expo-meta-wearables-dat"));
    assert.ok(glasses.ios.infoPlist.UIBackgroundModes?.includes("external-accessory"));
  });

  it("links the glasses module before EAS installs pods, which is ahead of its post-install hook", () => {
    const { scripts } = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    assert.equal(scripts["eas-build-pre-install"], "node scripts/glasses-autolink.mjs");
    assert.equal(scripts["eas-build-post-install"], undefined);
  });

  it("lists the Podfile fix ahead of the module, so it runs after the module's plugin", () => {
    const names = buildConfig({ MUSE_GLASSES: "1" }).plugins.map((plugin) => (Array.isArray(plugin) ? plugin[0] : plugin));
    const fix = names.indexOf("./plugins/without-deterministic-uuids.js");
    assert.ok(fix >= 0 && fix < names.indexOf("@chrisgocode/expo-meta-wearables-dat"));
  });

  it("only adds mock glasses when asked, and only with glasses", () => {
    const mock = "./plugins/with-mock-glasses-in-release.js";
    assert.ok(JSON.stringify(buildConfig({ MUSE_GLASSES: "1", MUSE_GLASSES_MOCK: "1" }).plugins).includes(mock));
    assert.ok(!JSON.stringify(buildConfig({ MUSE_GLASSES: "1" }).plugins).includes(mock));
    assert.ok(!JSON.stringify(buildConfig({ MUSE_GLASSES_MOCK: "1" }).plugins).includes(mock));
  });

  it("turns updates off in a per-product app", () => {
    assert.equal(buildConfig({}).updates.enabled, true);
    assert.equal(buildConfig({ MUSE_PRODUCT_URL: "https://one.example" }).updates.enabled, false);
    assert.equal(buildConfig({ MUSE_PRODUCT_URL: "https://one.example" }).extra.productUrl, "https://one.example");
  });
});
