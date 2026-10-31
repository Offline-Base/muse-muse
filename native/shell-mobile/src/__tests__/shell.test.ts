import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { buildConfig } from "../../app.config";
import { AUTOPILOT_LOG, buildAutopilotScript, cleanCheckpoint } from "../glasses/autopilot";
import { silentWavBase64 } from "../glasses/wav";
import { deviceSummary, problemFromSessionError, problemFromStreamError, problemFromThrown } from "../glasses/status";
import { chooseLaunchTarget, isOpenableUrl, isValidSlug, launchArgsToRequest, parseDeepLink, targetForRunningApp } from "../launch";
import type { LaunchEnv } from "../launch";
import { createRateLimiter, decideNavigation, EXTERNAL_OPEN_LIMIT, leftTheProduct, mayOpenExternally } from "../navigation";
import { createResolveClient, createStubResolveClient, ResolveError } from "../resolve";
import { buildSelftestScript, canAcceptPageReport, cleanPageObservations, finishReport, postSelftestReport, SELFTEST_SCROLL_MS } from "../selftest";
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

describe("leftTheProduct", () => {
  const productOrigin = "https://demo.vercel.app";

  it("catches a top-level load that got past the first check", () => {
    assert.equal(leftTheProduct("https://evil.example/login", productOrigin), true);
    assert.equal(leftTheProduct("intent://x", productOrigin), true);
  });

  it("leaves the product's own pages alone, and events with no URL", () => {
    assert.equal(leftTheProduct("https://demo.vercel.app/a", productOrigin), false);
    assert.equal(leftTheProduct("about:blank", productOrigin), false);
    assert.equal(leftTheProduct("", productOrigin), false);
    assert.equal(leftTheProduct(undefined, productOrigin), false);
  });
});

describe("external opens", () => {
  it("allows a few, then drops the rest until the window passes", () => {
    let clock = 1_000;
    const allow = createRateLimiter(EXTERNAL_OPEN_LIMIT, () => clock);
    assert.deepEqual([allow(), allow(), allow(), allow()], [true, true, true, false]);
    clock += EXTERNAL_OPEN_LIMIT.perMs + 1;
    assert.equal(allow(), true);
  });

  it("opens phone links on iOS only from a click", () => {
    const ios = { gestureKnown: true };
    assert.equal(mayOpenExternally({ url: "tel:+15551234", navigationType: "click", ...ios }), true);
    assert.equal(mayOpenExternally({ url: "tel:+15551234", navigationType: "other", ...ios }), false);
    assert.equal(mayOpenExternally({ url: "sms:+15551234", ...ios }), false);
  });

  it("leaves other links, and Android's phone links, to the rate limit", () => {
    assert.equal(mayOpenExternally({ url: "https://a.example", navigationType: "other", gestureKnown: true }), true);
    assert.equal(mayOpenExternally({ url: "tel:+15551234", navigationType: "other", gestureKnown: false }), true);
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

  it("ignores a report from before the page loaded or the scroll ended", () => {
    assert.equal(canAcceptPageReport(null, 99_999), false);
    assert.equal(canAcceptPageReport(1_000, 1_000 + SELFTEST_SCROLL_MS - 1), false);
    assert.equal(canAcceptPageReport(1_000, 1_000 + SELFTEST_SCROLL_MS), true);
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
    assert.equal(problemFromThrown(new Error("The Meta AI app is not installed on the device")).code, "meta_ai_missing");
    assert.equal(problemFromThrown(new Error("All discovered devices are powered off or disconnected")).code, "no_eligible_device");
    assert.equal(problemFromThrown(new Error("Your glasses need an update.")).code, "glasses_app_update_required");
    assert.equal(problemFromThrown(new Error("anything else")).code, "session_ended");
  });

  it("summarizes a device, treating -1 battery as unknown", () => {
    assert.deepEqual(deviceSummary({ name: "RB", batteryLevel: 80, donState: "donned" }), { name: "RB", battery: 80, worn: true });
    assert.deepEqual(deviceSummary({ batteryLevel: -1 }), { name: "Meta glasses", battery: null, worn: null });
    assert.equal(deviceSummary(null), null);
  });

  it("makes a valid 16 kHz mono silent WAV", () => {
    const wav = Buffer.from(silentWavBase64(0.5), "base64");
    assert.equal(wav.toString("latin1", 0, 4), "RIFF");
    assert.equal(wav.toString("latin1", 8, 12), "WAVE");
    assert.equal(wav.readUInt16LE(22), 1);
    assert.equal(wav.readUInt32LE(24), 16_000);
    assert.equal(wav.readUInt16LE(34), 16);
    assert.equal(wav.readUInt32LE(40), 16_000);
    assert.equal(wav.length, 44 + 16_000);
    assert.equal(wav.readUInt32LE(4), wav.length - 8);
    assert.equal(Buffer.from(silentWavBase64(-1), "base64").length, 44);
  });

  it("only logs known autopilot steps", () => {
    const at = new Date("2026-10-31T00:00:00Z");
    assert.deepEqual(cleanCheckpoint({ step: "result", ok: true, detail: "x".repeat(400) }, at)?.detail?.length, 300);
    assert.equal(cleanCheckpoint({ step: "rm -rf", ok: true }, at), null);
    assert.equal(cleanCheckpoint("junk", at), null);
  });

  it("builds an autopilot script that parses", () => {
    assert.doesNotThrow(() => new Function(buildAutopilotScript(10)));
    assert.equal(AUTOPILOT_LOG, "autopilot.jsonl");
  });

  /** Runs the script against a small fake of the template's connect and primary buttons. */
  async function runAutopilot(primary: { pressed: boolean; enabledAfterMs?: number }) {
    const started = Date.now();
    const clicks: number[] = [];
    const marks: Array<{ step: string; ok: boolean }> = [];
    let resultShown = false;
    const button = (attrs: Record<string, string | null>, onClick: () => void) => ({
      click: onClick,
      getAttribute: (name: string) => attrs[name] ?? null,
    });
    const connect = button({}, () => {});
    const attrs: Record<string, string | null> = { "aria-pressed": "false" };
    const main = button(attrs, () => {
      clicks.push(Date.now() - started);
      if (clicks.length === 1 && primary.pressed) {
        attrs["aria-pressed"] = "true";
      } else {
        attrs["aria-pressed"] = "false";
        resultShown = true;
      }
    });
    const document = {
      querySelector(selector: string) {
        if (selector === '[data-glasses-action="connect"]') return connect;
        if (selector === "[data-glasses-primary]") return main;
        if (selector === "[data-glasses-primary]:not([disabled])") {
          return Date.now() - started >= (primary.enabledAfterMs ?? 0) ? main : null;
        }
        if (selector === "[data-result]") return resultShown ? { innerText: "done" } : null;
        return null;
      },
    };
    const page: Record<string, unknown> = {
      __museNative: {
        checkpoint: async (entry: { step: string; ok: boolean }) => {
          marks.push(entry);
        },
      },
      MuseNative: { glasses: { status: async () => ({ state: "ready", mode: "mock" }) } },
    };
    new Function("window", "document", buildAutopilotScript(4_000, 50))(page, document);
    while (!marks.some((mark) => mark.step === "result" || mark.step === "timeout" || mark.step === "error")) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return { clicks, marks };
  }

  it("taps twice for the template's button, once it's enabled", async () => {
    const { clicks, marks } = await runAutopilot({ pressed: true, enabledAfterMs: 300 });
    assert.equal(clicks.length, 2);
    assert.ok(clicks[0] >= 300, "the first tap waits for the button to be enabled");
    assert.ok(clicks[1] - clicks[0] >= 50, "the second tap comes after the listening time");
    assert.deepEqual(marks.map((mark) => mark.step), ["start", "connect", "primary", "result"]);
    assert.ok(marks.every((mark) => mark.ok));
  });

  it("taps once for a button that doesn't stay pressed", async () => {
    const { clicks, marks } = await runAutopilot({ pressed: false });
    assert.equal(clicks.length, 1);
    assert.equal(marks.at(-1)?.step, "result");
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

  it("keeps the microphone on Android and gives iOS the shell's own words", () => {
    for (const env of [{}, { APP_VARIANT: "lab" }, { APP_VARIANT: "lab", MUSE_GLASSES: "1" }]) {
      const config = buildConfig(env);
      assert.ok(config.android.permissions.includes("android.permission.RECORD_AUDIO"));
      assert.ok(config.android.permissions.includes("android.permission.MODIFY_AUDIO_SETTINGS"));
      const text = "Products you open can hear a question you ask.";
      for (const name of ["expo-audio", "expo-image-picker"]) {
        const plugin = config.plugins.find((entry) => Array.isArray(entry) && entry[0] === name);
        assert.ok(Array.isArray(plugin), name);
        // false here would make expo-image-picker strip RECORD_AUDIO from the Android manifest.
        assert.equal(plugin[1].microphonePermission, text, name);
      }
    }
  });

  it("allows cleartext only in the lab, which opens http on the machine itself", () => {
    const cleartext = (env: Record<string, string>) =>
      buildConfig(env).plugins.find((entry) => Array.isArray(entry) && entry[0] === "expo-build-properties");
    assert.deepEqual((cleartext({ APP_VARIANT: "lab" }) as [string, unknown])[1], { android: { usesCleartextTraffic: true } });
    assert.equal(cleartext({ APP_VARIANT: "production" }), undefined);
    assert.equal(cleartext({}), undefined);
  });

  it("turns updates off in a per-product app", () => {
    assert.equal(buildConfig({}).updates.enabled, true);
    assert.equal(buildConfig({ MUSE_PRODUCT_URL: "https://one.example" }).updates.enabled, false);
    assert.equal(buildConfig({ MUSE_PRODUCT_URL: "https://one.example" }).extra.productUrl, "https://one.example");
  });
});
