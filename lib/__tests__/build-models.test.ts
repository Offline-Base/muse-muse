/**
 * One source of truth for what a build runs on (buildTestModel, lib/env.ts). With BUILDS_ON_CONTRIBUTOR on, every model
 * step of a build answers Contributor, and a build step that names another model itself fails here.
 *   npx tsx --test lib/__tests__/build-models.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { sessionModelFor } from "@/lib/caps/code/musecode/handler";
import { buildTestModel, env } from "@/lib/env";
import { CONTRIBUTOR_RUNTIME_MARKER, needsWonderInput } from "@/lib/gateway/policy";
import { contributorRuntimeMarkers, refineRoute, runtimeStaysOffContributor } from "@/lib/pipeline/logic";
import { PERSONAL_TOOL_IDS } from "@/lib/tools/ids";

const CONTRIBUTOR = "muse-spark-1.3-contributor";
const WONDER = "muse-wonder-1.0";
const ROOT = path.join(import.meta.dirname, "../..");
const read = (f: string) => readFileSync(path.join(ROOT, f), "utf8");

describe("with BUILDS_ON_CONTRIBUTOR", () => {
  const saved = { flag: process.env.BUILDS_ON_CONTRIBUTOR, build: process.env.BUILD_MODEL };
  before(() => {
    process.env.BUILDS_ON_CONTRIBUTOR = "1";
    process.env.BUILD_MODEL = WONDER;
  });
  after(() => {
    for (const [k, v] of [["BUILDS_ON_CONTRIBUTOR", saved.flag], ["BUILD_MODEL", saved.build]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("the brief, judge and both build models are Contributor, whatever their own settings say", () => {
    assert.equal(buildTestModel(), CONTRIBUTOR);
    assert.deepEqual([env.briefModel, env.judgeModel, env.buildModel, env.complexBuildModel], [CONTRIBUTOR, CONTRIBUTOR, CONTRIBUTOR, CONTRIBUTOR]);
  });
});

describe("build steps name no model of their own", () => {
  // Every other place that names Muse Wonder is a default behind buildTestModel, a product's runtime or not a build.
  for (const [file, must] of [
    ["lib/tools/fixtures.ts", "buildTestModel() ?? FIXTURE_MODEL"],
    ["lib/caps/platform/deps.ts", "buildTestModel() ?? DEFAULT_PLATFORM_MODEL"],
    ["lib/caps/code/musecode/deps.ts", "contributorBuilds: contributorBuildsOn"],
    ["lib/pipeline/build-steps.ts", "buildTestModel())"],
    ["lib/pipeline/prove-steps.ts", "contributorBuildsOn() ? NIGHTLY_MODEL"],
  ] as const) {
    it(`${file} goes through the switch`, () => assert.ok(read(file).includes(must)));
  }

  it("has no model literal in the steps themselves", () => {
    for (const file of ["lib/pipeline/build-steps.ts", "lib/judge.ts", "lib/brief/write.ts", "lib/brief/policy.ts"]) {
      assert.doesNotMatch(read(file), /model:\s*"muse-/, file);
    }
  });
});

describe("Muse Code sessions", () => {
  it("run on Contributor for everyone with the flag, and only for a build's with TEST_MODEL", () => {
    assert.equal(sessionModelFor(false, CONTRIBUTOR, true), CONTRIBUTOR);
    assert.equal(sessionModelFor(true, CONTRIBUTOR, false), CONTRIBUTOR);
    assert.equal(sessionModelFor(false, CONTRIBUTOR, false), WONDER);
    assert.equal(sessionModelFor(true, null, false), WONDER);
  });
});

describe("a change", () => {
  it("moves a Wonder session to a new Contributor session with the switch on, and stays put otherwise", () => {
    assert.deepEqual(refineRoute(WONDER, CONTRIBUTOR), { model: CONTRIBUTOR, freshSession: true });
    assert.deepEqual(refineRoute(CONTRIBUTOR, CONTRIBUTOR), { model: CONTRIBUTOR, freshSession: false });
    assert.deepEqual(refineRoute(WONDER, null), { model: WONDER, freshSession: false });
    assert.deepEqual(refineRoute(CONTRIBUTOR, null), { model: CONTRIBUTOR, freshSession: false });
  });
});

describe("a live product under the flag", () => {
  const plain = { capabilities: [{ need: "chat", model: WONDER, why: "x" }], agent: null } as never;
  const withAgent = (tools: string[], connections = "none") =>
    ({ capabilities: [{ need: "run", model: WONDER, why: "x" }], agent: { task: "t", tools: tools.map((id) => ({ id, need: "n", why: "w" })), connections, stepsPerRun: 2 } }) as never;

  it("gets the marker only with the flag, the notice and nothing personal", () => {
    assert.deepEqual(contributorRuntimeMarkers(plain, true, true), [CONTRIBUTOR_RUNTIME_MARKER]);
    assert.deepEqual(contributorRuntimeMarkers(plain, false, true), []);
    assert.deepEqual(contributorRuntimeMarkers(plain, true, false), []);
    assert.deepEqual(contributorRuntimeMarkers(null, true, true), []);
  });

  it("stays on Wonder with personal tools, an owner connection, owner keys or sends, or a gadget", () => {
    assert.equal(runtimeStaysOffContributor(withAgent([PERSONAL_TOOL_IDS[0] as string])), true);
    assert.equal(runtimeStaysOffContributor(withAgent([], "owner")), true);
    assert.equal(runtimeStaysOffContributor({ ...(plain as object), connect: { publicApis: [], keys: [{ service: "s", why: "w" }], sends: [] } } as never), true);
    assert.equal(runtimeStaysOffContributor({ ...(plain as object), connect: { publicApis: [], keys: [], sends: [{ channel: "email", why: "w" }] } } as never), true);
    assert.equal(runtimeStaysOffContributor({ capabilities: [{ need: "cam", model: "muse-gadget", why: "x" }], agent: null } as never), true);
  });

  it("follows the flag with web search, public APIs or plain chat", () => {
    assert.equal(runtimeStaysOffContributor(plain), false);
    assert.equal(runtimeStaysOffContributor(withAgent(["web_search"])), false);
    assert.equal(runtimeStaysOffContributor({ ...(plain as object), connect: { publicApis: ["x"], keys: [], sends: [] } } as never), false);
  });

  it("names audio input as what Contributor lacks", () => {
    assert.equal(needsWonderInput({ input: [{ role: "user", content: [{ type: "input_audio" }] }] }), true);
    assert.equal(needsWonderInput({ input: [{ role: "user", content: [{ type: "input_image" }] }] }), false);
  });
});

describe("the notice", () => {
  const line = "Don't enter personal or sensitive information.";
  it("is in both footers, behind the deploy's switch, with no em dash", () => {
    for (const file of ["template/components/Footer.tsx", "template/caps/trust/files/components/Footer.tsx"]) {
      const text = read(file);
      assert.ok(text.includes(line) && text.includes('process.env.MUSE_CONTRIBUTOR_NOTICE === "1"'), file);
      assert.equal(text.includes("—"), false);
    }
  });
});
