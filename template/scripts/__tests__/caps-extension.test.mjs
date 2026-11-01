// The extension cap's overlay (docs/CAPABILITIES.md, section 20): the packer (scripts/extension-pack.mjs) compiles the
// starter extension with the product's TypeScript and refuses what the platform would refuse; the fixed checks
// (scripts/caps/extension.mjs); and, in a full Chromium, the test helpers (tests/caps/extension.ts) load the extension
// with Load unpacked's flags, open its popup, see it call the product's action, and the content security policy stop a
// call anywhere else. Extensions need Chromium's full headless mode, which Playwright's headless shell lacks: set
// MUSEMUSE_EXTENSION_CHROMIUM to a Chromium on a machine without Playwright's own. Run from the repo root:
//   npx tsx --test template/scripts/__tests__/caps-extension.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const TEMPLATE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CAPS = path.join(TEMPLATE, "caps");
const MODULES = path.join(TEMPLATE, "node_modules");
const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const hasModules = existsSync(path.join(MODULES, "typescript"));

/** A product folder with core and the extension overlay applied, the template's package.json and its node_modules. */
function product(files = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "mm-extension-"));
  dirs.push(dir);
  for (const o of ["core", "extension"]) cpSync(path.join(CAPS, o, "files"), dir, { recursive: true });
  cpSync(path.join(TEMPLATE, "package.json"), path.join(dir, "package.json"));
  writeFileSync(path.join(dir, "musemuse.caps.json"), `${JSON.stringify({ caps: ["extension"], overlays: ["core", "extension"] })}\n`);
  if (existsSync(MODULES)) symlinkSync(MODULES, path.join(dir, "node_modules"));
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    writeFileSync(path.join(dir, f), text);
  }
  return dir;
}

const pack = (dir, ...args) => spawnSync(process.execPath, [path.join(dir, "scripts/extension-pack.mjs"), ...args], { cwd: dir, encoding: "utf8" });
const manifest = (over) => JSON.stringify({ ...JSON.parse(readFileSync(path.join(CAPS, "extension/files/extension/manifest.json"), "utf8")), ...over });

describe("the packer", { skip: hasModules ? false : "needs template/node_modules (TypeScript)" }, () => {
  test("compiles and checks the starter extension, and builds the folder Chrome loads for an origin", () => {
    const dir = product();
    const checked = pack(dir, "check");
    assert.equal(checked.status, 0, checked.stderr);
    const out = path.join(dir, "built");
    const built = pack(dir, "build", "--origin", "http://localhost:3100", "--out", out);
    assert.equal(built.status, 0, built.stderr);
    for (const f of ["manifest.json", "config.js", "platform.js", "popup.js", "popup.html", "popup.css", "background.js"]) assert.ok(existsSync(path.join(out, f)), f);
    assert.ok(!existsSync(path.join(out, "config.d.ts")) && !existsSync(path.join(out, "platform.ts")), "only compiled files");
    const m = JSON.parse(readFileSync(path.join(out, "manifest.json"), "utf8"));
    assert.deepEqual(m.host_permissions, ["http://localhost:3100/*"]);
    assert.match(m.content_security_policy.extension_pages, /connect-src http:\/\/localhost:3100;/);
    assert.match(readFileSync(path.join(out, "config.js"), "utf8"), /PRODUCT_ORIGIN = "http:\/\/localhost:3100"/);
    assert.match(readFileSync(path.join(out, "popup.js"), "utf8"), /from "\.\/platform\.js"/);
    assert.notEqual(pack(dir, "build", "--origin", "http://evil.example", "--out", out).status, 0, "only https or a loopback address");
  });

  test("writes the bundle the platform packages from: compiled files and the product's own manifest, no config.js", () => {
    const dir = product();
    const file = path.join(dir, "bundle.json");
    const res = pack(dir, "bundle", "--out", file);
    assert.equal(res.status, 0, res.stderr);
    const bundle = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(bundle.musemuse_extension, 1);
    assert.deepEqual(bundle.files.map((f) => f.path), ["background.js", "manifest.json", "platform.js", "popup.css", "popup.html", "popup.js"]);
    assert.equal(JSON.parse(Buffer.from(bundle.files.find((f) => f.path === "manifest.json").base64, "base64").toString()).host_permissions, undefined);
  });

  test("refuses broad permissions, compile errors, JSX, the platform's own files, inline scripts and remote code, naming each", () => {
    const cases = [
      [{ "extension/manifest.json": manifest({ permissions: ["<all_urls>"] }) }, /"<all_urls>" asks for sites/],
      [{ "extension/manifest.json": manifest({ host_permissions: ["https://*/*"] }) }, /host_permissions is the platform's/],
      [{ "extension/manifest.json": manifest({ content_scripts: [{ matches: ["<all_urls>"], js: ["x.js"] }] }) }, /content_scripts runs code in every page/],
      [{ "extension/broken.ts": "const = ;\n" }, /extension\/broken\.ts:1 doesn't compile/],
      [{ "extension/view.tsx": "export const v = <div />;\n" }, /no JSX or React/],
      [{ "extension/config.ts": "export const PRODUCT_ORIGIN = 'https://evil.example';\n" }, /config\.ts is written by the platform/],
      [{ "extension/popup.html": "<html><body><script>alert(1)</script></body></html>" }, /inline script/],
      [{ "extension/popup.ts": 'fetch("https://elsewhere.example");\nexport {};\n' }, /popup\.js uses fetch\(\)/],
      [{ "extension/popup.ts": 'import { h } from "preact";\nconsole.log(h);\nexport {};\n' }, /imports "preact"/],
      [{ "extension/run.sh": "echo hi\n" }, /isn't a file an extension may ship/],
      // Names that land on the platform's files once unzipped on a Mac or Windows disk, which ignores capital letters.
      [{ "extension/Config.ts": "export const PRODUCT_ORIGIN = 'https://evil.example';\n" }, /extension\/Config\.js would replace the platform's config\.js/],
      [{ "extension/config.js/x.ts": "export {};\n" }, /extension\/config\.js\/x\.js is in a folder named like the file config\.js/],
      [{ "extension/_x.ts": "export {};\n" }, /extension\/_x\.ts isn't a file an extension may ship/],
      [{ "extension/popup.ts": "const shot = await chrome.tabs.captureVisibleTab();\nexport {};\n" }, /captureVisibleTab, which takes a picture of the page/],
    ];
    for (const [files, want] of cases) {
      const res = pack(product(files), "check");
      assert.notEqual(res.status, 0, JSON.stringify(files));
      assert.match(res.stderr, want, `${JSON.stringify(files)}\n${res.stderr}`);
    }
  });

  test("checks the manifest against the permissions brief.md lists", () => {
    const brief = "# Page Notes\n\n## Platform services\n\n### Browser extension\n\nThe brief asks for a browser extension beside the web product: x\n\n- Permissions: `activeTab`. Ask for exactly these.\n";
    const narrow = pack(product({ "brief.md": brief, "extension/manifest.json": manifest({ permissions: ["activeTab", "storage"] }) }), "check");
    assert.notEqual(narrow.status, 0);
    assert.match(narrow.stderr, /asks for storage, which brief\.md doesn't list/);
    assert.equal(pack(product({ "brief.md": brief }), "check").status, 0);
  });
});

describe("the extension checker (scripts/caps/extension.mjs)", { skip: hasModules ? false : "needs template/node_modules (TypeScript)" }, async () => {
  const { check } = await import(pathToFileURL(path.join(CAPS, "extension/files/scripts/caps/extension.mjs")).href);

  test("fails the manifest and skips loading for a broad permission, and fails action without the smoke test's record", async () => {
    const checks = await check({ record: null, root: product({ "extension/manifest.json": manifest({ permissions: ["tabs"] }) }) });
    const byId = Object.fromEntries(checks.map((c) => [c.id, c]));
    assert.deepEqual(Object.keys(byId), ["manifest", "loaded", "popup", "action"]);
    assert.equal(byId.manifest.ok, false);
    assert.match(byId.manifest.detail, /the "tabs" permission isn't allowed/);
    assert.equal(byId.loaded.ok, false);
    assert.match(byId.loaded.detail, /manifest check failed/);
    assert.equal(byId.action.ok, false);
    assert.match(byId.action.detail, /expectExtensionAction/);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// In a full Chromium

const playwright = hasModules ? await import("@playwright/test").catch(() => null) : null;
let chromiumProblem = playwright ? null : "template/node_modules isn't installed";
if (playwright && !chromiumProblem) {
  // Extensions load only in full Chromium: Playwright's own (channel "chromium"), or MUSEMUSE_EXTENSION_CHROMIUM.
  const exe = process.env.MUSEMUSE_EXTENSION_CHROMIUM;
  const probe = await playwright.chromium
    .launch({ headless: true, ...(exe ? { executablePath: exe } : { channel: "chromium" }) })
    .then((b) => b.close().then(() => null))
    .catch((err) => `no full Chromium to load an extension in (${String(err?.message ?? err).split("\n")[0].slice(0, 120)}). Set MUSEMUSE_EXTENSION_CHROMIUM`);
  chromiumProblem = probe;
}

describe("the extension in Chromium", { skip: chromiumProblem ?? false }, () => {
  let dir;
  let server;
  let other;
  let baseURL;
  const hits = [];
  const startDir = process.cwd();

  before(async () => {
    dir = product({
      "extension/popup.ts": [
        'import { currentPage, productAction, ProductError } from "./platform.js";',
        'const app = document.getElementById("app") as HTMLElement;',
        "const page = await currentPage().catch(() => null);",
        'const title = document.createElement("p");',
        'title.textContent = page ? page.title : "Open a page first.";',
        'const button = document.createElement("button");',
        'button.textContent = "Save this page";',
        'const out = document.createElement("p");',
        'button.addEventListener("click", async () => {',
        "  try {",
        '    const reply = await productAction<{ saved: string }>("save_note", { url: page?.url, title: page?.title });',
        '    out.textContent = `Saved: ${reply.saved}`;',
        "  } catch (err) {",
        '    out.textContent = err instanceof ProductError ? err.message : "Something went wrong.";',
        "  }",
        "});",
        "app.append(title, button, out);",
      ].join("\n"),
    });
    const listen = (srv) => new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve(srv.address().port)));
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        hits.push({ method: req.method, url: req.url, client: req.headers["x-musemuse-client"] ?? null, body });
        if (req.url === "/") {
          res.setHeader("content-type", "text/html");
          res.end("<title>A page worth saving</title><h1>Hello</h1>");
          return;
        }
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ saved: JSON.parse(body || "{}").title ?? "nothing" }));
      });
    });
    baseURL = `http://127.0.0.1:${await listen(server)}`;
    other = http.createServer((req, res) => {
      hits.push({ method: req.method, url: `other:${req.url}` });
      res.end("{}");
    });
    await listen(other);
    process.chdir(dir);
  });

  after(async () => {
    process.chdir(startDir);
    server?.close();
    other?.close();
  });

  test("loads with Load unpacked's flags, opens the popup, and the popup calls the product's action", async () => {
    const E = await import(pathToFileURL(path.join(dir, "tests/caps/extension.ts")).href);
    const ext = await E.openExtension(baseURL);
    try {
      assert.match(ext.id, /^[a-p]{32}$/);
      const tab = await ext.context.newPage();
      await tab.goto(`${baseURL}/`);
      const popup = await E.openPopup(ext);
      assert.match(await popup.locator("#app").innerText(), /A page worth saving/);
      const reply = await E.expectExtensionAction(popup, "save_note", () => popup.getByRole("button", { name: "Save this page" }).click());
      assert.deepEqual(reply, { saved: "A page worth saving" });
      await popup.getByText("Saved: A page worth saving").waitFor();
      const action = hits.find((h) => h.url === "/api/actions/save_note");
      assert.equal(action.client, "extension");
      assert.deepEqual(JSON.parse(action.body), { url: `${baseURL}/`, title: "A page worth saving" });

      // The policy the platform writes: the popup can't reach any other address.
      const otherPort = other.address().port;
      const blocked = await popup.evaluate((port) => fetch(`http://127.0.0.1:${port}/x`).then(() => "reached", () => "blocked"), otherPort);
      assert.equal(blocked, "blocked");
      // Nor carry page data out in an image, a style or a font, which a fetch-only policy would let through.
      await popup.evaluate(async (port) => {
        const other = `http://127.0.0.1:${port}`;
        await new Promise((resolve) => {
          const img = new Image();
          img.onload = img.onerror = resolve;
          img.src = `${other}/img?u=${encodeURIComponent(location.href)}`;
        });
        const div = document.createElement("div");
        div.style.backgroundImage = `url(${other}/style)`;
        document.body.append(div);
        void getComputedStyle(div).backgroundImage;
        await new FontFace("Beacon", `url(${other}/font)`).load().catch(() => undefined);
      }, otherPort);
      await popup.waitForTimeout(500);
      assert.ok(!hits.some((h) => String(h.url).startsWith("other:")), `nothing reached the other address: ${JSON.stringify(hits.filter((h) => String(h.url).startsWith("other:")))}`);
    } finally {
      await ext.close();
    }
    const record = JSON.parse(readFileSync(path.join(dir, "test-results/caps/extension.json"), "utf8"));
    assert.deepEqual(record.checks.map((c) => [c.id, c.ok]), [["loaded", true], ["popup", true], ["action", true]]);
  });

  test("the checker loads it and opens the popup itself, with no product server behind it", async () => {
    const { check } = await import(pathToFileURL(path.join(dir, "scripts/caps/extension.mjs")).href);
    const record = JSON.parse(readFileSync(path.join(dir, "test-results/caps/extension.json"), "utf8"));
    const checks = await check({ record, root: dir });
    assert.deepEqual(checks.map((c) => [c.id, c.ok]), [["manifest", true], ["loaded", true], ["popup", true], ["action", true]]);
  });

  test("the checker fails a popup that throws when it opens", async () => {
    const broken = product({ "extension/popup.ts": 'throw new Error("boom");\nexport {};\n' });
    const { check } = await import(pathToFileURL(path.join(broken, "scripts/caps/extension.mjs")).href);
    const checks = Object.fromEntries((await check({ record: null, root: broken })).map((c) => [c.id, c]));
    assert.equal(checks.loaded.ok, true);
    assert.equal(checks.popup.ok, false);
    assert.match(checks.popup.detail, /popup\.html threw: boom/);
  });
});
