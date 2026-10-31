// Launches real Electron windows, so it isn't part of `npm test`. Run it with `npm run test:two-products` on a machine
// with a display. Every packaged product has the same productName, so this proves that two of them can run together
// while a second launch of one product still gives way to the first.

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { createServer } = require("node:http");
const { homedir, tmpdir } = require("node:os");
const { join } = require("node:path");

const electron = require("electron");

const { profileFolderFor } = require("../src/config");

const SETTLE_MS = 4_000;
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const root = mkdtempSync(join(tmpdir(), "muse-two-products-"));

function template(name, url) {
  const dir = join(root, name);
  cpSync(join(__dirname, "..", "src"), join(dir, "src"), { recursive: true });
  cpSync(join(__dirname, "..", "package.json"), join(dir, "package.json"));
  mkdirSync(join(dir, "resources"));
  writeFileSync(join(dir, "resources", "muse-product.json"), JSON.stringify({ name, url, shellVersion: "1.0.0" }));
  return dir;
}

function launch(dir) {
  // A parent run from an Electron-based tool can leave this set, and it would turn the app into plain Node.
  const { ELECTRON_RUN_AS_NODE: _ignored, ...env } = process.env;
  const child = spawn(electron, [dir], { stdio: "ignore", env });
  const state = { child, exitCode: undefined };
  state.exited = new Promise((done) => {
    child.on("exit", (code) => {
      state.exitCode = code;
      done();
    });
  });
  return state;
}

function listen() {
  return new Promise((done) => {
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "text/html");
      response.end("<title>Product</title><p>A product for the two products check.</p>");
    });
    server.listen(0, "127.0.0.1", () => done({ server, url: `http://127.0.0.1:${server.address().port}/` }));
  });
}

(async () => {
  const [a, b] = await Promise.all([listen(), listen()]);
  const first = launch(template("Product A", a.url));
  await delay(SETTLE_MS);
  const other = launch(template("Product B", b.url));
  await delay(SETTLE_MS);
  const again = launch(template("Product A again", a.url));
  await delay(SETTLE_MS);

  try {
    assert.equal(first.exitCode, undefined, "Product A should still be running");
    assert.equal(other.exitCode, undefined, "Product B should run next to Product A");
    assert.notEqual(again.exitCode, undefined, "A second launch of Product A should give way to the first");
    console.log("Pass: two products ran together, and a second launch of one gave way.");
  } finally {
    const running = [first, other, again];
    for (const { child } of running) child.kill();
    // Gone first, or an app still shutting down would write its profile folder back.
    await Promise.all(running.map(({ exited }) => exited));
    a.server.close();
    b.server.close();
    rmSync(root, { recursive: true, force: true });
    const profiles = join(homedir(), "Library", "Application Support", "Muse Muse");
    for (const { url } of [a, b]) rmSync(join(profiles, profileFolderFor(new URL(url).origin)), { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
