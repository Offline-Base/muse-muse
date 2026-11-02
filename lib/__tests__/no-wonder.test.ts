/**
 * BUILDS_ON_CONTRIBUTOR: no code path picks Muse Wonder but the owner's exceptions: WONDER_IN_LOOP's Wonder check once it merges,
 * the device route, and live gadget, board and demo products (keepsWonderUnderSwitch). A new use of the id fails the scan below
 * until someone says here why it isn't a model pick.
 *   npx tsx --test lib/__tests__/no-wonder.test.ts
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

// Before any import that reads it: some models are constants, fixed when their module loads.
process.env.BUILDS_ON_CONTRIBUTOR = "1";
delete process.env.TEST_MODEL;

const CONTRIBUTOR = "muse-spark-1.3-contributor";
const WONDER = "muse-wonder-1.0";
const ROOT = path.join(import.meta.dirname, "../..");

/** The owner's approved exception, on branch tg-wonder-loop. These two files may call Wonder, and no others. */
const WONDER_CHECK = ["lib/wonder/loop.ts", "lib/pipeline/wonder-step.ts"];

/** Every other file that names the id, and why that isn't a model pick. */
const NOT_A_PICK: Record<string, string> = {
  "lib/env.ts": "DEFAULT_PLATFORM_MODEL, read behind the switch and by the device route, an owner's exception",
  "lib/meta/spark.ts": "defaultModel's flag-off answer, and telling a product's writer to keep the id",
  "lib/meta/pricing.ts": "its price",
  "lib/edge/template-source.ts": "a generated copy of template/lib/meta/edge.ts, written into edge builds: a product's own default id and its label, which the gateway swaps under the switch",
  "lib/format.ts": "its display name",
  "lib/types.ts": "the type of model ids",
  "lib/brief/schema.ts": "the id a brief may list; the gateway serves it on Contributor",
  "lib/brief/render.ts": "the skill table, and whether a brief lists the id",
  "lib/gateway/policy.ts": "ids the gateway accepts, then swaps",
  "lib/gateway/handler.ts": "recognizes the id in order to swap, refuse or keep it for an exception, and TRUST_SPARK_TO_WONDER with the switch off",
  "lib/gateway/rewrite.ts": "flag-off refusal wording only",
  "lib/docs/proxy/rewrite.ts": "recognizes the id in order to swap it",
  "lib/docs/proxy/ask.ts": "recognizes the id in order to swap it",
  "lib/docs/proxy/policy.ts": "ids and limits the docs accept; the rewrite swaps it first",
  "lib/docs/client/models.ts": "the docs menu, filtered under the switch",
  "lib/docs/demos/muse-code.ts": "documentation of Meta's own models",
  "lib/docs/demos/start.ts": "documentation of Meta's own models",
  "lib/docs/demos/text.ts": "a docs demo's request, served through the proxy's swap",
  "lib/prompts/catalog.ts": "its catalog row, replaced under the switch, which names the gadget and board exception",
  "lib/prompts/brief.ts": "the id a brief lists",
  "lib/native/targets.ts": "the id a brief lists",
  "lib/recipes/registry.ts": "ids a recipe's token may name, served by the gateway's swap",
  "lib/caps/gpu/marker.ts": "the id a Glimmer product's token may name, served by the gateway's swap",
  "lib/caps/code/musecode/handler.ts": "sessionModelFor's flag-off answer",
  "lib/caps/code/musecode/sandbox.ts": "flag-off session settings and the type",
  "lib/sandbox/muse.ts": "the type of build models",
  "lib/outputs/prove.ts": "the reserve table by model",
  "lib/pipeline/logic.ts": "the list of build models",
  "lib/pipeline/prove-steps.ts": "the reserve table's fallback",
  "lib/train/hub-cards.ts": "the name in the note that scores don't compare",
  "scripts/prove-run.ts": "a command line argument a person passes by hand; its default follows the switch",
  "components/models/catalog.ts": "the Models page's catalog row, which the owner keeps",
};

function sources(dir: string): string[] {
  return readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "__tests__" || e.name === "skills" ? [] : sources(rel);
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [rel] : [];
  });
}

describe("with the switch on", () => {
  it("every model the platform picks is Contributor", async () => {
    const { buildTestModel, env } = await import("@/lib/env");
    const { defaultModel } = await import("@/lib/meta/spark");
    const { sessionModelFor } = await import("@/lib/caps/code/musecode/handler");
    const { pickBuildModel } = await import("@/lib/pipeline/logic");
    const { parseSessionUsage } = await import("@/lib/sandbox/muse-log");
    const { JUDGE_MODEL } = await import("@/lib/train/judge");
    const { DATASET_MODEL, writerFor } = await import("@/lib/train/datasets");
    const { STORY_MODEL } = await import("@/lib/train/hub-cards");
    const { planModel } = await import("@/lib/train/tune/plan");
    const { checkModel } = await import("@/lib/train/public/content");
    const { PROVE_MODEL } = await import("@/lib/outputs/prove");
    const { WRITER_MODEL } = await import("@/components/train/format");
    const picks: Record<string, string | null> = {
      defaultModel: defaultModel(), buildTestModel: buildTestModel(), brief: env.briefModel, judge: env.judgeModel, build: env.buildModel, complexBuild: env.complexBuildModel,
      session: sessionModelFor(false, null, true), fallbackBuild: pickBuildModel("simple", { buildModel: "nonsense", complexBuildModel: "nonsense" }),
      tuneJudge: JUDGE_MODEL, datasetWriter: DATASET_MODEL, savedWonderDataset: writerFor(WONDER), hubStory: STORY_MODEL, tunePlan: planModel(), contentCheck: checkModel(), prove: PROVE_MODEL, trainCopy: WRITER_MODEL,
    };
    for (const [name, model] of Object.entries(picks)) assert.equal(model, CONTRIBUTOR, name);
    assert.equal(parseSessionUsage.length, 1);
  });

  it("the docs proxy and its Ask box serve Wonder on Contributor, and the menus don't offer it", async () => {
    const { rewriteJson } = await import("@/lib/docs/proxy/rewrite");
    const { DOCS_MODELS } = await import("@/lib/docs/client/models");
    const rewritten = rewriteJson({ id: "responses.create" } as never, { model: WONDER, input: "made up" });
    assert.equal(rewritten.body.model, CONTRIBUTOR);
    assert.equal(rewritten.model, CONTRIBUTOR);
    assert.ok(!DOCS_MODELS.text.some((m) => m.id === WONDER));
  });

  it("a product holding something personal is refused, not moved to Contributor", async () => {
    const { contributorSwitchRefusal } = await import("@/lib/gateway/policy");
    const { contributorRuntimeMarkers, runtimeStaysOffContributor } = await import("@/lib/pipeline/logic");
    const personal = { capabilities: [], agent: { connections: "owner", tools: [] } } as never;
    assert.equal(runtimeStaysOffContributor(personal), true);
    assert.deepEqual(contributorRuntimeMarkers(personal, true, true), []);
    assert.equal(contributorSwitchRefusal({ input: "hi" }, { scope: "live", allowedModels: [WONDER] })?.code, "off_for_now");
    assert.equal(contributorSwitchRefusal({ input: "hi" }, { scope: "live", allowedModels: [WONDER, "runtime:contributor"] }), null);
    assert.equal(contributorSwitchRefusal({ input: [{ content: [{ type: "input_audio" }] }] }, { scope: "build", allowedModels: [WONDER] })?.code, "audio_input_off");
  });

  it("the Wonder exceptions are exactly gadgets, boards and the three demos, live only", async () => {
    const { keepsWonderUnderSwitch, WONDER_DEMO_SLUGS } = await import("@/lib/gateway/policy");
    assert.deepEqual([...WONDER_DEMO_SLUGS], ["voice-memo-tasks", "class-capture-notes", "gym-snap-coach"]);
    const live = (...extra: string[]) => ({ scope: "live", allowedModels: [WONDER, ...extra] });
    assert.equal(keepsWonderUnderSwitch(live("muse-gadget"), "x"), true);
    assert.equal(keepsWonderUnderSwitch(live("board-tools"), "x"), true);
    for (const slug of WONDER_DEMO_SLUGS) assert.equal(keepsWonderUnderSwitch(live(), slug), true, slug);
    assert.equal(keepsWonderUnderSwitch(live(), "another-product"), false);
    assert.equal(keepsWonderUnderSwitch(live("drive-tools", "tool:gmail"), "another-product"), false);
    assert.equal(keepsWonderUnderSwitch(live(), null), false);
    assert.equal(keepsWonderUnderSwitch({ scope: "build", allowedModels: [WONDER, "muse-gadget"] }, "gym-snap-coach"), false);
  });

  it("a new gadget or board product is built and gets no Contributor marker, and a personal one isn't built", async () => {
    const { contributorRuntimeMarkers, personalOffUnderSwitch } = await import("@/lib/pipeline/logic");
    const gadget = { capabilities: [{ model: "muse-gadget" }], agent: null } as never;
    assert.equal(personalOffUnderSwitch(gadget), false);
    assert.deepEqual(contributorRuntimeMarkers(gadget, true, true), []);
    assert.equal(personalOffUnderSwitch({ capabilities: [], agent: { connections: "owner", tools: [] } } as never), true);
  });

  it("switch off: the platform's answers are Muse Wonder, the flip docs/JUDGING_WEEK.md describes", async () => {
    const { buildTestModel } = await import("@/lib/env");
    const { contributorSwitchOn, defaultModel } = await import("@/lib/meta/spark");
    const { sessionModelFor } = await import("@/lib/caps/code/musecode/handler");
    process.env.BUILDS_ON_CONTRIBUTOR = "";
    try {
      assert.equal(contributorSwitchOn(), false);
      assert.equal(defaultModel(), WONDER);
      assert.equal(buildTestModel(), null);
      assert.equal(sessionModelFor(false, null, false), WONDER);
    } finally {
      process.env.BUILDS_ON_CONTRIBUTOR = "1";
    }
  });
});

describe("results and new builds under the switch", () => {
  it("a result judged on Contributor says its scores don't compare, and one judged on Wonder says nothing", async () => {
    const { judgeComparabilityNote } = await import("@/components/train/format");
    const { modelLabel } = await import("@/lib/format");
    assert.match(judgeComparabilityNote(modelLabel(CONTRIBUTOR)) ?? "", /don't compare with runs judged by Muse Wonder/);
    assert.equal(judgeComparabilityNote("Muse Wonder"), null);
  });

  it("a Muse Code task on a product that can't use Contributor is refused, and a new personal product isn't built", () => {
    assert.match(readFileSync(path.join(ROOT, "lib/caps/code/musecode/handler.ts"), "utf8"), /contributorBuilds\?\.\(\) === true && contributorSwitchRefusal\(\{\}, ctx\.token\)/);
    assert.match(readFileSync(path.join(ROOT, "lib/pipeline/build-steps.ts"), "utf8"), /personalOff \? PERSONAL_OFF_MESSAGE/);
  });
});

describe("the id in code", () => {
  const files = ["lib", "app", "scripts", "components"].flatMap(sources).filter((f) => !f.startsWith("scripts/knowledge") && !f.startsWith("scripts/docs") && !f.startsWith("scripts/dev") && !f.startsWith("components/docs"));
  const naming = files.filter((f) => readFileSync(path.join(ROOT, f), "utf8").includes(WONDER));

  it("appears only where this file says why", () => {
    const unexplained = naming.filter((f) => !NOT_A_PICK[f] && !WONDER_CHECK.includes(f));
    assert.deepEqual(unexplained, [], "A new use of Muse Wonder: route it through defaultModel(), or add why it isn't a model pick");
  });

  it("is never assigned as a model outside the Wonder check", () => {
    // The docs demos' own requests go through the proxy's swap, tested above.
    for (const f of naming.filter((n) => !WONDER_CHECK.includes(n) && !n.startsWith("lib/docs/"))) {
      assert.doesNotMatch(readFileSync(path.join(ROOT, f), "utf8"), /\bmodel:\s*"muse-wonder-1\.0"(?!\s*as const,\s*why)/, f);
    }
  });

  it("DEFAULT_PLATFORM_MODEL reaches a call only behind the switch, or on the device route, an owner's exception", () => {
    const device = readFileSync(path.join(ROOT, "app/api/device/ask/route.ts"), "utf8");
    assert.match(device, /const model = DEFAULT_PLATFORM_MODEL/);
    assert.doesNotMatch(device, /contributorBuildsOn/);
    assert.match(readFileSync(path.join(ROOT, "lib/caps/platform/deps.ts"), "utf8"), /buildTestModel\(\) \?\? DEFAULT_PLATFORM_MODEL/);
  });
});
