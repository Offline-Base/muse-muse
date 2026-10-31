const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const { allowPermission, canOpenExternally, createBridge, decideNavigation, originOf } = require("../src/policy");
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
