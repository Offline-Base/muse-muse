/**
 * What SPARK_OPEN_PRODUCTS changes outside the gateway route, and that it changes nothing with the flag off: the gateway's deps,
 * tokens, catalog, writer's schema, build prompt, judge, privacy facts. Then the helper and the skill a product gets.
 *
 *   npx tsx --test lib/prompts/__tests__/spark-open-flag.test.ts
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { renderBuildPrompt } from "@/lib/brief/render";
import { BriefSchema, NewBriefSchema, NewBriefSchemaNoGadget, newBriefSchemaFor, type Brief } from "@/lib/brief/schema";
import { strictJsonSchema } from "@/lib/brief/strict-schema";
import { capsJudgeNotes } from "@/lib/caps/judge";
import { capsBuildLines, capsRefineLines } from "@/lib/caps/render";
import { env } from "@/lib/env";
import { modelLabel } from "@/lib/format";
import { gatewayDeps } from "@/lib/gateway/deps";
import { SPARK_OPEN_CREDIT, SPARK_OPEN_PROVIDERS } from "@/lib/meta/spark-open";
import { selfHostKit } from "@/lib/outputs/selfhost";
import { allowedModelsFor } from "@/lib/pipeline/logic";
import { catalogSummary } from "@/lib/prompts/catalog";
import { SPARK_OPEN_PRIVACY_LINE, sparkOpenCatalogLine } from "@/lib/prompts/spark-open";
import { BRIEF } from "@/lib/promote/__tests__/fixtures";
import { SNAPSHOTS } from "@/lib/sandbox/snapshots";
import { productPrivacyFor } from "@/lib/trust/overlay";

const SPARK_BRIEF = { ...BRIEF, capabilities: [{ need: "sort each task into a list", model: "muse-spark-open", why: "the muse asked for Meta's open-weight model" }] } as unknown as Brief;
const OTHER_BRIEF = { ...BRIEF, capabilities: [{ need: "x", model: "muse-image-1.0", why: "y" }] } as unknown as Brief;
const saved = { ...process.env };
const file = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");
const models = (schema: unknown) => (strictJsonSchema(schema as never) as { properties: { capabilities: { items: { properties: { model: { enum: string[] } } } } } }).properties.capabilities.items.properties.model.enum;
const snapshot = (capOverlays: string[]) => ({ createdAt: "2026-11-02T00:00:00Z", templateHash: "x", capOverlays });
/** A made-up snapshot with the helper, for the tests that need SPARK_OPEN_PRODUCTS to reach builds. */
const WITH_SPARK_OPEN = "snap_test_with_spark_open";

beforeEach(() => {
  for (const k of ["SPARK_OPEN_PRODUCTS", "SPARK_OPEN_PROVIDER", "BASETEN_API_KEY", "FIREWORKS_API_KEY", "FLEET_PRODUCTS", "GPU_GLIMMER_SHARED", "VERCEL", "BUILDER_SNAPSHOT_ID"]) delete process.env[k];
  process.env.PLATFORM_URL = "https://platform.example";
});
afterEach(() => {
  process.env = { ...saved };
});

describe("with SPARK_OPEN_PRODUCTS off", () => {
  it("the gateway has no Spark Open deps, so /v1/chat/completions stays unknown", () => {
    process.env.BASETEN_API_KEY = "made-up";
    assert.equal(env.sparkOpenProducts, false);
    assert.equal(env.sparkOpenProductsForBuilds, false);
    assert.ok(!("sparkOpen" in gatewayDeps(() => {})));
  });

  it("nothing is offered or added to the prompts, even for a brief that already picked it", () => {
    assert.deepEqual(capsBuildLines(SPARK_BRIEF), []);
    assert.deepEqual(capsRefineLines(SPARK_BRIEF), []);
    assert.equal(capsJudgeNotes(SPARK_BRIEF), "");
    assert.ok(!catalogSummary([]).includes("muse-spark-open"));
    assert.ok(!catalogSummary([]).includes("Spark Open"));
  });

  it("a token is what it was for every brief that never picked it", () => {
    assert.deepEqual(allowedModelsFor(OTHER_BRIEF), ["muse-image-1.0"]);
  });

  it("the writer's schema is the same object, with no muse-spark-open in it", () => {
    assert.equal(newBriefSchemaFor({ gadgets: true, targets: [] }), NewBriefSchema);
    assert.equal(newBriefSchemaFor({ gadgets: false, targets: [] }), NewBriefSchemaNoGadget);
    assert.equal(newBriefSchemaFor({ gadgets: true, targets: [], sparkOpen: false }), NewBriefSchema);
    assert.ok(!models(NewBriefSchema).includes("muse-spark-open"));
    assert.ok(!models(NewBriefSchemaNoGadget).includes("muse-spark-open"));
  });

  it("a brief written while it was on still parses", () => {
    assert.equal(BriefSchema.safeParse(SPARK_BRIEF).success, true);
  });
});

describe("with SPARK_OPEN_PRODUCTS on", () => {
  beforeEach(() => {
    process.env.SPARK_OPEN_PRODUCTS = "1";
    SNAPSHOTS[WITH_SPARK_OPEN] = snapshot(["core", "gpu", "spark-open"]);
    process.env.BUILDER_SNAPSHOT_ID = WITH_SPARK_OPEN;
  });
  afterEach(() => {
    delete SNAPSHOTS[WITH_SPARK_OPEN];
  });

  it("the gateway reads the provider and its key per call: Baseten unless SPARK_OPEN_PROVIDER says fireworks", () => {
    const deps = gatewayDeps(() => {});
    assert.equal(typeof deps.sparkOpen, "function");
    assert.equal(deps.sparkOpen!(), null, "no key yet");
    process.env.BASETEN_API_KEY = "made-up-baseten";
    assert.equal(deps.sparkOpen!()?.baseUrl, "https://inference.baseten.co/v1");
    process.env.SPARK_OPEN_PROVIDER = "fireworks";
    assert.equal(deps.sparkOpen!(), null, "Fireworks' key isn't set");
    process.env.FIREWORKS_API_KEY = "made-up-fireworks";
    assert.equal(deps.sparkOpen!()?.model, "accounts/fireworks/models/muse-spark-open");
  });

  it("allowedModelsFor grants it from the brief, and a brief without it stays as it was", () => {
    assert.deepEqual(allowedModelsFor(SPARK_BRIEF), ["muse-spark-open"]);
    assert.deepEqual(allowedModelsFor(OTHER_BRIEF), ["muse-image-1.0"]);
  });

  it("the writer may pick it, after jetson-fleet when both are on, and the gadget setting still holds", () => {
    assert.deepEqual(models(newBriefSchemaFor({ gadgets: true, targets: [], sparkOpen: true })), [...models(NewBriefSchema), "muse-spark-open"]);
    const noGadget = models(newBriefSchemaFor({ gadgets: false, targets: [], sparkOpen: true }));
    assert.deepEqual(noGadget, [...models(NewBriefSchemaNoGadget), "muse-spark-open"]);
    assert.deepEqual(models(newBriefSchemaFor({ gadgets: true, targets: [], fleet: true, sparkOpen: true })), [...models(NewBriefSchema), "jetson-fleet", "muse-spark-open"]);
    assert.deepEqual(models(newBriefSchemaFor({ gadgets: true, targets: [], fleet: true })), [...models(NewBriefSchema), "jetson-fleet"]);
  });

  it("the writer's call asks for it through this flag", () => {
    assert.match(file("lib/brief/write.ts"), /env\.sparkOpenProductsForBuilds \? \{ sparkOpen: true \}/);
  });

  it("the catalog has its line with the provider's name and price, and keeps its cache apart", () => {
    const line = sparkOpenCatalogLine()!;
    assert.ok(catalogSummary([]).includes(line));
    assert.match(line, /on Baseten/);
    assert.match(line, /\$2\.50 per million input tokens and \$8\.50 per million output tokens/);
    assert.ok(line.includes(SPARK_OPEN_CREDIT));
    assert.match(line, /Never pick it for a product made for children or for students under 18\./);
    process.env.SPARK_OPEN_PROVIDER = "fireworks";
    assert.match(catalogSummary([]), /on Fireworks.*\n.*\$1\.25 per million input tokens and \$4\.25/);
    process.env.SPARK_OPEN_PROVIDER = "somewhere-else";
    assert.ok(!catalogSummary([]).includes("muse-spark-open"), "an unknown provider serves nothing, so nothing is offered");
    delete process.env.SPARK_OPEN_PRODUCTS;
    delete process.env.SPARK_OPEN_PROVIDER;
    assert.ok(!catalogSummary([]).includes("muse-spark-open"));
    assert.ok(!line.includes("\u2014"));
  });

  it("the build prompt lists the model with its skill, and its section with the helper, label and credit", () => {
    const section = capsBuildLines(SPARK_BRIEF).join("\n");
    assert.match(section, /### Muse Spark Open/);
    assert.match(section, /askSparkOpen/);
    assert.ok(section.includes(".agents/skills/meta-spark-open/SKILL.md"));
    assert.ok(section.includes(SPARK_OPEN_CREDIT));
    assert.ok(!section.includes("\u2014"));
    assert.match(capsRefineLines(SPARK_BRIEF).join("\n"), /lib\/meta\/spark-open\.ts/);
    assert.match(capsJudgeNotes(SPARK_BRIEF), /don't imply Meta made the product/);
    const text = renderBuildPrompt(SPARK_BRIEF, { inspoFiles: [], fixtures: [], maxModelSteps: 40, museAppLook: false });
    assert.ok(text.includes("`muse-spark-open`: Sort each task into a list."));
    assert.ok(text.includes("Skill: `.agents/skills/meta-spark-open`."));
    assert.ok(text.includes("### Muse Spark Open"));
    assert.deepEqual(capsBuildLines(OTHER_BRIEF), []);
  });

  for (const where of ["on Vercel", "on a local run"]) {
    it(`${where} it waits for a snapshot with the overlay before builds are told anything`, () => {
      if (where === "on Vercel") process.env.VERCEL = "1";
      delete process.env.BUILDER_SNAPSHOT_ID;
      assert.equal(env.sparkOpenProducts, true, "the gateway itself follows the flag");
      assert.equal(env.sparkOpenProductsForBuilds, false);
      assert.deepEqual(capsBuildLines(SPARK_BRIEF), []);
      SNAPSHOTS["snap_before_spark_open"] = snapshot(["core", "gpu"]);
      try {
        process.env.BUILDER_SNAPSHOT_ID = "snap_before_spark_open";
        assert.equal(env.sparkOpenProductsForBuilds, false);
        assert.ok(!catalogSummary([]).includes("muse-spark-open"));
        process.env.BUILDER_SNAPSHOT_ID = WITH_SPARK_OPEN;
        assert.equal(env.sparkOpenProductsForBuilds, true);
      } finally {
        delete SNAPSHOTS["snap_before_spark_open"];
      }
    });
  }

  it("the overlay that marks it is real and empty, so a snapshot from this checkout lists spark-open by itself", async () => {
    const { capOverlaysIn, readCapFiles } = await import("@/lib/sandbox/setup");
    const caps = await readCapFiles(fileURLToPath(new URL("../../../template", import.meta.url)));
    assert.ok(capOverlaysIn(caps).includes("spark-open"));
    assert.deepEqual(caps.filter((f) => f.path.startsWith("caps/spark-open/")).map((f) => f.path).sort(), ["caps/spark-open/deps.json", "caps/spark-open/platform-files.json"]);
  });
});

describe("what a product on it shows", () => {
  it("its chip says Muse Spark Open on the platform and in the product, and its manifest may name it", () => {
    assert.equal(modelLabel("muse-spark-open"), "Muse Spark Open");
    assert.match(file("template/components/ModelChip.tsx"), /"muse-spark-open": "Muse Spark Open"/);
    const schema = JSON.parse(file("template/musemuse.schema.json")) as { properties: { models: { items: { properties: { id: { enum: string[] } } } } } };
    assert.ok(schema.properties.models.items.properties.id.enum.includes("muse-spark-open"));
  });

  it("its privacy facts list it with Meta's models and name the providers", () => {
    const facts = productPrivacyFor(SPARK_BRIEF) as { models: Array<{ id: string; label: string }>; services: string[] };
    assert.deepEqual(facts.models.map((m) => [m.id, m.label]), [["muse-spark-open", "Muse Spark Open"]]);
    assert.ok(facts.services.includes(SPARK_OPEN_PRIVACY_LINE));
    for (const p of Object.values(SPARK_OPEN_PROVIDERS)) assert.ok(SPARK_OPEN_PRIVACY_LINE.includes(p.name), p.name);
    assert.ok(!(productPrivacyFor(OTHER_BRIEF) as { services: string[] }).services.includes(SPARK_OPEN_PRIVACY_LINE));
  });

  it("its self-host kit says it doesn't answer there, since the kit's gateway is Meta's", () => {
    const src = (path: string, content: string) => ({ path, content: Buffer.from(content) });
    const kit = selfHostKit({
      product: { slug: "task-sorter", name: "Task Sorter", tagline: "Sorts tasks", liveUrl: "https://tasks.example", manifest: null },
      deployment: "dpl_1",
      madeAt: new Date("2026-11-02T10:00:00Z"),
      files: [src("package.json", "{}"), src("app/api/sort/route.ts", 'import { askSparkOpen } from "@/lib/meta/spark-open";\n'), src("lib/meta/spark-open.ts", "export {}\n")],
    });
    const part = kit.manifest.platformOnly.find((p) => p.what.startsWith("Muse Spark Open"));
    assert.deepEqual(part?.files, ["app/api/sort/route.ts"]);
  });
});

describe("the helper and the skill", () => {
  const skill = () => file("template/.agents/skills/meta-spark-open/SKILL.md");

  it("the credit is the same, word for word, in the platform, the helper and the skill", () => {
    assert.equal(SPARK_OPEN_CREDIT, "Built with Muse Spark Open. For people 18 and over only.");
    assert.ok(file("template/lib/meta/spark-open.ts").includes(`"${SPARK_OPEN_CREDIT}"`));
    assert.ok(skill().includes(`> ${SPARK_OPEN_CREDIT}`));
    assert.ok(skill().includes("> Muse Spark Open, on Baseten"));
  });

  it("the skill is for this model only, sends nothing elsewhere, and has no em dashes", () => {
    assert.match(skill(), /^description: Use only when the brief lists muse-spark-open\./m);
    assert.match(skill(), /never call a provider or any other host yourself/);
    assert.ok(!skill().includes("\u2014"));
    assert.ok(!file("template/lib/meta/spark-open.ts").includes("\u2014"), "the helper says \\u2014, never the character");
  });

  it("the skill the brief's model line points at exists", () => {
    assert.ok(file("lib/brief/render.ts").includes('"muse-spark-open": ".agents/skills/meta-spark-open"'));
    assert.ok(existsSync(new URL("../../../template/.agents/skills/meta-spark-open/SKILL.md", import.meta.url)));
  });

  it(".env.example has the settings commented out, with no value", () => {
    const text = file(".env.example");
    for (const name of ["SPARK_OPEN_PRODUCTS", "SPARK_OPEN_PROVIDER"]) assert.match(text, new RegExp(`^# ${name}=\\r?$`, "m"), name);
  });
});
