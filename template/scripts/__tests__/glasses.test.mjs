// Tests for the glasses target: the overlay in targets/glasses/, tests/glasses.ts, and the real components driven in
// Chromium against the fake glasses. Nothing here leaves the machine. Run from the repo root:
//   npx tsx --test template/scripts/__tests__/*.test.mjs
// The browser tests skip themselves when Chromium or esbuild isn't installed.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";
import { glasses as fake, installGlasses, wavSecondsOf } from "../../tests/glasses.ts";
import { glassesProblems } from "../smoke-report.mjs";

const TEMPLATE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TARGET = path.join(TEMPLATE, "targets/glasses");
const FILES = path.join(TARGET, "files");
const read = (file) => readFileSync(file, "utf8");

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}
const overlayFiles = () => walk(FILES).map((f) => path.relative(FILES, f));

/** The members of a string-union type in a TypeScript file, sorted. */
function union(source, name) {
  const match = source.match(new RegExp(`type ${name} =([^;]*);`));
  assert.ok(match, `no type ${name}`);
  return [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();
}
/** The members of the inline error-code union in bridge.ts, which the design keeps inside GlassesStatus. */
function inlineCodes(source) {
  const match = source.match(/code:\s*((?:\|\s*"[^"]+"\s*)+);/);
  assert.ok(match, "no inline error codes");
  return [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();
}

describe("the overlay", () => {
  test("adds no npm dependencies", () => {
    assert.deepEqual(JSON.parse(read(path.join(TARGET, "deps.json"))), {});
  });

  test("every platform file exists, and lib/glasses and the skill are platform files", () => {
    const platform = JSON.parse(read(path.join(TARGET, "platform-files.json")));
    for (const file of platform) assert.ok(existsSync(path.join(FILES, file)), `${file} is missing`);
    const files = overlayFiles();
    for (const file of files.filter((f) => f.startsWith("lib/glasses/") || f.startsWith(".agents/"))) assert.ok(platform.includes(file), `${file} isn't a platform file`);
    for (const file of files.filter((f) => f.startsWith("components/"))) assert.ok(!platform.includes(file), `${file} is the product's to restyle`);
  });

  test("every @/ import resolves in the overlay or the base template", () => {
    for (const file of overlayFiles().filter((f) => /\.tsx?$/.test(f))) {
      for (const [, spec] of read(path.join(FILES, file)).matchAll(/from "@\/([^"]+)"/g)) {
        const found = [FILES, TEMPLATE].some((root) => [".ts", ".tsx"].some((ext) => existsSync(path.join(root, spec + ext))));
        assert.ok(found, `${file} imports @/${spec}, which doesn't exist`);
      }
    }
  });

  test("copy has no em dashes, and the UI never says the glasses are pretend", () => {
    for (const file of overlayFiles()) assert.ok(!read(path.join(FILES, file)).includes("—"), `${file} has an em dash`);
    for (const file of overlayFiles().filter((f) => f.startsWith("components/") || f.endsWith("client.ts"))) {
      assert.doesNotMatch(read(path.join(FILES, file)), /\b(mock|simulated|fake|emulat\w*)\b/i, file);
    }
  });

  test("the skill has the frontmatter skills need and shows the test helpers", () => {
    const skill = read(path.join(FILES, ".agents/skills/muse-glasses/SKILL.md"));
    assert.match(skill, /^---\nname: muse-glasses\ndescription: .+\n---\n/);
    for (const needed of ["useGlasses", "installGlasses", "data-glasses-primary", "data-result", "data-glasses-action", "glasses.spoken", "glasses.set"]) {
      assert.ok(skill.includes(needed), `the skill doesn't mention ${needed}`);
    }
  });
});

describe("the bridge types", () => {
  const bridge = () => read(path.join(FILES, "lib/glasses/bridge.ts"));
  const helper = () => read(path.join(TEMPLATE, "tests/glasses.ts"));

  test("tests/glasses.ts repeats lib/glasses/bridge.ts", () => {
    assert.deepEqual(union(helper(), "FakeGlassesState"), union(bridge(), "GlassesState"));
    assert.deepEqual(union(helper(), "FakeGlassesErrorCode"), inlineCodes(bridge()));
  });

  test("the fake has every method of the bridge", () => {
    const methods = [...bridge().match(/interface MuseGlasses \{([^]*?)\n\}/)[1].matchAll(/^ {2}(\w+)\(/gm)].map((m) => m[1]);
    assert.deepEqual(methods, ["status", "onStatus", "connect", "capturePhoto", "preview", "startRecording", "stopRecording", "speak"]);
    // onStatus is a listener, not a call, so it isn't logged.
    assert.deepEqual(union(helper(), "FakeGlassesMethod"), methods.filter((m) => m !== "onStatus").sort());
    for (const method of methods) assert.match(helper(), new RegExp(`\\b${method}[:(]`), `the fake has no ${method}`);
  });

  // The shell's copy of the protocol only exists once the native lane is in this tree, and never in a product.
  const shell = path.join(TEMPLATE, "../native/bridge/protocol.ts");
  test("matches the shell's protocol", { skip: existsSync(shell) ? false : "the shell isn't in this tree" }, () => {
    const protocol = read(shell);
    assert.deepEqual(union(protocol, "GlassesState"), union(bridge(), "GlassesState"));
    assert.deepEqual(union(protocol, "GlassesErrorCode"), inlineCodes(bridge()));
  });
});

/** A 16 kHz mono WAV of a quiet tone, or `extra` bytes of a LIST chunk before the data, like ffmpeg writes. */
function wav({ seconds = 1, rate = 16000, channels = 1, list = 0 } = {}) {
  const bytes = Math.round(seconds * rate) * 2 * channels;
  const head = 12 + 24 + (list ? 8 + list : 0) + 8;
  const out = Buffer.alloc(head + bytes);
  out.write("RIFF", 0, "latin1");
  out.writeUInt32LE(out.length - 8, 4);
  out.write("WAVEfmt ", 8, "latin1");
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(channels, 22);
  out.writeUInt32LE(rate, 24);
  out.writeUInt32LE(rate * channels * 2, 28);
  out.writeUInt16LE(channels * 2, 32);
  out.writeUInt16LE(16, 34);
  let at = 36;
  if (list) {
    out.write("LIST", at, "latin1");
    out.writeUInt32LE(list, at + 4);
    at += 8 + list;
  }
  out.write("data", at, "latin1");
  out.writeUInt32LE(bytes, at + 4);
  for (let i = 0; i < bytes / 2; i += 1) out.writeInt16LE(Math.round(4000 * Math.sin((i / rate) * 2 * Math.PI * 440)), at + 8 + i * 2);
  return out;
}

describe("wavSecondsOf", () => {
  test("reads the length of a 16 kHz mono WAV, walking past other chunks", () => {
    assert.equal(wavSecondsOf(wav({ seconds: 2 })), 2);
    assert.equal(wavSecondsOf(wav({ seconds: 1.5, list: 26 })), 1.5);
  });
  test("refuses anything the real app would never send, and says how to fix it", () => {
    for (const bad of [Buffer.from("not a wav"), wav({ rate: 44100 }), wav({ channels: 2 })]) {
      assert.throws(() => wavSecondsOf(bad, "fixtures/q.wav"), /fixtures\/q\.wav must be a 16 kHz mono WAV/);
    }
  });
});

/** esbuild, or null when it isn't installed. It comes with the repo's tsx, not with the template. */
const esbuild = await import("esbuild").catch(() => null);

/** Resolves @/ the way a product does: the overlay's files on top of the base template. */
const productAlias = {
  name: "product-alias",
  setup(build) {
    build.onResolve({ filter: /^@\// }, (args) => {
      const spec = args.path.slice(2);
      for (const root of [FILES, TEMPLATE]) {
        for (const ext of [".ts", ".tsx"]) {
          if (existsSync(path.join(root, spec + ext))) return { path: path.join(root, spec + ext) };
        }
      }
      return { errors: [{ text: `Can't find ${args.path}` }] };
    });
  },
};

describe("client.ts helpers", { skip: esbuild ? false : "esbuild isn't installed" }, () => {
  let client;
  let dir;
  before(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "glasses-client-"));
    const outfile = path.join(dir, "client.mjs");
    await esbuild.build({
      entryPoints: [path.join(FILES, "lib/glasses/client.ts")],
      absWorkingDir: TEMPLATE,
      bundle: true,
      format: "esm",
      platform: "node",
      external: ["react"],
      outfile,
      logLevel: "silent",
      plugins: [productAlias],
    });
    // The bundle lives in a temp folder, so react has to come from the template.
    writeFileSync(outfile, read(outfile).replaceAll('from "react"', `from ${JSON.stringify(pathToFileURL(path.join(TEMPLATE, "node_modules/react/index.js")).href)}`));
    client = await import(pathToFileURL(outfile).href);
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  const status = (state, device = null) => ({ state, mode: "real", device, error: null });

  test("statusLabel reads like the design's chip", () => {
    assert.equal(client.statusLabel(status("ready", { name: "Ray-Ban Meta", battery: 80, worn: true })), "Ready · Ray-Ban Meta 80%");
    assert.equal(client.statusLabel(status("ready", { name: "Oakley Meta", battery: null, worn: null })), "Ready · Oakley Meta");
    assert.equal(client.statusLabel(status("ready")), "Ready");
    for (const state of ["unavailable", "needs-meta-ai", "not-registered", "registering", "no-glasses", "connecting", "paused", "error"]) {
      assert.ok(client.statusLabel(status(state)).length > 0, state);
    }
  });

  test("a device starts on glasses, then its camera, then the sample", () => {
    assert.equal(client.firstSource({ glasses: true, camera: true }), "glasses");
    assert.equal(client.firstSource({ glasses: true, camera: false }), "glasses");
    assert.equal(client.firstSource({ glasses: false, camera: true }), "phone");
    assert.equal(client.firstSource({ glasses: false, camera: false }), "sample");
  });

  test("glassesMessage gives one plain sentence for anything thrown", () => {
    assert.equal(client.glassesMessage({ code: "hinges_closed", message: "HINGES_CLOSED" }), "Open your glasses and put them on, then try again.");
    assert.equal(client.glassesMessage(new client.GlassesClientError("not_connected")), "Connect your glasses first.");
    assert.equal(client.glassesMessage(new Error("Something else.")), "Something else.");
    assert.equal(client.glassesMessage(null), "That didn't work. Try again.");
    // A code the page doesn't know, from a newer app: the app's own words.
    assert.equal(client.glassesMessage(Object.assign(new Error("That's busy."), { code: "busy" })), "That's busy.");
  });
});

const ORIGIN = "http://localhost:4599";

/** What the test page mounts: the real parts, with a result and a way to leave the page. */
const PAGE_SOURCE = `
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { GlassesPanel } from "@/components/glasses/GlassesPanel";
import { HoldToAsk } from "@/components/glasses/HoldToAsk";
import { useGlasses } from "@/lib/glasses/client";

const samples = new URLSearchParams(location.search).has("nosamples") ? undefined : { photos: ["/samples/pov-1.jpg"], question: "/samples/question.wav" };

function Product() {
  const glasses = useGlasses({ samples });
  const [ask, setAsk] = useState(null);
  return (
    <main>
      <GlassesPanel glasses={glasses} />
      <HoldToAsk
        glasses={glasses}
        onAsk={async ({ photo, question }) => {
          setAsk({ photo, question });
          await glasses.say("A red door.");
        }}
      />
      <p data-source>{glasses.source}</p>
      {ask ? (
        <section data-result data-photo-source={ask.photo.source} data-question-source={ask.question.source} data-seconds={ask.question.seconds} data-width={ask.photo.width} data-height={ask.photo.height} data-photo={ask.photo.dataUrl.slice(0, 15)} data-wav={ask.question.wavDataUrl.slice(0, 15)}>
          A red door.
        </section>
      ) : null}
    </main>
  );
}

function App() {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button type="button" onClick={() => setOpen(false)}>Leave</button>
      {open ? <Product /> : null}
    </>
  );
}

createRoot(document.getElementById("root")).render(<App />);
`;

/** tsx names every function it compiles with a __name helper, and page.addInitScript sends the fake bridge's source as is. */
const NAME_SHIM = "window.__name = (f) => f;";

/** Records what the browser would say, since headless Chromium has no voices. */
const SPEECH_STUB = `(() => {
  const said = [];
  window.__said = said;
  Object.defineProperty(window, "speechSynthesis", {
    value: { speaking: false, cancel() {}, speak(u) { if (u.text) said.push(u.text); setTimeout(() => u.onend && u.onend(), 0); } },
  });
  window.SpeechSynthesisUtterance = function (text) { this.text = text; };
})();`;

const browserProblem = !esbuild ? "esbuild isn't installed" : null;

describe("in Chromium", { skip: browserProblem ?? false }, () => {
  const startDir = process.cwd();
  let browser;
  let dir;
  let bundle;
  let pov;
  let question;

  before(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "glasses-browser-"));
    // tests/glasses.ts writes to test-results/ under the working folder. Each test file gets its own process.
    process.chdir(dir);
    browser = await chromium
      .launch({ args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] })
      .catch(() => null);
    if (!browser) return;

    const built = await esbuild.build({
      stdin: { contents: PAGE_SOURCE, loader: "tsx", resolveDir: TEMPLATE, sourcefile: "page.tsx" },
      absWorkingDir: TEMPLATE,
      bundle: true,
      format: "iife",
      platform: "browser",
      jsx: "automatic",
      write: false,
      logLevel: "silent",
      define: { "process.env.NODE_ENV": '"development"' },
      plugins: [productAlias],
    });
    bundle = built.outputFiles[0].text;

    // A photo wider than the bridge's 1600 px, drawn by the browser itself.
    const page = await browser.newPage();
    const data = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 2000;
      canvas.height = 1000;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#c33";
      ctx.fillRect(0, 0, 2000, 1000);
      return canvas.toDataURL("image/jpeg", 0.9);
    });
    await page.close();
    mkdirSync("fixtures");
    pov = path.join(dir, "fixtures/pov-1.jpg");
    question = path.join(dir, "fixtures/question.wav");
    writeFileSync(pov, Buffer.from(data.slice(data.indexOf(",") + 1), "base64"));
    writeFileSync(question, wav({ seconds: 1 }));
  });

  after(async () => {
    await browser?.close();
    process.chdir(startDir);
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  /** A new page on the test origin, with the page's errors collected. goto() opens it. */
  async function open(t, { fakeGlasses, media = false, query = "" } = {}) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, ...(media ? {} : { permissions: [] }) });
    t.after(() => context.close());
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (err) => errors.push(err.message));
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    await page.addInitScript(NAME_SHIM);
    await page.addInitScript(SPEECH_STUB);
    // No camera or microphone on this page unless the test asks: enumerateDevices shows none.
    if (!media) {
      await page.addInitScript(() => {
        navigator.mediaDevices.enumerateDevices = async () => [];
      });
    }
    await context.route(`${ORIGIN}/**`, (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/bundle.js") return route.fulfill({ contentType: "text/javascript", body: bundle });
      if (url.pathname === "/samples/pov-1.jpg") return route.fulfill({ contentType: "image/jpeg", body: readFileSync(pov) });
      if (url.pathname === "/samples/question.wav") return route.fulfill({ contentType: "audio/wav", body: readFileSync(question) });
      if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: '<!doctype html><div id="root"></div><script src="/bundle.js"></script>' });
      return route.fulfill({ status: 404, body: "" });
    });
    if (fakeGlasses) await installGlasses(page, fakeGlasses);
    return { page, errors, goto: () => page.goto(`${ORIGIN}/${query}`) };
  }

  const askButton = (page) => page.locator("[data-glasses-primary]");
  const result = (page) => page.locator("[data-result]");

  test("glasses: connect, hold, photo and question from the glasses, spoken in the glasses", async (t) => {
    if (!browser) return t.skip("Chromium isn't installed");
    const { page, errors, goto } = await open(t, { fakeGlasses: { photos: [pov], question } });
    await goto();

    assert.equal(await page.locator("[data-source]").textContent(), "glasses");
    await page.locator("[data-glasses-panel] [role=status]").getByText("Not connected").waitFor();
    assert.ok(await askButton(page).isDisabled(), "the main button waits for the glasses");
    assert.equal(await page.locator("[data-glasses-ask] .hint").textContent(), "Connect your glasses first.");

    await page.getByRole("button", { name: "Connect your glasses" }).click();
    await page.locator("[data-glasses-panel] [role=status]").getByText("Ready · Ray-Ban Meta 80%").waitFor();
    assert.equal(await page.getByRole("button", { name: "Connect your glasses" }).count(), 0);

    await page.getByRole("button", { name: "Hold to ask" }).click({ delay: 600 });
    await result(page).waitFor();
    assert.equal(await result(page).getAttribute("data-photo-source"), "glasses");
    assert.equal(await result(page).getAttribute("data-question-source"), "glasses");
    assert.equal(await result(page).getAttribute("data-seconds"), "1");
    assert.equal(await result(page).getAttribute("data-width"), "1600");
    assert.equal(await result(page).getAttribute("data-height"), "800");
    assert.equal(await result(page).getAttribute("data-photo"), "data:image/jpeg");
    assert.equal(await result(page).getAttribute("data-wav"), "data:audio/wav;");
    assert.equal(await page.getByRole("img", { name: "What your glasses saw" }).count(), 1);

    for (let i = 0; i < 50 && (await fake.spoken(page)).length === 0; i += 1) await page.waitForTimeout(50);
    assert.deepEqual(await fake.spoken(page), ["A red door."]);
    assert.deepEqual(await page.evaluate(() => window.__said), [], "the browser stays quiet when the glasses speak");

    const methods = (await fake.calls(page)).map((c) => c.method);
    for (const m of ["status", "connect", "startRecording", "stopRecording", "capturePhoto", "speak"]) assert.ok(methods.includes(m), `${m} wasn't logged`);
    assert.ok(methods.indexOf("stopRecording") < methods.indexOf("capturePhoto"), "the photo is taken after the question");

    // The log verify reads, here without a Playwright project.
    const log = read("test-results/glasses/calls.jsonl");
    assert.deepEqual(glassesProblems(log, { project: "" }), []);
    assert.ok(!log.includes("base64"), "photos and recordings stay out of the log");
    assert.deepEqual(errors, []);
  });

  test("glasses: a tap listens until the next tap, and keys work too", async (t) => {
    if (!browser) return t.skip("Chromium isn't installed");
    const { page, goto } = await open(t, { fakeGlasses: { photos: [pov], question, state: "ready" } });
    await goto();
    await page.locator("[data-glasses-panel] [role=status]").getByText("Ready").waitFor();

    await askButton(page).click();
    await page.getByRole("button", { name: "Listening. Tap when you're done." }).waitFor();
    assert.equal(await askButton(page).getAttribute("aria-pressed"), "true");
    await askButton(page).click();
    await result(page).waitFor();
    await page.getByRole("button", { name: "Hold to ask" }).waitFor();
    assert.equal((await fake.calls(page)).filter((c) => c.method === "capturePhoto").length, 1);

    await askButton(page).focus();
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "Listening. Tap when you're done." }).waitFor();
    await page.keyboard.press("Enter");
    for (let i = 0; i < 60 && (await fake.calls(page)).filter((c) => c.method === "capturePhoto").length < 2; i += 1) await page.waitForTimeout(50);
    assert.equal((await fake.calls(page)).filter((c) => c.method === "capturePhoto").length, 2);
  });

  test("glasses: a failed photo says what to do, and the next press works", async (t) => {
    if (!browser) return t.skip("Chromium isn't installed");
    const { page, goto } = await open(t, { fakeGlasses: { photos: [pov], question, state: "ready" } });
    await goto();
    await page.locator("[data-glasses-panel] [role=status]").getByText("Ready").waitFor();

    await fake.set(page, { fail: { method: "capturePhoto", code: "capture_failed" } });
    await askButton(page).click({ delay: 500 });
    await page.getByRole("alert").getByText("That photo didn't work. Try again.").waitFor();
    assert.equal(await result(page).count(), 0);
    assert.deepEqual(glassesProblems(read("test-results/glasses/calls.jsonl").split("\n").filter((l) => l.includes('"ok":false')).join("\n"), { project: "" }).length, 1);

    await askButton(page).click({ delay: 500 });
    await result(page).waitFor();
    assert.equal(await page.getByRole("alert").count(), 0);
  });

  test("glasses: folding them mid-session brings back the connect button, and a reload stays connected", async (t) => {
    if (!browser) return t.skip("Chromium isn't installed");
    const { page, goto } = await open(t, { fakeGlasses: { photos: [pov], question } });
    await goto();
    await page.getByRole("button", { name: "Connect your glasses" }).click();
    await page.locator("[data-glasses-panel] [role=status]").getByText("Ready").waitFor();

    await page.reload();
    await page.locator("[data-glasses-panel] [role=status]").getByText("Ready").waitFor();

    await fake.set(page, { state: "paused" });
    await page.locator("[data-glasses-panel] [role=status]").getByText("Paused").waitFor();
    assert.ok(await askButton(page).isDisabled());
    await page.getByRole("button", { name: "Connect your glasses" }).waitFor();

    await fake.set(page, { state: "no-glasses", error: { code: "no_eligible_device", message: "none" } });
    await page.getByRole("alert").getByText("We can't find your glasses.", { exact: false }).waitFor();
  });

  test("glasses: a new photo list applies, and battery shows on the chip", async (t) => {
    if (!browser) return t.skip("Chromium isn't installed");
    const { page, goto } = await open(t, { fakeGlasses: { photos: [], question, state: "ready" } });
    await goto();
    await page.locator("[data-glasses-panel] [role=status]").getByText("Ready · Ray-Ban Meta 80%").waitFor();
    await fake.set(page, { battery: 15 });
    await page.locator("[data-glasses-panel] [role=status]").getByText("Ready · Ray-Ban Meta 15%").waitFor();

    await askButton(page).click({ delay: 500 });
    await page.getByRole("alert").getByText("That photo didn't work. Try again.").waitFor();
    await fake.set(page, { photos: [pov] });
    await askButton(page).click({ delay: 500 });
    await result(page).waitFor();
  });

  test("glasses: leaving the page mid-question stops the glasses' microphone", async (t) => {
    if (!browser) return t.skip("Chromium isn't installed");
    const { page, goto } = await open(t, { fakeGlasses: { photos: [pov], question, state: "ready" } });
    await goto();
    await page.locator("[data-glasses-panel] [role=status]").getByText("Ready").waitFor();
    await page.getByRole("button", { name: "Show the live view" }).click();
    await page.getByRole("button", { name: "Hide the live view" }).waitFor();
    await askButton(page).click();
    await page.getByRole("button", { name: "Listening. Tap when you're done." }).waitFor();

    await page.getByRole("button", { name: "Leave" }).click();
    for (let i = 0; i < 60 && !(await fake.calls(page)).some((c) => c.method === "stopRecording"); i += 1) await page.waitForTimeout(50);
    const calls = await fake.calls(page);
    assert.ok(calls.some((c) => c.method === "stopRecording"), "the microphone stayed on");
    for (let i = 0; i < 60 && (await fake.calls(page)).filter((c) => c.method === "preview").length < 2; i += 1) await page.waitForTimeout(50);
    assert.deepEqual((await fake.calls(page)).filter((c) => c.method === "preview").map((c) => c.params.show), [true, false]);
  });

  test("no bridge, no camera: it starts on the sample, and the browser speaks", async (t) => {
    if (!browser) return t.skip("Chromium isn't installed");
    const { page, errors, goto } = await open(t);
    await goto();
    await page.locator("[data-source]").getByText("sample").waitFor();
    assert.equal(await page.locator("[data-glasses-panel] [role=status]").count(), 0, "no glasses chip on the sample");
    assert.equal(await page.getByRole("button", { name: "Connect your glasses" }).count(), 0);

    await page.getByRole("button", { name: "Hold to ask" }).click({ delay: 500 });
    await result(page).waitFor();
    assert.equal(await result(page).getAttribute("data-photo-source"), "sample");
    assert.equal(await result(page).getAttribute("data-question-source"), "sample");
    assert.equal(await result(page).getAttribute("data-seconds"), "1");
    assert.equal(await result(page).getAttribute("data-width"), "1600");
    assert.equal(await page.getByRole("img", { name: "The sample view" }).count(), 1);
    await page.waitForFunction(() => window.__said.length === 1);
    assert.deepEqual(await page.evaluate(() => window.__said), ["A red door."]);

    // Choosing glasses here explains where they work.
    await page.getByRole("radio", { name: "Glasses" }).check({ force: true });
    await page.getByText("Your glasses connect through the Muse Muse app on iPhone.").waitFor();
    assert.ok(await askButton(page).isDisabled());
    assert.deepEqual(errors, []);
  });

  test("no bridge, no samples: the main button says why it can't go", async (t) => {
    if (!browser) return t.skip("Chromium isn't installed");
    const { page, errors, goto } = await open(t, { query: "?nosamples" });
    await goto();
    await page.locator("[data-source]").getByText("sample").waitFor();
    assert.ok(await askButton(page).isDisabled());
    assert.equal(await page.locator("[data-glasses-ask] .hint").textContent(), "There's no sample to show here. Try this device's camera.");
    assert.deepEqual(errors, []);
  });

  test("no bridge, a camera: it starts on the phone, using getUserMedia and toWav16k", async (t) => {
    if (!browser) return t.skip("Chromium isn't installed");
    const { page, errors, goto } = await open(t, { media: true });
    await goto();
    await page.locator("[data-source]").getByText("phone").waitFor();

    await page.getByRole("button", { name: "Show the live view" }).click();
    await page.getByRole("button", { name: "Hide the live view" }).waitFor();
    assert.equal(await page.locator("video").count(), 1);
    await page.waitForFunction(() => document.querySelector("video")?.srcObject?.active === true);
    await page.getByRole("button", { name: "Hide the live view" }).click();
    await page.getByRole("button", { name: "Show the live view" }).waitFor();
    assert.equal(await page.locator("video").count(), 0);

    await page.getByRole("button", { name: "Hold to ask" }).click({ delay: 1200 });
    await result(page).waitFor({ timeout: 15_000 });
    assert.equal(await result(page).getAttribute("data-photo-source"), "phone");
    assert.equal(await result(page).getAttribute("data-question-source"), "phone");
    assert.equal(await result(page).getAttribute("data-photo"), "data:image/jpeg");
    assert.equal(await result(page).getAttribute("data-wav"), "data:audio/wav;");
    assert.ok(Number(await result(page).getAttribute("data-seconds")) > 0);
    assert.ok(Number(await result(page).getAttribute("data-width")) > 0);
    assert.equal(await page.getByRole("img", { name: "What your phone saw" }).count(), 1);
    await page.waitForFunction(() => window.__said.length === 1);
    assert.deepEqual(errors, []);
  });

  test("installGlasses refuses to run twice or after the page has loaded, and bad fixtures say how to fix them", async (t) => {
    if (!browser) return t.skip("Chromium isn't installed");
    const { page, goto } = await open(t);
    await goto();
    await assert.rejects(installGlasses(page, {}), /before page\.goto/);

    const fresh = await open(t, { fakeGlasses: {} });
    await assert.rejects(installGlasses(fresh.page, {}), /already on this page/);

    const other = await open(t);
    await assert.rejects(installGlasses(other.page, { photos: ["fixtures/none.jpg"] }), /Add the photo to fixtures/);
    await assert.rejects(installGlasses(other.page, { photos: [question] }), /isn't a photo/);
    await assert.rejects(installGlasses(other.page, { question: "fixtures/none.wav" }), /Add the recording to fixtures/);
    await assert.rejects(fake.spoken(await browser.newPage()), /installGlasses\(page\) first/);
  });
});
