/**
 * Edge builds (lib/pipeline/edge-build.ts): the standalone Next config, the drill's script and env, and how the drill's
 * results become verify steps. Pure, no sandbox.
 *
 *   npx tsx --test lib/pipeline/__tests__/edge-build.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, describe, it } from "node:test";
import {
  EDGE_DRILL_KIT,
  EDGE_DRILL_PORT,
  edgeBuildFiles,
  edgeDrillEnv,
  edgeDrillScript,
  edgeDrillSteps,
  isEdgeBuild,
  TEMPLATE_NEXT_CONFIG,
  withEdgeDrill,
  withStandaloneOutput,
} from "@/lib/pipeline/edge-build";

const EDGE = { targets: [{ id: "web" }, { id: "edge" }] };
const results = (pass: boolean[]) => JSON.stringify({ simulated: true, results: pass.map((p, i) => ({ id: i + 1, name: "x", pass: p, ms: 50, why: p ? null : "nope" })) });
/** Results by drill id, for runs that include the photo drills (12 to 15). */
const byId = (pass: Record<number, boolean>) => JSON.stringify({ simulated: true, results: Object.entries(pass).map(([id, p]) => ({ id: Number(id), name: "x", pass: p, ms: 50, why: p ? null : "nope" })) });
const on = () => {
  process.env.EDGE_ENABLED = "1";
  process.env.EDGE_BUILDS = "1";
};

afterEach(() => {
  delete process.env.EDGE_ENABLED;
  delete process.env.EDGE_BUILDS;
});

describe("which builds are edge builds", () => {
  it("none with the flags off, or with EDGE_ENABLED alone", () => {
    assert.equal(isEdgeBuild(EDGE), false);
    process.env.EDGE_ENABLED = "1";
    assert.equal(isEdgeBuild(EDGE), false, "the helper and the kit come with EDGE_BUILDS");
    assert.deepEqual(edgeBuildFiles(EDGE), []);
  });

  it("a brief with the edge target once both are on", () => {
    on();
    assert.equal(isEdgeBuild(EDGE), true);
    assert.equal(isEdgeBuild({ targets: [{ id: "web" }] }), false);
    assert.equal(isEdgeBuild(null), false);
    assert.deepEqual(edgeBuildFiles(EDGE).map((f) => f.path), ["next.config.ts"]);
  });
});

describe("the Next config", () => {
  it("matches the template's", () => {
    assert.equal(TEMPLATE_NEXT_CONFIG, readFileSync(new URL("../../../template/next.config.ts", import.meta.url), "utf8"));
  });

  it("adds output standalone once, and gives null when it can't", () => {
    const once = withStandaloneOutput(TEMPLATE_NEXT_CONFIG)!;
    assert.match(once, /const nextConfig: NextConfig = \{\n {2}\/\/ An edge build[^\n]*\n {2}output: "standalone",\n/);
    assert.ok(once.includes('allowedDevOrigins: ["*.vercel.run"]'));
    assert.equal(withStandaloneOutput(once), once);
    assert.equal(withStandaloneOutput("module.exports = {};\n"), null);
  });
});

describe("the drill's script and env", () => {
  it("runs the kit against a second next start on loopback, never at Meta", () => {
    const script = edgeDrillScript();
    assert.match(script, new RegExp(`next start -p ${EDGE_DRILL_PORT} -H 127\\.0\\.0\\.1`));
    assert.match(script, /exec \.\/node_modules/, "stopping the drill stops the server");
    assert.match(script, /rm -f 'test-results\/caps\/edge-drill\.json'/);
    assert.ok(!/meta\.ai|GATEWAY_URL=http/.test(script));
    const vars = edgeDrillEnv();
    assert.equal(vars.MUSEMUSE_BASE_URL, `http://127.0.0.1:${EDGE_DRILL_PORT}`);
    assert.equal(vars.EDGE_FIRST, "0");
    assert.ok(!("GATEWAY_URL" in vars) && !("PRODUCT_TOKEN" in vars), "edge-drill.mjs sets these to the blackhole and a dummy");
    assert.ok(!("EDGE_SAM_URL" in vars), "edge-drill.mjs points it at the fake");
    assert.equal(vars.EDGE_SAM_MODEL_NAME, "simulated SAM", "a fake board's look never claims to be Meta SAM 3.1");
    assert.deepEqual(EDGE_DRILL_KIT.map((f) => f.path), ["scripts/edge-blackhole.mjs", "scripts/edge-drill.mjs", "scripts/edge-fake.mjs"]);
  });
});

describe("the drill as verify steps", () => {
  const base = { passed: true, steps: [{ name: "build", ok: true }], failureOutput: "" };

  it("four passed steps when every drill passed", () => {
    const s = withEdgeDrill(base, { exitCode: 0, timedOut: false, outputTail: "", json: results([true, true, true, true]) });
    assert.equal(s.passed, true);
    assert.deepEqual(s.steps.map((x) => x.name), ["build", "Simulated outage drill 1: cloud refused", "Simulated outage drill 2: cloud hung", "Simulated outage drill 3: both down", "Simulated outage drill 4: tampered reply rejected"]);
    assert.equal(s.failureOutput, "");
  });

  it("a failed drill fails the summary, with its reason for the fix round", () => {
    const s = withEdgeDrill(base, { exitCode: 1, timedOut: false, outputTail: "", json: results([true, false, true, true]) });
    assert.equal(s.passed, false);
    assert.deepEqual(s.steps.map((x) => x.ok), [true, true, false, true, true]);
    assert.match(s.failureOutput, /- Simulated outage drill 2: cloud hung: nope/);
  });

  it("fails all four on a timeout, no results, a missing drill, or a bad exit with passing results", () => {
    const fails = (run: Parameters<typeof edgeDrillSteps>[0]) => edgeDrillSteps(run).steps.filter((x) => !x.ok).length;
    assert.equal(fails({ exitCode: null, timedOut: true, outputTail: "", json: null }), 4);
    assert.equal(fails({ exitCode: 2, timedOut: false, outputTail: "setup", json: null }), 4);
    assert.equal(fails({ exitCode: 0, timedOut: false, outputTail: "", json: "not json" }), 4);
    assert.equal(fails({ exitCode: 1, timedOut: false, outputTail: "", json: results([true, true, true, true]) }), 4);
    assert.equal(fails({ exitCode: 0, timedOut: false, outputTail: "", json: results([true, true, true]) }), 1);
  });

  it("adds the four photo drills as steps once any of them ran, and holds the run to all eight", () => {
    const all = { 1: true, 2: true, 3: true, 4: true, 12: true, 13: true, 14: true, 15: true };
    const s = withEdgeDrill(base, { exitCode: 0, timedOut: false, outputTail: "", json: byId(all) });
    assert.equal(s.passed, true);
    assert.deepEqual(s.steps.slice(5).map((x) => x.name), [
      "Simulated outage drill 12: SAM, cloud refused",
      "Simulated outage drill 13: SAM, cloud hung",
      "Simulated outage drill 14: SAM, both down",
      "Simulated outage drill 15: SAM, tampered board reply rejected",
    ]);
    const failed = withEdgeDrill(base, { exitCode: 1, timedOut: false, outputTail: "", json: byId({ ...all, 15: false }) });
    assert.equal(failed.passed, false);
    assert.deepEqual(failed.steps.map((x) => x.ok), [true, true, true, true, true, true, true, true, false]);
    assert.match(failed.failureOutput, /- Simulated outage drill 15: SAM, tampered board reply rejected: nope/);
    const missing = edgeDrillSteps({ exitCode: 0, timedOut: false, outputTail: "", json: byId({ 1: true, 2: true, 3: true, 4: true, 12: true }) });
    assert.deepEqual(missing.steps.filter((x) => !x.ok).map((x) => x.name.split(":")[0]), ["Simulated outage drill 13", "Simulated outage drill 14", "Simulated outage drill 15"]);
  });

  it("a product that only looks is held to the four photo drills, and a run with no results to the four", () => {
    const s = edgeDrillSteps({ exitCode: 0, timedOut: false, outputTail: "", json: byId({ 12: true, 13: true, 14: true, 15: true }) });
    assert.deepEqual(s.steps.map((x) => x.name.split(":")[0]), [12, 13, 14, 15].map((id) => `Simulated outage drill ${id}`));
    assert.ok(s.steps.every((x) => x.ok));
    assert.equal(edgeDrillSteps({ exitCode: 2, timedOut: false, outputTail: "", json: null }).steps.length, 4);
  });

  it("keeps verify's own failure and never passes a failed verify", () => {
    const s = withEdgeDrill({ ...base, passed: false, failureOutput: "build broke" }, { exitCode: 0, timedOut: false, outputTail: "", json: results([true, true, true, true]) });
    assert.equal(s.passed, false);
    assert.equal(s.failureOutput, "build broke");
  });

  it("has no em dashes in anything a person reads", () => {
    const s = withEdgeDrill(base, { exitCode: null, timedOut: true, outputTail: "", json: null });
    assert.ok(!JSON.stringify(s).includes("\u2014"));
  });
});
