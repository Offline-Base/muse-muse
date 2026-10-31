const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const {
  allowDownload,
  allowPermission,
  canOpenExternally,
  createBridge,
  createPermissionGate,
  createRateLimiter,
  decideNavigation,
  decideRedirect,
  failurePage,
  originOf,
  permissionQuestion,
  promptKinds,
} = require("../src/policy");
const { buildReport, selftestDirFrom } = require("../src/selftest");

const ORIGIN = "https://demo.vercel.app";
const MAIN = { isMainFrame: true, url: `${ORIGIN}/a` };

describe("decideNavigation", () => {
  it("stays on the product's origin", () => {
    assert.equal(decideNavigation(`${ORIGIN}/x?y=1`, ORIGIN), "allow");
  });

  it("sends other sites to the system browser", () => {
    for (const url of ["https://evil.example/", "http://demo.vercel.app/", "https://demo.vercel.app.evil.example/", "mailto:a@b.example"]) {
      assert.equal(decideNavigation(url, ORIGIN), "external", url);
    }
  });

  it("refuses files and app schemes", () => {
    for (const url of ["file:///etc/passwd", "javascript:alert(1)", "smb://a/b", "nonsense"]) {
      assert.equal(decideNavigation(url, ORIGIN), "block", url);
    }
  });
});

describe("decideRedirect", () => {
  it("pins the page itself, as a navigation does", () => {
    assert.equal(decideRedirect(`${ORIGIN}/x`, true, ORIGIN), "allow");
    assert.equal(decideRedirect("https://evil.example/", true, ORIGIN), "external");
    assert.equal(decideRedirect("file:///etc/passwd", true, ORIGIN), "block");
  });

  it("leaves an inner frame's redirect alone, so embeds keep working and open no tabs", () => {
    assert.equal(decideRedirect("https://maps.example/final", false, ORIGIN), "allow");
  });
});

describe("createRateLimiter", () => {
  it("allows a few, then drops the rest until the window passes", () => {
    let clock = 1_000;
    const allow = createRateLimiter(undefined, () => clock);
    assert.deepEqual([allow(), allow(), allow(), allow()], [true, true, true, false]);
    clock += 9_999;
    assert.equal(allow(), false);
    clock += 2;
    assert.equal(allow(), true);
  });
});

describe("allowDownload", () => {
  it("lets only the product's own page save a file", () => {
    assert.equal(allowDownload(`${ORIGIN}/report`, ORIGIN), true);
    assert.equal(allowDownload("https://evil.example/", ORIGIN), false);
    assert.equal(allowDownload("data:text/html,x", ORIGIN), false);
    assert.equal(allowDownload(undefined, ORIGIN), false);
  });
});

describe("failurePage", () => {
  it("says what happened, runs nothing, and escapes its link", () => {
    const html = decodeURIComponent(failurePage(`${ORIGIN}/?a="><script>x</script>`).split(",").slice(1).join(","));
    assert.match(html, /This didn't open/);
    assert.match(html, /default-src 'none'/);
    assert.doesNotMatch(html, /<script/);
    assert.ok(failurePage(ORIGIN).startsWith("data:text/html"));
  });
});

describe("canOpenExternally", () => {
  it("only hands safe schemes to the system", () => {
    assert.equal(canOpenExternally("https://a.example"), true);
    for (const url of ["file:///x", "smb://x", "javascript:alert(1)", "x"]) assert.equal(canOpenExternally(url), false);
  });
});

describe("allowPermission", () => {
  it("grants listed permissions to the product's origin only", () => {
    assert.equal(allowPermission("media", `${ORIGIN}/a`, ORIGIN), true);
    assert.equal(allowPermission("media", "https://evil.example/", ORIGIN), false);
    assert.equal(allowPermission("media", "", ORIGIN), false);
  });

  it("refuses anything not listed, even for the product", () => {
    for (const permission of ["openExternal", "midi", "midiSysex", "hid", "serial", "usb", "unknown"]) {
      assert.equal(allowPermission(permission, `${ORIGIN}/a`, ORIGIN), false, permission);
    }
  });
});

describe("promptKinds", () => {
  it("names what needs a yes, and nothing else does", () => {
    assert.deepEqual(promptKinds("media", ["audio"]), ["microphone"]);
    assert.deepEqual(promptKinds("media", ["video"]), ["camera"]);
    assert.deepEqual(promptKinds("media", ["audio", "video"]), ["camera", "microphone"]);
    assert.deepEqual(promptKinds("media", []), ["camera", "microphone"]);
    assert.deepEqual(promptKinds("media", undefined), ["camera", "microphone"]);
    assert.deepEqual(promptKinds("geolocation"), ["location"]);
    assert.deepEqual(promptKinds("notifications"), []);
  });

  it("asks in plain words", () => {
    assert.equal(permissionQuestion("Demo", ["microphone"]), "Demo wants to use your microphone.");
    assert.equal(permissionQuestion("Demo", ["camera", "microphone"]), "Demo wants to use your camera and microphone.");
    assert.equal(permissionQuestion("Demo", ["location"]), "Demo wants to use your location.");
  });
});

describe("createPermissionGate", () => {
  const URL = `${ORIGIN}/a`;
  function harness(answer = true) {
    const asked = [];
    const gate = createPermissionGate({
      productOrigin: ORIGIN,
      ask: async (kinds) => {
        asked.push(kinds);
        return answer;
      },
    });
    return { gate, asked };
  }

  it("asks before the microphone, and remembers a yes", async () => {
    const { gate, asked } = harness(true);
    assert.equal(gate.check("media", URL, "audio"), false);
    assert.equal(await gate.request("media", URL, ["audio"]), true);
    assert.equal(await gate.request("media", URL, ["audio"]), true);
    assert.deepEqual(asked, [["microphone"]]);
    assert.equal(gate.check("media", URL, "audio"), true);
    assert.equal(gate.check("media", URL, "video"), false);
  });

  it("remembers a no, so a page can't keep asking", async () => {
    const { gate, asked } = harness(false);
    assert.equal(await gate.request("media", URL, ["audio"]), false);
    assert.equal(await gate.request("media", URL, ["audio"]), false);
    assert.equal(await gate.request("media", URL, ["audio", "video"]), false);
    assert.equal(asked.length, 1);
    assert.equal(gate.check("media", URL, "audio"), false);
  });

  it("shows one question for requests that arrive together", async () => {
    const { gate, asked } = harness(true);
    const answers = await Promise.all([1, 2, 3, 4].map(() => gate.request("geolocation", URL)));
    assert.deepEqual(answers, [true, true, true, true]);
    assert.equal(asked.length, 1);
  });

  it("never asks for another origin or an unlisted permission", async () => {
    const { gate, asked } = harness(true);
    assert.equal(await gate.request("media", "https://evil.example/", ["audio"]), false);
    assert.equal(await gate.request("midi", URL), false);
    assert.equal(gate.check("media", "https://evil.example/", "audio"), false);
    assert.equal(asked.length, 0);
  });

  it("lets through what needs no question", async () => {
    const { gate, asked } = harness(false);
    assert.equal(gate.check("fullscreen", URL), true);
    assert.equal(await gate.request("notifications", URL), true);
    assert.equal(asked.length, 0);
  });

  it("says no if the question itself fails, and can still ask later", async () => {
    let fails = true;
    const gate = createPermissionGate({
      productOrigin: ORIGIN,
      ask: async () => {
        if (fails) throw new Error("no window");
        return true;
      },
    });
    await assert.rejects(gate.request("geolocation", URL));
    fails = false;
    assert.equal(await gate.request("geolocation", URL), true);
  });
});

describe("originOf", () => {
  it("only gives web origins", () => {
    assert.equal(originOf("https://a.example:8/x"), "https://a.example:8");
    assert.equal(originOf("file:///x"), null);
    assert.equal(originOf("x"), null);
  });
});

describe("createBridge", () => {
  const HELLO = { version: 1, platform: "mac" };
  function harness(extra = {}) {
    const shown = [];
    const handle = createBridge({ productOrigin: ORIGIN, hello: HELLO, showNotification: (n) => shown.push(n), ...extra });
    return { handle, shown };
  }

  it("answers hello", () => {
    assert.deepEqual(harness().handle(MAIN, { method: "hello" }), { ok: true, result: HELLO });
  });

  it("answers nothing for another origin or an inner frame", () => {
    const { handle, shown } = harness();
    for (const sender of [
      { isMainFrame: true, url: "https://evil.example/" },
      { isMainFrame: false, url: `${ORIGIN}/frame` },
      { isMainFrame: true, url: "about:blank" },
    ]) {
      assert.equal(handle(sender, { method: "notify", params: { title: "x" } }), null);
    }
    assert.equal(shown.length, 0);
  });

  it("says unsupported for what a desktop can't do", () => {
    const { handle } = harness();
    for (const method of ["haptic", "share", "takePhoto", "glasses.connect", "constructor", undefined]) {
      assert.equal(handle(MAIN, { method }).error.code, "unsupported");
    }
    assert.equal(handle(MAIN, null).error.code, "unsupported");
  });

  it("checks a notification, then shows it", () => {
    const { handle, shown } = harness();
    assert.deepEqual(handle(MAIN, { method: "notify", params: { title: "Hi", body: "There" } }), { ok: true, result: null });
    assert.deepEqual(shown, [{ title: "Hi", body: "There" }]);
    for (const params of [undefined, {}, { title: "" }, { title: "x".repeat(121) }, { title: "a", body: 5 }, { title: "a", body: "x".repeat(501) }]) {
      assert.equal(handle(MAIN, { method: "notify", params }).error.code, "bad_request");
    }
  });

  it("holds a delayed notification until its time, and says it was scheduled", () => {
    const timers = [];
    const { handle, shown } = harness({ setTimer: (run, ms) => (timers.push({ run, ms }), timers.length) });
    assert.deepEqual(handle(MAIN, { method: "notify", params: { title: "Stretch", delaySeconds: 1800 } }), { ok: true, result: null });
    assert.equal(shown.length, 0);
    assert.equal(timers[0].ms, 1_800_000);
    timers[0].run();
    assert.deepEqual(shown, [{ title: "Stretch", body: "" }]);
  });

  it("checks the delay the way the phone shell does", () => {
    const { handle, shown } = harness();
    for (const delaySeconds of [-1, 86_401, "5", Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.equal(handle(MAIN, { method: "notify", params: { title: "x", delaySeconds } }).error.code, "bad_request");
    }
    assert.equal(shown.length, 0);
    assert.equal(handle(MAIN, { method: "notify", params: { title: "x", delaySeconds: 0 } }).ok, true);
    assert.equal(shown.length, 1);
  });

  it("drops waiting notifications when the app quits", () => {
    const cleared = [];
    const { handle, shown } = harness({ setTimer: () => "timer", clearTimer: (timer) => cleared.push(timer) });
    handle(MAIN, { method: "notify", params: { title: "x", delaySeconds: 5 } });
    handle.dispose();
    assert.deepEqual(cleared, ["timer"]);
    assert.equal(shown.length, 0);
  });

  it("caps how many can wait", () => {
    let clock = 0;
    let next = 0;
    const { handle } = harness({ now: () => clock, setTimer: () => (next += 1) });
    const notify = { method: "notify", params: { title: "x", delaySeconds: 60 } };
    for (let i = 0; i < 64; i += 1) {
      clock += 60_001;
      assert.equal(handle(MAIN, notify).ok, true);
    }
    clock += 60_001;
    assert.equal(handle(MAIN, notify).error.code, "rate_limited");
  });

  it("says unsupported when this system can't show notifications", () => {
    const { handle, shown } = harness({ notificationsSupported: false });
    assert.equal(handle(MAIN, { method: "notify", params: { title: "x" } }).error.code, "unsupported");
    assert.equal(handle(MAIN, { method: "hello" }).ok, true);
    assert.equal(shown.length, 0);
  });

  it("rate limits notifications within the window", () => {
    let clock = 1_000;
    const { handle, shown } = harness({ now: () => clock });
    const notify = { method: "notify", params: { title: "Hi" } };
    for (let i = 0; i < 6; i += 1) assert.equal(handle(MAIN, notify).ok, true);
    assert.equal(handle(MAIN, notify).error.code, "rate_limited");
    assert.equal(shown.length, 6);
    clock += 60_001;
    assert.equal(handle(MAIN, notify).ok, true);
  });
});

describe("selftest", () => {
  const seen = {
    finalUrl: `${ORIGIN}/`,
    httpStatus: 200,
    loadMs: 400,
    crashed: false,
    loadError: null,
    textLength: 300,
    handshake: true,
    consoleErrors: [],
  };

  it("reads the directory flag", () => {
    assert.equal(selftestDirFrom(["app", "--muse-selftest=/tmp/x"]), "/tmp/x");
    assert.equal(selftestDirFrom(["app"]), null);
    assert.equal(selftestDirFrom(["app", "--muse-selftest="]), null);
  });

  it("passes a healthy load, and only warns on console errors", () => {
    const report = buildReport({ ...seen, consoleErrors: ["x"] }, ORIGIN, new Date(0));
    assert.equal(report.ok, true);
    assert.deepEqual(report.warnings, ["x"]);
  });

  it("fails each thing the plan names", () => {
    const cases = [
      [{ crashed: true }, /crashed/],
      [{ loadError: "offline" }, /didn't load/],
      [{ httpStatus: 404 }, /answered 404/],
      [{ finalUrl: "https://evil.example/" }, /another site/],
      [{ textLength: 0 }, /blank/],
      [{ handshake: false }, /talk to each other/],
    ];
    for (const [change, problem] of cases) {
      const report = buildReport({ ...seen, ...change }, ORIGIN, new Date(0));
      assert.equal(report.ok, false);
      assert.match(report.problems.join(" "), problem);
    }
  });
});
