// The connect cap's overlay (docs/CAPABILITIES.md, section 11): its paths, platform files and skill, the fixed checks
// (scripts/caps/connect.mjs) with the leak scan, and the helpers against a fake gateway: fetchPublic, secrets and send,
// the key settings route that never puts a key in a redirect, and the product's tsc with core and connect applied.
// Run from the repo root:
//   npx tsx --test template/scripts/__tests__/caps-connect.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const TEMPLATE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CONNECT = path.join(TEMPLATE, "caps/connect/files");
const CORE = path.join(TEMPLATE, "caps/core/files");
const APIS = JSON.parse(readFileSync(path.join(TEMPLATE, "../lib/caps/connect/apis.json"), "utf8"));
const SERVICES = JSON.parse(readFileSync(path.join(TEMPLATE, "../lib/caps/connect/services.json"), "utf8"));
const modules = path.join(TEMPLATE, "node_modules");
const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function walk(dir, base = dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? (e.name === "node_modules" ? [] : walk(path.join(dir, e.name), base)) : [path.relative(base, path.join(dir, e.name)).split(path.sep).join("/")],
  );
}

describe("the overlay's files", () => {
  test("write no path the template, a target overlay or another cap overlay writes", () => {
    const own = walk(CONNECT);
    const others = [
      ...walk(TEMPLATE).filter((f) => !f.startsWith("targets/") && !f.startsWith("caps/")),
      ...readdirSync(path.join(TEMPLATE, "targets")).flatMap((t) => walk(path.join(TEMPLATE, "targets", t, "files"))),
      ...readdirSync(path.join(TEMPLATE, "caps")).filter((c) => c !== "connect").flatMap((c) => walk(path.join(TEMPLATE, "caps", c, "files"))),
    ];
    assert.deepEqual(own.filter((f) => others.includes(f)), []);
  });

  test("are all platform files, with no dependency of their own", () => {
    assert.deepEqual(JSON.parse(readFileSync(path.join(TEMPLATE, "caps/connect/platform-files.json"), "utf8")).sort(), walk(CONNECT).sort());
    assert.deepEqual(JSON.parse(readFileSync(path.join(TEMPLATE, "caps/connect/deps.json"), "utf8")), { dependencies: {}, devDependencies: {} });
  });

  test("musemuse.schema.json's connect block takes exactly the allowlisted APIs and the channels that send", () => {
    const schema = JSON.parse(readFileSync(path.join(TEMPLATE, "musemuse.schema.json"), "utf8"));
    const block = schema.properties.connect;
    assert.deepEqual(block.properties.publicApis.items.enum, Object.keys(APIS));
    assert.deepEqual(block.properties.sends.items.enum, [...new Set(Object.values(SERVICES).flatMap((s) => (s.send ? [s.send] : [])))]);
    assert.ok(!schema.required.includes("connect"));
  });

  test("the skill names every helper, every API path and every service call, and nothing has an em dash", () => {
    const skill = readFileSync(path.join(CONNECT, ".agents/skills/muse-connect/SKILL.md"), "utf8");
    for (const name of ["fetchPublic", "secrets(", "KeySettings", "ConfirmSend", "send(", "needs_key", "switched_off", "checkFetchShown", "saveTestKey", "confirmSend", "openAsOwner"]) assert.ok(skill.includes(name), name);
    for (const [id, api] of Object.entries(APIS)) {
      assert.ok(skill.includes(api.attribution), `${id} credit`);
      for (const p of api.paths) assert.ok(skill.includes(`\`${p.path}\` (\`${id}.${p.id}\`)`), `${id} ${p.path}`);
    }
    for (const [id, s] of Object.entries(SERVICES)) for (const c of s.calls) assert.ok(skill.includes(`\`${c.method} ${c.path}\``), `${id} ${c.method} ${c.path}`);
    for (const f of walk(CONNECT)) assert.ok(!readFileSync(path.join(CONNECT, f), "utf8").includes("—"), f);
  });

  test("the key settings form never fills a key back in, and the send card has the test ids the helpers press", () => {
    const keys = readFileSync(path.join(CONNECT, "components/platform/KeySettings.tsx"), "utf8");
    assert.match(keys, /type="password"/);
    assert.doesNotMatch(keys, /defaultValue/);
    assert.doesNotMatch(keys, /name="value"[^>]*\svalue=/, "the key field is never filled in");
    const card = readFileSync(path.join(CONNECT, "components/platform/ConfirmSend.tsx"), "utf8");
    for (const id of ["confirm-send-card", "confirm-send", "send-result"]) assert.ok(card.includes(`data-testid="${id}"`), id);
    assert.match(card, /Sent \(sample\)/);
  });
});

describe("the send card (components/platform/ConfirmSend.tsx), rendered", () => {
  let card, html;
  before(async () => {
    // tsx compiles a file outside the root tsconfig's include with the classic JSX transform, which reads a global React.
    const React = await import("react");
    globalThis.React ??= React;
    const { createElement } = React;
    card = await import(pathToFileURL(path.join(CONNECT, "components/platform/ConfirmSend.tsx")).href);
    const { renderToStaticMarkup } = await import("react-dom/server");
    html = (state) => renderToStaticMarkup(createElement(card.ConfirmSendCard, { state, onConfirm() {}, onCancel() {} }));
  });
  const long = `${"Rain until noon. ".repeat(586)}HIDDEN TAIL`;
  const confirmation = { id: "ap1.x", title: "Send this email?", lines: ["To: friend@example.com", "Subject: Saturday plan", `Message: ${long}`], args: { channel: "email", to: ["friend@example.com"], subject: "Saturday plan", body: long } };

  test("asks with every line in full, in a box that scrolls, with Confirm and Cancel", () => {
    const out = html({ kind: "ask", confirmation });
    assert.match(out, /data-testid="confirm-send-card"/);
    assert.ok(out.includes(`Message: ${long}`), "the whole message, never cut");
    assert.match(out, /data-testid="confirm-send-lines"[^>]*style="[^"]*overflow-y:auto/);
    assert.match(out, /Confirm and send/);
    assert.match(out, />Cancel</);
    assert.doesNotMatch(out, /role="alert"/);
  });

  test("a stale approval asks again with the new card and a note; a refusal shows an error and keeps the card", () => {
    const fresh = { ...confirmation, id: "ap1.y", lines: ["To: friend@example.com", "Message: New words"] };
    const stale = card.afterConfirm(confirmation, { status: "needs_confirmation", confirmation: fresh });
    assert.deepEqual(stale, { kind: "ask", confirmation: fresh, note: "This needs a fresh confirmation. Check it again." });
    const staleHtml = html(stale);
    assert.match(staleHtml, /This needs a fresh confirmation/);
    assert.match(staleHtml, /Message: New words/);
    assert.ok(!staleHtml.includes("HIDDEN TAIL"), "the old message is gone");

    const error = card.afterConfirm(confirmation, { error: "Resend didn't send it. Nothing was sent." });
    assert.equal(error.kind, "error");
    const errorHtml = html(error);
    assert.match(errorHtml, /role="alert">Resend didn&#x27;t send it\. Nothing was sent\./);
    assert.ok(errorHtml.includes("HIDDEN TAIL"), "the message stays on screen");
    assert.equal(card.afterConfirm(confirmation, null).message, "That didn't send. Nothing went out.");
  });

  test("says Sent (sample) for a build's send, Sent for a real one, and disables both buttons while sending", () => {
    assert.match(html(card.afterConfirm(confirmation, { status: "sent", simulated: true })), /data-testid="send-result".*Sent \(sample\)/);
    assert.match(html(card.afterConfirm(confirmation, { status: "sent" })), />Sent</);
    const busy = html({ kind: "busy", confirmation });
    assert.equal((busy.match(/disabled=""/g) ?? []).length, 2);
    assert.match(busy, />Sending</);
  });
});

describe("the fixed checks (scripts/caps/connect.mjs)", () => {
  let checker;
  before(async () => {
    checker = await import(pathToFileURL(path.join(CONNECT, "scripts/caps/connect.mjs")).href);
  });

  const canary = "mmtest_ABCDEFGHIJKLMNOPQRSTUVWX";
  const sha = createHash("sha256").update(canary).digest("hex").slice(0, 16);
  const proof = { fetches: 2, calls: 0, sends: 1, keys: 1, [`secret-sha:${sha}`]: 1, "brief:api:nws": 1, "brief:key:github": 1, "brief:send:email": 1 };
  const manifest = { connect: { publicApis: ["nws"], keys: ["github"], sends: ["email"] } };
  const record = { cap: "connect", checks: [{ id: "fetch-shown", ok: true, detail: "shown" }, { id: "key-saved", ok: true }, { id: "send-confirmed", ok: true }] };

  function root(m, files = {}) {
    const dir = mkdtempSync(path.join(tmpdir(), "mm-connect-check-"));
    dirs.push(dir);
    if (m) writeFileSync(path.join(dir, "musemuse.json"), JSON.stringify(m));
    for (const [f, text] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      writeFileSync(path.join(dir, f), text);
    }
    return dir;
  }

  test("pass when the manifest is the brief's, the gateway saw each part and no key shows anywhere", async () => {
    const out = await checker.check({ record, proof, root: root(manifest, { "app/page.tsx": "export default () => null", ".next/static/x.js": "mmtest_ZZZZZZZZZZZZZZZZZZZZZZZZ" }) });
    assert.deepEqual(out.map((c) => [c.id, c.ok]), [["manifest", true], ["fetch-shown", true], ["key-saved", true], ["no-key-leak", true], ["send-confirmed", true]]);
  });

  test("fail when a saved test key shows in a kept page, the built output or the source, and say where", async () => {
    for (const where of ["test-results/caps/connect-pages/1.html", ".next/server/app/settings.html", "lib/keys.ts", "public/k.txt"]) {
      const out = await checker.check({ record, proof, root: root(manifest, { [where]: `<p>${canary}</p>` }) });
      const leak = out.find((c) => c.id === "no-key-leak");
      assert.equal(leak.ok, false, where);
      assert.match(leak.detail, new RegExp(where.replace(/[.]/g, "\\.")));
    }
  });

  test("fail a manifest that adds or drops a pick, and with no gateway record", async () => {
    const out = await checker.check({ record, proof, root: root({ connect: { publicApis: ["nws", "usgs"], keys: ["github"], sends: ["email"] } }) });
    assert.equal(out.find((c) => c.id === "manifest").ok, false);
    const none = await checker.check({ record, proof: null, root: root(manifest) });
    assert.deepEqual(none.filter((c) => !c.ok).map((c) => c.id), ["manifest", "fetch-shown"]);
  });

  test("fail a smoke test that skipped a part, or a part the gateway never saw", async () => {
    const idle = await checker.check({ record: { checks: [] }, proof: { ...proof, fetches: 0, sends: 0 }, root: root(manifest) });
    assert.deepEqual(idle.filter((c) => !c.ok).map((c) => c.id), ["fetch-shown", "key-saved", "send-confirmed"]);
    const { [`secret-sha:${sha}`]: _gone, ...noKey } = proof;
    const unsaved = await checker.check({ record, proof: { ...noKey, keys: 0 }, root: root(manifest) });
    assert.deepEqual(unsaved.filter((c) => !c.ok).map((c) => c.id), ["key-saved", "no-key-leak"]);
  });

  test("check only the parts the brief has", async () => {
    const out = await checker.check({ record, proof: { fetches: 1, "brief:api:usgs": 1 }, root: root({ connect: { publicApis: ["usgs"], keys: [], sends: [] } }) });
    assert.deepEqual(out.map((c) => c.id), ["manifest", "fetch-shown"]);
  });
});

describe("in a product with core and connect", { skip: existsSync(modules) ? false : "needs template/node_modules" }, () => {
  let dir;
  let server;
  let base;
  const seen = [];
  let answer = () => ({ status: 200, body: {} });

  before(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "mm-connect-product-"));
    dirs.push(dir);
    for (const f of ["tsconfig.json", "package.json", "next-env.d.ts"]) if (existsSync(path.join(TEMPLATE, f))) cpSync(path.join(TEMPLATE, f), path.join(dir, f));
    for (const d of ["lib", "components", "app", "tests"]) cpSync(path.join(TEMPLATE, d), path.join(dir, d), { recursive: true });
    cpSync(CORE, dir, { recursive: true });
    cpSync(CONNECT, dir, { recursive: true });
    symlinkSync(modules, path.join(dir, "node_modules"));
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen.push({ method: req.method, url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null });
        const a = answer(req);
        res.writeHead(a.status, { "content-type": "application/json" });
        res.end(JSON.stringify(a.body));
      });
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${server.address().port}/api/gateway`;
  });
  after(() => server?.close());

  async function run(code) {
    const script = path.join(dir, `run-${seen.length}-${Math.random().toString(36).slice(2)}.mts`);
    writeFileSync(script, `${code}\n`);
    const tsx = fileURLToPath(import.meta.resolve("tsx/esm"));
    const { spawn } = await import("node:child_process");
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", tsx, script], { cwd: dir, env: { ...process.env, GATEWAY_URL: base, PRODUCT_TOKEN: "mm_build_sample_token_value" } });
      let out = "";
      let err = "";
      child.stdout.on("data", (c) => (out += c));
      child.stderr.on("data", (c) => (err += c));
      child.on("close", (status) => (status === 0 ? resolve(JSON.parse(out.trim().split("\n").at(-1))) : reject(new Error(err || out))));
    });
  }

  const COOKIES = "mm_vid=visitor_abcdefghijklmnop; mm_owner=os1.p.s.9999999999999.sig_sig_sig_sig";

  test("fetchPublic sends the request and who is asking, and notes a build's sample for the smoke test", async () => {
    seen.length = 0;
    answer = () => ({ status: 200, body: { ok: true, api: "nws", route: "forecast", status: 200, data: { properties: { periods: [{ shortForecast: "Sunny" }] } }, credit: "Weather from the National Weather Service", cached: false, simulated: true } });
    const out = await run(`
import { fetchPublic } from "./lib/platform/fetch-public.ts";
const request = new Request("http://localhost/x", { headers: { cookie: ${JSON.stringify(COOKIES)}, "x-forwarded-for": "203.0.113.9" } });
console.log(JSON.stringify(await fetchPublic(request, { api: "nws", path: "/gridpoints/LWX/97,71/forecast", query: { units: "us" } })));
`);
    assert.equal(out.credit, "Weather from the National Weather Service");
    assert.equal(out.simulated, true);
    assert.equal(seen[0].url, "/api/gateway/fetch");
    assert.deepEqual(seen[0].body, { api: "nws", path: "/gridpoints/LWX/97,71/forecast", query: { units: "us" } });
    assert.equal(seen[0].headers.authorization, "Bearer mm_build_sample_token_value");
    assert.equal(seen[0].headers["x-musemuse-visitor"], "visitor_abcdefghijklmnop");
    assert.equal(seen[0].headers["x-musemuse-client-ip"], "203.0.113.9");
    const noted = JSON.parse(readFileSync(path.join(dir, "test-results/caps/connect-fetched.json"), "utf8"));
    assert.equal(noted["nws.forecast"].properties.periods[0].shortForecast, "Sunny");
  });

  test("secrets and send go to their paths, needs_key and refusals become CapErrors, and a confirmation comes back as is", async () => {
    seen.length = 0;
    answer = (req) => {
      if (req.url === "/api/gateway/vault/call") return { status: 200, body: { ok: false, code: "needs_key", service: "github", label: "GitHub", canAdd: true } };
      if (req.url === "/api/gateway/send") return { status: 200, body: { ok: false, code: "needs_confirmation", confirmation: { id: "ap1.x", title: "Send this email?", lines: ["To: a@example.com"], args: { channel: "email" } } } };
      if (req.method === "POST" && req.url === "/api/gateway/vault") return { status: 403, body: { error: { code: "sign_in_required", message: "Only the product's owner can save a key." } } };
      return { status: 200, body: { keys: [], services: [] } };
    };
    const out = await run(`
import { secrets } from "./lib/platform/secrets.ts";
import { send } from "./lib/platform/send.ts";
import { CapError } from "./lib/platform/connect.ts";
const request = new Request("http://localhost/x", { headers: { cookie: ${JSON.stringify(COOKIES)} } });
const list = await secrets(request).list();
const call = await secrets(request).call("github", { path: "/user" }).catch((e) => ({ code: e.code, isCap: e instanceof CapError, message: e.message }));
const save = await secrets(request).save("github", "ghp_madeUp123456").catch((e) => ({ code: e.code, status: e.status, message: e.message }));
const sent = await send(request, { channel: "email", to: ["a@example.com"], subject: "Hi", body: "Plan" });
console.log(JSON.stringify({ list, call, save, sent }));
`);
    assert.deepEqual(out.list, { keys: [], services: [] });
    assert.deepEqual(out.call, { code: "needs_key", isCap: true, message: "Add a GitHub key in this product's settings first." });
    assert.deepEqual(out.save, { code: "sign_in_required", status: 403, message: "Only the product's owner can save a key." });
    assert.equal(out.sent.status, "needs_confirmation");
    assert.equal(out.sent.confirmation.id, "ap1.x");
    assert.deepEqual(seen.map((s) => `${s.method} ${s.url}`), ["GET /api/gateway/vault", "POST /api/gateway/vault/call", "POST /api/gateway/vault", "POST /api/gateway/send"]);
    assert.equal(seen[1].headers["x-musemuse-owner"], "os1.p.s.9999999999999.sig_sig_sig_sig");
  });

  test("the key settings route saves through the gateway and goes back with a status, never the key", async () => {
    seen.length = 0;
    answer = () => ({ status: 201, body: { ok: true, name: "github", label: "GitHub" } });
    const out = await run(`
import { POST } from "./app/api/musemuse/connect-keys/route.ts";
const form = new FormData();
form.set("action", "save"); form.set("service", "github"); form.set("value", "ghp_madeUpSecret98765"); form.set("returnTo", "//evil.example/x");
const res = await POST(new Request("http://localhost/api/musemuse/connect-keys", { method: "POST", body: form, headers: { cookie: ${JSON.stringify(COOKIES)} } }));
console.log(JSON.stringify({ status: res.status, location: res.headers.get("location") }));
`);
    assert.deepEqual(out, { status: 303, location: "/?key=saved" });
    assert.deepEqual(seen[0].body, { service: "github", value: "ghp_madeUpSecret98765" });
  });

  test("the product typechecks with core and connect applied", () => {
    const tsc = path.join(modules, "typescript/bin/tsc");
    const res = spawnSync(process.execPath, [tsc, "--noEmit", "-p", dir], { encoding: "utf8" });
    const errors = (res.stdout + res.stderr).split("\n").filter((l) => /error TS/.test(l) && !/run-\d/.test(l));
    assert.deepEqual(errors, []);
  });
});
