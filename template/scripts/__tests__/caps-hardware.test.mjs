// The hardware cap's overlay (docs/CAPABILITIES.md, section 19): which files it writes, the DeviceLink helpers against the
// simulated port, serial, USB and Bluetooth alike, plain messages where the browser can't, and the fixed
// checks. lib/platform/board.ts imports "@/lib/meta/client", which only a product folder resolves, so it runs in a real build. Run from the repo root:
//   npx tsx --test template/scripts/__tests__/caps-hardware.test.mjs
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const TEMPLATE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OVERLAY = path.join(TEMPLATE, "caps/hardware/files");

function walk(dir, base = dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? (e.name === "node_modules" ? [] : walk(path.join(dir, e.name), base)) : [path.relative(base, path.join(dir, e.name)).split(path.sep).join("/")],
  );
}
const load = (f) => import(pathToFileURL(path.join(OVERLAY, f)).href);

const hardware = await load("lib/platform/hardware.ts");
const { installFakeDevices } = await load("tests/caps/hardware-fake.ts");
const checker = await load("scripts/caps/hardware.mjs");

function clearDevices() {
  for (const name of ["serial", "usb", "bluetooth"]) delete navigator[name];
  delete globalThis.__musemuseFakeDevices;
}
after(clearDevices);

const nextData = (link) => new Promise((resolve) => { const off = link.onData((b) => { off(); resolve(new TextDecoder().decode(b)); }); });
const nextLine = (link) => new Promise((resolve) => { const off = link.onLine((l) => { off(); resolve(l); }); });

describe("the overlay's files", () => {
  test("write no path the template, a target overlay or another cap overlay writes", () => {
    const own = walk(OVERLAY);
    const others = [
      ...walk(TEMPLATE).filter((f) => !f.startsWith("targets/") && !f.startsWith("caps/")),
      ...readdirSync(path.join(TEMPLATE, "targets")).flatMap((t) => walk(path.join(TEMPLATE, "targets", t, "files"))),
      ...readdirSync(path.join(TEMPLATE, "caps")).filter((c) => c !== "hardware").flatMap((c) => walk(path.join(TEMPLATE, "caps", c, "files"))),
    ];
    assert.deepEqual(own.filter((f) => others.includes(f)), []);
  });

  test("are all platform files, and there are no new packages", () => {
    assert.deepEqual(JSON.parse(readFileSync(path.join(TEMPLATE, "caps/hardware/platform-files.json"), "utf8")).sort(), walk(OVERLAY).sort());
    assert.deepEqual(JSON.parse(readFileSync(path.join(TEMPLATE, "caps/hardware/deps.json"), "utf8")), { dependencies: {}, devDependencies: {} });
  });

  test("the owner landing is a static segment, with no em dash anywhere a person reads", () => {
    assert.ok(existsSync(path.join(OVERLAY, "app/api/musemuse/board/owner/route.ts")));
    for (const f of walk(OVERLAY)) assert.equal(readFileSync(path.join(OVERLAY, f), "utf8").includes(String.fromCharCode(0x2014)), false, f);
  });

  test("the skill and the helpers keep the gateway's numbers", () => {
    const board = readFileSync(path.join(OVERLAY, "lib/platform/board.ts"), "utf8");
    assert.match(board, /SHOW_TEXT_MAX_CHARS = 200/);
    assert.match(board, /identityHeaders\(request\)/);
    assert.doesNotMatch(board, /run_command/);
  });

  test("the helpers need the request: leaving it out fails the build, since the simulated board wouldn't notice", () => {
    const board = readFileSync(path.join(OVERLAY, "lib/platform/board.ts"), "utf8");
    assert.match(board, /type WithRequest = \{ request: RequestLike \| null \}/);
    for (const signature of [/readSensor\(opts: \{ sensor\?: string \} & WithRequest\)/, /showText\(text: string, opts: WithRequest\)/, /boardPhoto\(opts: WithRequest\)/, /boardSound\(opts: \{ seconds\?: number \} & WithRequest\)/]) assert.match(board, signature);
    assert.doesNotMatch(board, /request\?: RequestLike/);
    const skill = readFileSync(path.join(OVERLAY, ".agents/skills/muse-hardware/SKILL.md"), "utf8");
    assert.match(skill, /without it a live board refuses the owner/);
    assert.match(skill, /boardMessage\(err\)/);
    assert.match(skill, /boardPhoto\(\{ request \}\)/);
    assert.match(skill, /Open as owner/);
    assert.match(board, /exportToDrive\(opts: \{ approval\?: string \} & WithRequest\)/);
    assert.match(board, /driveStatus\(opts: WithRequest\)/);
    assert.match(skill, /Never send it by yourself/);
    assert.match(skill, /needs_erase/);
    assert.doesNotMatch(skill, /\u2014/);
  });
});

describe("a board's answers, through the real helpers with a fake gateway", () => {
  let dir;
  let board;
  const realFetch = globalThis.fetch;
  const asked = [];
  let answer;

  before(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "mm-hardware-board-"));
    writeFileSync(path.join(dir, "client.mjs"), 'export const gatewayEnv = () => ({ baseURL: "https://gateway.example/v1", apiKey: "made-up" });\n');
    writeFileSync(path.join(dir, "identity.mjs"), 'export const identityHeaders = (request) => (request ? { "x-owner": request.pass } : {});\n');
    cpSync(path.join(OVERLAY, "lib/platform/board-errors.ts"), path.join(dir, "board-errors.ts"));
    const source = readFileSync(path.join(OVERLAY, "lib/platform/board.ts"), "utf8")
      .replace('"@/lib/meta/client"', '"./client.mjs"')
      .replace('"@/lib/platform/board-errors"', '"./board-errors.ts"')
      .replace('"@/lib/platform/identity"', '"./identity.mjs"');
    writeFileSync(path.join(dir, "board.ts"), source);
    board = await import(pathToFileURL(path.join(dir, "board.ts")).href);
    globalThis.fetch = async (url, init) => {
      asked.push({ url, headers: init.headers, body: JSON.parse(init.body) });
      return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200 });
    };
  });
  after(() => {
    globalThis.fetch = realFetch;
    rmSync(dir, { recursive: true, force: true });
  });

  const request = { pass: "owners-pass" };
  const fails = async (status, code) => {
    answer = { status, body: { error: { code, message: "words" } } };
    return board.readSensor({ request }).then(() => assert.fail("it should throw"), (err) => err);
  };

  test("readSensor and showText send the tool, its arguments and the owner's pass", async () => {
    answer = { body: { content: [{ type: "text", text: '{"sensors":[{"name":"cpu"}]}' }], simulated: false } };
    assert.deepEqual((await board.readSensor({ sensor: "cpu", request })).sensors, [{ name: "cpu" }]);
    const sent = asked.at(-1);
    assert.equal(sent.url, "https://gateway.example/gadget");
    assert.deepEqual(sent.body, { tool: "read_sensor", arguments: { sensor: "cpu" } });
    assert.equal(sent.headers["x-owner"], "owners-pass");
  });

  test("boardPhoto and boardSound send the owner's pass too, which takePhoto doesn't", async () => {
    answer = { body: { content: [{ type: "image", data: "AAAA", mimeType: "image/jpeg" }], simulated: true } };
    assert.deepEqual(await board.boardPhoto({ request }), { dataUrl: "data:image/jpeg;base64,AAAA", simulated: true });
    assert.equal(asked.at(-1).body.tool, "capture_image");
    assert.equal(asked.at(-1).headers["x-owner"], "owners-pass");
    answer = { body: { content: [{ type: "text", text: "{}" }, { type: "audio", data: "BBBB", mimeType: "audio/wav" }], simulated: false } };
    assert.equal((await board.boardSound({ seconds: 99, request })).dataUrl, "data:audio/wav;base64,BBBB");
    assert.deepEqual(asked.at(-1).body, { tool: "record_audio", arguments: { seconds: 30 } });
    answer = { body: { content: [{ type: "text", text: "{}" }] } };
    await assert.rejects(board.boardPhoto({ request }), (err) => err.code === "board_tool_error");
  });

  test("driveStatus and exportToDrive send only the tool, own model, the approval and the owner's pass", async () => {
    answer = { body: { content: [{ type: "text", text: '{"drives":[],"export":null}' }], simulated: true } };
    assert.deepEqual(await board.driveStatus({ request }), { drives: [], export: null, simulated: true });
    assert.deepEqual(asked.at(-1).body, { tool: "drive_status", arguments: {} });
    assert.equal(asked.at(-1).headers["x-owner"], "owners-pass");

    answer = { body: { content: [{ type: "text", text: '{"ok":false,"code":"needs_confirmation","approval":{"id":"ap1.x","title":"Put this model on your drive?","lines":["Model: x"]}}' }], simulated: false } };
    const card = await board.exportToDrive({ request });
    assert.equal(card.code, "needs_confirmation");
    assert.deepEqual(asked.at(-1).body, { tool: "export_to_drive", arguments: { model: "own" } });
    assert.equal(asked.at(-1).headers["x-owner"], "owners-pass");

    answer = { body: { content: [{ type: "text", text: '{"ok":true,"export":"exp_1","state":"checking"}' }], simulated: false } };
    assert.equal((await board.exportToDrive({ approval: card.approval.id, request })).ok, true);
    assert.deepEqual(asked.at(-1).body, { tool: "export_to_drive", arguments: { model: "own" }, approval: "ap1.x" });
  });

  test("a drive export's refusals show the gateway's own sentence", async () => {
    for (const code of ["no_drive", "several_drives", "export_busy", "own_model_not_ready", "license_duties_missing"]) {
      answer = { status: 409, body: { error: { code, message: `the words for ${code}` } } };
      const err = await board.exportToDrive({ request }).then(() => assert.fail("it should throw"), (e) => e);
      assert.equal(err.code, code);
      assert.equal(board.boardMessage(err), `the words for ${code}`);
    }
  });

  test("every way a board says no has a line to show", async () => {
    const offline = await fails(503, "gadget_offline");
    assert.equal(board.isBoardOffline(offline), true);
    assert.match(board.boardMessage(offline), /isn't available/);
    assert.match(board.boardMessage(await fails(502, "gadget_unavailable")), /isn't available/);
    const limited = await fails(429, "rate_limited");
    assert.equal(board.isBoardOffline(limited), false);
    assert.match(board.boardMessage(limited), /too many requests/);
    answer = { body: { isError: true, content: [{ type: "text", text: "This board has no sensors it can read." }] } };
    const noSensors = await board.readSensor({ request }).catch((err) => err);
    assert.equal(noSensors.code, "board_tool_error");
    assert.equal(board.isBoardOffline(noSensors), false);
    assert.match(board.boardMessage(noSensors), /couldn't do that/);
    assert.match(board.boardMessage(await fails(500, "something_new")), /didn't answer/);
    assert.equal(board.boardMessage(new Error("a bug")), null, "a bug isn't a board's no");
  });
});

describe("where the browser can't", () => {
  beforeEach(clearDevices);
  test("says so in plain words, for each kind of link", async () => {
    for (const [kind, connect] of [["serial", () => hardware.connectSerial()], ["usb", () => hardware.connectUsb({ filters: [] })], ["bluetooth", () => hardware.connectBluetooth({ service: "s" })]]) {
      assert.equal(hardware.linkSupported(kind), false);
      await assert.rejects(connect(), (err) => err.code === "unsupported" && /Chrome or Edge/.test(err.message) && /iPhone/.test(err.message));
    }
  });
  test("refused inside a frame, it says to open its own tab, and only there", async () => {
    Object.defineProperty(navigator, "serial", { value: { requestPort: async () => { throw new DOMException("internal words", "SecurityError"); } }, configurable: true });
    const realWindow = globalThis.window;
    try {
      globalThis.window = { self: {}, top: {} };
      await assert.rejects(hardware.connectSerial(), (err) => err.code === "framed" && err.message === hardware.FRAMED_MESSAGE && /own tab/.test(err.message));
      const same = {};
      globalThis.window = { self: same, top: same };
      await assert.rejects(hardware.connectSerial(), (err) => err.code === "failed" && /https/.test(err.message));
      Object.defineProperty(navigator, "serial", { value: { requestPort: async () => { throw new DOMException("internal words", "NotAllowedError"); } }, configurable: true });
      globalThis.window = { self: {}, top: {} };
      await assert.rejects(hardware.connectSerial(), (err) => err.code === "failed", "a missing click isn't the frame's fault");
    } finally {
      if (realWindow === undefined) delete globalThis.window;
      else globalThis.window = realWindow;
    }
  });
  test("the picker being closed is 'cancelled', and a browser's own words never show", async () => {
    Object.defineProperty(navigator, "serial", { value: { requestPort: async () => { throw new DOMException("internal words", "NotFoundError"); } }, configurable: true });
    await assert.rejects(hardware.connectSerial(), (err) => err.code === "cancelled" && !/internal/.test(err.message));
    Object.defineProperty(navigator, "serial", { value: { requestPort: async () => { throw new DOMException("internal words", "SecurityError"); } }, configurable: true });
    await assert.rejects(hardware.connectSerial(), (err) => err.code === "failed" && !/internal/.test(err.message));
  });
});

describe("against the simulated port", () => {
  beforeEach(() => {
    clearDevices();
    installFakeDevices({ reply: "TEMP 21.4\n", greeting: "HELLO\n" });
  });

  const links = {
    serial: () => hardware.connectSerial({ baudRate: 115200 }),
    usb: () => hardware.connectUsb({ filters: [{ vendorId: 1 }] }),
    bluetooth: () => hardware.connectBluetooth({ service: "svc", notify: "notify-uuid", write: "write-uuid" }),
  };

  for (const [kind, open] of Object.entries(links)) {
    test(`${kind}: the port gets the bytes the product sent, and the product gets the reply`, async () => {
      assert.equal(hardware.linkSupported(kind), true);
      const link = await open();
      assert.equal(link.kind, kind);
      assert.equal(await nextLine(link), "HELLO", "what came before the first listener is kept for it");
      const reply = nextData(link);
      await link.send("READ\n");
      assert.equal(await reply, "TEMP 21.4\n");
      const record = globalThis.__musemuseFakeDevices;
      assert.deepEqual(record.connected, [kind]);
      assert.deepEqual(record.sent, [{ link: kind, bytes: [...new TextEncoder().encode("READ\n")] }]);
      await link.close();
      await assert.rejects(link.send("again"), /isn't connected/);
    });
  }

  test("bytes go as they are, and lines come back whole across chunks", async () => {
    const link = await links.serial();
    const lines = [];
    link.onLine((l) => lines.push(l));
    await link.send(new Uint8Array([1, 2, 3]));
    await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual(globalThis.__musemuseFakeDevices.sent.at(-1).bytes, [1, 2, 3]);
    assert.deepEqual(lines, ["HELLO", "TEMP 21.4"]);
    await link.close();
  });
});

describe("the fixed checks", () => {
  const ids = (out) => Object.fromEntries(out.map((c) => [c.id, c.ok]));
  const LINK_OK = { checks: [{ id: "link-sent", ok: true, detail: "d" }, { id: "link-reply", ok: true, detail: "d" }] };

  test("fail with no gateway record, or a brief that asks for nothing", async () => {
    assert.deepEqual(ids(await checker.check({ record: LINK_OK, proof: null })), { gateway: false });
    assert.deepEqual(ids(await checker.check({ record: LINK_OK, proof: {} })), { brief: false });
  });

  test("browser links: the bytes and the reply", async () => {
    const proof = { "brief:links": 1, read_sensor: 0, show_text: 0 };
    assert.deepEqual(ids(await checker.check({ record: LINK_OK, proof })), { "link-sent": true, "link-reply": true });
    assert.deepEqual(ids(await checker.check({ record: { checks: [] }, proof })), { "link-sent": false, "link-reply": false });
  });

  test("board tools: a product's own record can't pass without the gateway's", async () => {
    const shown = { checks: [{ id: "board-shown", ok: true }] };
    const asks = { "brief:boardTools": 1 };
    assert.deepEqual(ids(await checker.check({ record: shown, proof: { ...asks, read_sensor: 0, show_text: 0 } })), { "board-tool": false, "board-limit": true, "board-shown": true });
    assert.deepEqual(ids(await checker.check({ record: shown, proof: { ...asks, read_sensor: 1, show_text: 1 } })), { "board-tool": true, "board-limit": true, "board-shown": true });
    assert.equal(ids(await checker.check({ record: shown, proof: { ...asks, read_sensor: 5, show_text: 0 } }))["board-limit"], false);
    const drive = { "brief:driveExport": 1 };
    const driveShown = { checks: [{ id: "drive-shown", ok: true, detail: "shown" }] };
    assert.deepEqual(ids(await checker.check({ record: driveShown, proof: { ...drive, export_to_drive: 1 } })), { "drive-tool": true, "drive-shown": true });
    assert.deepEqual(ids(await checker.check({ record: driveShown, proof: { ...drive, export_to_drive: 0 } })), { "drive-tool": false, "drive-shown": true });
    assert.deepEqual(ids(await checker.check({ record: { checks: [] }, proof: { ...drive, export_to_drive: 1 } })), { "drive-tool": true, "drive-shown": false });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// checkDeviceLink in Chromium: needs template/node_modules and Playwright's Chromium, skipped without them

const MODULES = path.join(TEMPLATE, "node_modules");
const playwright = existsSync(MODULES) ? await import(pathToFileURL(path.join(MODULES, "@playwright/test/index.mjs")).href).catch(() => null) : null;
let browserProblem = playwright ? null : "template/node_modules isn't installed";
const browser = playwright
  ? await playwright.chromium.launch().catch((err) => {
      browserProblem = `Playwright's Chromium didn't start (${String(err?.message ?? err).split("\n")[0]})`;
      return null;
    })
  : null;
after(() => browser?.close());

describe("device links in a cross-origin frame, in Chromium", { skip: browserProblem ?? false }, () => {
  // The frame's two origins are real ones on this machine, so it's truly cross-origin, and both are secure contexts. The
  // allow values are read from lib/product-frame.ts's output in lib/__tests__/product-frame.test.ts.
  const SANDBOX = "allow-scripts allow-same-origin allow-forms allow-popups allow-downloads";
  let server;
  let port;
  const PRODUCT = `<!doctype html><title>product</title><button id=go>Connect</button><p id=out></p><script>
    document.getElementById("go").onclick = () => navigator.serial.requestPort().then(() => "picked", (e) => e.name).then((r) => { document.getElementById("out").textContent = r; });
  </script>`;

  before(async () => {
    const { createServer } = await import("node:http");
    server = createServer((req, res) => {
      res.setHeader("content-type", "text/html");
      if (req.url === "/product") return res.end(PRODUCT);
      const allow = new URL(req.url, "http://x").searchParams.get("allow");
      res.end(`<!doctype html><title>page</title><iframe id=f src="http://localhost:${port}/product" sandbox="${SANDBOX}" allow="${allow}"></iframe>`);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = server.address().port;
  });
  after(() => server?.close());

  async function connectIn(allow) {
    const page = await browser.newPage();
    try {
      await page.goto(`http://127.0.0.1:${port}/?allow=${encodeURIComponent(allow)}`);
      const frame = page.frameLocator("#f");
      const allowed = await page.frames()[1].evaluate(() => ["serial", "usb", "bluetooth"].filter((f) => document.featurePolicy?.allowsFeature(f)));
      await frame.locator("#go").click();
      // The picker has no one to answer it in a test browser, so only a refusal is expected to finish.
      const refused = await frame.locator("#out").textContent({ timeout: 1500 }).then((t) => t || null, () => null);
      await page.waitForTimeout(500);
      return { allowed, result: refused || (await frame.locator("#out").textContent()) };
    } finally {
      await page.close();
    }
  }

  test("without the allow values a device picker is refused, the way plainError's framed message expects", async () => {
    const { allowed, result } = await connectIn("clipboard-write; fullscreen");
    assert.deepEqual(allowed, []);
    assert.equal(result, "SecurityError");
  });

  test("with them it isn't refused for being in a frame", async () => {
    const { allowed, result } = await connectIn("clipboard-write; fullscreen; serial; usb; bluetooth");
    assert.deepEqual(allowed, ["serial", "usb", "bluetooth"]);
    assert.notEqual(result, "SecurityError");
  });
});

describe("checkDeviceLink in Chromium", { skip: browserProblem ?? false }, () => {
  let dir;
  let H;
  let helperJs;
  const startDir = process.cwd();

  before(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "mm-hardware-"));
    for (const o of ["core", "hardware"]) cpSync(path.join(TEMPLATE, "caps", o, "files"), dir, { recursive: true });
    cpSync(path.join(TEMPLATE, "tests/judge-shot.ts"), path.join(dir, "tests/judge-shot.ts"));
    for (const f of ["xr.ts", "demo-fixtures.ts"]) cpSync(path.join(TEMPLATE, "tests", f), path.join(dir, "tests", f));
    symlinkSync(MODULES, path.join(dir, "node_modules"));
    process.chdir(dir);
    H = await import(pathToFileURL(path.join(dir, "tests/caps/hardware.ts")).href);
    const { build } = await import("esbuild");
    const built = await build({ entryPoints: [path.join(OVERLAY, "lib/platform/hardware.ts")], bundle: true, format: "iife", globalName: "H", write: false, keepNames: false, target: "es2022" });
    helperJs = built.outputFiles[0].text;
  });
  after(() => {
    process.chdir(startDir);
    rmSync(dir, { recursive: true, force: true });
  });

  const PAGE = (kind, connect, { sends = true, shows = true } = {}) => `<!doctype html><title>t</title><script>${helperJs}</script>
    <button id=c>Connect</button><button id=s>Read</button><p id=out></p>
    <script>
      let link;
      document.getElementById("c").onclick = async () => { link = await H.${connect}; link.onLine((l) => { ${shows ? 'document.getElementById("out").textContent = l;' : ""} }); };
      document.getElementById("s").onclick = () => { ${sends ? 'void link.send("READ\\n");' : ""} };
    </script>`;

  async function run(kind, connect, opts) {
    const page = await browser.newPage();
    try {
      await page.addInitScript("globalThis.__name = (f) => f");
      await H.useFakeDevices(page, { reply: "TEMP 21.4\n" });
      await page.route("http://product.test/", (r) => r.fulfill({ contentType: "text/html", body: PAGE(kind, connect, opts) }));
      await page.goto("http://product.test/");
      const err = await H.checkDeviceLink(page, {
        link: kind,
        connect: (p) => p.getByRole("button", { name: "Connect" }).click(),
        exchange: (p) => p.getByRole("button", { name: "Read" }).click(),
        shows: "21.4",
      }).then(() => null, (e) => e);
      const record = JSON.parse(readFileSync(path.join(dir, "test-results/caps/hardware.json"), "utf8"));
      return { err, checks: Object.fromEntries(record.checks.map((c) => [c.id, c])) };
    } finally {
      await page.close();
      rmSync(path.join(dir, "test-results"), { recursive: true, force: true });
    }
  }

  for (const [kind, connect] of [["serial", 'connectSerial({ baudRate: 9600 })'], ["usb", 'connectUsb({ filters: [{ vendorId: 1 }] })'], ["bluetooth", 'connectBluetooth({ service: "svc", notify: "notify-uuid", write: "write-uuid" })']]) {
    test(`${kind}: a product that sends and shows passes both checks`, async () => {
      const { err, checks } = await run(kind, connect);
      assert.equal(err, null);
      assert.equal(checks["link-sent"].ok, true);
      assert.equal(checks["link-reply"].ok, true);
    });
  }

  test("a product that never sends fails link-sent", { timeout: 60_000 }, async () => {
    const { err, checks } = await run("serial", 'connectSerial()', { sends: false });
    assert.match(String(err?.message), /got nothing/);
    assert.equal(checks["link-sent"].ok, false);
  });

  test("a product that doesn't show the reply fails link-reply", { timeout: 60_000 }, async () => {
    const { err, checks } = await run("serial", 'connectSerial()', { shows: false });
    assert.match(String(err?.message), /didn't show/);
    assert.equal(checks["link-reply"].ok, false);
  });
});
