/**
 * The code cap (docs/CAPABILITIES.md, section 15) without a database or a sandbox: /exec's limits and its empty network
 * policy, /browse's URL-in-input rule and its private-address and password-field refusals, who may run what (decision
 * 10), the build's own counts and stand-ins, and the brief, prompt and judge text.
 *
 *   npx tsx --test lib/caps/code/__tests__/code.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { newBriefSchemaFor } from "@/lib/brief/schema";
import { strictJsonSchema } from "@/lib/brief/strict-schema";
import { normalizeRawBrief } from "@/lib/brief/normalize";
import { CodeBriefBlock, codeBlock, normalizeCodeBlock } from "@/lib/caps/code/brief";
import { codePartsOn } from "@/lib/caps/code/parts";
import { capsForBuild } from "@/lib/caps/ready";
import { env } from "@/lib/env";
import { catalogSummary } from "@/lib/prompts/catalog";
import { browseOutcomeOf, readBrowseArgs, runBrowse, typedByPerson, type BrowseArgs } from "@/lib/caps/code/browse";
import { execFiles, execScript, outcomeOf, readExecArgs, runExec, type ExecArgs } from "@/lib/caps/code/exec";
import { browseRoute, execRoute, handleBrowse, handleExec, type CodeDeps } from "@/lib/caps/code/handler";
import { codeJudgeNote } from "@/lib/caps/code/judge";
import { BROWSE_SANDBOX_MS, BROWSE_WORST_USD, BUILD_VERIFIES_MAX, EXEC_LIMITS, EXEC_SANDBOX_MS, EXEC_WORST_USD, SMOKE_EXEC_RUNS, sandboxCostUsd } from "@/lib/caps/code/limits";
import { REFINE_ROUND_STRIDE } from "@/lib/sandbox/muse";
import { SAMPLE_MARKERS, samplePageFor } from "@/lib/caps/code/pages";
import { browsePolicy, execPolicy, PRIVATE_CIDRS } from "@/lib/caps/code/policy";
import { CODE_RENDER } from "@/lib/caps/code/render";
import type { CodeSession, SessionSpec } from "@/lib/caps/code/session";
import type { ExecRunRow } from "@/lib/caps/code/store";
import { capsWriterRules } from "@/lib/caps/brief-fields";
import { capsCatalogBlocks } from "@/lib/caps/catalog";
import type { CapProduct, CapToken } from "@/lib/caps/gate";
import { BUILD_TEST_OWNER } from "@/lib/caps/principal";
import { capsBuildLines } from "@/lib/caps/render";
import { OWNER_HEADER, VISITOR_HEADER } from "@/lib/gateway/policy";
import { BRIEF } from "@/lib/promote/__tests__/fixtures";
import { mintOwnerSession } from "@/lib/tools/principal";
import { GUEST_EMAIL } from "@/lib/auth";
import type { Brief } from "@/lib/brief/schema";
import type { ModelUsage } from "@/lib/types";

process.env.GATEWAY_TOKEN_PEPPER ??= "test-pepper-for-the-code-cap";
// Both server parts on, as a site serving all of the code cap would have them (lib/caps/code/parts.ts). The tests of
// the parts switched off set them per test.
process.env.CODE_EXEC = "1";
process.env.CODE_BROWSE = "1";
process.env.BUILDER_SNAPSHOT_ID = "snap_builder";

const NOW = new Date("2026-11-01T12:00:00Z");
const BUILD = "22222222-2222-4222-8222-222222222222";

const execArgs = (over: Partial<ExecArgs> = {}): ExecArgs => ({ language: "python", code: "print(1)", stdin: "", files: [], ...over });

describe("/exec arguments", () => {
  it("takes python or node, code, stdin and files, and refuses anything else by name", () => {
    assert.deepEqual(readExecArgs({ language: "node", code: "console.log(1)" }), { language: "node", code: "console.log(1)", stdin: "", files: [] });
    const extra = readExecArgs({ language: "python", code: "x", network: true });
    assert.ok(extra instanceof Response);
    assert.equal(extra.status, 400);
    for (const bad of [{ language: "ruby", code: "x" }, { language: "python", code: "" }, { language: "python", code: "   " }, { language: "python" }, { language: "python", code: 1 }]) {
      assert.ok(readExecArgs(bad) instanceof Response, JSON.stringify(bad));
    }
  });

  it("holds code and stdin to 64 KB, files to 20 and 1 MB, with plain names that aren't the program's", () => {
    assert.ok(readExecArgs({ language: "python", code: "x".repeat(EXEC_LIMITS.codeMaxBytes) }) && !(readExecArgs({ language: "python", code: "x".repeat(EXEC_LIMITS.codeMaxBytes) }) instanceof Response));
    assert.ok(readExecArgs({ language: "python", code: "é".repeat(EXEC_LIMITS.codeMaxBytes / 2 + 1) }) instanceof Response, "bytes, not characters");
    assert.ok(readExecArgs({ language: "python", code: "x", stdin: "y".repeat(EXEC_LIMITS.stdinMaxBytes + 1) }) instanceof Response);
    const ok = readExecArgs({ language: "python", code: "x", files: [{ name: "data.csv", text: "a,b\n1,2\n" }, { name: "pic.bin", base64: Buffer.from([1, 2, 3]).toString("base64") }] });
    assert.ok(!(ok instanceof Response));
    assert.deepEqual([...(ok as ExecArgs).files[1]!.content], [1, 2, 3]);
    for (const name of ["../x", "a/b", ".env", "main.py", "main.mjs", "", "x".repeat(101)]) {
      assert.ok(readExecArgs({ language: "python", code: "x", files: [{ name, text: "" }] }) instanceof Response, name);
    }
    assert.ok(readExecArgs({ language: "python", code: "x", files: [{ name: "a", text: "1" }, { name: "a", text: "2" }] }) instanceof Response, "twice");
    assert.ok(readExecArgs({ language: "python", code: "x", files: [{ name: "a", text: "1", base64: "AA==" }] }) instanceof Response, "both");
    assert.ok(readExecArgs({ language: "python", code: "x", files: [{ name: "a", base64: "not base64!" }] }) instanceof Response);
    assert.ok(readExecArgs({ language: "python", code: "x", files: Array.from({ length: 21 }, (_, i) => ({ name: `f${i}`, text: "" })) }) instanceof Response);
    const half = "a".repeat(EXEC_LIMITS.filesMaxBytes / 2 + 1);
    assert.ok(readExecArgs({ language: "python", code: "x", files: [{ name: "a", text: half }, { name: "b", text: half }] }) instanceof Response, "1 MB in all");
  });

  it("runs the program in its own folder with a hard 15 s kill, each stream cut at 64 KB, and limits on files and processes", () => {
    const script = execScript("python");
    assert.match(script, /timeout -s KILL 15 python3 \/tmp\/mm-exec\/main\.py < \/tmp\/mm-exec\/stdin/);
    assert.match(script, /head -c 65537 > \/tmp\/mm-exec\/out/);
    assert.match(script, /head -c 65537 > \/tmp\/mm-exec\/err/);
    assert.match(script, /ulimit -f 65536/);
    assert.match(script, /ulimit -u 256/);
    assert.match(execScript("node"), /timeout -s KILL 15 node \/tmp\/mm-exec\/main\.mjs/);
    const files = execFiles(execArgs({ files: [{ name: "data.csv", content: Buffer.from("1") }] }));
    assert.deepEqual(files.map((f) => f.path), ["/tmp/mm-exec/main.py", "/tmp/mm-exec/stdin", "/tmp/mm-exec/run.sh", "/tmp/mm-exec/work/.keep", "/tmp/mm-exec/work/data.csv"]);
  });

  it("reads the outcome: ok, an error exit, a kill at the limit, a run that never wrote its status, and cut output", () => {
    const ok = outcomeOf(Buffer.from("45\n"), Buffer.from(""), Buffer.from("0 120\n"));
    assert.deepEqual(ok, { status: "ok", exitCode: 0, stdout: "45\n", stderr: "", truncated: false, ms: 120 });
    const error = outcomeOf(Buffer.from(""), Buffer.from("Traceback"), Buffer.from("1 80"));
    assert.equal(error.status, "error");
    assert.equal(error.exitCode, 1);
    const killed = outcomeOf(null, null, Buffer.from("137 15002"));
    assert.equal(killed.status, "timeout");
    assert.equal(killed.exitCode, null);
    assert.match(killed.stderr, /stopped after 15 seconds/);
    assert.equal(killed.ms, 15_000);
    assert.equal(outcomeOf(null, null, null).status, "timeout");
    const long = outcomeOf(Buffer.alloc(EXEC_LIMITS.outputMaxBytes + 1, 97), null, Buffer.from("141 30"));
    assert.equal(long.truncated, true);
    assert.equal(long.stdout.length, EXEC_LIMITS.outputMaxBytes);
  });
});

describe("the sandboxes' firewalls", () => {
  it("gives /exec no network at all", () => {
    assert.equal(execPolicy(), "deny-all");
  });

  it("gives /browse the one host and no private range", () => {
    assert.deepEqual(browsePolicy("Example.org"), { allow: ["example.org"], subnets: { deny: [...PRIVATE_CIDRS] } });
    for (const cidr of ["10.0.0.0/8", "127.0.0.0/8", "169.254.0.0/16", "192.168.0.0/16", "172.16.0.0/12"]) assert.ok(PRIVATE_CIDRS.includes(cidr as never), cidr);
    for (const bad of ["*.example.org", "localhost", "10.0.0.1", "example.org/path", "", "a b.org"]) assert.throws(() => browsePolicy(bad), bad);
  });
});

describe("/browse arguments", () => {
  const read = (body: Record<string, unknown>) => readBrowseArgs(body);
  const refused = async (body: Record<string, unknown>) => {
    const out = read(body);
    assert.ok(out instanceof Response, JSON.stringify(body));
    return ((await out.json()) as { error: { message: string } }).error.message;
  };

  it("opens only an address that is in what the person typed, with or without its scheme", async () => {
    const ok = read({ url: "https://example.org/news", input: "Summarize example.org/news for me" });
    assert.ok(!(ok instanceof Response));
    assert.deepEqual(ok, { url: "https://example.org/news", host: "example.org", actions: [] });
    assert.ok(!(read({ url: "example.org/news/", input: "look at https://example.org/news" }) instanceof Response), "a bare url and a trailing slash");
    assert.match(await refused({ url: "https://example.org/admin", input: "Summarize example.org/news" }), /address the person typed/);
    assert.match(await refused({ url: "https://other.example/news", input: "Summarize example.org/news" }), /address the person typed/);
    assert.equal(typedByPerson("https://example.org/a?b=1", "see example.org/a?b=1."), true);
    assert.equal(typedByPerson("https://example.org/a?b=2", "see example.org/a?b=1."), false);
    assert.equal(typedByPerson("https://example.org/", "mail me at ana@example.org"), false, "an email address is no site");
  });

  it("refuses IP literals, private names, odd ports, other schemes and addresses that carry a sign-in", async () => {
    for (const url of ["http://127.0.0.1/", "http://10.0.0.5/", "http://[::1]/", "http://169.254.169.254/latest", "http://2130706433/"]) {
      assert.ok(read({ url, input: `open ${url}` }) instanceof Response, url);
    }
    for (const url of ["http://localhost:3000/", "https://printer.local/", "https://db.internal/"]) assert.ok(read({ url, input: `open ${url}` }) instanceof Response, url);
    assert.match(await refused({ url: "https://example.org:8443/", input: "open https://example.org:8443/" }), /usual port/);
    assert.match(await refused({ url: "ftp://example.org/", input: "open ftp://example.org/" }), /http and https/);
    assert.match(await refused({ url: "https://ana:secret@example.org/", input: "open https://ana:secret@example.org/" }), /never signs in/);
  });

  it("refuses up front, in plain words, a site name the firewall can't hold, and treats a trailing dot as the same site", async () => {
    assert.match(await refused({ url: "https://my_site.example.com", input: "my_site.example.com" }), /characters browsing can't open/);
    const dotted = read({ url: "https://example.com.", input: "open https://example.com." });
    assert.ok(!(dotted instanceof Response), "typed exactly, with its trailing dot");
    assert.deepEqual(dotted, { url: "https://example.com/", host: "example.com", actions: [] });
    const page = Buffer.from(JSON.stringify({ ok: true, url: "https://example.com./", title: "t", text: "x", screenshot: "" }));
    assert.equal(browseOutcomeOf(page, "example.com").ok, true, "a final host with a trailing dot is the same site");
  });

  it("takes at most 5 click, type or wait steps, and never types into a password, code or card field", async () => {
    const input = "open example.org";
    const steps = [{ type: "click", selector: "#more" }, { type: "type", selector: "#q", text: "tides" }, { type: "wait", ms: 500 }];
    const ok = read({ url: "https://example.org", input, actions: steps });
    assert.ok(!(ok instanceof Response));
    assert.equal((ok as BrowseArgs).actions.length, 3);
    assert.ok(read({ url: "https://example.org", input, actions: Array.from({ length: 6 }, () => ({ type: "wait", ms: 1 })) }) instanceof Response);
    for (const selector of ["input[type=password]", "#password", "[name=otp]", "#cc-number", "#card", "#cvc"]) {
      assert.match(await refused({ url: "https://example.org", input, actions: [{ type: "type", selector, text: "x" }] }), /never signs in/, selector);
    }
    assert.ok(read({ url: "https://example.org", input, actions: [{ type: "wait", ms: 9_000 }] }) instanceof Response);
    assert.ok(read({ url: "https://example.org", input, actions: [{ type: "submit", selector: "form" }] }) instanceof Response);
    assert.ok(read({ url: "https://example.org", input, actions: [{ type: "click", selector: "#a", text: "extra" }] }) instanceof Response);
  });

  it("checks the page again after it opened: still on the typed host, and says why in plain words when not", () => {
    const page = (o: object) => Buffer.from(JSON.stringify(o));
    assert.equal(browseOutcomeOf(page({ ok: true, url: "https://elsewhere.example/", title: "x", text: "y", screenshot: "" }), "example.org").ok, false);
    assert.match(browseOutcomeOf(page({ ok: false, error: "secret-field" }), "example.org").problem!, /never signs in/);
    assert.match(browseOutcomeOf(null, "example.org").problem!, /didn't open/);
    const ok = browseOutcomeOf(page({ ok: true, url: "https://example.org/a", title: "Tides", text: "Hi", screenshot: "QUJD" }), "example.org");
    assert.deepEqual(ok, { ok: true, page: { url: "https://example.org/a", title: "Tides", text: "Hi", screenshot: "data:image/jpeg;base64,QUJD" } });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The routes, behind the cap gate, with fakes

function token(over: Partial<CapToken> = {}): CapToken {
  return { id: "tok-1", productId: "p1", scope: "live", allowedModels: ["muse-wonder-1.0", "cap:code"], dailyBudgetUsd: 3, buildId: null, ...over };
}
const buildToken = () => token({ scope: "build", buildId: BUILD });
const product = (over: Partial<CapProduct> = {}): CapProduct => ({ status: "live", manifest: null, liveUrl: "https://p1.example", takenDownAt: null, ownerId: "u1", ownerEmail: "maker@example.com", ownerIsAdmin: false, ownerBannedAt: null, ...over });

interface Seen {
  launched: SessionSpec[];
  stopped: number;
  wrote: string[];
  runs: ExecRunRow[];
  settled: Array<ModelUsage | null>;
  reserved: number[];
  slots: string[];
  released: string[];
  lookups: string[];
  /** The build counters, by key, as reserveCounter and adjustCounter keep them. */
  counters: Map<string, number>;
}

function fakeSession(seen: Seen, files: Record<string, Buffer | null>): CodeSession & { stop(): Promise<void> } {
  return {
    name: "mm-test",
    async writeFiles(list) {
      seen.wrote.push(...list.map((f) => f.path));
    },
    async run() {
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    async readFile(path) {
      return files[path] ?? null;
    },
    async stop() {
      seen.stopped += 1;
    },
  };
}

function deps(over: Partial<CodeDeps> & { tok?: CapToken | null; files?: Record<string, Buffer | null>; counter?: number | null; addresses?: string[] } = {}) {
  const seen: Seen = { launched: [], stopped: 0, wrote: [], runs: [], settled: [], reserved: [], slots: [], released: [], lookups: [], counters: new Map() };
  let t = 0;
  const d: CodeDeps = {
    servedCaps: () => ["code"],
    findToken: async () => (over.tok === undefined ? token() : over.tok),
    product: async () => product(),
    adminEmails: [],
    hitRateLimits: async (keys) => Object.fromEntries(keys.map((k) => [k, 1])),
    acquireInFlight: async (key) => {
      seen.slots.push(key);
      return NOW;
    },
    releaseInFlight: async (key) => {
      seen.released.push(key);
    },
    tokenSpendToday: async () => 0,
    platformSpendToday: async () => 0,
    dailySpendCapUsd: 50,
    reserveSpend: async (_ctx, _model, usd) => {
      seen.reserved.push(usd);
      return "res-1";
    },
    settleSpend: async (_id, item) => {
      seen.settled.push(item);
    },
    execOn: () => true,
    browseOn: () => true,
    visitorsOn: () => false,
    execDailyUsd: () => 3,
    browseDailyUsd: () => 2,
    spendToday: async () => 0,
    execSnapshotId: () => null,
    browseSnapshotId: () => "snap_builder",
    launch: async (spec) => {
      seen.launched.push(spec);
      return fakeSession(seen, over.files ?? { "/tmp/mm-exec/out": Buffer.from("45\n"), "/tmp/mm-exec/err": Buffer.from(""), "/tmp/mm-exec/status": Buffer.from("0 40") });
    },
    recordRun: async (row) => {
      seen.runs.push(row);
    },
    // A real counter, as lib/gateway/store.ts keeps one, unless a test fixes the answer.
    reserveCounter: async (key, _window, amount, limit) => {
      if (over.counter !== undefined) return over.counter;
      const now = (seen.counters.get(key) ?? 0) + amount;
      if (now > limit) return null;
      seen.counters.set(key, now);
      return limit - now;
    },
    adjustCounter: async (key, _window, delta) => {
      seen.counters.set(key, Math.max(0, (seen.counters.get(key) ?? 0) + delta));
    },
    lookupHost: async (host) => {
      seen.lookups.push(host);
      return over.addresses ?? ["93.184.215.14"];
    },
    clock: () => (t += 2_000),
    now: () => NOW,
    ...over,
  };
  return { d, seen };
}

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`https://platform.example/api/gateway/${path}`, { method: "POST", headers: { authorization: "Bearer mm_live_x", "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const ownerHeaders = () => ({ [OWNER_HEADER]: mintOwnerSession({ productId: "p1", subject: "own_1" }, NOW).session });
const visitorHeaders = { [VISITOR_HEADER]: "visitor_aaaaaaaaaaaaaaaa" };
const errorCode = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;

describe("POST /exec", () => {
  it("runs the owner's program in a fresh sandbox with no network, stops it, records the run and settles what it cost", async () => {
    const { d, seen } = deps();
    const res = await handleExec(post("exec", { language: "python", code: "print(sum(range(10)))" }, ownerHeaders()), d);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: "ok", exitCode: 0, stdout: "45\n", stderr: "", truncated: false, ms: 40 });
    assert.equal(seen.launched.length, 1);
    assert.equal(seen.launched[0]!.networkPolicy, "deny-all");
    assert.equal(seen.launched[0]!.vcpus, 1);
    assert.equal(seen.launched[0]!.purpose, "exec");
    assert.equal(seen.stopped, 1);
    assert.deepEqual(seen.reserved, [EXEC_WORST_USD]);
    assert.equal(seen.settled.length, 1);
    assert.equal(seen.settled[0]!.costUsd, sandboxCostUsd(2_000, 1));
    assert.equal(seen.settled[0]!.units, 1);
    assert.equal(seen.runs.length, 1);
    assert.equal(seen.runs[0]!.namespace, "live");
    assert.equal(seen.runs[0]!.principal, "owner");
    assert.equal(seen.runs[0]!.status, "ok");
    assert.match(seen.runs[0]!.subjectKey!, /^[A-Za-z0-9_-]{32}$/);
    assert.deepEqual(seen.slots, ["exec:product:p1", "exec:all"]);
    assert.deepEqual(seen.released.sort(), ["exec:all", "exec:product:p1"]);
  });

  it("refuses a visitor and a product with no owner pass (decision 10), touching no sandbox", async () => {
    for (const headers of [visitorHeaders, {}]) {
      const { d, seen } = deps();
      const res = await handleExec(post("exec", { language: "python", code: "print(1)" }, headers), d);
      assert.equal(res.status, 403);
      assert.equal(await errorCode(res), "sign_in_required");
      assert.equal(seen.launched.length, 0);
    }
  });

  it("lets a visitor run only with CODE_EXEC_VISITORS on", async () => {
    const { d, seen } = deps({ visitorsOn: () => true });
    const res = await handleExec(post("exec", { language: "python", code: "print(1)" }, visitorHeaders), d);
    assert.equal(res.status, 200);
    assert.equal(seen.runs[0]!.principal, "visitor");
  });

  it("refuses a product made by a guest, or without the code marker", async () => {
    const guest = deps({ product: async () => product({ ownerEmail: GUEST_EMAIL }) });
    const r1 = await handleExec(post("exec", { language: "python", code: "print(1)" }, ownerHeaders()), guest.d);
    assert.equal(r1.status, 403);
    assert.equal(await errorCode(r1), "sign_in_required");
    assert.equal(guest.seen.launched.length, 0);
    const noMarker = deps({ tok: token({ allowedModels: ["muse-wonder-1.0"] }) });
    const r2 = await handleExec(post("exec", { language: "python", code: "print(1)" }, ownerHeaders()), noMarker.d);
    assert.equal(r2.status, 403);
    assert.equal(await errorCode(r2), "cap_not_allowed");
    assert.equal(noMarker.seen.launched.length, 0);
  });

  it("runs a build's program for real, in its own namespace, and refuses once the build has used its runs", async () => {
    const { d, seen } = deps({ tok: buildToken() });
    const res = await handleExec(post("exec", { language: "node", code: "console.log(45)" }, visitorHeaders), d);
    assert.equal(res.status, 200, "a build's tests may run it from any browser");
    assert.equal(seen.runs[0]!.namespace, `b:${BUILD}`);
    assert.equal(seen.runs[0]!.principal, "build");
    assert.equal(seen.runs[0]!.subjectKey, null);
    const spent = deps({ tok: buildToken(), counter: null });
    const over = await handleExec(post("exec", { language: "node", code: "console.log(45)" }), spent.d);
    assert.equal(over.status, 429);
    assert.equal(spent.seen.launched.length, 0);
    assert.deepEqual(spent.seen.settled, [null], "the reservation is removed");
  });

  it("lets every verify of a build make its smoke test's runs: two verifies of 3, and the most verifies a build can run", async () => {
    // The smoke test makes up to SMOKE_EXEC_RUNS a verify, and a build verifies up to BUILD_VERIFIES_MAX times.
    assert.ok(EXEC_LIMITS.perBuild >= SMOKE_EXEC_RUNS * BUILD_VERIFIES_MAX);
    assert.equal(BUILD_VERIFIES_MAX, REFINE_ROUND_STRIDE, "every Muse Code round of a build stays under the stride");
    assert.match(CODE_RENDER.build({ ...BRIEF, code: { runtimes: ["exec"], browse: false } } as unknown as Brief).join("\n"), new RegExp(`at most ${SMOKE_EXEC_RUNS} times`));
    const { d, seen } = deps({ tok: buildToken() });
    for (let verify = 0; verify < 2; verify++) {
      for (let run = 0; run < SMOKE_EXEC_RUNS; run++) {
        const res = await handleExec(post("exec", { language: "python", code: "print(45)" }), d);
        assert.equal(res.status, 200, `verify ${verify + 1}, run ${run + 1}`);
      }
    }
    assert.equal(seen.counters.get(`exec-build:${BUILD}`), 2 * SMOKE_EXEC_RUNS);
    const skill = readFileSync(new URL("../../../../template/caps/code/files/.agents/skills/muse-code-run/SKILL.md", import.meta.url), "utf8");
    assert.match(skill, new RegExp(`at most ${SMOKE_EXEC_RUNS} each time the smoke test runs, ${EXEC_LIMITS.perBuild} in the whole build`), "the skill says the same numbers");
    for (let i = 2 * SMOKE_EXEC_RUNS; i < SMOKE_EXEC_RUNS * BUILD_VERIFIES_MAX; i++) assert.equal((await handleExec(post("exec", { language: "python", code: "print(1)" }), d)).status, 200, `run ${i + 1}`);
  });

  it("uses none of a build's runs for a call that is refused, and gives one back when no sandbox started", async () => {
    const key = `exec-build:${BUILD}`;
    const paused = deps({ tok: buildToken(), execDailyUsd: () => 0 });
    assert.equal((await handleExec(post("exec", { language: "python", code: "print(1)" }), paused.d)).status, 503);
    assert.equal(paused.seen.counters.get(key) ?? 0, 0, "paused");
    const full = deps({ tok: buildToken(), spendToday: async () => 3 });
    assert.equal((await handleExec(post("exec", { language: "python", code: "print(1)" }), full.d)).status, 429);
    assert.equal(full.seen.counters.get(key) ?? 0, 0, "over budget");
    const busy = deps({ tok: buildToken(), acquireInFlight: async (k) => (k === "exec:all" ? null : NOW) });
    assert.equal((await handleExec(post("exec", { language: "python", code: "print(1)" }), busy.d)).status, 429);
    assert.equal(busy.seen.counters.get(key) ?? 0, 0, "the platform was busy");
    const broken = deps({
      tok: buildToken(),
      launch: async () => {
        throw new Error("create timed out");
      },
    });
    assert.equal((await handleExec(post("exec", { language: "python", code: "print(1)" }), broken.d)).status, 502);
    assert.equal(broken.seen.counters.get(key), 0, "no sandbox started, so the run went back");
  });

  it("gives each sandbox a lifetime its reservation covers, and a deadline inside the route's maxDuration", async () => {
    const { d, seen } = deps();
    await handleExec(post("exec", { language: "python", code: "print(1)" }, ownerHeaders()), d);
    const spec = seen.launched[0]!;
    assert.equal(spec.timeoutMs, EXEC_SANDBOX_MS);
    assert.equal(EXEC_WORST_USD, sandboxCostUsd(spec.timeoutMs, 1), "the reservation is the sandbox's whole life");
    assert.ok(spec.createTimeoutMs <= 30_000);
    assert.ok(spec.deadlineMs < 90_000, "inside /exec's maxDuration of 90 s");
    const browse = deps({ files: { "/tmp/mm-browse/out.json": Buffer.from(JSON.stringify({ ok: true, url: "https://example.org/", title: "t", text: "x", screenshot: "" })) } });
    await handleBrowse(post("browse", { url: "https://example.org/", input: "open example.org" }, ownerHeaders()), browse.d);
    const b = browse.seen.launched[0]!;
    assert.equal(b.timeoutMs, BROWSE_SANDBOX_MS);
    assert.ok(BROWSE_WORST_USD > sandboxCostUsd(b.timeoutMs, 2), "the whole life, plus a network allowance");
    assert.ok(b.deadlineMs < 120_000, "inside /browse's maxDuration of 120 s");
  });

  it("pauses at 0 dollars, stops at the cap's daily dollars, and touches no sandbox", async () => {
    const paused = deps({ execDailyUsd: () => 0 });
    const r1 = await handleExec(post("exec", { language: "python", code: "print(1)" }, ownerHeaders()), paused.d);
    assert.equal(r1.status, 503);
    assert.equal(await errorCode(r1), "caps_paused");
    const full = deps({ spendToday: async () => 3 });
    const r2 = await handleExec(post("exec", { language: "python", code: "print(1)" }, ownerHeaders()), full.d);
    assert.equal(r2.status, 429);
    assert.equal(await errorCode(r2), "budget_exceeded");
    assert.equal(paused.seen.launched.length + full.seen.launched.length, 0);
  });

  it("waits its turn when 4 programs already run on the platform", async () => {
    const { d, seen } = deps({ acquireInFlight: async (key) => (key === "exec:all" ? null : NOW) });
    const res = await handleExec(post("exec", { language: "python", code: "print(1)" }, ownerHeaders()), d);
    assert.equal(res.status, 429);
    assert.equal(seen.launched.length, 0);
  });

  it("answers a sandbox that won't start with a plain 502, records it as failed and still settles the time it took", async () => {
    const { d, seen } = deps({
      launch: async () => {
        throw new Error("quota");
      },
    });
    const res = await handleExec(post("exec", { language: "python", code: "print(1)" }, ownerHeaders()), d);
    assert.equal(res.status, 502);
    assert.equal(await errorCode(res), "cap_failed");
    assert.equal(seen.runs[0]!.status, "failed");
    assert.equal(seen.settled.length, 1);
    assert.ok(seen.released.includes("exec:all"));
  });

  it("limits each person to 20 runs a day and the product to 200, by subject key, never a raw id", () => {
    const route = execRoute(deps().d);
    const stage = { req: post("exec", {}), token: token(), product: product(), caller: { kind: "owner" as const, owner: "own_1", user: null, visitor: null, job: null, ip: null }, now: NOW, args: execArgs() };
    const limits = route.limits!(stage);
    assert.deepEqual(limits.map((l) => [l.window, l.limit]), [["minute", 10], ["day", 200], ["day", 20]]);
    assert.ok(!limits.some((l) => l.key.includes("own_1")));
  });

  it("also limits each address, which a visitor can't change the way they can change their cookie", () => {
    const route = execRoute(deps({ visitorsOn: () => true }).d);
    const caller = { kind: "visitor" as const, owner: null, user: null, visitor: "visitor_aaaaaaaaaaaaaaaa", job: null, ip: "ipkey_1" };
    const limits = route.limits!({ req: post("exec", {}), token: token(), product: product(), caller, now: NOW, args: execArgs() });
    const ip = limits.find((l) => l.key.startsWith("exec:ip:"));
    assert.deepEqual(ip && [ip.key, ip.window, ip.limit], ["exec:ip:p1:ipkey_1", "day", EXEC_LIMITS.perIpPerDay]);
  });

  it("refuses a visitor-mode call that names no visitor and no user, so nobody runs without a per-person limit", async () => {
    const { d, seen } = deps({ visitorsOn: () => true });
    const res = await handleExec(post("exec", { language: "python", code: "print(1)" }), d);
    assert.equal(res.status, 403);
    assert.equal(seen.launched.length, 0);
  });
});

describe("runExec against a session", () => {
  it("writes the program and its files, runs the script once, and reads back the three files", async () => {
    const seen: Seen = { launched: [], stopped: 0, wrote: [], runs: [], settled: [], reserved: [], slots: [], released: [], lookups: [], counters: new Map() };
    const out = await runExec(fakeSession(seen, { "/tmp/mm-exec/out": Buffer.from("hi\n"), "/tmp/mm-exec/status": Buffer.from("0 3") }), execArgs({ stdin: "x" }));
    assert.equal(out.stdout, "hi\n");
    assert.ok(seen.wrote.includes("/tmp/mm-exec/run.sh"));
  });
});

describe("POST /browse", () => {
  const body = { url: "https://example.org/tides", input: "What does example.org/tides say?" };

  it("gives a build a recorded sample page, the same one each time, and opens no sandbox", async () => {
    const { d, seen } = deps({ tok: buildToken() });
    const res = await handleBrowse(post("browse", body), d);
    assert.equal(res.status, 200);
    const page = (await res.json()) as { url: string; title: string; text: string; screenshot: string; simulated: boolean };
    assert.equal(page.simulated, true);
    assert.equal(page.url, body.url);
    assert.ok(SAMPLE_MARKERS.some((m) => page.text.includes(m)));
    assert.match(page.screenshot, /^data:image\/svg\+xml;base64,/);
    assert.equal(seen.launched.length, 0);
    assert.equal(seen.lookups.length, 0);
    assert.equal(seen.runs[0]!.status, "simulated");
    const again = (await (await handleBrowse(post("browse", body), deps({ tok: buildToken() }).d)).json()) as { title: string };
    assert.equal(again.title, page.title);
    const own = samplePageFor({ url: body.url, actions: [] }, { "cap:code:browse": [{ title: "Mine", text: "Own text" }] });
    assert.equal(own.title, "Mine");
  });

  it("opens the owner's page in a sandbox that reaches only that host, from the builder snapshot", async () => {
    const files = { "/tmp/mm-browse/out.json": Buffer.from(JSON.stringify({ ok: true, url: "https://example.org/tides", title: "Tides", text: "Twice a day", screenshot: "QUJD" })) };
    const { d, seen } = deps({ files });
    const res = await handleBrowse(post("browse", body, ownerHeaders()), d);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { url: "https://example.org/tides", title: "Tides", text: "Twice a day", screenshot: "data:image/jpeg;base64,QUJD" });
    assert.deepEqual(seen.lookups, ["example.org"]);
    assert.equal(seen.launched[0]!.snapshotId, "snap_builder");
    assert.deepEqual(seen.launched[0]!.networkPolicy, browsePolicy("example.org"));
    assert.equal(seen.stopped, 1);
    assert.deepEqual(seen.reserved, [BROWSE_WORST_USD]);
    assert.equal(seen.runs[0]!.kind, "browse");
    assert.equal(seen.runs[0]!.language, null);
  });

  it("refuses a host that resolves to a private address, and never starts a sandbox for it", async () => {
    const { d, seen } = deps({ addresses: ["10.1.2.3"] });
    const res = await handleBrowse(post("browse", body, ownerHeaders()), d);
    assert.equal(res.status, 400);
    assert.equal(seen.launched.length, 0);
  });

  it("is never for visitors, whatever CODE_EXEC_VISITORS says", async () => {
    const { d, seen } = deps({ visitorsOn: () => true });
    const res = await handleBrowse(post("browse", body, visitorHeaders), d);
    assert.equal(res.status, 403);
    assert.equal(seen.launched.length, 0);
  });

  it("says so plainly when no builder snapshot is set", async () => {
    const { d, seen } = deps({ browseSnapshotId: () => null });
    const res = await handleBrowse(post("browse", body, ownerHeaders()), d);
    assert.equal(res.status, 502);
    assert.equal(seen.launched.length, 0);
  });

  it("holds one slot of 2 on the whole platform for a real page, none for a build's sample", () => {
    const route = browseRoute(deps().d);
    const caller = { kind: "owner" as const, owner: "own_1", user: null, visitor: null, job: null, ip: null };
    const args = { url: body.url, host: "example.org", actions: [] };
    assert.deepEqual(route.inFlight!({ req: post("browse", {}), token: token(), product: product(), caller, now: NOW, args }), { key: "browse:all", limit: 2 });
    assert.equal(route.inFlight!({ req: post("browse", {}), token: buildToken(), product: product(), caller, now: NOW, args }), null);
  });

  it("writes its script and arguments to files, never a command line", async () => {
    const seen: Seen = { launched: [], stopped: 0, wrote: [], runs: [], settled: [], reserved: [], slots: [], released: [], lookups: [], counters: new Map() };
    let ran: string[] = [];
    const session = { ...fakeSession(seen, {}), run: async (_cmd: string, a: string[]) => ((ran = a), { exitCode: 0, stdout: "", stderr: "" }) };
    const out = await runBrowse(session, { url: "https://example.org/", host: "example.org", actions: [] });
    assert.equal(out.ok, false);
    assert.deepEqual(ran, ["/tmp/mm-browse/browse.mjs", "/tmp/mm-browse/args.json"]);
  });
});

describe("the brief block, the writer and the prompts", () => {
  const brief = (code: unknown) => ({ ...BRIEF, code }) as unknown as Brief;

  it("takes runtimes it knows, once each, and makes a block that asks for nothing null", () => {
    assert.deepEqual(normalizeCodeBlock({ runtimes: ["EXEC", "pyodide", "pyodide", "rust"], browse: "yes" }), { runtimes: ["pyodide", "exec"], browse: true });
    assert.equal(normalizeCodeBlock({ runtimes: [], browse: false }), null);
    assert.equal(CodeBriefBlock.safeParse({ runtimes: ["pyodide"], browse: false }).success, true);
    assert.equal(CodeBriefBlock.safeParse({ runtimes: ["rust"], browse: false }).success, false);
    assert.equal(codeBlock(brief({ runtimes: [], browse: false })), null);
    const normalized = normalizeRawBrief({ ...BRIEF, code: { runtimes: ["quickjs", "quickjs"], browse: false } }, []) as { code: unknown };
    assert.deepEqual(normalized.code, { runtimes: ["quickjs"], browse: false });
  });

  it("puts code in the writer's schema only when the cap is on, required and nullable for strict output", () => {
    const on = strictJsonSchema(newBriefSchemaFor({ gadgets: false, targets: [], caps: ["code"] })) as { required: string[]; properties: Record<string, unknown> };
    assert.ok(on.required.includes("code"));
    const off = strictJsonSchema(newBriefSchemaFor({ gadgets: false, targets: [], caps: [] })) as { properties: Record<string, unknown> };
    assert.ok(!("code" in off.properties));
    assert.match(capsWriterRules(["code"]), /code\.runtimes/);
    assert.match(capsCatalogBlocks(["code"]).join("\n"), /running code/);
  });

  it("names only the helpers the brief asks for, the owner-only rule and the smoke test's helpers", () => {
    const web = CODE_RENDER.build(brief({ runtimes: ["pyodide", "quickjs"], browse: false })).join("\n");
    assert.match(web, /runPython/);
    assert.match(web, /runJavaScript/);
    assert.doesNotMatch(web, /runOnServer|openPage/);
    assert.match(web, /expectInPageRun/);
    const server = CODE_RENDER.build(brief({ runtimes: ["exec"], browse: true })).join("\n");
    assert.match(server, /runOnServer/);
    assert.match(server, /openPage/);
    assert.match(server, /Only the product's owner/);
    assert.match(server, /expectExecOutput/);
    assert.match(server, /expectBrowsePage/);
    assert.match(server, /simulated: true/);
    assert.match(capsBuildLines(brief({ runtimes: ["exec"], browse: false })).join("\n"), /### Running code/);
    for (const text of [web, server, codeJudgeNote(brief({ runtimes: ["exec"], browse: true })), capsWriterRules(["code"])]) assert.ok(!text.includes("—"));
    assert.deepEqual(CODE_RENDER.build(BRIEF), []);
    assert.match(codeJudgeNote(brief({ runtimes: [], browse: true })), /samples/);
  });
});

describe("with CODE_EXEC or CODE_BROWSE off (CODE_ENABLED alone is browser Python and JavaScript)", () => {
  const brief = (code: unknown) => ({ ...BRIEF, code }) as unknown as Brief;
  const ALL = { runtimes: ["pyodide", "exec"], browse: true };
  function withEnv<T>(vars: Record<string, string | undefined>, run: () => T): T {
    const before = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
    for (const [k, v] of Object.entries(vars)) (v === undefined ? delete process.env[k] : (process.env[k] = v));
    try {
      return run();
    } finally {
      for (const [k, v] of Object.entries(before)) (v === undefined ? delete process.env[k] : (process.env[k] = v));
    }
  }
  const off = { CODE_EXEC: undefined, CODE_BROWSE: undefined };

  it("follows the same flags as lib/env.ts", () => {
    withEnv({ CODE_EXEC: "yes", CODE_BROWSE: "1", CODE_EXEC_VISITORS: "on", BUILDER_SNAPSHOT_ID: "snap" }, () => {
      assert.deepEqual(codePartsOn(), { exec: env.codeExec, browse: env.codeBrowse, visitors: env.codeExecVisitors });
    });
    withEnv({ CODE_BROWSE: "1", BUILDER_SNAPSHOT_ID: undefined }, () => assert.equal(codePartsOn().browse, false, "no builder snapshot, no live page"));
  });

  it("never offers exec or browse to the writer: not in its enum, its rules or the catalog", () => {
    withEnv(off, () => {
      const schema = strictJsonSchema(newBriefSchemaFor({ gadgets: false, targets: [], caps: ["code"] })) as { properties: Record<string, unknown> };
      const text = JSON.stringify(schema.properties.code);
      assert.match(text, /pyodide/);
      assert.doesNotMatch(text, /"exec"/);
      const rules = capsWriterRules(["code"]);
      assert.doesNotMatch(rules, /\bexec\b|sandbox/);
      assert.match(rules, /browse: always false/);
      const catalog = capsCatalogBlocks(["code"]).join("\n");
      assert.doesNotMatch(catalog, /sandbox|web page/);
      assert.match(catalog, /Pyodide/);
      assert.equal(catalogSummary(["code"]).includes("platform sandbox"), false, "the cached catalog follows the flags too");
    });
    withEnv({ CODE_EXEC: "1", CODE_BROWSE: "1" }, () => assert.equal(catalogSummary(["code"]).includes("platform sandbox"), true));
  });

  it("drops a part that is off from the writer's block, and a block left with nothing is null", () => {
    withEnv(off, () => {
      assert.deepEqual(normalizeCodeBlock({ runtimes: ["exec", "quickjs"], browse: true }), { runtimes: ["quickjs"], browse: false });
      assert.equal(normalizeCodeBlock({ runtimes: ["exec"], browse: true }), null);
    });
  });

  it("asks the build, the judge and the fixed checks for no route that answers 404", async () => {
    withEnv(off, () => {
      const text = CODE_RENDER.build(brief(ALL)).join("\n");
      assert.match(text, /runPython/);
      assert.doesNotMatch(text, /runOnServer|openPage|expectExecOutput|expectBrowsePage/);
      assert.doesNotMatch(codeJudgeNote(brief(ALL)), /samples/);
      assert.deepEqual(codeBlock(brief(ALL)), { runtimes: ["pyodide"], browse: false });
      assert.equal(codeBlock(brief({ runtimes: ["exec"], browse: true })), null);
    });
  });

  it("drops the cap from a build whose code block has no part left, and keeps it with what is left otherwise", () => {
    withEnv(off, () => {
      const none = capsForBuild(brief({ runtimes: ["exec"], browse: true }), { enabled: ["code"], onSite: ["code"] });
      assert.deepEqual(none.dropped, [{ cap: "code", reason: "off" }]);
      assert.equal((none.brief as unknown as { code: unknown }).code, null);
      const some = capsForBuild(brief(ALL), { enabled: ["code"], onSite: ["code"] });
      assert.deepEqual(some.dropped, []);
      assert.deepEqual(codeBlock(some.brief), { runtimes: ["pyodide"], browse: false });
      const refine = capsForBuild(brief({ runtimes: ["exec"], browse: false }), { kind: "refine", served: ["code"] });
      assert.deepEqual(refine.dropped, [{ cap: "code", reason: "off" }]);
    });
  });

  it("says anyone can run code on the platform only when CODE_EXEC_VISITORS is on", () => {
    withEnv({ CODE_EXEC_VISITORS: "1" }, () => {
      const text = CODE_RENDER.build(brief({ runtimes: ["exec"], browse: false })).join("\n");
      assert.match(text, /Anyone using the product can run code on the platform/);
      assert.doesNotMatch(text, /Only the product's owner can run code/);
      assert.match(capsWriterRules(["code"]), /for anyone using the product/);
    });
    assert.match(CODE_RENDER.build(brief({ runtimes: ["exec"], browse: false })).join("\n"), /Only the product's owner can run code/);
  });
});
