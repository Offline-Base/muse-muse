// The live cap's overlay (docs/CAPABILITIES.md, section 13): cutting audio and taking out repeats, following the stream,
// the fixed checks, the routes against a fake gateway, tsc with the overlay applied, and useCaptions and useLive in real
// Chromium with its fake microphone playing fixtures/talk.wav. Run from the repo root:
//   npx tsx --test template/scripts/__tests__/caps-live.test.mjs
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const TEMPLATE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const LIVE = path.join(TEMPLATE, "caps/live/files");
const CORE = path.join(TEMPLATE, "caps/core/files");
const AGENT = path.join(TEMPLATE, "targets/agent/files");
const modules = path.join(TEMPLATE, "node_modules");
const noTemplateModules = existsSync(modules) ? null : "needs template/node_modules";
const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function walk(dir, base = dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? (e.name === "node_modules" ? [] : walk(path.join(dir, e.name), base)) : [path.relative(base, path.join(dir, e.name)).split(path.sep).join("/")],
  );
}

const chunks = await import(pathToFileURL(path.join(LIVE, "lib/platform/captions-chunks.ts")).href);
const state = await import(pathToFileURL(path.join(LIVE, "lib/platform/live-state.ts")).href);
const checker = await import(pathToFileURL(path.join(LIVE, "scripts/caps/live.mjs")).href);

describe("the overlay's files", () => {
  test("write no path the template, a target overlay or another cap overlay writes", () => {
    const own = walk(LIVE);
    const others = [
      ...walk(TEMPLATE).filter((f) => !f.startsWith("targets/") && !f.startsWith("caps/")),
      ...readdirSync(path.join(TEMPLATE, "targets")).flatMap((t) => walk(path.join(TEMPLATE, "targets", t, "files"))),
      ...readdirSync(path.join(TEMPLATE, "caps")).filter((c) => c !== "live").flatMap((c) => walk(path.join(TEMPLATE, "caps", c, "files"))),
    ];
    assert.deepEqual(own.filter((f) => others.includes(f)), []);
  });

  test("are all platform files", () => {
    assert.deepEqual(JSON.parse(readFileSync(path.join(TEMPLATE, "caps/live/platform-files.json"), "utf8")).sort(), walk(LIVE).sort());
  });

  test("the routes are static segments beside the agent kit's catch-all", () => {
    assert.ok(existsSync(path.join(AGENT, "app/api/musemuse/[...path]/route.ts")));
    for (const f of ["app/api/musemuse/live-caption/route.ts", "app/api/musemuse/live-ticket/route.ts"]) assert.ok(!walk(AGENT).includes(f), f);
  });

  test("the fixture is a 16 kHz mono 16-bit WAV of about 15 seconds, small enough to ship", () => {
    const wav = readFileSync(path.join(LIVE, "fixtures/talk.wav"));
    assert.equal(wav.toString("latin1", 0, 4), "RIFF");
    assert.equal(wav.toString("latin1", 8, 12), "WAVE");
    assert.ok(wav.byteLength < 600_000);
    let at = 12;
    let fmt = null;
    while (at + 8 <= wav.byteLength) {
      const id = wav.toString("latin1", at, at + 4);
      const size = wav.readUInt32LE(at + 4);
      if (id === "fmt ") fmt = { format: wav.readUInt16LE(at + 8), channels: wav.readUInt16LE(at + 10), rate: wav.readUInt32LE(at + 12), bits: wav.readUInt16LE(at + 22) };
      at += 8 + size + (size % 2);
    }
    assert.deepEqual(fmt, { format: 1, channels: 1, rate: 16000, bits: 16 });
  });

  test("the browser args name the fixture, and a browser.json Playwright can read", () => {
    const { args } = JSON.parse(readFileSync(path.join(LIVE, "scripts/caps/live.browser.json"), "utf8"));
    assert.deepEqual(args, ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--use-file-for-fake-audio-capture=fixtures/talk.wav"]);
  });

  test("the skill names every helper, and nothing a person reads has an em dash", () => {
    const skill = readFileSync(path.join(LIVE, ".agents/skills/muse-live/SKILL.md"), "utf8");
    for (const name of ["useCaptions", "CAPTIONS_NOTICE", "useLive", "checkCaptions", "checkLiveUpdate", "fixtures/talk.wav", "10-captions", "11-second-browser-live"]) assert.ok(skill.includes(name), name);
    for (const f of walk(LIVE).filter((x) => !x.endsWith(".wav"))) assert.ok(!readFileSync(path.join(LIVE, f), "utf8").includes("—"), f);
  });
});

describe("cutting audio into pieces", () => {
  const RATE = 1000;
  const ramp = (from, n) => Float32Array.from({ length: n }, (_, i) => from + i);

  test("each piece has chunkMs of new audio and the overlap before it, with its own times", () => {
    const cutter = new chunks.ChunkCutter(RATE, { chunkMs: 2500, overlapMs: 400 });
    assert.deepEqual(cutter.push(ramp(0, 2499)), []);
    const [first, ...more] = cutter.push(ramp(2499, 1));
    assert.deepEqual(more, []);
    assert.deepEqual([first.startMs, first.endMs, first.samples.length], [0, 2500, 2500]);
    const [second] = cutter.push(ramp(2500, 2500));
    assert.deepEqual([second.startMs, second.endMs, second.samples.length], [2100, 5000, 2900]);
    assert.equal(second.samples[0], 2100, "it starts 400 ms back, with the very samples the first piece ended on");
    assert.equal(second.samples.at(-1), 4999);
  });

  test("audio that arrives in one lump still comes out in pieces, in order, with nothing lost", () => {
    const cutter = new chunks.ChunkCutter(RATE, { chunkMs: 2000, overlapMs: 400 });
    const pieces = cutter.push(ramp(0, 6000));
    assert.deepEqual(pieces.map((p) => [p.startMs, p.endMs]), [[0, 2000], [1600, 4000], [3600, 6000]]);
    const heard = new Set(pieces.flatMap((p) => [...p.samples]));
    assert.equal(heard.size, 6000);
  });

  test("chunk length stays between 2 and 3 seconds, whatever's asked", () => {
    assert.equal(new chunks.ChunkCutter(RATE, { chunkMs: 500 }).push(ramp(0, 2000))[0].endMs, 2000);
    assert.equal(new chunks.ChunkCutter(RATE, { chunkMs: 9000 }).push(ramp(0, 3000))[0].endMs, 3000);
    assert.deepEqual(new chunks.ChunkCutter(RATE).push(ramp(0, 2500)).map((p) => p.endMs), [2500]);
  });

  test("stopping sends what's new, but not a sliver, and not the overlap alone", () => {
    const cutter = new chunks.ChunkCutter(RATE, { chunkMs: 2500, overlapMs: 400 });
    cutter.push(ramp(0, 2500));
    assert.equal(cutter.flush(), null, "only the overlap is left");
    cutter.push(ramp(2500, 300));
    assert.equal(cutter.flush(), null, "300 ms isn't worth a call");
    cutter.push(ramp(2800, 500));
    const last = cutter.flush();
    assert.deepEqual([last.startMs, last.endMs], [2100, 3300]);
    assert.equal(cutter.flush(), null, "and only once");
  });

  test("a quiet piece isn't sent", () => {
    assert.equal(chunks.isSilent(new Float32Array(100)), true);
    assert.equal(chunks.isSilent(new Float32Array(0)), true);
    assert.equal(chunks.isSilent(Float32Array.from({ length: 100 }, (_, i) => Math.sin(i / 3) * 0.2)), false);
  });
});

describe("taking out what the overlap repeats", () => {
  test("drops the words the last piece ended on, whatever their capitals and punctuation", () => {
    assert.equal(chunks.trimOverlap("the river cuts a wider", "wider valley and the farms"), "valley and the farms");
    assert.equal(chunks.trimOverlap("the river, cuts a wider.", "A Wider valley"), "valley");
    assert.equal(chunks.trimOverlap("down to the sea", "the sea. Over many years"), "Over many years");
  });

  test("keeps everything when nothing repeats, and takes the longest match", () => {
    assert.equal(chunks.trimOverlap("water moves slowly", "across the plain"), "across the plain");
    assert.equal(chunks.trimOverlap("no no", "no no no way"), "no way");
    assert.equal(chunks.trimOverlap("", "hello there"), "hello there");
    assert.equal(chunks.trimOverlap("hello", ""), "");
    assert.equal(chunks.trimOverlap("a b c d e f g h", "b c d e f g h i"), "b c d e f g h i", "past 6 words it isn't an overlap");
  });

  test("a piece that carries on mid-sentence takes back the full stop the model ended the last one with", () => {
    // The real model's words for fixtures/talk.wav's first three pieces (Oct 2026, docs/CAPABILITIES.md, 13a).
    let list = [];
    for (const [text, startMs, endMs] of [["Good morning and welcome to the first lecture on.", 0, 2500], ["on how river river shake the land, water moves slowly..", 2100, 5000], ["slowly across the plate.", 4600, 7500]]) list = chunks.addCaption(list, { text, startMs, endMs });
    assert.equal(list.map((c) => c.text).join(" "), "Good morning and welcome to the first lecture on how river river shake the land, water moves slowly across the plate.");
    const sentence = chunks.addCaption([{ text: "That was all.", startMs: 0, endMs: 2500 }], { text: "Next we turn.", startMs: 2100, endMs: 5000 });
    assert.equal(sentence[0].text, "That was all.", "a new sentence keeps it");
  });

  test("addCaption keeps times, removes repeats only across a real overlap, and adds nothing for no new words", () => {
    let list = chunks.addCaption([], { text: " Good morning and ", startMs: 0, endMs: 2500 });
    assert.deepEqual(list, [{ text: "Good morning and", startMs: 0, endMs: 2500 }]);
    list = chunks.addCaption(list, { text: "and welcome to", startMs: 2100, endMs: 5000 });
    assert.deepEqual(list[1], { text: "welcome to", startMs: 2100, endMs: 5000 });
    assert.equal(chunks.addCaption(list, { text: "to", startMs: 4600, endMs: 7500 }).length, 2);
    assert.equal(chunks.addCaption(list, { text: "   ", startMs: 8000, endMs: 9000 }).length, 2);
    assert.equal(chunks.addCaption(list, { text: "to the first", startMs: 9000, endMs: 11000 })[2].text, "to the first", "silence left a gap, so it isn't a repeat");
  });
});

describe("following the stream", () => {
  const put = (seq, id, data = {}) => ({ seq, op: "put", id, data });

  test("a put adds or moves an item to the end, a delete takes it away, and a repeat changes nothing", () => {
    let items = [];
    items = state.applyLiveChange(items, put(1, "a", { n: 1 }));
    items = state.applyLiveChange(items, put(2, "b"));
    items = state.applyLiveChange(items, put(3, "a", { n: 2 }));
    assert.deepEqual(items.map((i) => [i.id, i.seq]), [["b", 2], ["a", 3]]);
    assert.deepEqual(items.at(-1).data, { n: 2 });
    assert.equal(state.applyLiveChange(items, put(3, "a", { n: 9 })), items, "a reconnect's repeat");
    assert.equal(state.applyLiveChange(items, put(1, "a", { n: 0 })), items, "an older change");
    items = state.applyLiveChange(items, { seq: 4, op: "delete", id: "b", data: null });
    assert.deepEqual(items.map((i) => i.id), ["a"]);
    assert.deepEqual(state.applyLiveChange(items, { seq: 5, op: "delete", id: "never", data: null }).map((i) => i.id), ["a"]);
  });

  test("keeps the newest changes up to its limit", () => {
    let items = [];
    for (let i = 1; i <= 5; i++) items = state.applyLiveChange(items, put(i, `r${i}`), 3);
    assert.deepEqual(items.map((i) => i.id), ["r3", "r4", "r5"]);
  });

  test("reads only real changes", () => {
    assert.deepEqual(state.readLiveChange('{"seq":1,"op":"put","id":"a","data":{}}'), put(1, "a"));
    for (const bad of ["not json", "{}", '{"seq":"1","op":"put","id":"a"}', '{"seq":1,"op":"x","id":"a"}', '{"seq":1,"op":"put"}', "null"]) assert.equal(state.readLiveChange(bad), null, bad);
  });

  test("backs off to at most 30 seconds, with a spread so everyone doesn't come back at once", () => {
    assert.equal(state.liveBackoffMs(1, () => 0.5), 1000);
    assert.equal(state.liveBackoffMs(3, () => 0.5), 4000);
    assert.equal(state.liveBackoffMs(50, () => 0.5), 30000);
    assert.equal(state.liveBackoffMs(1, () => 0), 750);
  });
});

describe("the fixed checks (scripts/caps/live.mjs)", () => {
  const good = {
    checks: [
      { id: "notice", ok: true, detail: "said" },
      { id: "chunks", ok: true, detail: "2 pieces" },
      { id: "shown", ok: true, detail: "shown" },
      { id: "live-update", ok: true, detail: "1200 ms" },
    ],
  };
  const proof = { "brief:captions": 1, "brief:updates": 1, chunks: 2, tickets: 2, streams: 2, events: 1 };
  const failed = async (args) => (await checker.check(args)).filter((c) => !c.ok).map((c) => c.id);

  test("pass with both records", async () => {
    const out = await checker.check({ record: good, proof });
    assert.deepEqual(out.map((c) => c.id), ["notice", "chunks", "chunk-limit", "shown", "live-update"]);
    assert.ok(out.every((c) => c.ok), JSON.stringify(out));
  });

  test("ask only for what the brief has", async () => {
    assert.deepEqual((await checker.check({ record: good, proof: { "brief:captions": 1, chunks: 2 } })).map((c) => c.id), ["notice", "chunks", "chunk-limit", "shown"]);
    assert.deepEqual((await checker.check({ record: good, proof: { "brief:updates": 1, streams: 1, events: 1 } })).map((c) => c.id), ["live-update"]);
  });

  test("fail with no gateway record, or a brief with neither", async () => {
    assert.deepEqual(await failed({ record: good, proof: null }), ["gateway"]);
    assert.deepEqual(await failed({ record: good, proof: { chunks: 2 } }), ["brief"]);
  });

  test("a product's record alone isn't enough: the gateway has to have taken the pieces and sent the change", async () => {
    assert.deepEqual(await failed({ record: good, proof: { ...proof, chunks: 1 } }), ["chunks"]);
    assert.deepEqual(await failed({ record: good, proof: { ...proof, streams: 0 } }), ["live-update"]);
    assert.deepEqual(await failed({ record: good, proof: { ...proof, events: 0 } }), ["live-update"]);
  });

  test("the gateway's record alone isn't enough either", async () => {
    assert.deepEqual(await failed({ record: { checks: [] }, proof }), ["notice", "chunks", "shown", "live-update"]);
    const bad = { checks: good.checks.map((c) => (c.id === "live-update" ? { ...c, ok: false, detail: "no" } : c)) };
    assert.deepEqual(await failed({ record: bad, proof }), ["live-update"]);
  });

  test("fail a smoke test past its pieces", async () => {
    assert.deepEqual(await failed({ record: good, proof: { ...proof, chunks: 6 } }), []);
    assert.deepEqual(await failed({ record: good, proof: { ...proof, chunks: 7 } }), ["chunk-limit"]);
  });
});

describe("in a product with core and live", { skip: noTemplateModules ?? false }, () => {
  let dir;
  let server;
  let base;
  const seen = [];
  let answer = () => ({ status: 200, body: {} });

  before(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "mm-live-product-"));
    dirs.push(dir);
    for (const f of ["tsconfig.json", "package.json"]) cpSync(path.join(TEMPLATE, f), path.join(dir, f));
    cpSync(path.join(TEMPLATE, "lib"), path.join(dir, "lib"), { recursive: true });
    cpSync(path.join(TEMPLATE, "tests"), path.join(dir, "tests"), { recursive: true });
    cpSync(CORE, dir, { recursive: true });
    cpSync(LIVE, dir, { recursive: true });
    symlinkSync(modules, path.join(dir, "node_modules"));
    server = http.createServer((req, res) => {
      const parts = [];
      req.on("data", (c) => parts.push(c));
      req.on("end", () => {
        const body = Buffer.concat(parts);
        seen.push({ method: req.method, url: req.url, headers: req.headers, body });
        const a = answer(req);
        res.writeHead(a.status, { "content-type": "application/json", ...(a.headers ?? {}) });
        res.end(JSON.stringify(a.body));
      });
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${server.address().port}/api/gateway`;
  });
  after(() => server?.close());

  /** Runs TypeScript in the product folder, so "@/..." is the product's own files, and gives its last line as JSON. */
  async function run(code) {
    const script = path.join(dir, `run-${Math.random().toString(36).slice(2)}.mts`);
    writeFileSync(script, `${code}\n`);
    const tsx = fileURLToPath(import.meta.resolve("tsx/esm"));
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", tsx, script], { cwd: dir, env: { ...process.env, GATEWAY_URL: base, PRODUCT_TOKEN: "mm_build_sample_token_value" } });
      let out = "";
      let err = "";
      child.stdout.on("data", (c) => (out += c));
      child.stderr.on("data", (c) => (err += c));
      child.on("close", (status) => (status === 0 ? resolve(JSON.parse(out.trim().split("\n").at(-1))) : reject(new Error(err || out))));
    });
  }

  const caption = (query, init) => `
    import { POST } from "./app/api/musemuse/live-caption/route.ts";
    const res = await POST(new Request("https://p.example/api/musemuse/live-caption${query}", ${init}));
    console.log(JSON.stringify({ status: res.status, body: await res.json(), cookie: res.headers.get("set-cookie") }));`;
  const WAV = `{ method: "POST", headers: { "content-type": "audio/wav", cookie: "mm_vid=visitor_abcdefghijklmnop", "x-forwarded-for": "203.0.113.7", "sec-fetch-site": "same-origin" }, body: new Uint8Array(4000) }`;
  const GOOD = "?session=session_12345678&startMs=2100&endMs=5000";

  test("the caption route sends one chunk with its session and who is asking, and answers the text with its times", async () => {
    seen.length = 0;
    answer = () => ({ status: 200, body: { transcript: " Water​ moves slowly. ", audioDurationMs: 2900 } });
    const out = await run(caption(GOOD, WAV));
    assert.deepEqual(out.body, { text: "Water moves slowly.", startMs: 2100, endMs: 5000 });
    assert.equal(out.status, 200);
    assert.equal(out.cookie, null, "it already has a visitor id");
    const call = seen[0];
    assert.equal(call.url, "/api/gateway/v1/asr/transcribe");
    assert.equal(call.headers.authorization, "Bearer mm_build_sample_token_value");
    assert.equal(call.headers["x-musemuse-live"], "session_12345678");
    assert.equal(call.headers["x-musemuse-visitor"], "visitor_abcdefghijklmnop");
    assert.equal(call.headers["x-musemuse-client-ip"], "203.0.113.7");
    assert.match(call.headers["content-type"], /^multipart\/form-data/);
    assert.match(call.body.toString("latin1"), /muse-voice-transcribe-1\.0/);
  });

  test("a first piece gives the browser its visitor id", async () => {
    seen.length = 0;
    answer = () => ({ status: 200, body: { transcript: "hi" } });
    const out = await run(caption(GOOD, `{ method: "POST", body: new Uint8Array(4000) }`));
    assert.match(out.cookie, /^mm_vid=[A-Za-z0-9_-]{16,}; Path=\/; .*HttpOnly/);
    assert.equal(seen[0].headers["x-musemuse-visitor"], out.cookie.match(/^mm_vid=([^;]+)/)[1]);
  });

  test("the caption route refuses what isn't a piece, before the gateway", async () => {
    seen.length = 0;
    const cases = [
      ["?startMs=0&endMs=1000", WAV, 400],
      ["?session=bad!&startMs=0&endMs=1000", WAV, 400],
      ["?session=session_12345678&startMs=5&endMs=1", WAV, 400],
      [GOOD, `{ method: "POST", body: new Uint8Array(44) }`, 400],
      [GOOD, `{ method: "POST", body: new Uint8Array(320101) }`, 413],
      [GOOD, `{ method: "POST", headers: { "sec-fetch-site": "cross-site" }, body: new Uint8Array(4000) }`, 403],
    ];
    for (const [q, init, status] of cases) assert.equal((await run(caption(q, init))).status, status, `${q} ${init}`);
    assert.equal(seen.length, 0);
  });

  test("the caption route passes the day's limit on in words, and hides anything else", async () => {
    answer = () => ({ status: 429, headers: { "retry-after": "3600" }, body: { error: { code: "quota_exceeded", message: "Captions have used today's 10 minutes for this person." } } });
    const limit = await run(caption(GOOD, WAV));
    assert.deepEqual([limit.status, limit.body.code], [429, "quota_exceeded"]);
    assert.match(limit.body.error, /today's 10 minutes/);
    answer = () => ({ status: 502, body: { error: { code: "upstream_unreachable", message: "Internal details at 10.0.0.1" } } });
    const other = await run(caption(GOOD, WAV));
    assert.equal(other.status, 502);
    assert.ok(!JSON.stringify(other.body).includes("10.0.0.1"));
  });

  const ticket = (body, headers = "{}") => `
    import { POST } from "./app/api/musemuse/live-ticket/route.ts";
    const res = await POST(new Request("https://p.example/api/musemuse/live-ticket", { method: "POST", headers: ${headers}, body: ${JSON.stringify(typeof body === "string" ? body : JSON.stringify(body))} }));
    console.log(JSON.stringify({ status: res.status, body: await res.json(), cookie: res.headers.get("set-cookie") }));`;

  test("the ticket route asks as this browser, and gives the page only the ticket and the stream's address", async () => {
    seen.length = 0;
    answer = () => ({ status: 200, body: { ticket: "lt1.sample", expiresAt: "2030-01-01T00:00:00.000Z" } });
    const out = await run(ticket({ collection: "scores", scope: "shared" }, `{ cookie: "mm_vid=visitor_abcdefghijklmnop; mm_user=us1.p.subject123.9999999999999.signaturesignature", "x-forwarded-for": "203.0.113.7" }`));
    assert.deepEqual(out.body, { ticket: "lt1.sample", expiresAt: "2030-01-01T00:00:00.000Z", streamUrl: `${base}/live/stream` });
    assert.ok(!JSON.stringify(out.body).includes("mm_build_sample_token_value"), "the token never reaches the page");
    const call = seen[0];
    assert.equal(call.url, "/api/gateway/live/ticket");
    assert.deepEqual(JSON.parse(call.body.toString()), { collection: "scores", scope: "shared" });
    assert.equal(call.headers["x-musemuse-visitor"], "visitor_abcdefghijklmnop");
    assert.match(call.headers["x-musemuse-user"], /^us1\./);
    assert.equal(call.headers["x-musemuse-client-ip"], "203.0.113.7");
  });

  test("a visitor's own collection gives a first visit its id, and a shared one doesn't", async () => {
    answer = () => ({ status: 200, body: { ticket: "lt1.sample", expiresAt: "2030-01-01T00:00:00.000Z" } });
    assert.match((await run(ticket({ collection: "notes", scope: "visitor" }))).cookie, /^mm_vid=/);
    assert.equal((await run(ticket({ collection: "scores", scope: "shared" }))).cookie, null);
  });

  test("the ticket route passes a refusal on, and refuses another site and a bad body", async () => {
    answer = () => ({ status: 403, body: { error: { code: "sign_in_required", message: "Sign in to use these items." } } });
    const refused = await run(ticket({ collection: "lists", scope: "user" }));
    assert.deepEqual([refused.status, refused.body.error, refused.body.code], [403, "Sign in to use these items.", "sign_in_required"]);
    seen.length = 0;
    assert.equal((await run(ticket({ collection: "a", scope: "shared" }, `{ "sec-fetch-site": "cross-site" }`))).status, 403);
    assert.equal((await run(ticket({ scope: "shared" }))).status, 400);
    assert.equal((await run(ticket("not json"))).status, 400);
    assert.equal(seen.length, 0);
  });

  test("everything typechecks in a product", { timeout: 300_000 }, () => {
    const files = ["lib/platform/captions.ts", "lib/platform/captions-chunks.ts", "lib/platform/live.ts", "lib/platform/live-state.ts", "app/api/musemuse/live-caption/route.ts", "app/api/musemuse/live-ticket/route.ts", "tests/caps/live.ts"];
    writeFileSync(path.join(dir, "tsconfig.check.json"), JSON.stringify({ extends: "./tsconfig.json", compilerOptions: { noEmit: true, incremental: false, plugins: [] }, include: files, exclude: ["node_modules"] }));
    const out = spawnSync(path.join(modules, ".bin/tsc"), ["-p", "tsconfig.check.json"], { cwd: dir, encoding: "utf8" });
    assert.equal(out.status, 0, `${out.stdout}${out.stderr}`.slice(0, 3000));
  });
});

// ---------- in real Chromium ----------

const esbuild = await import("esbuild").catch(() => null);
const playwright = noTemplateModules ? null : (await import(pathToFileURL(path.join(modules, "@playwright/test/index.js")).href).catch(() => null))?.default ?? null;
const browserProblem = noTemplateModules ?? (!esbuild ? "esbuild isn't installed" : !playwright ? "playwright isn't installed" : null);

const productAlias = {
  name: "product-alias",
  setup(build) {
    build.onResolve({ filter: /^@\// }, (args) => {
      const spec = args.path.slice(2);
      for (const root of [LIVE, TEMPLATE]) {
        for (const ext of [".ts", ".tsx"]) if (existsSync(path.join(root, spec + ext))) return { path: path.join(root, spec + ext) };
      }
      return { errors: [{ text: `Can't find ${args.path}` }] };
    });
  },
};

const PAGE = `
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { CAPTIONS_NOTICE, useCaptions } from "@/lib/platform/captions";
import { useLive } from "@/lib/platform/live";

function Captions() {
  const { captions, text, status, error, start, stop } = useCaptions();
  window.__captions = captions;
  return (
    <section>
      <p>{CAPTIONS_NOTICE}</p>
      <button onClick={start}>Start captions</button>
      <button onClick={stop}>Stop</button>
      <p id="status">{status}</p>
      <p id="error">{error}</p>
      <p id="text">{text}</p>
    </section>
  );
}

function Board() {
  const { items, status, error } = useLive("scores", "shared");
  return (
    <section>
      <p id="live-status">{status}</p>
      <p id="live-error">{error}</p>
      <ul id="items">{items.map((i) => <li key={i.id}>{i.data.team}</li>)}</ul>
    </section>
  );
}

const live = new URLSearchParams(location.search).has("live");
createRoot(document.getElementById("root")).render(live ? <Board /> : <Captions />);
`;

describe("in Chromium", { skip: browserProblem ?? false }, () => {
  const startDir = process.cwd();
  let browser;
  let dir;
  let server;
  let base;
  let bundle;
  const pieces = [];
  let captionAnswer;
  let ticketAnswer;
  const streams = [];
  let streamRefuse = 0;
  const changes = [];

  before(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "mm-live-browser-"));
    dirs.push(dir);
    // The fake microphone's path is relative to the folder the browser starts in, as it is in a product.
    cpSync(path.join(LIVE, "fixtures"), path.join(dir, "fixtures"), { recursive: true });
    process.chdir(dir);
    const { args } = JSON.parse(readFileSync(path.join(LIVE, "scripts/caps/live.browser.json"), "utf8"));
    browser = await playwright.chromium.launch({ args }).catch(() => null);
    const built = await esbuild.build({
      stdin: { contents: PAGE, loader: "tsx", resolveDir: TEMPLATE, sourcefile: "page.tsx" },
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
    server = http.createServer((req, res) => {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end('<!doctype html><div id="root"></div><script src="/app.js"></script>');
      } else if (url.pathname === "/app.js") {
        res.writeHead(200, { "content-type": "text/javascript" });
        res.end(bundle);
      } else if (url.pathname === "/api/musemuse/live-caption") {
        const parts = [];
        req.on("data", (c) => parts.push(c));
        req.on("end", () => {
          const wav = Buffer.concat(parts);
          const piece = { session: url.searchParams.get("session"), startMs: Number(url.searchParams.get("startMs")), endMs: Number(url.searchParams.get("endMs")), wav };
          pieces.push(piece);
          const a = captionAnswer(piece, pieces.length);
          res.writeHead(a.status ?? 200, { "content-type": "application/json" });
          res.end(JSON.stringify(a.body));
        });
      } else if (url.pathname === "/api/musemuse/live-ticket") {
        const a = ticketAnswer();
        res.writeHead(a.status ?? 200, { "content-type": "application/json" });
        res.end(JSON.stringify(a.body));
      } else if (url.pathname === "/stream") {
        // Refused streams answer as the gateway does, and the browser's error path has to recover.
        if (streamRefuse > 0) {
          streamRefuse -= 1;
          res.writeHead(429, { "content-type": "application/json" });
          return res.end("{}");
        }
        const after = Number(url.searchParams.get("after") ?? 0);
        const stream = { res, after, ticket: url.searchParams.get("ticket") };
        streams.push(stream);
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        res.write(`retry: 2000\n\nevent: open\ndata: {"after":${after}}\n\n`);
        for (const c of changes.filter((x) => x.seq > after)) res.write(`id: ${c.seq}\ndata: ${JSON.stringify(c)}\n\n`);
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    for (const s of streams) s.res.end();
    await browser?.close();
    server?.closeAllConnections?.();
    server?.close();
    process.chdir(startDir);
  });

  const wavFormat = (wav) => ({ tag: wav.toString("latin1", 0, 4), rate: wav.readUInt32LE(24), channels: wav.readUInt16LE(22), bits: wav.readUInt16LE(34) });
  const rms = (wav) => {
    let sum = 0;
    const n = Math.floor((wav.byteLength - 44) / 2);
    for (let i = 0; i < n; i++) sum += wav.readInt16LE(44 + i * 2) ** 2;
    return Math.sqrt(sum / Math.max(1, n));
  };

  test("the fake microphone gives real pieces: 16 kHz WAVs with sound, in order, with overlapping times", { timeout: 60_000 }, async (t) => {
    if (!browser) return t.skip("Chromium isn't installed");
    pieces.length = 0;
    captionAnswer = (_p, n) => ({ body: { text: `word${n} shared${n} next${n}`, startMs: _p.startMs, endMs: _p.endMs } });
    const context = await browser.newContext();
    const page = await context.newPage();
    const problems = [];
    page.on("pageerror", (e) => problems.push(e.message));
    await page.goto(base);
    assert.equal(await page.locator("#status").innerText(), "idle", "nothing starts on load");
    assert.equal(pieces.length, 0);
    await page.getByText("Muse Voice Transcribe").waitFor();
    await page.getByRole("button", { name: "Start captions" }).click();
    await page.waitForFunction(() => document.querySelector("#status").textContent === "listening");
    await page.waitForFunction(() => (window.__captions ?? []).length >= 2, null, { timeout: 30_000 });
    await page.getByRole("button", { name: "Stop" }).click();
    await page.waitForFunction(() => document.querySelector("#status").textContent === "stopped");
    assert.deepEqual(problems, []);

    assert.ok(pieces.length >= 2, `${pieces.length} pieces`);
    assert.ok(new Set(pieces.map((p) => p.session)).size === 1, "one session");
    assert.match(pieces[0].session, /^[A-Za-z0-9_-]{8,64}$/);
    for (const p of pieces.slice(0, 2)) {
      assert.deepEqual(wavFormat(p.wav), { tag: "RIFF", rate: 16000, channels: 1, bits: 16 });
      assert.ok(rms(p.wav) > 20, `the piece has sound in it (rms ${rms(p.wav)})`);
      assert.ok(p.wav.byteLength < 320_100, "inside a live chunk's limit");
    }
    assert.equal(pieces[0].startMs, 0);
    assert.ok(Math.abs(pieces[0].endMs - 2500) < 20, `${pieces[0].endMs}`);
    assert.ok(pieces[1].startMs < pieces[0].endMs, "the second overlaps the first");
    assert.ok(Math.abs(pieces[1].endMs - pieces[1].startMs - 2900) < 40, `${pieces[1].startMs}-${pieces[1].endMs}`);
    // What was recorded fills the time it claims: the file really is about that long.
    const seconds = (pieces[1].wav.byteLength - 44) / 32000;
    assert.ok(Math.abs(seconds - (pieces[1].endMs - pieces[1].startMs) / 1000) < 0.1, `${seconds} s`);
    const held = await page.evaluate(() => window.__captions);
    assert.deepEqual(Object.keys(held[0]).sort(), ["endMs", "startMs", "text"]);
    assert.match(await page.locator("#text").innerText(), /word1 shared1 next1 word2/);
    // The microphone really stops.
    const count = pieces.length;
    await page.waitForTimeout(3000);
    assert.equal(pieces.length, count, "no more pieces after Stop");
    await context.close();
  });

  test("the day's limit stops captions and says so", { timeout: 60_000 }, async (t) => {
    if (!browser) return t.skip("Chromium isn't installed");
    pieces.length = 0;
    captionAnswer = () => ({ status: 429, body: { error: "Captions have used today's 10 minutes for this person.", code: "quota_exceeded" } });
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(base);
    await page.getByRole("button", { name: "Start captions" }).click();
    await page.waitForFunction(() => document.querySelector("#status").textContent === "limit", null, { timeout: 30_000 });
    assert.match(await page.locator("#error").innerText(), /today's 10 minutes/);
    const count = pieces.length;
    await page.waitForTimeout(3000);
    assert.equal(pieces.length, count);
    await context.close();
  });

  test("a blocked microphone says so in plain words", { timeout: 60_000 }, async (t) => {
    if (!browser) return t.skip("Chromium isn't installed");
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = async () => {
        throw new DOMException("no", "NotAllowedError");
      };
    });
    await page.goto(base);
    await page.getByRole("button", { name: "Start captions" }).click();
    await page.waitForFunction(() => document.querySelector("#status").textContent === "error");
    assert.match(await page.locator("#error").innerText(), /microphone is blocked/);
    await context.close();
  });

  const changeItem = (seq, id, team) => ({ seq, op: "put", id, data: { team } });
  const send = (c) => {
    changes.push(c);
    for (const s of streams) if (!s.res.writableEnded) s.res.write(`id: ${c.seq}\ndata: ${JSON.stringify(c)}\n\n`);
  };

  test("useLive fills from the stream with no reload, follows a delete, and carries on from the last change after a plain end", { timeout: 60_000 }, async (t) => {
    if (!browser) return t.skip("Chromium isn't installed");
    changes.length = 0;
    streams.length = 0;
    changes.push(changeItem(5, "a", "Heron"));
    ticketAnswer = () => ({ body: { ticket: "lt1.sample", expiresAt: new Date(Date.now() + 600_000).toISOString(), streamUrl: `${base}/stream` } });
    const context = await browser.newContext();
    const page = await context.newPage();
    let loads = 0;
    page.on("framenavigated", () => (loads += 1));
    await page.goto(`${base}/?live=1`);
    await page.getByText("Heron").waitFor();
    assert.equal(await page.locator("#live-status").innerText(), "live");
    assert.equal(streams[0].ticket, "lt1.sample");
    assert.equal(streams[0].after, 0);
    const before = loads;
    send(changeItem(6, "b", "Kingfisher"));
    await page.getByText("Kingfisher").waitFor({ timeout: 5000 });
    send({ seq: 7, op: "delete", id: "a", data: null });
    await page.getByText("Heron").waitFor({ state: "detached", timeout: 5000 });
    assert.equal(loads, before, "no reload");

    // The server closes this stream with its end event, as it does every 55 seconds.
    streams[0].res.write('event: end\ndata: {"after":7}\n\n');
    const reconnected = Date.now();
    while (streams.length < 2 && Date.now() - reconnected < 5000) await new Promise((r) => setTimeout(r, 20));
    streams[0].res.end();
    assert.equal(streams.length, 2, "it reconnected");
    assert.equal(streams[1].after, 7, "from the last change it saw");
    send(changeItem(8, "c", "Avocet"));
    await page.getByText("Avocet").waitFor({ timeout: 5000 });
    assert.equal(await page.locator("#items li").count(), 2);
    await context.close();
    for (const s of streams) s.res.end();
  });

  test("useLive comes back after a refused stream, and a hidden tab lets go of its stream", { timeout: 60_000 }, async (t) => {
    if (!browser) return t.skip("Chromium isn't installed");
    changes.length = 0;
    streams.length = 0;
    changes.push(changeItem(1, "a", "Heron"));
    streamRefuse = 1;
    ticketAnswer = () => ({ body: { ticket: "lt1.sample", expiresAt: new Date(Date.now() + 600_000).toISOString(), streamUrl: `${base}/stream` } });
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${base}/?live=1`);
    await page.getByText("Heron").waitFor({ timeout: 15_000 });
    assert.equal(streams.length, 1);

    const gone = new Promise((resolve) => streams[0].res.on("close", resolve));
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await Promise.race([gone, new Promise((_, no) => setTimeout(() => no(new Error("the stream stayed open")), 5000))]);
    send(changeItem(2, "b", "Kingfisher"));
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await page.getByText("Kingfisher").waitFor({ timeout: 5000 });
    assert.equal(streams.at(-1).after, 1, "it caught up from where it stopped");
    await context.close();
    for (const s of streams) s.res.end();
  });

  test("a refused ticket says so and doesn't keep asking", { timeout: 30_000 }, async (t) => {
    if (!browser) return t.skip("Chromium isn't installed");
    let asked = 0;
    ticketAnswer = () => {
      asked += 1;
      return { status: 403, body: { error: "Sign in to use these items." } };
    };
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${base}/?live=1`);
    await page.getByText("Sign in to use these items.").waitFor();
    assert.equal(await page.locator("#live-status").innerText(), "error");
    await page.waitForTimeout(2500);
    assert.equal(asked, 1);
    await context.close();
  });
});
