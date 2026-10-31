/**
 * Wave 3, unit 2: engine (docs/CAPABILITIES.md, section 8). Round time by brief size, the build's wall, the writer's
 * rules, milestones in the brief and the prompts, the live check against a local server, and the caps registries with
 * a fake cap plugged in, so each hook is seen doing something.
 *
 *   npx tsx --test lib/engine/__tests__/engine.test.ts
 */
import assert from "node:assert/strict";
import http from "node:http";
import { after, afterEach, before, describe, it } from "node:test";
import { z } from "zod";
import { normalizeRawBrief } from "@/lib/brief/normalize";
import { renderBuildPrompt } from "@/lib/brief/render";
import { BriefSchema, newBriefSchemaFor, NewBriefSchemaNoGadget } from "@/lib/brief/schema";
import { strictJsonSchema } from "@/lib/brief/strict-schema";
import { CAP_BRIEF_FIELDS, CAP_WRITER_RULES, briefCaps } from "@/lib/caps/brief-fields";
import { CAP_CATALOG } from "@/lib/caps/catalog";
import { capsBuildEnded, capsProductOff, registerCapCleanup, resetCapCleanups, sweepCaps } from "@/lib/caps/cleanup";
import { CAP_ENV, capBuildEnv, capDeployEnv } from "@/lib/caps/env";
import { CAP_BUILD_HOSTS, capBuildHosts } from "@/lib/caps/hosts";
import { CAP_READY } from "@/lib/caps/ids";
import { CAP_JUDGE, capsJudgeNotes, capsProofText } from "@/lib/caps/judge";
import { capsFileFor, overlaysFor } from "@/lib/caps/overlays";
import { CAP_RENDER } from "@/lib/caps/render";
import { engineEventText } from "@/lib/engine/events";
import { liveCheck } from "@/lib/engine/live-check";
import { briefMilestones } from "@/lib/engine/milestones";
import { EXACT_LOGIC_RULE, MILESTONES_RULE, engineWriterRules, renderMilestonePrompt } from "@/lib/engine/prompts";
import { env } from "@/lib/env";
import { allowedModelsFor } from "@/lib/pipeline/logic";
import { capWithinWall, MAX_BUILD_WALL_MS, roundCapMs, roundPlanFor } from "@/lib/pipeline/steps";
import { briefInstructions } from "@/lib/prompts/brief";
import { catalogSummary } from "@/lib/prompts/catalog";
import { BRIEF } from "@/lib/promote/__tests__/fixtures";
import { builderNetworkPolicy } from "@/lib/sandbox/policy";

const MIN = 60_000;
const on = { scaling: true, maxMinutes: 45 };
const size = (over: Partial<Parameters<typeof roundCapMs>[0]> = {}) => ({ complexity: "standard" as const, caps: 0, screens: 2, actions: 1, ...over });

describe("roundCapMs", () => {
  it("is today's 25, 12 and 8 minutes with scaling off, whatever the brief", () => {
    const big = size({ complexity: "complex", caps: 4, screens: 5, actions: 3 });
    assert.deepEqual((["build", "fix", "verify"] as const).map((k) => roundCapMs(big, k, { scaling: false, maxMinutes: 90 }) / MIN), [25, 12, 8]);
  });

  it("grows a first round 5 minutes for complex, 5 for a big brief and 5 per cap, up to the ceiling", () => {
    assert.equal(roundCapMs(size(), "build", on) / MIN, 25);
    assert.equal(roundCapMs(size({ complexity: "complex" }), "build", on) / MIN, 30);
    // The tile game of Oct 31: complex, 3 screens, 3 actions.
    assert.equal(roundCapMs(size({ complexity: "complex", screens: 3, actions: 3 }), "build", on) / MIN, 35);
    assert.equal(roundCapMs(size({ caps: 2 }), "build", on) / MIN, 35);
    assert.equal(roundCapMs(size({ complexity: "complex", screens: 3, actions: 3, caps: 3 }), "build", on) / MIN, 45, "held to the ceiling");
    assert.equal(roundCapMs(size({ caps: 9 }), "build", { scaling: true, maxMinutes: 60 }) / MIN, 60);
    assert.equal(roundCapMs(size(), "build", { scaling: true, maxMinutes: 10 }) / MIN, 25, "never below today's round");
  });

  it("gives fix rounds 12 to 15 minutes and verify 8 to 10", () => {
    assert.equal(roundCapMs(size(), "fix", on) / MIN, 12);
    assert.equal(roundCapMs(size({ complexity: "complex" }), "fix", on) / MIN, 15);
    assert.equal(roundCapMs(size({ caps: 1 }), "fix", on) / MIN, 15);
    assert.deepEqual([0, 1, 2, 5].map((caps) => roundCapMs(size({ caps }), "verify", on) / MIN), [8, 9, 10, 10]);
  });

  it("plans a wall only when something scales, and reads ENGINE_ROUND_MAX_MINUTES within 25 to 90", () => {
    assert.equal(roundPlanFor(size(), [], { scaling: false, maxMinutes: 45 }).wallMs, null);
    assert.equal(roundPlanFor(size(), [{ title: "a" }, { title: "b" }], { scaling: false, maxMinutes: 45 }).wallMs, MAX_BUILD_WALL_MS);
    assert.equal(roundPlanFor(size(), [], on).wallMs, MAX_BUILD_WALL_MS);
    const saved = process.env.ENGINE_ROUND_MAX_MINUTES;
    try {
      for (const [raw, want] of [["", 45], ["10", 25], ["200", 90], ["60", 60], ["x", 45]] as const) {
        process.env.ENGINE_ROUND_MAX_MINUTES = raw;
        assert.equal(env.engineRoundMaxMinutes, want, raw);
      }
    } finally {
      if (saved === undefined) delete process.env.ENGINE_ROUND_MAX_MINUTES;
      else process.env.ENGINE_ROUND_MAX_MINUTES = saved;
    }
  });
});

describe("capWithinWall", () => {
  it("keeps the cap with room, trims it near the wall, and gives null with less than 5 minutes left", () => {
    const at = (elapsedMin: number, reserveMin = 0) => capWithinWall({ capMs: 30 * MIN, startedAt: 0, now: elapsedMin * MIN, wallMs: 90 * MIN, reserveMs: reserveMin * MIN });
    assert.equal(at(10), 30 * MIN);
    assert.equal(at(70), 20 * MIN);
    assert.equal(at(70, 10), 10 * MIN);
    assert.equal(at(86), null);
    assert.equal(capWithinWall({ capMs: 30 * MIN, startedAt: 0, now: 500 * MIN, wallMs: null }), 30 * MIN, "no wall, no limit");
  });
});

describe("the brief writer", () => {
  const FLAGS = ["ENGINE_MILESTONES", "ENGINE_EXACT_LOGIC"];
  afterEach(() => FLAGS.forEach((f) => delete process.env[f]));

  it("adds the exact-logic rule and the milestones rule only under their flags, inside the brief list", () => {
    const off = briefInstructions();
    assert.ok(!off.includes(EXACT_LOGIC_RULE) && !off.includes(MILESTONES_RULE));
    process.env.ENGINE_EXACT_LOGIC = "1";
    const exact = briefInstructions();
    assert.ok(exact.startsWith(off.slice(0, 200)));
    assert.ok(exact.endsWith(`\n${EXACT_LOGIC_RULE}`));
    assert.match(EXACT_LOGIC_RULE, /parser, a solver, a validator/);
    process.env.ENGINE_MILESTONES = "1";
    assert.ok(briefInstructions().endsWith(`\n${EXACT_LOGIC_RULE}\n${MILESTONES_RULE}`));
    assert.equal(engineWriterRules({ milestones: false, exactLogic: false }), "");
    for (const text of [EXACT_LOGIC_RULE, MILESTONES_RULE]) assert.ok(!/[—–]/.test(text), "no em dashes");
  });

  it("asks for milestones, required but nullable, only with ENGINE_MILESTONES; the stored brief takes 2 or 3", () => {
    const schema = newBriefSchemaFor({ gadgets: false, targets: [], caps: [], milestones: true });
    assert.notEqual(schema, NewBriefSchemaNoGadget);
    const strict = strictJsonSchema(schema) as { required: string[] };
    assert.ok(strict.required.includes("milestones"));
    assert.equal(schema.safeParse(BRIEF).success, false, "required");
    assert.equal(schema.safeParse({ ...BRIEF, milestones: null }).success, true);
    const two = [{ title: "Play one level", doneMeans: "A level loads and can be won." }, { title: "Level maker", doneMeans: "A new level saves and plays." }];
    assert.equal(schema.safeParse({ ...BRIEF, milestones: two }).success, true);
    assert.equal(schema.safeParse({ ...BRIEF, milestones: two.slice(0, 1) }).success, false);
    assert.equal(schema.safeParse({ ...BRIEF, milestones: [...two, ...two] }).success, false);
    assert.equal(BriefSchema.safeParse({ ...BRIEF, milestones: two }).success, true);
    assert.deepEqual(briefMilestones({ milestones: two }), two);
    assert.deepEqual(briefMilestones({ milestones: two.slice(0, 1) }), []);
    assert.deepEqual(briefMilestones(BRIEF), []);
  });
});

describe("milestone prompts", () => {
  const milestones = [
    { title: "Play one level", doneMeans: "A built-in level loads, the player moves with the arrow keys and can win." },
    { title: "Level maker", doneMeans: "A generated level is checked by the solver and saved." },
  ];
  const render = { inspoFiles: [], fixtures: [], maxModelSteps: 40 };

  it("brief.md lists the milestones after Done means and says this run builds only the first", () => {
    const prompt = renderBuildPrompt({ ...BRIEF, milestones }, { ...render, milestones });
    assert.ok(prompt.indexOf("## Milestones") > prompt.indexOf("Then stop."));
    assert.ok(prompt.indexOf("## Milestones") < prompt.indexOf("## Product"));
    assert.match(prompt, /This run builds only milestone 1/);
    assert.match(prompt, /1\. \*\*Play one level\*\*: A built-in level loads/);
    assert.match(prompt, /2\. \*\*Level maker\*\*/);
  });

  it("brief.md has no Milestones section unless the build's plan chains them, whatever the stored brief has", () => {
    // A brief written with ENGINE_MILESTONES on and built with it off gets no milestone rounds, so its brief.md must not
    // say "This run builds only milestone 1".
    const prompt = renderBuildPrompt({ ...BRIEF, milestones }, render);
    assert.ok(!prompt.includes("## Milestones"));
    assert.equal(prompt, renderBuildPrompt(BRIEF, render));
  });

  it("the writer's milestones are cleaned before the schema checks them: clamped, at most 3, and null below 2", () => {
    const long = (n: number) => "x".repeat(n);
    const raw = (list: unknown) => normalizeRawBrief({ ...BRIEF, milestones: list }, []) as { milestones: unknown };
    const four = [1, 2, 3, 4].map((i) => ({ title: `${i} ${long(70)}`, doneMeans: long(320) }));
    const cleaned = raw(four).milestones as Array<{ title: string; doneMeans: string }>;
    assert.equal(cleaned.length, 3);
    assert.ok(cleaned.every((m) => m.title.length <= 60 && m.doneMeans.length <= 300));
    const schema = newBriefSchemaFor({ gadgets: false, targets: [], caps: [], milestones: true });
    assert.equal(schema.safeParse(raw(four)).success, true, "a brief that overran the limits still parses");
    assert.equal(raw([four[0]]).milestones, null, "one milestone isn't a milestone build");
    assert.equal(raw([]).milestones, null);
    assert.equal(raw([{ title: "", doneMeans: "x" }, { title: "Two", doneMeans: "y" }]).milestones, null, "an empty title doesn't count");
    assert.equal(schema.safeParse(raw([four[0]])).success, true);
    assert.ok(!("milestones" in (normalizeRawBrief({ ...BRIEF }, []) as object)), "a brief with no milestones gets none added");
  });

  it("brief.md's budget says to verify at most twice a round only for big builds", () => {
    assert.ok(!renderBuildPrompt(BRIEF, render).includes("at most twice in a round"));
    const big = renderBuildPrompt(BRIEF, { ...render, verifyBudget: true });
    assert.match(big, /Run `npm run verify` at most twice in a round\. The platform runs it again after you stop\./);
    assert.match(big, /test one generated item for real and the rest with fixtures/);
    assert.ok(big.trimEnd().endsWith("the rest with fixtures."));
  });

  it("milestone-<n>.md carries the last check's failures, and nothing extra when it passed", () => {
    const failed = renderMilestonePrompt({
      index: 2,
      of: 2,
      milestone: milestones[1]!,
      verify: { passed: false, steps: [{ name: "smoke", ok: false, detail: "Timed out waiting for the board" }, { name: "build", ok: true }], failureOutput: "Error: board never drew" },
    });
    assert.match(failed, /^# Milestone 2 of 2: Level maker\n/);
    assert.match(failed, /Done means for this milestone: A generated level is checked/);
    assert.match(failed, /FAILED: smoke: Timed out waiting for the board/);
    assert.ok(!failed.includes("FAILED: build"));
    assert.match(failed, /Error: board never drew/);
    assert.ok(!failed.includes("The platform sends the next milestone"), "the last milestone has no next");
    const passed = renderMilestonePrompt({ index: 2, of: 3, milestone: milestones[1]!, verify: { passed: true, steps: [], failureOutput: "" } });
    assert.ok(!passed.includes("What the last check found"));
    assert.match(passed, /The platform sends the next milestone after that\./);
    for (const text of [failed, passed]) assert.ok(!/[—–]/.test(text));
  });
});

describe("liveCheck", () => {
  type Route = (req: http.IncomingMessage, res: http.ServerResponse) => void;
  const servers: http.Server[] = [];
  after(() => servers.forEach((s) => { s.closeAllConnections(); s.close(); }));
  /** A server of its own for each test, answering "METHOD /path" routes and 404 otherwise. */
  async function serve(routes: Record<string, Route>): Promise<string> {
    const server = http.createServer((req, res) => {
      const handler = routes[`${req.method} ${req.url}`];
      if (handler) return handler(req, res);
      res.statusCode = 404;
      res.end("not found");
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  }
  const html: Route = (_req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end("<!doctype html><html><body>Bird Count</body></html>");
  };
  const fast = { attempts: 2, waitMs: 10, timeoutMs: 2000 };

  it("passes a page that loads, action routes that take POST and a healthy service route, with no POST sent", async () => {
    const methods: string[] = [];
    const base = await serve({
      "GET /": html,
      "OPTIONS /api/actions/count_birds": (req, res) => {
        methods.push(req.method!);
        res.statusCode = 204;
        res.setHeader("allow", "OPTIONS, POST");
        res.end();
      },
      "GET /api/musemuse/health": (_req, res) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true, gateway: true }));
      },
    });
    const result = await liveCheck({ url: `${base}/`, actions: ["count_birds"], health: true, ...fast });
    assert.equal(result.ok, true, result.reason ?? "");
    assert.deepEqual(result.checks.map((c) => [c.path, c.ok]), [["/", true], ["/api/actions/count_birds", true], ["/api/musemuse/health", true]]);
    assert.deepEqual(methods, ["OPTIONS"]);
  });

  it("fails a page that errors, after its tries, and a page behind a sign-in at once", async () => {
    let hits = 0;
    const errors = await serve({ "GET /": (_req, res) => { hits += 1; res.statusCode = 500; res.end("boom"); } });
    const errored = await liveCheck({ url: errors, actions: [], health: false, ...fast });
    assert.deepEqual([errored.ok, errored.reason, hits], [false, "the page answered HTTP 500", 2]);
    let walledHits = 0;
    const wall = await serve({ "GET /": (_req, res) => { walledHits += 1; res.statusCode = 401; res.end(); } });
    const walled = await liveCheck({ url: wall, actions: [], health: false, ...fast });
    assert.match(walled.reason ?? "", /asks for a sign-in \(HTTP 401\)/);
    assert.equal(walledHits, 1);
  });

  it("fails a missing action route, one that doesn't take POST, and an unhealthy service route", async () => {
    const missing = await serve({ "GET /": html });
    assert.equal((await liveCheck({ url: missing, actions: ["count_birds"], health: false, ...fast })).reason, "the action route /api/actions/count_birds is missing");
    const getOnly = await serve({ "GET /": html, "OPTIONS /api/actions/count_birds": (_req, res) => { res.statusCode = 204; res.setHeader("allow", "OPTIONS, GET"); res.end(); } });
    assert.equal((await liveCheck({ url: getOnly, actions: ["count_birds"], health: false, ...fast })).reason, "the action route /api/actions/count_birds doesn't take POST");
    const unhealthy = await serve({ "GET /": html, "GET /api/musemuse/health": (_req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ ok: false })); } });
    assert.equal((await liveCheck({ url: unhealthy, actions: [], health: true, ...fast })).reason, "its health check says the platform services aren't set up");
  });

  it("fails a page that never answers within its time", async () => {
    const silent = await serve({ "GET /": () => undefined });
    const result = await liveCheck({ url: silent, actions: [], health: false, attempts: 1, timeoutMs: 200 });
    assert.equal(result.reason, "the page gave no answer within 0 seconds");
  });
});

describe("the caps registries, with a fake cap plugged in", () => {
  const fields = CAP_BRIEF_FIELDS as Record<string, z.ZodTypeAny>;
  const ready = CAP_READY as Record<string, boolean>;
  const block = z.object({ scopes: z.array(z.enum(["shared", "visitor"])).min(1) });
  before(() => {
    fields.data = block;
    ready.data = true;
    CAP_RENDER.data = { title: "Saved data", build: () => ["Read `.agents/skills/muse-data` first.", "The build's stand-in is the build namespace."] };
    CAP_ENV.data = { build: () => ({ MUSEMUSE_DATA: "on" }), deploy: () => ({ MUSEMUSE_DATA: "on" }) };
    CAP_JUDGE.data = () => "A second browser shows the saved item.";
    CAP_CATALOG.data = { name: "saved rows", block: "- data: rows saved on the platform." };
    CAP_BUILD_HOSTS.data = ["pypi.example"];
    CAP_WRITER_RULES.data = ["Fill data only when the muse saves something for later."];
  });
  after(() => {
    delete fields.data;
    ready.data = false;
    delete CAP_RENDER.data;
    delete CAP_ENV.data;
    delete CAP_JUDGE.data;
    delete CAP_CATALOG.data;
    delete CAP_BUILD_HOSTS.data;
    delete CAP_WRITER_RULES.data;
    delete process.env.DATA_ENABLED;
  });
  const withData = { ...BRIEF, data: { scopes: ["shared"] } } as typeof BRIEF;

  it("the brief, the token, the overlays, the env and the hosts follow its block", () => {
    assert.deepEqual(briefCaps(withData), ["data"]);
    assert.deepEqual(allowedModelsFor(withData), [...allowedModelsFor(BRIEF), "cap:data"]);
    assert.deepEqual(overlaysFor(withData), ["core", "data"]);
    assert.deepEqual(capsFileFor(withData), { caps: ["data"], overlays: ["core", "data"] });
    assert.equal(capBuildEnv(withData), "MUSEMUSE_DATA=on\n");
    assert.deepEqual(capDeployEnv(withData, "tok"), { MUSEMUSE_DATA: "on" });
    assert.deepEqual(capBuildHosts(["data"]), ["pypi.example"]);
    const policy = builderNetworkPolicy({ modelApiKey: "k", placeholderKey: "p", platformHost: null, capHosts: capBuildHosts(["data"]) }) as { allow: Record<string, unknown[]> };
    assert.deepEqual(policy.allow["pypi.example"], []);
    assert.ok(Array.isArray(policy.allow["api.meta.ai"]) && policy.allow["api.meta.ai"].length > 1, "a cap host never replaces Meta's rules");
  });

  it("the writer gets its rules, its catalog entry and its field when its flag is on", () => {
    process.env.DATA_ENABLED = "1";
    assert.deepEqual(env.enabledCaps, ["data"]);
    assert.match(briefInstructions(), /\n\nPlatform services\n- Fill data only when the muse saves something for later\.$/);
    const catalog = catalogSummary();
    assert.match(catalog, /Platform services a product may use, when the brief picks them:\n- data: rows saved on the platform\./);
    assert.match(catalog, /The platform services below add saved rows, only when the brief picks them\./);
    const strict = strictJsonSchema(newBriefSchemaFor({ gadgets: false, targets: [], caps: env.enabledCaps })) as { required: string[] };
    assert.ok(strict.required.includes("data"));
    delete process.env.DATA_ENABLED;
    assert.ok(!catalogSummary().includes("Platform services a product may use"), "cached per enabled caps");
  });

  it("brief.md gets a Platform services section right after the models and the agent, and the judge its note", () => {
    const prompt = renderBuildPrompt(withData, { inspoFiles: [], fixtures: [], maxModelSteps: 40 });
    const at = prompt.indexOf("## Platform services");
    assert.ok(at > prompt.indexOf("## Meta models") && at < prompt.indexOf("## Inputs"), prompt);
    assert.match(prompt, /## Platform services\n\n### Saved data\n\nRead `\.agents\/skills\/muse-data` first\./);
    assert.match(capsJudgeNotes(withData), /Fixed checks the platform ran decide whether each one works, not you\.[\s\S]*- A second browser shows the saved item\./);
  });
});

describe("capsProofText", () => {
  it("lists each check as decided, and is null with none", () => {
    assert.equal(capsProofText(null), null);
    assert.equal(capsProofText({ caps: [] }), null);
    const text = capsProofText({ caps: [{ cap: "data", checks: [{ id: "second-browser", ok: true, detail: "Second browser, after a reload" }, { id: "gateway-rows", ok: false }] }] });
    assert.match(text ?? "", /already decided/);
    assert.match(text ?? "", /- data, second-browser: passed \(Second browser, after a reload\)\n- data, gateway-rows: failed$/);
  });
});

describe("the cleanup registry", () => {
  afterEach(() => resetCapCleanups());

  it("tells every cap a build ended or a product went off, and a failing one doesn't stop the rest", async () => {
    const seen: string[] = [];
    registerCapCleanup({ cap: "data", buildEnded: async (b) => void seen.push(`data:${b}`), productOff: async (p) => void seen.push(`data-off:${p}`) });
    registerCapCleanup({ cap: "files", buildEnded: async () => { throw new Error("blob down"); } });
    registerCapCleanup({ cap: "jobs", buildEnded: async (b) => void seen.push(`jobs:${b}`) });
    await capsBuildEnded("b1");
    await capsProductOff("p1");
    assert.deepEqual(seen, ["data:b1", "jobs:b1", "data-off:p1"]);
  });

  it("sweeps and counts, replaces a cap registered twice, and says nothing when no cap sweeps", async () => {
    assert.equal(await sweepCaps(), null);
    registerCapCleanup({ cap: "data", sweep: async () => 2 });
    registerCapCleanup({ cap: "data", sweep: async () => 3 });
    registerCapCleanup({ cap: "files", sweep: async () => { throw new Error("x"); } });
    assert.deepEqual(await sweepCaps(new Date(0)), { ok: false, removed: 3, failed: ["files"] });
  });
});

describe("build room lines", () => {
  it("say each event in plain words", () => {
    assert.equal(engineEventText({ type: "caps", cap: "data", check: "second-browser", ok: true, detail: "Second browser saw it" }), "Platform service data, check second-browser: passed. Second browser saw it");
    assert.equal(engineEventText({ type: "milestone", index: 2, of: 3, title: "Level maker", state: "skipped" }), "Milestone 2 of 3, Level maker: skipped, the build ran out of time.");
    assert.equal(engineEventText({ type: "live_check", ok: false, url: "https://x.vercel.app", reason: "the page answered HTTP 500" }), "The live link failed its check: the page answered HTTP 500.");
    assert.equal(engineEventText({ type: "live_check", ok: true, url: "https://x.vercel.app" }), "The live link passed its check: https://x.vercel.app");
  });
});
