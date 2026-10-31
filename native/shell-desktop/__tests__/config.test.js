const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { join } = require("node:path");

const { ConfigError, configPath, isOpenableUrl, loadConfig, parseConfig, profileFolderFor } = require("../src/config");

const GOOD = { name: "Dinner Split", url: "https://dinner.vercel.app/start?x=1", shellVersion: "1.0.0" };
const PATHS = { isPackaged: true, resourcesPath: "/app/resources", appPath: "/app/resources/app.asar" };

describe("profileFolderFor", () => {
  it("gives each product its own stable folder, safe in a path", () => {
    const a = profileFolderFor("https://a.vercel.app");
    assert.match(a, /^[0-9a-f]{16}$/);
    assert.equal(profileFolderFor("https://a.vercel.app"), a);
    assert.notEqual(profileFolderFor("https://b.vercel.app"), a);
  });
});

describe("parseConfig", () => {
  it("returns the known fields and the origin", () => {
    assert.deepEqual(parseConfig({ ...GOOD, extra: "drop me" }), {
      name: "Dinner Split",
      url: "https://dinner.vercel.app/start?x=1",
      origin: "https://dinner.vercel.app",
      shellVersion: "1.0.0",
    });
  });

  it("allows http only on the machine itself", () => {
    assert.equal(parseConfig({ name: "A", url: "http://localhost:3000/" }).origin, "http://localhost:3000");
    assert.equal(parseConfig({ name: "A", url: "http://127.0.0.1:3000/" }).origin, "http://127.0.0.1:3000");
    assert.throws(() => parseConfig({ name: "A", url: "http://a.example/" }), ConfigError);
  });

  it("refuses unsafe links", () => {
    for (const url of ["file:///etc/passwd", "javascript:alert(1)", "ftp://a.example", "https://u:p@a.example/", "nope", "", 5, null]) {
      assert.throws(() => parseConfig({ name: "A", url }), ConfigError, String(url));
    }
  });

  it("needs a real name", () => {
    for (const name of ["", "   ", 5, null, "x".repeat(81)]) {
      assert.throws(() => parseConfig({ name, url: GOOD.url }), ConfigError);
    }
  });

  it("refuses shapes that aren't objects", () => {
    for (const raw of [null, [], "x", 5]) assert.throws(() => parseConfig(raw), ConfigError);
  });

  it("defaults and trims the shell version", () => {
    assert.equal(parseConfig({ name: "A", url: GOOD.url }).shellVersion, "0.0.0");
    assert.equal(parseConfig({ name: "A", url: GOOD.url, shellVersion: "9".repeat(99) }).shellVersion.length, 40);
    assert.equal(parseConfig({ name: "A", url: GOOD.url, shellVersion: 5 }).shellVersion, "0.0.0");
  });
});

describe("loadConfig", () => {
  it("reads from outside the asar when packaged", () => {
    assert.equal(configPath(PATHS), join("/app/resources", "muse-product.json"));
    assert.equal(configPath({ ...PATHS, isPackaged: false, appPath: "/src" }), join("/src", "resources", "muse-product.json"));
  });

  it("loads a good file", () => {
    let asked = "";
    const config = loadConfig(PATHS, (path) => {
      asked = path;
      return JSON.stringify(GOOD);
    });
    assert.equal(asked, join("/app/resources", "muse-product.json"));
    assert.equal(config.name, "Dinner Split");
  });

  it("says plainly when the file is missing, broken or huge", () => {
    const missing = () => {
      throw new Error("ENOENT /secret/path");
    };
    assert.throws(() => loadConfig(PATHS, missing), { name: "ConfigError", message: "The product settings are missing." });
    assert.throws(() => loadConfig(PATHS, () => "{"), { name: "ConfigError", message: "The product settings aren't valid." });
    assert.throws(() => loadConfig(PATHS, () => " ".repeat(17_000)), { name: "ConfigError", message: "The product settings are too large." });
  });
});

describe("isOpenableUrl", () => {
  it("doesn't throw on junk", () => {
    assert.equal(isOpenableUrl({}), false);
    assert.equal(isOpenableUrl(undefined), false);
    assert.equal(isOpenableUrl("https://a.example"), true);
  });
});

describe("the shipped config", () => {
  it("is valid", () => {
    const config = loadConfig({ isPackaged: false, appPath: join(__dirname, "..") });
    assert.equal(config.url, "https://muse-muse.vercel.app/");
  });
});
