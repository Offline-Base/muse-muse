/**
 * The extension cap (docs/CAPABILITIES.md, section 20): its brief block, the writer's rules and catalog, the build
 * prompt's section, the platform's manifest rules (the generator refuses broad permissions), the file scan, packaging
 * for the live link, the ship step, the download route and the Get it tab. The overlay's packer runs the same rules in
 * the build: a parity test here keeps the two in step.
 *   npx tsx --test lib/caps/extension/__tests__/extension.test.ts
 */
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { extensionLink, extensionSlots } from "@/components/product/ExtensionPanel";
import { judgeInstructions } from "@/lib/prompts/judge";
import { briefToMarkdown, renderBuildPrompt, renderRefinePrompt } from "@/lib/brief/render";
import { normalizeRawBrief } from "@/lib/brief/normalize";
import { BriefSchema, newBriefSchemaFor, NewBriefSchemaNoGadget, type Brief } from "@/lib/brief/schema";
import { strictJsonSchema } from "@/lib/brief/strict-schema";
import { briefCaps, capsWriterRules } from "@/lib/caps/brief-fields";
import { capsCatalogBlocks, howProductsRun } from "@/lib/caps/catalog";
import { capBuildEnv, capDeployEnv } from "@/lib/caps/env";
import { EXTENSION_PERMISSIONS, ExtensionBriefBlock, normalizeExtensionBlock, type ExtensionBrief } from "@/lib/caps/extension/brief";
import { answerExtensionDownload, type ExtensionDownloadDeps } from "@/lib/caps/extension/download";
import { checkProductManifest, extensionCsp, extensionOrigin, finalManifest, isExtensionPath, MANIFEST_KEYS } from "@/lib/caps/extension/manifest";
import { ExtensionPackError, packageExtension, type ExtensionBundle } from "@/lib/caps/extension/package";
import { extensionFileName, extensionZipPath } from "@/lib/caps/extension/paths";
import { pathClashes, scanExtensionFiles } from "@/lib/caps/extension/scan";
import { BUNDLE_FILE, PACKER, shipExtension, type ExtensionShipDeps } from "@/lib/caps/extension/ship";
import { capBuildHosts } from "@/lib/caps/hosts";
import { capsJudgeNotes } from "@/lib/caps/judge";
import { capsLivePaths } from "@/lib/caps/live";
import { capsFileFor, overlaysFor } from "@/lib/caps/overlays";
import { capsBuildLines, capsMarkdown, capsRefineLines } from "@/lib/caps/render";
import { answerDownload } from "@/lib/native/downloads";
import { readZip } from "@/lib/outputs/zip";
import { allowedModelsFor } from "@/lib/pipeline/logic";
import { BRIEF } from "@/lib/promote/__tests__/fixtures";
import { CAPS_DIR, PRODUCT_DIR } from "@/lib/sandbox/paths";

const EXT: ExtensionBrief = { does: "Saves the page you're reading as a note, with a one-line summary.", permissions: ["activeTab", "storage"] };
const WITH: Brief = { ...BRIEF, extension: EXT } as Brief;
const render = { inspoFiles: [], fixtures: [], maxModelSteps: 40 };
const ORIGIN = "https://page-notes.vercel.app";

/** The overlay's packer, for the parity checks and the rendered brief's permissions line. */
const PACKER_FILE = path.join(import.meta.dirname, "../../../../template/caps/extension/files/scripts/extension-pack.mjs");
const PACK = await import(pathToFileURL(PACKER_FILE).href);

const MANIFEST = {
  manifest_version: 3,
  name: "Page Notes",
  description: "Save the page you're on as a note.",
  version: "1.0.0",
  action: { default_popup: "popup.html", default_title: "Save this page" },
  background: { service_worker: "background.js", type: "module" },
  permissions: ["activeTab", "storage"],
};
const FILES: Record<string, string> = {
  "manifest.json": JSON.stringify(MANIFEST),
  "popup.html": '<!doctype html><html><head><link rel="stylesheet" href="./popup.css"></head><body><main id="app"></main><script type="module" src="./popup.js"></script></body></html>',
  "popup.css": "body { margin: 0 }",
  "popup.js": 'import { productAction } from "./platform.js";\nconst app = document.getElementById("app");\n',
  "background.js": "chrome.runtime.onInstalled.addListener(() => {});\nexport {};\n",
  "platform.js": 'import { PRODUCT_ORIGIN } from "./config.js";\nexport async function productAction(name, input) { return (await fetch(`${PRODUCT_ORIGIN}/api/actions/${name}`, { method: "POST", body: JSON.stringify(input) })).json(); }\n',
};
const bundleOf = (files: Record<string, string>): ExtensionBundle => ({ musemuse_extension: 1, files: Object.entries(files).map(([p, c]) => ({ path: p, base64: Buffer.from(c).toString("base64") })) });
const asMap = (files: Record<string, string>) => new Map(Object.entries(files).map(([p, c]) => [p, Buffer.from(c)]));

describe("the extension brief block", () => {
  it("is an optional field of the stored brief, and in the writer's schema only when the cap is on", () => {
    assert.deepEqual(BriefSchema.parse(WITH).extension, EXT);
    assert.equal(BriefSchema.parse(BRIEF).extension, undefined);
    assert.equal(newBriefSchemaFor({ gadgets: false, targets: [], caps: [] }), NewBriefSchemaNoGadget);
    const on = newBriefSchemaFor({ gadgets: false, targets: [], caps: ["extension"] });
    assert.equal(on.safeParse(BRIEF).success, false, "required, as null, when the cap is on");
    assert.equal(on.safeParse({ ...BRIEF, extension: null }).success, true);
    assert.equal(on.safeParse(WITH).success, true);
    assert.ok((strictJsonSchema(on) as { required: string[] }).required.includes("extension"));
  });

  it("takes only the four permissions, each at most once in the schema's eyes", () => {
    assert.deepEqual([...EXTENSION_PERMISSIONS], ["activeTab", "storage", "contextMenus", "sidePanel"]);
    for (const bad of ["tabs", "scripting", "<all_urls>", "https://*/*", "cookies", "history"]) {
      assert.equal(ExtensionBriefBlock.safeParse({ ...EXT, permissions: [bad] }).success, false, bad);
    }
    assert.equal(ExtensionBriefBlock.safeParse({ ...EXT, does: "" }).success, false);
  });

  it("is cleaned before zod: Chrome's spelling, each once in manifest order, broad ones dropped, null with nothing it does", () => {
    const out = normalizeExtensionBlock({ does: "  Saves pages  ", permissions: ["Storage", "active-tab", "<all_urls>", "tabs", "context menus", "storage"] }) as ExtensionBrief;
    assert.deepEqual(out, { does: "Saves pages", permissions: ["activeTab", "storage", "contextMenus"] });
    assert.equal(normalizeExtensionBlock({ does: "   ", permissions: [] }), null);
    const brief = normalizeRawBrief({ ...BRIEF, extension: { does: "x".repeat(400), permissions: ["sidepanel"] } }, []) as { extension: ExtensionBrief };
    assert.ok(brief.extension.does.length <= 300);
    assert.deepEqual(brief.extension.permissions, ["sidePanel"]);
    assert.ok(ExtensionBriefBlock.safeParse(brief.extension).success);
  });
});

describe("the writer's rules, catalog and judge note", () => {
  it("say when to pick an extension and what it can't do, only when the cap is on, with no em dashes", () => {
    const rules = capsWriterRules(["extension"]);
    assert.match(rules, /^\n\nPlatform services\n- extension: fill it only when/);
    assert.match(rules, /never gets access to every site/);
    assert.match(rules, /Load unpacked/);
    assert.match(capsCatalogBlocks(["extension"]).join("\n"), /extension \(browser extension\)/);
    assert.match(howProductsRun(["extension"], { gadgets: false })!.first, /add a browser extension, only when the brief picks them/);
    assert.equal(capsJudgeNotes(BRIEF), "");
    assert.match(capsJudgeNotes(WITH), /opened in a test browser as a page at popup size/);
    assert.match(judgeInstructions(WITH), /opened in a test browser as a page at popup size/);
    for (const text of [rules, capsCatalogBlocks(["extension"]).join("\n"), capsJudgeNotes(WITH)]) assert.ok(!text.includes("—"));
  });
});

describe("the build prompt", () => {
  it("has a Browser extension section naming the skill, the helper, the policy, the test and the AGENTS.md line", () => {
    const lines = capsBuildLines(WITH).join("\n");
    assert.match(lines, /^\n## Platform services\n\n### Browser extension\n\nThe brief asks for a browser extension beside the web product: Saves the page/);
    for (const want of [
      "- Permissions: `activeTab`, `storage`.",
      ".agents/skills/muse-extension/SKILL.md",
      "productAction(name, input)",
      "allows only the product's own link",
      "node scripts/extension-pack.mjs check",
      "tests/extension.spec.ts",
      "openExtension(baseURL)",
      "`template/AGENTS.md` says server work goes in `app/api/`",
    ]) {
      assert.ok(lines.includes(want), want);
    }
    assert.ok(!lines.includes("—"));
    assert.ok(renderBuildPrompt(WITH, render).includes("### Browser extension"));
    assert.ok(!renderBuildPrompt(BRIEF, render).includes("extension"));
  });

  it("writes the permissions line the packer reads back from brief.md, including none", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mm-ext-brief-"));
    try {
      writeFileSync(path.join(dir, "brief.md"), renderBuildPrompt(WITH, render));
      assert.deepEqual(PACK.briefPermissions(dir), ["activeTab", "storage"]);
      writeFileSync(path.join(dir, "brief.md"), renderBuildPrompt({ ...WITH, extension: { ...EXT, permissions: [] } } as Brief, render));
      assert.deepEqual(PACK.briefPermissions(dir), []);
      writeFileSync(path.join(dir, "brief.md"), "# No extension here\n");
      assert.deepEqual(PACK.briefPermissions(dir), [...EXTENSION_PERMISSIONS], "a folder without the section allows all four");
      assert.deepEqual(PACK.briefPermissions(dir, { strict: true }), [], "a platform build without the line allows none");
      rmSync(path.join(dir, "brief.md"));
      assert.deepEqual(PACK.briefPermissions(dir, { strict: true }), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads a missing line as no permissions when the packer is the platform's copy in CAPS_DIR", async () => {
    const caps = mkdtempSync(path.join(tmpdir(), "mm-ext-capsdir-"));
    try {
      const scripts = path.join(caps, "extension", "files", "scripts");
      mkdirSync(scripts, { recursive: true });
      copyFileSync(PACKER_FILE, path.join(scripts, "extension-pack.mjs"));
      writeFileSync(path.join(caps, "active.json"), JSON.stringify({ caps: ["extension"], overlays: ["core", "extension"] }));
      const copy = await import(pathToFileURL(path.join(scripts, "extension-pack.mjs")).href);
      assert.equal(copy.inPlatformCapsDir(), true);
      assert.equal(PACK.inPlatformCapsDir(), false);
      const product = path.join(caps, "product");
      mkdirSync(product);
      writeFileSync(path.join(product, "brief.md"), "# The line was taken out\n");
      assert.deepEqual(copy.briefPermissions(product), []);
      writeFileSync(path.join(product, "brief.md"), renderBuildPrompt(WITH, render));
      assert.deepEqual(copy.briefPermissions(product), ["activeTab", "storage"]);
    } finally {
      rmSync(caps, { recursive: true, force: true });
    }
  });

  it("adds a refine line and the product page's markdown, and nothing for a brief without the block", () => {
    assert.match(capsRefineLines(WITH).join("\n"), /extension\//);
    assert.match(capsMarkdown(WITH).join("\n"), /\*\*Browser extension\*\*[\s\S]*Installs with Load unpacked/);
    assert.ok(renderRefinePrompt({ brief: WITH, message: "Add a dark mode.", newReferences: [] }).includes("extension-pack.mjs check"));
    assert.ok(briefToMarkdown(WITH).includes("Browser extension"));
    assert.deepEqual([capsBuildLines(BRIEF), capsRefineLines(BRIEF), capsMarkdown(BRIEF)], [[], [], []]);
  });
});

describe("the build sandbox", () => {
  it("gets core and the extension overlay, the cap marker, no build or deploy env, no extra hosts and no live path", () => {
    assert.deepEqual(briefCaps(WITH), ["extension"]);
    assert.deepEqual(overlaysFor(WITH), ["core", "extension"]);
    assert.deepEqual(capsFileFor(WITH), { caps: ["extension"], overlays: ["core", "extension"] });
    assert.equal(capBuildEnv(WITH), "");
    assert.deepEqual(capDeployEnv(WITH, "mm_live_x"), {});
    assert.deepEqual(capBuildHosts(["extension"]), []);
    assert.deepEqual(capsLivePaths(WITH), []);
    assert.ok(allowedModelsFor(WITH).includes("cap:extension"));
    assert.ok(!allowedModelsFor(BRIEF).includes("cap:extension"));
  });
});

describe("the manifest generator", () => {
  it("refuses broad permissions and host patterns by name, and every key it doesn't allow", () => {
    for (const broad of ["<all_urls>", "*://*/*", "https://*/*", "http://example.com/*", "file:///*", "tabs", "scripting", "webRequest", "cookies", "history", "debugger", "nativeMessaging"]) {
      const out = checkProductManifest({ ...MANIFEST, permissions: [broad] }, { allowed: EXTENSION_PERMISSIONS });
      assert.equal(out.manifest, null, broad);
      assert.ok(out.problems.some((p) => p.includes(broad.slice(0, 20))), `${broad}: ${out.problems.join(" | ")}`);
    }
    for (const key of ["host_permissions", "content_scripts", "content_security_policy", "externally_connectable", "web_accessible_resources", "optional_host_permissions", "key", "update_url", "oauth2", "sandbox", "options_page"]) {
      const out = checkProductManifest({ ...MANIFEST, [key]: ["x"] }, { allowed: EXTENSION_PERMISSIONS });
      assert.equal(out.manifest, null, key);
    }
    assert.ok(!(MANIFEST_KEYS as readonly string[]).includes("host_permissions"));
  });

  it("drops a known permission the brief doesn't list, and says so", () => {
    const out = checkProductManifest({ ...MANIFEST, permissions: ["activeTab", "storage", "contextMenus"] }, { allowed: ["activeTab", "storage"] });
    assert.deepEqual(out.dropped, ["contextMenus"]);
    assert.deepEqual(out.manifest?.permissions, ["activeTab", "storage"]);
  });

  it("needs Manifest V3, a module service worker, a popup or side panel, and a side panel to come with its permission", () => {
    const check = (m: object) => checkProductManifest(m, { allowed: EXTENSION_PERMISSIONS }).problems;
    assert.deepEqual(check(MANIFEST), []);
    assert.ok(check({ ...MANIFEST, manifest_version: 2 }).length);
    assert.ok(check({ ...MANIFEST, background: { service_worker: "background.js" } }).some((p) => p.includes('"module"')));
    assert.ok(check({ ...MANIFEST, background: { scripts: ["a.js"] } }).length);
    assert.ok(check({ ...MANIFEST, action: {} }).some((p) => p.includes("needs a popup")));
    assert.ok(check({ ...MANIFEST, side_panel: { default_path: "panel.html" } }).some((p) => p.includes("sidePanel permission")));
    assert.deepEqual(check({ ...MANIFEST, permissions: ["sidePanel"], side_panel: { default_path: "panel.html" } }), []);
    assert.ok(check({ ...MANIFEST, action: { default_popup: "../popup.html" } }).length, "no path outside the folder");
    assert.ok(check({ ...MANIFEST, version: "1.0.0.0.1" }).length);
    assert.ok(check({ ...MANIFEST, icons: { "64": "icon.png" } }).length);
  });

  it("writes the one host permission and a policy that allows only the product's link", () => {
    const fields = checkProductManifest(MANIFEST, { allowed: EXTENSION_PERMISSIONS }).manifest!;
    const out = finalManifest(fields, ORIGIN);
    assert.deepEqual(out.host_permissions, [`${ORIGIN}/*`]);
    assert.deepEqual(out.permissions, ["activeTab", "storage"]);
    assert.equal((out.content_security_policy as { extension_pages: string }).extension_pages, `default-src 'self'; script-src 'self'; object-src 'self'; img-src 'self' data: blob: ${ORIGIN}; connect-src ${ORIGIN}; frame-src 'none'; form-action 'none'; base-uri 'none'`);
    assert.equal(extensionCsp(ORIGIN), PACK.extensionCsp(ORIGIN));
  });

  it("takes only an https link, or a loopback one for the build's own test browser", () => {
    assert.equal(extensionOrigin("https://page-notes.vercel.app/some/path?x=1"), ORIGIN);
    assert.throws(() => extensionOrigin("http://page-notes.vercel.app"), /https/);
    assert.throws(() => extensionOrigin("http://localhost:3100"), /https/);
    assert.equal(extensionOrigin("http://localhost:3100", { allowLoopback: true }), "http://localhost:3100");
    assert.throws(() => extensionOrigin("https://a:b@x.vercel.app"), /name or password/);
    assert.throws(() => extensionOrigin("not a url"), /web address/);
  });
});

describe("the file scan", () => {
  it("passes a plain extension", () => {
    assert.deepEqual(scanExtensionFiles(asMap(FILES)), []);
  });

  it("refuses remote and inline code, network calls outside the helper, bare imports and pages from elsewhere", () => {
    const cases: Array<[Record<string, string>, RegExp]> = [
      [{ "popup.js": 'const s = await import("./more.js");' }, /import\(\)/],
      [{ "background.js": 'importScripts("x.js");' }, /importScripts/],
      [{ "popup.js": "eval('1+1');" }, /eval/],
      [{ "popup.js": "new Function('return 1')();" }, /new Function/],
      [{ "popup.js": 'fetch("https://elsewhere.example/steal");' }, /fetch\(\)/],
      [{ "background.js": "new WebSocket('wss://x');\nexport {};" }, /WebSocket/],
      [{ "popup.js": 'import React from "react";' }, /imports "react"/],
      [{ "popup.js": 'import { x } from "./missing.js";' }, /missing\.js, which isn't in the extension/],
      [{ "popup.js": 'import { x } from "./platform";' }, /\.js ending/],
      [{ "popup.js": "chrome.scripting.executeScript({});" }, /chrome\.scripting/],
      [{ "popup.js": "const shot = await chrome.tabs.captureVisibleTab();" }, /captureVisibleTab, which takes a picture of the page/],
      [{ "background.js": "chrome.tabCapture.capture({});\nexport {};" }, /tabCapture, desktopCapture, pageCapture/],
      [{ "popup.js": "chrome.pageCapture.saveAsMHTML({ tabId: 1 });" }, /tabCapture, desktopCapture, pageCapture/],
      [{ "popup.html": "<script>alert(1)</script>" }, /inline script/],
      [{ "popup.html": '<script type="module" src="https://cdn.example/x.js"></script>' }, /loads a script from https/],
      [{ "popup.html": '<script src="./popup.js"></script>' }, /without type="module"/],
      [{ "popup.html": '<button onclick="go()">Go</button>' }, /inline event handler/],
      [{ "popup.html": '<iframe src="https://x.example"></iframe>' }, /embeds another page/],
      [{ "popup.html": '<link rel="stylesheet" href="https://fonts.example/a.css">' }, /Styles and fonts come only from the extension/],
      [{ "popup.css": "@import url('https://fonts.example/a.css');" }, /another site/],
    ];
    for (const [over, want] of cases) {
      const problems = scanExtensionFiles(asMap({ ...FILES, ...over }));
      assert.ok(problems.some((p) => want.test(p)), `${JSON.stringify(over)}: ${problems.join(" | ")}`);
    }
  });

  it("doesn't fire on comments, and allows fetch only in platform.js", () => {
    assert.deepEqual(scanExtensionFiles(asMap({ ...FILES, "popup.js": `${FILES["popup.js"]}// fetch("x") and eval("y") in a comment\n/* import("z") */\n` })), []);
    assert.ok(isExtensionPath("icons/icon-128.png"));
    for (const bad of ["../x.js", "/abs.js", ".hidden.js", "a//b.js", "run.sh", "a\\b.js", "_metadata/x.json", "_x.js", "icons/_a.png"]) {
      assert.equal(isExtensionPath(bad), false, bad);
      assert.equal(PACK.isExtensionPath(bad), false, `packer: ${bad}`);
    }
  });
});

describe("the packer in the build and the platform agree", () => {
  it("on every manifest and file case here", () => {
    const manifests: object[] = [
      MANIFEST,
      { ...MANIFEST, permissions: ["<all_urls>"] },
      { ...MANIFEST, permissions: ["activeTab", "contextMenus"] },
      { ...MANIFEST, content_scripts: [] },
      { ...MANIFEST, manifest_version: 2 },
      { ...MANIFEST, side_panel: { default_path: "panel.html" }, permissions: ["sidePanel"] },
      { ...MANIFEST, commands: { _execute_action: { suggested_key: { default: "Ctrl+Shift+Y" } } } },
      { ...MANIFEST, icons: { "16": "i16.png", "128": "i128.png" }, action: { default_popup: "popup.html", default_icon: { "32": "i32.png" } } },
    ];
    for (const m of manifests) {
      for (const allowed of [[...EXTENSION_PERMISSIONS], ["activeTab"]]) {
        assert.deepEqual(PACK.checkProductManifest(m, { allowed }), checkProductManifest(m, { allowed: allowed as typeof EXTENSION_PERMISSIONS[number][] }), JSON.stringify(m));
      }
    }
    const fileCases = [FILES, { ...FILES, "popup.js": 'fetch("x")' }, { ...FILES, "popup.html": "<script>1</script><iframe></iframe>" }, { ...FILES, "a.css": "x{background:url(//x.example/a.png)}" }];
    for (const files of fileCases) assert.deepEqual(PACK.scanExtensionFiles(asMap(files)), scanExtensionFiles(asMap(files)));
    assert.deepEqual(PACK.finalManifest(checkProductManifest(MANIFEST, { allowed: EXTENSION_PERMISSIONS }).manifest, ORIGIN), finalManifest(checkProductManifest(MANIFEST, { allowed: EXTENSION_PERMISSIONS }).manifest!, ORIGIN));
  });
});

describe("packaging for the live link", () => {
  it("zips the files with the platform's own manifest and config.js, in a stable order", () => {
    const pack = packageExtension(bundleOf(FILES), { origin: ORIGIN, permissions: ["activeTab", "storage"] });
    const zip = readZip(pack.zip);
    assert.deepEqual([...zip.keys()], ["background.js", "config.js", "manifest.json", "platform.js", "popup.css", "popup.html", "popup.js"]);
    assert.equal(zip.get("config.js")!.toString(), `// Written by the Muse Muse platform when it packages the extension. Don't edit.\nexport const PRODUCT_ORIGIN = "${ORIGIN}";\n`);
    const manifest = JSON.parse(zip.get("manifest.json")!.toString());
    assert.deepEqual(manifest.host_permissions, [`${ORIGIN}/*`]);
    assert.equal(manifest.name, "Page Notes");
    assert.equal(packageExtension(bundleOf(FILES), { origin: ORIGIN, permissions: ["activeTab", "storage"] }).sha256, pack.sha256, "same files, same bytes");
  });

  it("leaves out a permission the brief didn't list, and refuses everything else with every reason", () => {
    const narrow = packageExtension(bundleOf(FILES), { origin: ORIGIN, permissions: ["activeTab"] });
    assert.deepEqual(narrow.dropped, ["storage"]);
    assert.deepEqual(narrow.manifest.permissions, ["activeTab"]);
    const bad = { ...FILES, "manifest.json": JSON.stringify({ ...MANIFEST, permissions: ["<all_urls>"], host_permissions: ["https://*/*"] }), "config.js": "export const PRODUCT_ORIGIN = 'https://evil.example';" };
    assert.throws(
      () => packageExtension(bundleOf(bad), { origin: ORIGIN, permissions: ["activeTab"] }),
      (err: unknown) => err instanceof ExtensionPackError && err.problems.length >= 3 && err.problems.some((p) => p.includes("config.js is written by the platform")),
    );
    assert.throws(() => packageExtension({ musemuse_extension: 1, files: [{ path: "../x.js", base64: "" }] }, { origin: ORIGIN, permissions: [] }), ExtensionPackError);
    assert.throws(() => packageExtension(bundleOf({ ...FILES, "popup.html": FILES["popup.html"]!.replace("./popup.js", "./gone.js") }), { origin: ORIGIN, permissions: ["activeTab", "storage"] }), /gone\.js/);
    assert.throws(() => packageExtension({ files: [] }, { origin: ORIGIN, permissions: [] }), /isn't an extension bundle/);
  });

  it("refuses names that would land on the platform's files, or on each other, once unzipped on a Mac or Windows disk", () => {
    const broad = JSON.stringify({ ...MANIFEST, host_permissions: ["<all_urls>"], content_scripts: [{ matches: ["<all_urls>"], js: ["popup.js"] }] });
    const cases: Array<[Record<string, string>, RegExp]> = [
      [{ "MANIFEST.JSON": broad }, /^MANIFEST\.JSON would replace the platform's manifest\.json on a Mac or Windows disk/],
      [{ "Manifest.json": broad }, /^Manifest\.json would replace the platform's manifest\.json/],
      [{ "CONFIG.js": 'export const PRODUCT_ORIGIN = "https://elsewhere.example";\n' }, /^CONFIG\.js would replace the platform's config\.js/],
      [{ "Config.js": "export {};\n" }, /^Config\.js would replace the platform's config\.js/],
      [{ "Popup.js": "export {};\n" }, /^Popup\.js and popup\.js differ only in capital letters/],
      [{ "config.js/x.js": "export {};\n" }, /^config\.js\/x\.js is in a folder named like the file config\.js/],
      [{ "Manifest.JSON/x.js": "export {};\n" }, /is in a folder named like the file manifest\.json/],
      [{ "popup.html/x.js": "export {};\n" }, /is in a folder named like the file popup\.html/],
    ];
    for (const [over, want] of cases) {
      assert.throws(
        () => packageExtension(bundleOf({ ...FILES, ...over }), { origin: ORIGIN, permissions: ["activeTab", "storage"] }),
        (err: unknown) => err instanceof ExtensionPackError && err.problems.some((p) => want.test(p)),
        JSON.stringify(Object.keys(over)),
      );
    }
    assert.throws(() => packageExtension(bundleOf({ ...FILES, "_metadata/verified_contents.json": "[]" }), { origin: ORIGIN, permissions: ["activeTab", "storage"] }), /isn't a file an extension may ship/);
    // The build's packer runs the same rules.
    for (const paths of [Object.keys(FILES), [...Object.keys(FILES), "MANIFEST.JSON", "CONFIG.js"], ["a.js", "A.js", "a.js/b.js", "config.js/c.js", "icons/i.png", "Icons/i.png"]]) {
      assert.deepEqual(PACK.pathClashes(paths), pathClashes(paths), JSON.stringify(paths));
    }
    assert.deepEqual(pathClashes(Object.keys(FILES)), []);
  });

  it("keeps the zip at the extensions prefix, under a name people recognize", () => {
    assert.equal(extensionZipPath("p-1"), "extensions/p-1/latest.zip");
    assert.equal(extensionFileName("page-notes"), "page-notes-extension.zip");
  });
});

describe("the step after deploy", () => {
  const fakeDeps = (over: Partial<ExtensionShipDeps> & { bundle?: unknown } = {}) => {
    const saved: Array<{ productId: string; bytes: number }> = [];
    const ran: string[][] = [];
    const deps: ExtensionShipDeps = {
      node: async (args) => {
        ran.push(args);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      readFile: async (file) => (file === BUNDLE_FILE ? Buffer.from(JSON.stringify(over.bundle ?? bundleOf(FILES))) : null),
      save: async (productId, zip) => {
        saved.push({ productId, bytes: zip.length });
        return `https://store.example/${extensionZipPath(productId)}`;
      },
      ...over,
    };
    return { deps, saved, ran };
  };

  it("runs the platform's packer from CAPS_DIR on the product, packages for the live link and saves it", async () => {
    const { deps, saved, ran } = fakeDeps();
    const line = await shipExtension({ productId: "p-1", liveUrl: `${ORIGIN}/`, brief: WITH }, deps);
    assert.deepEqual(ran, [[`${CAPS_DIR}/extension/files/scripts/extension-pack.mjs`, "bundle", "--root", PRODUCT_DIR, "--out", BUNDLE_FILE]]);
    assert.equal(PACKER, `${CAPS_DIR}/extension/files/scripts/extension-pack.mjs`);
    assert.equal(saved.length, 1);
    assert.match(line!, /^Packaged the browser extension for https:\/\/page-notes\.vercel\.app \(7 files, \d+ KB\)\. People install it with Load unpacked/);
  });

  it("does nothing for a brief without the block, and says why in one line when it can't package", async () => {
    assert.equal(await shipExtension({ productId: "p", liveUrl: ORIGIN, brief: BRIEF }, fakeDeps().deps), null);
    const failed = await shipExtension({ productId: "p", liveUrl: ORIGIN, brief: WITH }, fakeDeps({ node: async () => ({ exitCode: 1, stdout: "", stderr: "extension: extension/popup.ts:3 doesn't compile: ';' expected.\n" }) }).deps);
    assert.equal(failed, "The browser extension wasn't packaged: extension/popup.ts:3 doesn't compile: ';' expected. The web product is live as usual.");
    const broad = await shipExtension({ productId: "p", liveUrl: ORIGIN, brief: WITH }, fakeDeps({ bundle: bundleOf({ ...FILES, "manifest.json": JSON.stringify({ ...MANIFEST, permissions: ["<all_urls>"] }) }) }).deps);
    assert.match(broad!, /wasn't packaged: "<all_urls>" asks for sites/);
    const http = await shipExtension({ productId: "p", liveUrl: "http://x.example", brief: WITH }, fakeDeps().deps);
    assert.match(http!, /must be https/);
    const lost = await shipExtension({ productId: "p", liveUrl: ORIGIN, brief: WITH }, fakeDeps({ save: async () => { throw new Error("blob down"); } }).deps);
    assert.match(lost!, /couldn't be saved/);
  });
});

describe("GET /p/<slug>/get/extension", () => {
  const deps = (over: Partial<ExtensionDownloadDeps> = {}) => {
    const counted: string[] = [];
    const d: ExtensionDownloadDeps = {
      enabled: () => true,
      findProduct: async (slug) => (slug === "page-notes" ? { id: "p-1", liveUrl: ORIGIN, hasExtension: true } : null),
      findZip: async (id) => (id === "p-1" ? { url: "https://store.example/extensions/p-1/latest.zip" } : null),
      reserve: async (key) => {
        counted.push(key);
        return 1;
      },
      release: async () => undefined,
      now: () => new Date("2026-11-02T12:00:00Z"),
      ...over,
    };
    return { d, counted };
  };
  const get = (method = "GET") => new Request("https://site.example/p/page-notes/get/extension", { method, headers: { "x-forwarded-for": "203.0.113.9" } });

  it("with the flag off, answers exactly what the downloads route answered this path before, touching nothing", async () => {
    const touched: string[] = [];
    const off = await answerExtensionDownload(get(), "page-notes", {
      ...deps().d,
      enabled: () => false,
      findProduct: async () => {
        touched.push("product");
        return null;
      },
    });
    const before = await answerDownload(get(), "page-notes", "extension", {
      findPackage: async () => null,
      reserve: async () => 1,
      release: async () => undefined,
      count: async () => undefined,
      now: () => new Date(),
    });
    assert.equal(off.status, before.status);
    assert.equal(await off.text(), await before.text());
    assert.deepEqual([...off.headers.entries()], [...before.headers.entries()]);
    assert.deepEqual(touched, []);
  });

  it("redirects to the zip as a download, counted per address and per day", async () => {
    const { d, counted } = deps();
    const res = await answerExtensionDownload(get(), "page-notes", d);
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "https://store.example/extensions/p-1/latest.zip?download=1");
    assert.deepEqual(counted, ["extension-get-ip:203.0.113.9", "extension-get-day"]);
  });

  it("answers 404 for an unknown product, one with no extension or no zip yet, and HEAD without counting", async () => {
    for (const over of [
      { findProduct: async () => null },
      { findProduct: async () => ({ id: "p-1", liveUrl: ORIGIN, hasExtension: false }) },
      { findProduct: async () => ({ id: "p-1", liveUrl: null, hasExtension: true }) },
      { findZip: async () => null },
    ] as Array<Partial<ExtensionDownloadDeps>>) {
      const res = await answerExtensionDownload(get(), "page-notes", deps(over).d);
      assert.equal(res.status, 404);
      assert.equal(await res.text(), "This download isn't available.\n");
    }
    const { d, counted } = deps();
    assert.equal((await answerExtensionDownload(get("HEAD"), "page-notes", d)).status, 200);
    assert.deepEqual(counted, []);
    assert.equal((await answerExtensionDownload(get(), "Bad Slug!", deps().d)).status, 404);
  });

  it("limits an address and the day, and says so plainly", async () => {
    const atLimit = await answerExtensionDownload(get(), "page-notes", deps({ reserve: async (key) => (key.startsWith("extension-get-ip:") ? null : 1) }).d);
    assert.equal(atLimit.status, 429);
    assert.equal(await atLimit.text(), "Too many downloads from here. Try again later.\n");
    const full = await answerExtensionDownload(get(), "page-notes", deps({ reserve: async (key) => (key === "extension-get-day" ? null : 1) }).d);
    assert.equal(full.status, 429);
    assert.match(full.headers.get("retry-after")!, /^\d+$/);
    const broken = await answerExtensionDownload(get(), "page-notes", deps({ findZip: async () => { throw new Error("blob down"); } }).d);
    assert.equal(broken.status, 503);
  });
});

describe("the Get it tab", () => {
  const product = { slug: "page-notes", liveUrl: ORIGIN as string | null };
  const html = (node: unknown) => renderToString(createElement("div", null, node as never)).replace(/<!-- -->/g, "");

  it("offers the zip with the Load unpacked steps and what it may do, for a live product with an extension", () => {
    const slots = extensionSlots({ product, origin: "https://site.example/", brief: WITH });
    assert.deepEqual(Object.keys(slots), ["extension"]);
    const out = html(slots.extension);
    assert.match(out, /href="https:\/\/site\.example\/p\/page-notes\/get\/extension"/);
    assert.match(out, /download="page-notes-extension\.zip"/);
    for (const want of ["chrome://extensions", "Developer mode", "Load unpacked", "isn&#x27;t in any extension store", "see the address and title of the page you&#x27;re on", "keep its settings"]) {
      assert.ok(out.includes(want), want);
    }
    assert.ok(!out.includes("—"));
    assert.equal(extensionLink("https://site.example/", "x"), "https://site.example/p/x/get/extension");
  });

  it("is empty without a live link or an extension block", () => {
    assert.deepEqual(extensionSlots({ product: { ...product, liveUrl: null }, origin: "https://site.example", brief: WITH }), {});
    assert.deepEqual(extensionSlots({ product, origin: "https://site.example", brief: BRIEF }), {});
    assert.deepEqual(extensionSlots({ product, origin: "https://site.example", brief: null }), {});
  });
});

after(() => undefined);
