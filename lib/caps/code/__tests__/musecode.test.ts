/**
 * Muse Code sessions in products (docs/CAPABILITIES.md, 15b) without a database, a sandbox or a model: the routes behind
 * the cap gate with fakes, the session's settings, firewall and token, the build's limits, the events' secret scan, the
 * result zip's rules, the code_session scope at the gateway, Wonder's fitted output, and the sweep.
 *
 *   npx tsx --test lib/caps/code/__tests__/musecode.test.ts
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import type { z } from "zod";
import type { Brief } from "@/lib/brief/schema";
import { codeBlock, codePartsOff, codeWriterBlock, codeWriterRules, normalizeCodeBlock } from "@/lib/caps/code/brief";
import { codeCatalogBlock } from "@/lib/caps/code/catalog";
import { codeJudgeNote } from "@/lib/caps/code/judge";
import { codePartsKey, museCodeOn } from "@/lib/caps/code/parts";
import { CODE_RENDER } from "@/lib/caps/code/render";
import { capBuildEnv, capDeployEnv } from "@/lib/caps/env";
import { CAP_OVERLAY_PICK, capOverlaysNeeded } from "@/lib/caps/overlays";
import { BRIEF } from "@/lib/promote/__tests__/fixtures";
import type { CapProduct, CapToken } from "@/lib/caps/gate";
import { finishSession, handleCodeSessions, isUploadUrl, readStartArgs, sessionModelFor, type CodeSessionRow, type CodeSessionStore, type MuseCodeDeps, type NewCodeSession } from "@/lib/caps/code/musecode/handler";
import { sessionLeftUsd } from "@/lib/caps/code/musecode/gateway";
import { MUSE_CODE_DISCLOSURE, MUSE_CODE_LIMITS } from "@/lib/caps/code/musecode/limits";
import { REDACTED, redactBytes, redactText, redactValue, secretValues } from "@/lib/caps/code/musecode/redact";
import { cleanResultPath, crc32, readTar, resultFromTar } from "@/lib/caps/code/musecode/result";
import { binaryHashesFrom, killScript, mailboxFile, packScript, prepareScript, runnerScript, SESSION_PATHS, SESSION_WORKSPACE, sessionBridgeConfig, sessionPrompt, sessionSettings } from "@/lib/caps/code/musecode/sandbox";
import { sweepMuseCode, type SweepDeps } from "@/lib/caps/code/musecode/sweep";
import { isSessionToken, sessionTokenFor } from "@/lib/caps/code/musecode/token";
import { SESSION_GATEWAY_PATH, sessionPolicy } from "@/lib/caps/code/policy";
import type { LongSession, SessionSpec } from "@/lib/caps/code/session";
import { codeSessionRefusal } from "@/lib/gateway/policy";
import { handleGateway } from "@/lib/gateway/handler";
import { estimateCost } from "@/lib/gateway/estimate";
import { OWNER_HEADER, VISITOR_HEADER } from "@/lib/gateway/policy";
import { BRIDGE_SCRIPT } from "@/lib/sandbox/bridge-protocol";
import { configProblem, serveArgs } from "@/lib/sandbox/bridge/bridge.mjs";
import { newSessionId } from "@/lib/sandbox/muse";
import { mintOwnerSession } from "@/lib/tools/principal";
import { fakeGateway, gatewayRequest, json, TEST_TOKEN } from "@/lib/gateway/__tests__/helpers";

process.env.GATEWAY_TOKEN_PEPPER ??= "test-pepper-for-muse-code-sessions";

const NOW = new Date("2026-11-01T12:00:00Z");
const BUILD = "22222222-2222-4222-8222-222222222222";
const PEPPER = "pepper-for-the-session-tests-0001";
const FAKE_SECRETS = { MODEL_API_KEY: "fake-meta-key-0123456789abcdef", VERCEL_TOKEN: "fake-vercel-token-0123456789", VERCEL_OIDC_TOKEN: "fake-oidc-token-abcdefghijkl", BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_fake_0123456789" };
const BIN = Buffer.from("this stands in for the muse-bin program, which is never shipped");
const BIN_SHA = createHash("sha256").update(BIN).digest("hex");
const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

// ---------- A tiny tar writer, so the tests build exactly the archive a session's workspace might give ----------

function tarHeader(name: string, size: number, type: string, linkname = ""): Buffer {
  const h = Buffer.alloc(512);
  h.write(name.slice(0, 100), 0, "utf8");
  h.write("0000644\0", 100);
  h.write("0000000\0", 108);
  h.write("0000000\0", 116);
  h.write(`${size.toString(8).padStart(11, "0")}\0`, 124);
  h.write("00000000000\0", 136);
  h.write("        ", 148);
  h.write(type, 156);
  h.write(linkname, 157);
  h.write("ustar\0", 257);
  h.write("00", 263);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  return h;
}

function tar(entries: Array<{ name: string; data?: Buffer | string; type?: string; link?: string }>): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    const data = typeof e.data === "string" ? Buffer.from(e.data) : (e.data ?? Buffer.alloc(0));
    if (Buffer.byteLength(e.name) > 100) {
      const long = Buffer.from(`${e.name}\0`);
      parts.push(tarHeader("././@LongLink", long.length, "L"), long, Buffer.alloc((512 - (long.length % 512)) % 512));
    }
    parts.push(tarHeader(e.name, data.length, e.type ?? "0", e.link), data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

/** Lists and checks a zip with Python's zipfile (CRCs included), from a file in a temp folder. */
function unzip(zip: Buffer): Record<string, string> {
  const dir = mkdtempSync(path.join(tmpdir(), "mm-zip-"));
  dirs.push(dir);
  const file = path.join(dir, "r.zip");
  writeFileSync(file, zip);
  const out = execFileSync("python3", ["-I", "-c", "import json,sys,zipfile;z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None;print(json.dumps({n:z.read(n).decode('utf8','replace') for n in z.namelist()}))", file], { encoding: "utf8" });
  return JSON.parse(out) as Record<string, string>;
}

describe("the result zip", () => {
  it("keeps the workspace's plain files and drops links, program files, the Muse Code binary, big files and left-out folders", () => {
    const archive = tar([
      { name: "./", type: "5" },
      { name: "./dedupe.js", data: "console.log('ok')\n" },
      { name: "./src/", type: "5" },
      { name: "./src/lib.js", data: "module.exports = 1;\n" },
      { name: "./bin-copy", data: BIN },
      { name: "./tool", data: Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.from("rest of an elf")]) },
      { name: "./link-to-bin", type: "2", link: "/vercel/.local/bin/muse-bin-1.4.14" },
      { name: "./hard", type: "1", link: "./dedupe.js" },
      { name: "./node_modules/x/index.js", data: "x" },
      { name: "./.git/HEAD", data: "ref" },
      { name: "./big.bin", data: Buffer.alloc(2048, 1) },
      { name: "../escape.txt", data: "no" },
      { name: `./${"d/".repeat(60)}deep.txt`, data: "deep" },
    ]);
    const r = resultFromTar(archive, { binaryHashes: [BIN_SHA], secrets: [], limits: { resultFileMaxBytes: 1024 } });
    assert.deepEqual(r.files.map((f) => f.path).sort(), ["d/".repeat(60) + "deep.txt", "dedupe.js", "src/lib.js"].sort());
    const why = Object.fromEntries(r.dropped.map((d) => [d.path, d.why]));
    assert.match(why["bin-copy"]!, /Muse Code program/);
    assert.match(why.tool!, /program file/);
    assert.match(why["link-to-bin"]!, /link/);
    assert.match(why.hard!, /hard link/);
    assert.match(why["big.bin"]!, /bigger than/);
    assert.match(why["../escape.txt"]!, /inside the workspace/);
    assert.ok(!r.dropped.some((d) => d.path.includes("node_modules") || d.path.includes(".git")), "left-out folders are skipped quietly");
    const files = unzip(r.zip!);
    assert.equal(files["dedupe.js"], "console.log('ok')\n");
    assert.equal(Object.keys(files).length, 3);
  });

  it("holds the total and the file count, and a tar cut short drops what it cut", () => {
    const many = tar(Array.from({ length: 6 }, (_, i) => ({ name: `f${i}.txt`, data: "x".repeat(400) })));
    const r = resultFromTar(many, { binaryHashes: [], secrets: [], limits: { resultMaxBytes: 1000, resultMaxFiles: 10 } });
    assert.equal(r.files.length, 2);
    assert.ok(r.dropped.every((d) => /MB a result may hold/.test(d.why)));
    const counted = resultFromTar(many, { binaryHashes: [], secrets: [], limits: { resultMaxFiles: 3 } });
    assert.equal(counted.files.length, 3);
    const cut = resultFromTar(many.subarray(0, 512 * 3 + 100), { binaryHashes: [], secrets: [] });
    assert.ok(cut.files.length <= 1);
    assert.equal(resultFromTar(Buffer.alloc(0), { binaryHashes: [], secrets: [] }).zip, null);
  });

  it("redacts every secret value inside a file before it's zipped", () => {
    const leak = `key=${FAKE_SECRETS.MODEL_API_KEY}\ntoken=${FAKE_SECRETS.VERCEL_TOKEN}\n`;
    const r = resultFromTar(tar([{ name: "leak.env.txt", data: leak }]), { binaryHashes: [], secrets: secretValues([], FAKE_SECRETS) });
    assert.equal(r.secretHits, 2);
    const files = unzip(r.zip!);
    assert.ok(!files["leak.env.txt"]!.includes("fake-meta-key"));
    assert.ok(files["leak.env.txt"]!.includes(REDACTED));
  });

  it("reads GNU long names and pax paths, and cleans paths to the workspace", () => {
    const pax = Buffer.from("27 path=pax/long/name.txt\n");
    const archive = Buffer.concat([tarHeader("PaxHeader", pax.length, "x"), pax, Buffer.alloc(512 - pax.length), tarHeader("short", 2, "0"), Buffer.from("hi"), Buffer.alloc(510), Buffer.alloc(1024)]);
    assert.equal(readTar(archive)[0]!.path, "pax/long/name.txt");
    assert.equal(cleanResultPath("./a/b.txt"), "a/b.txt");
    for (const bad of ["/etc/passwd", "a/../b", "", "a\\b", "x/node_modules/y", ".muse/s"]) assert.equal(cleanResultPath(bad), null, bad);
    assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
  });
});

describe("the sandbox's scripts, run for real here", () => {
  it("packs with a real GNU tar's headers: long names read back, and a symlink to the binary is never followed", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mm-tar-"));
    dirs.push(dir);
    const file = path.join(dir, "r.tar");
    const long = `${"long-folder/".repeat(12)}name.txt`;
    const py = "import io,sys,tarfile\nt=tarfile.open(sys.argv[1],'w',format=tarfile.GNU_FORMAT)\ndef add(n,d):\n  i=tarfile.TarInfo(n);i.size=len(d);t.addfile(i,io.BytesIO(d))\nadd('./ok.txt',b'fine');add('./'+sys.argv[2],b'deep')\ns=tarfile.TarInfo('./bin');s.type=tarfile.SYMTYPE;s.linkname='/vercel/.local/bin/muse-bin';t.addfile(s)\nt.close()";
    execFileSync("python3", ["-I", "-c", py, file, long]);
    const r = resultFromTar(readFileSync(file), { binaryHashes: [], secrets: [] });
    assert.deepEqual(r.files.map((f) => f.path).sort(), [long, "ok.txt"].sort());
    assert.match(r.dropped.find((d) => d.path === "bin")!.why, /link/);
    assert.deepEqual(Object.keys(unzip(r.zip!)).sort(), [long, "ok.txt"].sort());
  });

  it("kills the bridge's whole process group by its pid, and the script survives to finish", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mm-kill-"));
    dirs.push(dir);
    const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
    const gone = new Promise((resolve) => child.once("exit", resolve));
    const pidFile = path.join(dir, "bridge.pid");
    writeFileSync(pidFile, String(child.pid));
    const script = killScript().replace(SESSION_PATHS.pid, pidFile);
    assert.doesNotMatch(script, /pkill/);
    execFileSync("bash", ["-c", script]);
    await gone;
    assert.equal(child.signalCode, "SIGTERM");
    execFileSync("bash", ["-c", killScript().replace(SESSION_PATHS.pid, path.join(dir, "missing"))]);
  });

  it("gives the bridge a config it accepts, and flags in the order it passes them", () => {
    const config = sessionBridgeConfig({ sessionId: newSessionId(NOW.getTime()), model: "muse-spark-1.3-contributor", effort: "low", gatewayV1: "https://p.example/api/gateway/v1" });
    assert.equal(configProblem(config), null);
    const args = serveArgs(config);
    assert.ok(args.includes("--disable-sandbox") && args.includes("--trust-workspace") && args.includes("--disable-request-user-input"));
    assert.equal(args[args.indexOf("--model") + 1], "muse-spark-1.3-contributor");
    assert.equal(args.filter((a) => a === "-c").length, config.settings.length);
    const keys = config.settings.map((x) => x.split("=")[0]);
    assert.equal(new Set(keys).size, keys.length, "a key given twice refuses the run");
    const runner = runnerScript();
    assert.ok(!runner.includes("META_API_KEY"), "the token is never in the script");
    execFileSync("bash", ["-n"], { input: runner });
    execFileSync("bash", ["-n"], { input: prepareScript() });
    execFileSync("bash", ["-n"], { input: packScript() });
  });
});

describe("the secret scan", () => {
  it("reads the platform's secret values, skips short ones, and redacts text, JSON and bytes", () => {
    const values = secretValues(["mm_cs_session-token-value-xyz"], { ...FAKE_SECRETS, GATEWAY_TOKEN_PEPPER: "short" });
    assert.equal(values.length, 5, "four platform secrets and the session's token; a short value isn't one");
    const text = `a ${FAKE_SECRETS.BLOB_READ_WRITE_TOKEN} b ${FAKE_SECRETS.BLOB_READ_WRITE_TOKEN} c mm_cs_session-token-value-xyz`;
    const r = redactText(text, values);
    assert.equal(r.hits, 3);
    assert.ok(!r.text.includes("vercel_blob_rw_fake"));
    const v = redactValue({ list: [{ deep: FAKE_SECRETS.VERCEL_OIDC_TOKEN }], [FAKE_SECRETS.MODEL_API_KEY]: 1 }, values);
    assert.equal(v.hits, 2);
    assert.ok(!JSON.stringify(v.value).includes("fake-"));
    const b = redactBytes(Buffer.concat([Buffer.from([0, 1]), Buffer.from(FAKE_SECRETS.VERCEL_TOKEN), Buffer.from([2])]), values);
    assert.equal(b.hits, 1);
    assert.deepEqual([...b.bytes.subarray(0, 2)], [0, 1]);
  });
});

describe("the session's settings, firewall and token", () => {
  it("pins bearer auth on the gateway, never none, and turns telemetry, web search and every reminder off", () => {
    const settings = sessionSettings("muse-wonder-1.0", "https://platform.example/api/gateway/v1");
    const endpoint = JSON.parse(settings[0]!.slice("endpoint_transport=".length));
    assert.deepEqual(endpoint, { base_url: "https://platform.example/api/gateway/v1", auth: "bearer" });
    assert.ok(!settings.join(" ").includes('"none"'));
    assert.ok(settings.includes("telemetry.enabled=false"));
    assert.ok(settings.includes('tools.web_search.mode="off"'));
    const reminders = JSON.parse(settings.find((s) => s.startsWith("runtime_capabilities="))!.slice("runtime_capabilities=".length));
    assert.deepEqual(new Set(Object.keys(reminders).map((k) => k.split(":").pop())), new Set(["scope-reminder", "skill-reminder", "goal-reminder", "verify-reminder", "memory-reminder", "todo-reminder"]));
    assert.ok(Object.values(reminders).every((r) => (r as { enabled: boolean }).enabled === false));
    assert.ok(settings.includes("context_compaction.provider_context_limit_tokens=200000"));
    assert.ok(settings.some((s) => s.startsWith("model_catalog=") && s.includes('"background_agent_model":"muse-wonder-1.0"')), "Wonder keeps background work on Wonder");
    assert.ok(!sessionSettings("muse-spark-1.3-contributor", "https://x/api/gateway/v1").some((s) => s.startsWith("model_catalog=")));
    const config = sessionBridgeConfig({ sessionId: "0190f0a0-0000-7000-8000-000000000000", model: "muse-wonder-1.0", effort: "medium", gatewayV1: "https://p/api/gateway/v1" });
    assert.equal(config.reasoningEffort, "medium");
    assert.equal(config.workspace, SESSION_WORKSPACE);
    assert.equal(config.disableRequestUserInput, true);
    assert.equal(config.goal, null);
  });

  it("deletes the catalog copy and hashes Muse Code's programs before the agent runs, and packs without following links", () => {
    const prep = prepareScript();
    assert.match(prep, /rm -rf "\$HOME\/\.local\/share\/muse\/model-catalog"/);
    assert.match(prep, /sha256sum/);
    assert.deepEqual(binaryHashesFrom(`binary-sha256 ${BIN_SHA}\nbinary-sha256 nothex\nsdk-ready\n`), [BIN_SHA]);
    const pack = packScript();
    assert.match(pack, /--exclude='node_modules'/);
    assert.doesNotMatch(pack, / -h | --dereference/);
    assert.match(sessionPrompt("Do it.", ["a.csv"]), /a\.csv[\s\S]*The task:\n\nDo it\./);
  });

  it("reaches only POST /api/gateway/v1/responses on the platform, Host pinned, and npm for GET, nothing else", () => {
    const policy = sessionPolicy("Platform.Example") as { allow: Record<string, Array<Record<string, unknown>>>; subnets: { deny: string[] } };
    assert.deepEqual(Object.keys(policy.allow).sort(), ["platform.example", "registry.npmjs.org"]);
    const [pass, refuse] = policy.allow["platform.example"]!;
    assert.deepEqual(pass!.match, { method: ["POST"], path: { exact: SESSION_GATEWAY_PATH } });
    assert.deepEqual(pass!.transform, [{ headers: { Host: "platform.example" } }]);
    assert.equal((refuse!.response as { statusCode: number }).statusCode, 403);
    assert.deepEqual(policy.allow["registry.npmjs.org"]![0]!.match, { method: ["GET"] });
    assert.ok(policy.subnets.deny.includes("10.0.0.0/8"));
    const bypassed = sessionPolicy("preview.example", { host: "preview.example", secret: "bypass-secret" }) as typeof policy;
    const rules = bypassed.allow["preview.example"]!;
    assert.equal(rules.length, 4, "the bypass-cookie refusals come first");
    assert.deepEqual((rules[2]!.transform as Array<{ headers: Record<string, string> }>)[0]!.headers, { Host: "preview.example", "x-vercel-protection-bypass": "bypass-secret" });
    const other = sessionPolicy("platform.example", { host: "preview.example", secret: "bypass-secret" }) as typeof policy;
    assert.ok(!JSON.stringify(other).includes("bypass-secret"), "a secret for another host never goes in");
  });

  it("makes one token per session from the pepper, shaped so findToken never takes it", () => {
    const a = sessionTokenFor("0190f0a0-0000-7000-8000-000000000001", PEPPER);
    assert.equal(a, sessionTokenFor("0190f0a0-0000-7000-8000-000000000001", PEPPER));
    assert.notEqual(a, sessionTokenFor("0190f0a0-0000-7000-8000-000000000002", PEPPER));
    assert.ok(isSessionToken(a));
    assert.ok(!/^mm_(build|live)_/.test(a));
    assert.throws(() => sessionTokenFor("x", ""));
  });

  it("writes mailbox commands the bridge reads in time order", () => {
    const f = mailboxFile({ type: "steer", text: "Use semicolons." }, NOW);
    assert.ok(f.path.startsWith(`${SESSION_PATHS.mailbox}/${NOW.toISOString()}-`));
    assert.deepEqual(JSON.parse(f.content).command, { type: "steer", text: "Use semicolons." });
  });
});

describe("the code_session scope at the gateway", () => {
  const tok = (model: string) => ({ allowedModels: [model] });
  it("takes only /v1/responses with its one model; muse-spark-1.3 refused outright, Contributor only under TEST_MODEL", () => {
    assert.equal(codeSessionRefusal("responses", "muse-wonder-1.0", tok("muse-wonder-1.0"), null), null);
    assert.equal(codeSessionRefusal("images/generations", "muse-image-1.0", tok("muse-wonder-1.0"), null)?.code, "session_scope");
    assert.equal(codeSessionRefusal("files", null, tok("muse-wonder-1.0"), null)?.code, "session_scope");
    assert.equal(codeSessionRefusal("responses", "muse-spark-1.3", tok("muse-spark-1.3"), "muse-spark-1.3-contributor")?.code, "model_not_found");
    assert.equal(codeSessionRefusal("responses", "sam-3.1", tok("muse-wonder-1.0"), null)?.code, "model_not_found");
    assert.equal(codeSessionRefusal("responses", "muse-wonder-1.0", tok("muse-spark-1.3-contributor"), "muse-spark-1.3-contributor")?.code, "model_not_found", "not its model");
    assert.equal(codeSessionRefusal("responses", "muse-spark-1.3-contributor", tok("muse-spark-1.3-contributor"), null)?.code, "model_not_for_sessions");
    assert.equal(codeSessionRefusal("responses", "muse-spark-1.3-contributor", tok("muse-spark-1.3-contributor"), "muse-spark-1.3-contributor"), null);
    assert.equal(sessionModelFor(true, "muse-spark-1.3-contributor"), "muse-spark-1.3-contributor");
    assert.equal(sessionModelFor(false, "muse-spark-1.3-contributor"), "muse-wonder-1.0", "a person's task never runs on Contributor");
    assert.equal(sessionModelFor(true, null), "muse-wonder-1.0");
  });

  const sessionToken = (model: string, dailyBudgetUsd = 1) => ({ scope: "code_session" as const, allowedModels: [model], dailyBudgetUsd });
  /** A Muse Code turn: about 30,000 input tokens and max_output_tokens 128,000, as the spike measured. */
  const TURN = { model: "muse-wonder-1.0", input: "x".repeat(120_000), max_output_tokens: 128_000, stream: true };

  it("refuses a session token's muse-spark-1.3, other models and other endpoints at the handler", async () => {
    const g = fakeGateway({ token: sessionToken("muse-wonder-1.0") });
    const spark = await handleGateway(gatewayRequest("responses", json({ ...TURN, model: "muse-spark-1.3" }), { "content-type": "application/json" }), ["responses"], g.deps);
    assert.equal(spark.status, 404);
    assert.equal(((await spark.json()) as { error: { code: string } }).error.code, "model_not_found");
    const image = await handleGateway(gatewayRequest("images/generations", json({ model: "muse-image-1.0", prompt: "a cat" }), { "content-type": "application/json" }), ["images", "generations"], g.deps);
    assert.equal(image.status, 403);
    assert.equal(g.upstreamCalls.length, 0);
  });

  it("serves Contributor to a build's session only while TEST_MODEL names it, and never rewrites the model", async () => {
    const reply = { usage: { input_tokens: 100, output_tokens: 10 } };
    const off = fakeGateway({ token: sessionToken("muse-spark-1.3-contributor"), fetch: async () => Response.json(reply) });
    const refused = await handleGateway(gatewayRequest("responses", json({ ...TURN, model: "muse-spark-1.3-contributor" }), { "content-type": "application/json" }), ["responses"], off.deps);
    assert.equal(refused.status, 403);
    const on = fakeGateway({ token: sessionToken("muse-spark-1.3-contributor"), buildTestModel: "muse-spark-1.3-contributor", fetch: async () => Response.json(reply) });
    const ok = await handleGateway(gatewayRequest("responses", json({ ...TURN, model: "muse-spark-1.3-contributor" }), { "content-type": "application/json" }), ["responses"], on.deps);
    assert.equal(ok.status, 200);
    await on.settled();
    assert.equal(JSON.parse(new TextDecoder().decode(on.upstreamCalls[0]!.init!.body as Uint8Array)).model, "muse-spark-1.3-contributor");
  });

  it("Wonder's 128,000-token ask doesn't stop a $1 session early: the call is fitted to what's left (fitOutputToBudget)", async () => {
    const estimate = estimateCost("responses", { kind: "json", json: TURN, model: TURN.model }, 0, 0);
    assert.ok(estimate > 0.7, `about $0.76 unfitted (${estimate})`);
    const reply = { usage: { input_tokens: 30_000, output_tokens: 2_000 } };
    // $0.30 spent of $1: unfitted, $0.30 + $0.76 > $1 would refuse it.
    const g = fakeGateway({ token: sessionToken("muse-wonder-1.0", 1), tokenSpend: 0.3, fetch: async () => Response.json(reply) });
    const res = await handleGateway(gatewayRequest("responses", json(TURN), { "content-type": "application/json" }), ["responses"], g.deps);
    assert.equal(res.status, 200);
    await g.settled();
    const sent = JSON.parse(new TextDecoder().decode(g.upstreamCalls[0]!.init!.body as Uint8Array)) as { max_output_tokens: number };
    assert.ok(sent.max_output_tokens < 128_000 && sent.max_output_tokens >= 1_024, String(sent.max_output_tokens));
    // And at $0.90 spent the session still gets a fitted call rather than a refusal while the input fits.
    const late = fakeGateway({ token: sessionToken("muse-wonder-1.0", 1), tokenSpend: 0.8, fetch: async () => Response.json(reply) });
    assert.equal((await handleGateway(gatewayRequest("responses", json(TURN), { "content-type": "application/json" }), ["responses"], late.deps)).status, 200);
    // A live product's own token is never fitted: it gets the plain budget answer, as today.
    const live = fakeGateway({ token: { allowedModels: ["muse-wonder-1.0"], dailyBudgetUsd: 1 }, tokenSpend: 0.3, fetch: async () => Response.json(reply) });
    assert.equal((await handleGateway(gatewayRequest("responses", json(TURN), { "content-type": "application/json" }), ["responses"], live.deps)).status, 429);
  });

  it("works out what a session has left: its own budget and the product's shared one, whichever is less", () => {
    assert.equal(sessionLeftUsd({ sessionBudgetUsd: 1, sessionSpentUsd: 0.25, parentBudgetUsd: 3, familySpentTodayUsd: 1 }), 0.75);
    assert.ok(Math.abs(sessionLeftUsd({ sessionBudgetUsd: 1, sessionSpentUsd: 0.25, parentBudgetUsd: 3, familySpentTodayUsd: 2.9 }) - 0.1) < 1e-9);
    assert.equal(sessionLeftUsd({ sessionBudgetUsd: 1, sessionSpentUsd: 1.2, parentBudgetUsd: 3, familySpentTodayUsd: 0 }), 0);
  });
});

// ---------- The routes, with fakes ----------

function token(over: Partial<CapToken> = {}): CapToken {
  return { id: "tok-1", productId: "p1", scope: "live", allowedModels: ["muse-wonder-1.0", "cap:code"], dailyBudgetUsd: 3, buildId: null, ...over };
}
const product = (over: Partial<CapProduct> = {}): CapProduct => ({ status: "live", manifest: null, liveUrl: "https://p1.example", takenDownAt: null, ownerId: "u1", ownerEmail: "maker@example.com", ownerIsAdmin: false, ownerBannedAt: null, ...over });

function memoryStore(): CodeSessionStore & { rows: Map<string, CodeSessionRow> } {
  const rows = new Map<string, CodeSessionRow>();
  return {
    rows,
    async insert(r: NewCodeSession) {
      rows.set(r.id, { ...r, tokenId: null, status: "starting", reason: null, sandboxUsageId: null, costUsd: 0, binaryHashes: [], logOffset: 0, condense: {}, events: [], nextEvent: 0, finalText: null, exitCode: null, worked: null, files: [], dropped: [], resultUrl: null, resultExpiresAt: null, createdAt: NOW, startedAt: null, endedAt: null });
    },
    async get(id) {
      const r = rows.get(id);
      return r ? structuredClone(r) : null;
    },
    async update(id, patch, whileStatus) {
      const r = rows.get(id);
      if (!r || (whileStatus && !whileStatus.includes(r.status))) return false;
      rows.set(id, { ...r, ...patch });
      return true;
    },
    async countActive(productId) {
      const active = [...rows.values()].filter((r) => r.status === "starting" || r.status === "running");
      return { product: active.filter((r) => r.productId === productId).length, all: active.length };
    },
    async buildTotals(namespace) {
      const real = [...rows.values()].filter((r) => r.namespace === namespace && r.startedAt);
      return { sessions: real.length, ms: real.reduce((n, r) => n + r.limitMs, 0), usd: real.reduce((n, r) => n + r.costUsd, 0) };
    },
  };
}

interface Seen {
  launched: SessionSpec[];
  wrote: Array<{ path: string; content: Buffer }>;
  detached: Array<{ cmd: string; args: string[]; env?: Record<string, string> }>;
  ran: string[];
  stopped: number;
  tokens: Array<{ token: string; model: string; budgetUsd: number; expiresAt: Date }>;
  revoked: string[];
  reserved: number[];
  settled: unknown[];
  put: Buffer[];
}

/** A sandbox that answers the platform's scripts as a real one would, with a log and a workspace tar the test sets. */
function fakeSandbox(seen: Seen, box: { log: string; tar: Buffer | null }): LongSession {
  return {
    name: "mm-musecode-test",
    async writeFiles(list) {
      seen.wrote.push(...list);
    },
    async run(_cmd, args) {
      const script = args[1] ?? "";
      seen.ran.push(script.slice(0, 40));
      if (script.includes("sha256sum")) return { exitCode: 0, stdout: `binary-sha256 ${BIN_SHA}\nsdk-ready\n`, stderr: "" };
      if (script.includes("tar --format")) return { exitCode: 0, stdout: box.tar ? "packed\n" : "", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    async readFile() {
      return null;
    },
    async startDetached(cmd, args, opts) {
      seen.detached.push({ cmd, args, env: opts.env });
      return { cmdId: "cmd-1" };
    },
    async readPart(p, offset, max) {
      if (p === SESSION_PATHS.log) return Buffer.from(box.log).subarray(offset, offset + max);
      if (p === SESSION_PATHS.tar) return box.tar ? box.tar.subarray(offset, offset + max) : null;
      return null;
    },
    async stop() {
      seen.stopped += 1;
    },
  };
}

function deps(over: Partial<MuseCodeDeps> & { tok?: CapToken; brief?: boolean; box?: { log: string; tar: Buffer | null }; spent?: number; secretSource?: Record<string, string> } = {}) {
  const seen: Seen = { launched: [], wrote: [], detached: [], ran: [], stopped: 0, tokens: [], revoked: [], reserved: [], settled: [], put: [] };
  const store = memoryStore();
  const box = over.box ?? { log: "", tar: null };
  let alive = true;
  const d: MuseCodeDeps = {
    servedCaps: () => ["code"],
    findToken: async () => over.tok ?? token(),
    product: async () => product(),
    adminEmails: [],
    hitRateLimits: async (keys) => Object.fromEntries(keys.map((k) => [k, 1])),
    acquireInFlight: async () => NOW,
    releaseInFlight: async () => undefined,
    platformSpendToday: async () => 0,
    dailySpendCapUsd: 50,
    reserveSpend: async (_ctx, _model, usd) => {
      seen.reserved.push(usd);
      return "res-1";
    },
    settleSpend: async (_id, item) => {
      seen.settled.push(item);
    },
    museCodeOn: () => true,
    visitorsOn: () => false,
    snapshotId: () => "snap_builder",
    platformUrl: () => "https://platform.example",
    bypass: () => null,
    pepper: () => PEPPER,
    testModel: () => null,
    secrets: (extra) => secretValues(extra, over.secretSource ?? FAKE_SECRETS),
    briefAllows: async () => over.brief ?? true,
    sessions: store,
    launch: async (spec) => {
      seen.launched.push(spec);
      return fakeSandbox(seen, box);
    },
    open: async () => (alive ? fakeSandbox(seen, box) : null),
    storeToken: async (opts) => {
      seen.tokens.push(opts);
      return { id: `st-${seen.tokens.length}` };
    },
    revokeToken: async (id) => {
      seen.revoked.push(id);
    },
    familySpendToday: async () => over.spent ?? 0,
    sessionSpendUsd: async () => 0.004,
    putResult: async (_id, zip) => {
      seen.put.push(zip);
      return "https://store.public.blob.vercel-storage.com/caps/code/x/0123.zip";
    },
    fetchFile: async () => Buffer.from("a,b\n"),
    sleep: async () => undefined,
    now: () => NOW,
    clock: () => NOW.getTime(),
    ...over,
  };
  return { d, seen, store, box, kill: () => (alive = false) };
}

const req = (method: string, p: string, body?: unknown, headers: Record<string, string> = {}) =>
  new Request(`https://platform.example/api/gateway/code/sessions${p}`, { method, headers: { authorization: "Bearer mm_live_x", "content-type": "application/json", ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
const ownerHeaders = () => ({ [OWNER_HEADER]: mintOwnerSession({ productId: "p1", subject: "own_1" }, NOW).session });
const errorCode = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;
const start = (d: MuseCodeDeps, body: unknown = { task: "Dedupe people.csv by email.", files: [{ name: "people.csv", text: "email\na@x\n" }] }, headers: Record<string, string> = ownerHeaders()) =>
  handleCodeSessions(req("POST", "", body, headers), [], d);

const exitLog = (finalText: string, code = 0) =>
  [
    { t: 1, kind: "bridge", event: "started", sessionId: "s" },
    { t: 2, kind: "note", method: "item/completed", params: { item: { kind: "agentMessage", itemId: "m1", text: finalText, messagePhase: "final" } } },
    { t: 3, kind: "bridge", event: "exit", exitCode: code, finalText, reason: code ? "failed" : "completed" },
  ]
    .map((r) => JSON.stringify(r))
    .join("\n") + "\n";

describe("the routes, flags and who may", () => {
  it("answers 404 and touches nothing with Muse Code off, or for a path it doesn't serve", async () => {
    const touched: string[] = [];
    const { d } = deps({ museCodeOn: () => false, findToken: async () => (touched.push("findToken"), token()) });
    for (const [method, p, path] of [["POST", "", []], ["GET", "/x/events", ["x", "events"]], ["POST", "/x/stop", ["x", "stop"]]] as const) {
      const res = await handleCodeSessions(req(method, p, method === "POST" ? {} : undefined), [...path], d);
      assert.equal(res.status, 404);
      assert.equal(await errorCode(res), "unknown_endpoint");
    }
    const on = deps({ findToken: async () => (touched.push("findToken"), token()) });
    assert.equal((await handleCodeSessions(req("GET", "/a/b/c"), ["a", "b", "c"], on.d)).status, 404);
    assert.deepEqual(touched, []);
  });

  it("lets the owner start, refuses visitors with MUSE_CODE_VISITORS off, and refuses a product not built for it", async () => {
    const visitor = await start(deps().d, undefined, { [VISITOR_HEADER]: "visitor_aaaaaaaaaaaaaaaa" });
    assert.equal(visitor.status, 403);
    assert.equal(await errorCode(visitor), "sign_in_required");
    const nobody = await start(deps().d, undefined, {});
    assert.equal(nobody.status, 403);
    const notBuilt = await start(deps({ brief: false }).d);
    assert.equal(await errorCode(notBuilt), "cap_not_allowed");
    const on = deps({ visitorsOn: () => true });
    assert.equal((await start(on.d, undefined, { [VISITOR_HEADER]: "visitor_aaaaaaaaaaaaaaaa" })).status, 201);
    assert.equal([...on.store.rows.values()][0]!.principal, "visitor");
  });

  it("checks the task and its files: plain names, one source each, upload URLs only", () => {
    assert.ok(!(readStartArgs({ task: "x" }) instanceof Response));
    for (const bad of [{}, { task: "" }, { task: "x", extra: 1 }, { task: "x".repeat(MUSE_CODE_LIMITS.taskMaxChars + 1) }, { task: "x", files: [{ name: "../a", text: "" }] }, { task: "x", files: [{ name: "a", text: "1", base64: "AA==" }] }, { task: "x", files: [{ name: "a", url: "https://example.com/a" }] }, { task: "x", files: [{ name: ".env", text: "" }] }]) {
      assert.ok(readStartArgs(bad as Record<string, unknown>) instanceof Response, JSON.stringify(bad).slice(0, 80));
    }
    assert.ok(isUploadUrl("https://abc123.public.blob.vercel-storage.com/uploads/p1/a.csv"));
    assert.ok(!isUploadUrl("https://abc123.public.blob.vercel-storage.com/caps/code/x.zip"));
    assert.ok(!isUploadUrl("http://abc123.public.blob.vercel-storage.com/uploads/a"));
  });
});

describe("starting a session", () => {
  it("starts a sibling sandbox from the builder snapshot with the session firewall, its own token in the env only, and the measured settings", async () => {
    const { d, seen, store } = deps();
    const res = await start(d);
    assert.equal(res.status, 201);
    const body = (await res.json()) as { id: string; model: string; budgetUsd: number; disclosure: string; endsAt: string };
    assert.equal(body.model, "muse-wonder-1.0");
    assert.equal(body.budgetUsd, 1);
    assert.equal(body.disclosure, MUSE_CODE_DISCLOSURE);
    assert.equal(new Date(body.endsAt).getTime() - NOW.getTime(), 15 * 60_000);
    const spec = seen.launched[0]!;
    assert.equal(spec.purpose, "musecode");
    assert.equal(spec.snapshotId, "snap_builder");
    assert.equal(spec.vcpus, 2);
    assert.equal(spec.timeoutMs, 15 * 60_000 + MUSE_CODE_LIMITS.sandboxGraceMs);
    assert.deepEqual(Object.keys((spec.networkPolicy as { allow: object }).allow).sort(), ["platform.example", "registry.npmjs.org"]);
    // The token: one per session, its model and budget, dead at the session's end, and only in the runner's env.
    const minted = sessionTokenFor(body.id, PEPPER);
    assert.deepEqual(seen.tokens.map((t) => [t.token === minted, t.model, t.budgetUsd, t.expiresAt.toISOString()]), [[true, "muse-wonder-1.0", 1, body.endsAt]]);
    assert.deepEqual(seen.detached, [{ cmd: "bash", args: [SESSION_PATHS.runner], env: { META_API_KEY: minted } }]);
    assert.ok(seen.wrote.every((f) => !f.content.toString("utf8").includes(minted)), "the token is in no file");
    assert.ok(seen.wrote.every((f) => !f.content.toString("utf8").includes(FAKE_SECRETS.MODEL_API_KEY)));
    const wrote = Object.fromEntries(seen.wrote.map((f) => [f.path, f.content.toString("utf8")]));
    assert.ok(wrote[BRIDGE_SCRIPT]!.includes("runBridge"));
    const config = JSON.parse(wrote[SESSION_PATHS.config]!);
    assert.equal(config.model, "muse-wonder-1.0");
    assert.equal(config.reasoningEffort, "medium");
    assert.ok(config.settings[0].includes('"base_url":"https://platform.example/api/gateway/v1","auth":"bearer"'));
    assert.match(wrote[SESSION_PATHS.prompt]!, /Dedupe people\.csv by email\./);
    assert.equal(wrote[`${SESSION_WORKSPACE}/people.csv`], "email\na@x\n");
    const row = store.rows.get(body.id)!;
    assert.equal(row.status, "running");
    assert.deepEqual(row.binaryHashes, [BIN_SHA]);
    assert.equal(row.tokenId, "st-1");
    assert.equal(row.principal, "owner");
    assert.ok(seen.reserved[0]! > 0 && seen.reserved[0]! < 0.2, "the sandbox's worst case is reserved");
  });

  it("holds 2 at once per product and 8 across the platform", async () => {
    const one = deps();
    for (let i = 0; i < 2; i++) assert.equal((await start(one.d)).status, 201);
    const third = await start(one.d);
    assert.equal(third.status, 429);
    assert.equal(await errorCode(third), "rate_limited");
    const all = deps();
    all.d.sessions.countActive = async () => ({ product: 0, all: 8 });
    assert.equal((await start(all.d)).status, 429);
  });

  it("shares the product's daily budget: a session gets what's left, and none when too little is", async () => {
    const some = deps({ spent: 2.4 });
    const res = await start(some.d);
    assert.equal(((await res.json()) as { budgetUsd: number }).budgetUsd, 0.6);
    const none = deps({ spent: 2.99 });
    assert.equal(await errorCode(await start(none.d)), "budget_exceeded");
  });

  it("gives a build 2 real sessions, 5 minutes and $0.50 in all, on Contributor under TEST_MODEL", async () => {
    const b = deps({ tok: token({ scope: "build", buildId: BUILD, dailyBudgetUsd: 10 }), testModel: () => "muse-spark-1.3-contributor" });
    const first = (await (await start(b.d, undefined, {})).json()) as { model: string; budgetUsd: number; endsAt: string };
    assert.equal(first.model, "muse-spark-1.3-contributor");
    assert.equal(first.budgetUsd, 0.5);
    assert.equal(new Date(first.endsAt).getTime() - NOW.getTime(), 5 * 60_000);
    assert.equal(JSON.parse(b.seen.wrote.find((f) => f.path === SESSION_PATHS.config)!.content.toString()).reasoningEffort, "low");
    // The first used its 5 minutes: nothing is left for a second.
    assert.equal(await errorCode(await start(b.d, undefined, {})), "budget_exceeded");
    const two = deps({ tok: token({ scope: "build", buildId: BUILD, dailyBudgetUsd: 10 }) });
    two.d.sessions.buildTotals = async () => ({ sessions: 2, ms: 60_000, usd: 0.01 });
    assert.equal(await errorCode(await start(two.d, undefined, {})), "rate_limited");
  });

  it("tells a site without a builder snapshot or public address plainly, and cleans up a start that fails", async () => {
    assert.equal(await errorCode(await start(deps({ snapshotId: () => null }).d)), "cap_failed");
    assert.equal(await errorCode(await start(deps({ platformUrl: () => "http://localhost:3000" }).d)), "cap_failed");
    const broken = deps();
    broken.d.launch = async () => {
      throw new Error(`create failed near ${FAKE_SECRETS.MODEL_API_KEY}`);
    };
    const res = await start(broken.d);
    assert.equal(res.status, 502);
    const row = [...broken.store.rows.values()][0]!;
    assert.equal(row.status, "failed");
    assert.deepEqual(broken.seen.revoked, ["st-1"]);
    assert.equal(broken.seen.settled.length, 1, "the sandbox reservation is settled");
  });
});

describe("following, steering, stopping and the result", () => {
  async function running(over: Parameters<typeof deps>[0] = {}) {
    const f = deps(over);
    const { id } = (await (await start(f.d)).json()) as { id: string };
    return { ...f, id };
  }

  it("condenses the bridge log into steps, scans them for secrets and the session's token, and ends with the files when the bridge exits", async () => {
    const f = await running();
    const minted = sessionTokenFor(f.id, PEPPER);
    f.box.log = exitLog(`Wrote dedupe.js. The key was ${FAKE_SECRETS.MODEL_API_KEY} and the token ${minted}.`);
    f.box.tar = tar([{ name: "./dedupe.js", data: "x" }, { name: "./copy", data: BIN }]);
    const res = await handleCodeSessions(req("GET", `/${f.id}/events?after=-1`, undefined, ownerHeaders()), [f.id, "events"], f.d);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { status: string; events: Array<{ n: number; text: string }>; finalText: string; worked: boolean; costUsd: number };
    assert.equal(body.status, "completed");
    assert.equal(body.worked, true);
    const shown = JSON.stringify(body);
    assert.ok(!shown.includes(FAKE_SECRETS.MODEL_API_KEY) && !shown.includes(minted), "no secret in what's shown");
    assert.ok(body.finalText.includes(REDACTED));
    assert.ok(!JSON.stringify(f.store.rows.get(f.id)).includes(FAKE_SECRETS.MODEL_API_KEY), "nor in what's stored");
    assert.deepEqual(f.seen.revoked, ["st-1"], "the token died when it ended");
    const row = f.store.rows.get(f.id)!;
    assert.deepEqual(row.files.map((x) => x.path), ["dedupe.js"]);
    assert.match(row.dropped[0]!.why, /Muse Code program/);
    assert.equal(f.seen.put.length, 1);
    assert.ok(row.resultExpiresAt!.getTime() - NOW.getTime() === 24 * 3_600_000);
    const result = (await (await handleCodeSessions(req("GET", `/${f.id}/result`, undefined, ownerHeaders()), [f.id, "result"], f.d)).json()) as { done: boolean; zipUrl: string; files: unknown[] };
    assert.equal(result.done, true);
    assert.ok(result.zipUrl.includes("/caps/code/"));
  });

  it("says a run that exited 0 but made nothing didn't work", async () => {
    const f = await running();
    f.box.log = exitLog("I need a CSV to read. Please attach one.");
    f.box.tar = tar([]);
    const body = (await (await handleCodeSessions(req("GET", `/${f.id}/events`, undefined, ownerHeaders()), [f.id, "events"], f.d)).json()) as { status: string; worked: boolean; finalText: string };
    assert.equal(body.status, "completed");
    assert.equal(body.worked, false);
    assert.match(body.finalText, /attach one/);
  });

  it("stops at its time limit and keeps what it made", async () => {
    const f = await running();
    f.box.tar = tar([{ name: "half.js", data: "x" }]);
    const later = { ...f.d, now: () => new Date(NOW.getTime() + 16 * 60_000) };
    const body = (await (await handleCodeSessions(req("GET", `/${f.id}/events`, undefined, ownerHeaders()), [f.id, "events"], later)).json()) as { status: string; reason: string };
    assert.equal(body.status, "stopped");
    assert.match(body.reason, /15 minute limit/);
    assert.deepEqual(f.store.rows.get(f.id)!.files.map((x) => x.path), ["half.js"]);
  });

  it("steers into the running turn through the mailbox, and stops on request: token first, then the files", async () => {
    const f = await running();
    const steer = await handleCodeSessions(req("POST", `/${f.id}/steer`, { text: "Use semicolons." }, ownerHeaders()), [f.id, "steer"], f.d);
    assert.equal(steer.status, 200);
    const note = f.seen.wrote.find((w) => w.path.startsWith(`${SESSION_PATHS.mailbox}/`))!;
    assert.deepEqual(JSON.parse(note.content.toString()).command, { type: "steer", text: "Use semicolons." });
    f.box.tar = tar([{ name: "out.txt", data: "done" }]);
    const stop = await handleCodeSessions(req("POST", `/${f.id}/stop`, {}, ownerHeaders()), [f.id, "stop"], f.d);
    const body = (await stop.json()) as { status: string; done: boolean; files: unknown[] };
    assert.equal(body.status, "stopped");
    assert.equal(body.done, true);
    assert.equal(body.files.length, 1);
    assert.equal(f.seen.revoked[0], "st-1");
    assert.ok(f.seen.wrote.some((w) => w.path.startsWith(`${SESSION_PATHS.mailbox}/`) && w.content.toString().includes('"type":"end"')));
    const again = await handleCodeSessions(req("POST", `/${f.id}/steer`, { text: "more" }, ownerHeaders()), [f.id, "steer"], f.d);
    assert.equal(again.status, 400, "a stopped session takes no note");
  });

  it("shows a session only to the one who started it, on its own product and namespace", async () => {
    const f = await running({ visitorsOn: () => true });
    const other = await handleCodeSessions(req("GET", `/${f.id}/events`, undefined, { [VISITOR_HEADER]: "visitor_bbbbbbbbbbbbbbbb" }), [f.id, "events"], f.d);
    assert.equal(other.status, 400);
    const otherProduct = { ...f.d, findToken: async () => token({ productId: "p2" }) };
    const p2Owner = { [OWNER_HEADER]: mintOwnerSession({ productId: "p2", subject: "own_1" }, NOW).session };
    assert.equal((await handleCodeSessions(req("GET", `/${f.id}/events`, undefined, p2Owner), [f.id, "events"], otherProduct)).status, 400);
    const asBuild = { ...f.d, findToken: async () => token({ scope: "build", buildId: BUILD }) };
    assert.equal((await handleCodeSessions(req("GET", `/${f.id}/events`, undefined, {}), [f.id, "events"], asBuild)).status, 400);
  });

  it("ends a session whose sandbox is gone, with no files and a plain reason", async () => {
    const f = await running();
    f.kill();
    const body = (await (await handleCodeSessions(req("GET", `/${f.id}/events`, undefined, ownerHeaders()), [f.id, "events"], f.d)).json()) as { status: string; reason: string };
    assert.equal(body.status, "expired");
    assert.match(body.reason, /no files came back/);
  });
});

describe("the sweep", () => {
  it("closes overdue sessions, stops sandboxes no session holds, and deletes zips past 24 hours", async () => {
    const f = deps();
    const { id } = (await (await start(f.d)).json()) as { id: string };
    const row = f.store.rows.get(id)!;
    row.endsAt = new Date(NOW.getTime() - 10 * 60_000);
    const stopped: string[] = [];
    const deleted: string[] = [];
    const s: SweepDeps = {
      deps: f.d,
      overdue: async () => [structuredClone(row)],
      active: async () => [],
      heldNames: async () => new Set([row.sandboxName]),
      runningNames: async () => [row.sandboxName, "mm-musecode-orphan"],
      stopByName: async (name) => (stopped.push(name), true),
      expired: async () => [{ id: "old", url: "https://x.public.blob.vercel-storage.com/caps/code/old.zip" }],
      deleteResult: async (url) => {
        deleted.push(url);
      },
      clearResult: async () => undefined,
      oldBuildResults: async () => [],
      deleteSession: async () => undefined,
      deleteBuildSessions: async () => undefined,
      buildResultUrls: async () => [],
    };
    const n = await sweepMuseCode(NOW, s);
    assert.equal(n, 3);
    assert.equal(f.store.rows.get(id)!.status, "expired");
    assert.deepEqual(stopped, ["mm-musecode-orphan"]);
    assert.equal(deleted.length, 1);
  });

  it("records a session's end once, even when two finishers race", async () => {
    const f = deps();
    const { id } = (await (await start(f.d)).json()) as { id: string };
    const row = f.store.rows.get(id)!;
    await Promise.all([finishSession(structuredClone(row), { status: "stopped", reason: "a" }, f.d, NOW), finishSession(structuredClone(row), { status: "expired", reason: "b" }, f.d, NOW)]);
    assert.ok(["stopped", "expired"].includes(f.store.rows.get(id)!.status));
  });
});

describe("the brief, the catalog, the build prompt and the judge", () => {
  const ON = { exec: false, browse: false, visitors: false, museCode: true };
  const OFF = { exec: false, browse: false, visitors: false };
  const museBrief = { ...BRIEF, code: { runtimes: [], browse: false, museCode: true } } as unknown as Brief;
  const withEnv = (run: () => void) => {
    const keep = { MUSE_CODE_ENABLED: process.env.MUSE_CODE_ENABLED, BUILDER_SNAPSHOT_ID: process.env.BUILDER_SNAPSHOT_ID, VERCEL: process.env.VERCEL };
    try {
      process.env.MUSE_CODE_ENABLED = "1";
      process.env.BUILDER_SNAPSHOT_ID = "snap_builder";
      delete process.env.VERCEL;
      run();
    } finally {
      for (const [k, v] of Object.entries(keep)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  };

  it("offers the writer museCode only while the part is on, and with it off the block is what it was", () => {
    assert.deepEqual(Object.keys((codeWriterBlock(OFF) as z.ZodObject<z.ZodRawShape>).shape), ["runtimes", "browse"]);
    const on = (codeWriterBlock(ON) as z.ZodObject<z.ZodRawShape>).shape;
    assert.deepEqual(Object.keys(on), ["runtimes", "browse", "museCode"]);
    assert.ok(!codeWriterRules(OFF).join(" ").includes("museCode"));
    assert.ok(codeWriterRules(ON).join(" ").includes("code.museCode"));
    assert.ok(!codeCatalogBlock(OFF).includes("Muse Code"));
    assert.ok(codeCatalogBlock(ON).includes("for the product's owner only"));
    assert.ok(codeCatalogBlock({ ...ON, museCodeVisitors: true }).includes("3 tasks a day each"));
    assert.equal(codePartsKey(OFF), "");
    assert.equal(codePartsKey({ ...ON, museCodeVisitors: true }), "mw");
  });

  it("keeps museCode only while it's on, in the block, the overlay and the build's env", () => {
    const stored = { runtimes: [], browse: false, museCode: true };
    assert.equal(codeBlock({ code: stored }, OFF), null, "off, a block with nothing else isn't a code product");
    assert.deepEqual(codeBlock({ code: stored }, ON), stored);
    assert.deepEqual(codeBlock({ code: { runtimes: ["quickjs"], browse: false } }, ON), { runtimes: ["quickjs"], browse: false });
    assert.deepEqual(codePartsOff({ code: stored }, OFF), ["museCode"]);
    assert.equal(normalizeCodeBlock({ runtimes: [], browse: false, museCode: true }, OFF), null);
    assert.deepEqual(normalizeCodeBlock({ runtimes: [], browse: false, museCode: "yes" }, ON), { runtimes: [], browse: false, museCode: true });
    assert.deepEqual(CAP_OVERLAY_PICK.code!(museBrief), ["code"], "with the flag off here, no kit");
    assert.deepEqual(capBuildEnv({ ...BRIEF, code: { runtimes: ["quickjs"], browse: false } } as unknown as Brief), "");
    withEnv(() => {
      assert.deepEqual(CAP_OVERLAY_PICK.code!(museBrief), ["code", "musecode"]);
      assert.equal(capBuildEnv(museBrief), "MUSE_CODE_REPLAY_OK=1\n");
      assert.deepEqual(capDeployEnv(museBrief, "tok"), {}, "the live product never replays");
      assert.equal(capOverlaysNeeded("code").includes("musecode"), false, "a snapshot without the kit leaves the rest of the code cap ready");
    });
  });

  it("needs a snapshot that lists the kit on Vercel, and a builder snapshot anywhere", () => {
    withEnv(() => {
      assert.equal(museCodeOn(), true);
      delete process.env.BUILDER_SNAPSHOT_ID;
      assert.equal(museCodeOn(), false);
      process.env.BUILDER_SNAPSHOT_ID = "snap_builder";
      process.env.VERCEL = "1";
      const warn = console.warn;
      console.warn = () => undefined;
      try {
        assert.equal(museCodeOn(), false, "this snapshot id isn't in lib/sandbox/snapshots.json");
      } finally {
        console.warn = warn;
      }
    });
  });

  it("writes the build prompt's section and the judge's note, with the disclosure, the limits and no em dash", () => {
    withEnv(() => {
      const lines = CODE_RENDER.build(museBrief);
      const text = lines.join("\n");
      for (const part of [MUSE_CODE_DISCLOSURE, "muse-code-in-product", "CodeRun", "museCode.link", "120 seconds", "15 minutes", "$1.00", "2 real tasks", "$0.50", "replay: true", "expectMuseCodeRun", "sign_in_required"]) {
        assert.ok(text.includes(part), part);
      }
      assert.ok(!text.includes("\u2014"));
      assert.ok(!text.includes("Pyodide"), "a block with only Muse Code says nothing of runtimes");
      const both = CODE_RENDER.build({ ...BRIEF, code: { runtimes: ["quickjs"], browse: false, museCode: true } } as unknown as Brief).join("\n");
      assert.ok(both.includes("QuickJS") && both.includes("muse-code-in-product"));
      const note = codeJudgeNote(museBrief);
      assert.match(note, /Stop button/);
      assert.match(note, /made nothing didn't work/);
      assert.ok(!note.includes("\u2014"));
      assert.equal(CODE_RENDER.refine!(museBrief).length, 1);
    });
    assert.deepEqual(CODE_RENDER.build(museBrief), [], "with the flag off the build gets no section");
  });
});

describe("TEST_TOKEN stays a product token", () => {
  it("is not shaped like a session token", () => {
    assert.ok(!isSessionToken(TEST_TOKEN));
  });
});
