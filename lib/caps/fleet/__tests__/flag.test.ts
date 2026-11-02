/**
 * What FLEET_PRODUCTS changes outside the route (docs/CAPABILITIES.md, 17b), and that it changes nothing with the flag off:
 * tokens, catalog, writer's schema, build prompt, judge. Then the seams a product on this model shows, and the skill.
 *
 *   npx tsx --test lib/caps/fleet/__tests__/flag.test.ts
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { renderBuildPrompt } from "@/lib/brief/render";
import { BriefSchema, NewBriefSchema, NewBriefSchemaNoGadget, newBriefSchemaFor, type Brief } from "@/lib/brief/schema";
import { strictJsonSchema } from "@/lib/brief/strict-schema";
import { capBuildEnv, capDeployEnv } from "@/lib/caps/env";
import { FLEET_SIMULATED_REPLY, handleFleetChat, type FleetDeps } from "@/lib/caps/fleet/handler";
import { FLEET_LABEL } from "@/lib/caps/fleet/marker";
import { FLEET_CATALOG_LINE } from "@/lib/caps/fleet/render";
import { capsJudgeNotes } from "@/lib/caps/judge";
import { capsFileFor } from "@/lib/caps/overlays";
import { capsBuildLines, capsRefineLines } from "@/lib/caps/render";
import { env } from "@/lib/env";
import { modelLabel } from "@/lib/format";
import { selfHostKit } from "@/lib/outputs/selfhost";
import { allowedModelsFor } from "@/lib/pipeline/logic";
import { catalogSummary } from "@/lib/prompts/catalog";
import { BRIEF } from "@/lib/promote/__tests__/fixtures";
import { SNAPSHOTS } from "@/lib/sandbox/snapshots";
import { productPrivacyFor } from "@/lib/trust/overlay";

const FLEET_BRIEF = { ...BRIEF, capabilities: [{ need: "answer questions about the shop's hours", model: "jetson-fleet", why: "the muse asked for our boards" }] } as unknown as Brief;
const OTHER_BRIEF = { ...BRIEF, capabilities: [{ need: "x", model: "muse-wonder-1.0", why: "y" }] } as unknown as Brief;
const saved = { ...process.env };
const file = (path: string) => readFileSync(new URL(`../../../../${path}`, import.meta.url), "utf8");
const models = (schema: unknown) => ((strictJsonSchema(schema as never) as { properties: { capabilities: { items: { properties: { model: { enum: string[] } } } } } }).properties.capabilities.items.properties.model.enum);
const snapshot = (capOverlays: string[]) => ({ createdAt: "2026-11-02T00:00:00Z", templateHash: "x", capOverlays });
/** A made-up snapshot with the helper, for the tests that need FLEET_PRODUCTS to reach builds. */
const WITH_FLEET = "snap_test_with_fleet";

beforeEach(() => {
  for (const k of ["FLEET_PRODUCTS", "FLEET_ALL_PRODUCTS", "FLEET_PRODUCTS_URL", "FLEET_PRODUCTS_KEY", "FLEET_PRODUCTS_MODEL", "GPU_GLIMMER_SHARED", "VERCEL", "BUILDER_SNAPSHOT_ID"]) delete process.env[k];
  process.env.PLATFORM_URL = "https://platform.example";
});
afterEach(() => {
  process.env = { ...saved };
});

describe("with FLEET_PRODUCTS off", () => {
  it("the route answers 404 unknown_endpoint, whatever is asked", async () => {
    const route = await import("@/app/api/gateway/fleet/v1/chat/completions/route");
    for (const handler of [route.POST, route.GET]) {
      const res = await handler(new Request("https://x.example/api/gateway/fleet/v1/chat/completions", { method: handler === route.POST ? "POST" : "GET", ...(handler === route.POST ? { body: "{}" } : {}) }));
      assert.equal(res.status, 404);
      assert.equal(((await res.json()) as { error: { code: string } }).error.code, "unknown_endpoint");
    }
  });

  it("nothing is offered or added, even for a brief that already picked it", () => {
    assert.equal(env.fleetProducts, false);
    assert.equal(env.fleetProductsForBuilds, false);
    assert.deepEqual(allowedModelsFor(FLEET_BRIEF), []);
    assert.deepEqual(capsBuildLines(FLEET_BRIEF), []);
    assert.deepEqual(capsRefineLines(FLEET_BRIEF), []);
    assert.equal(capsJudgeNotes(FLEET_BRIEF), "");
    assert.ok(!catalogSummary([]).includes("jetson-fleet"));
  });

  it("the writer's schema is the same object, and has no jetson-fleet in it", () => {
    assert.equal(newBriefSchemaFor({ gadgets: true, targets: [] }), NewBriefSchema);
    assert.equal(newBriefSchemaFor({ gadgets: false, targets: [] }), NewBriefSchemaNoGadget);
    assert.equal(newBriefSchemaFor({ gadgets: true, targets: [], fleet: false }), NewBriefSchema);
    assert.ok(!models(NewBriefSchema).includes("jetson-fleet"));
    assert.ok(!models(NewBriefSchemaNoGadget).includes("jetson-fleet"));
  });

  it("a brief written while it was on still parses", () => {
    assert.equal(BriefSchema.safeParse(FLEET_BRIEF).success, true);
  });
});

describe("with FLEET_PRODUCTS on", () => {
  beforeEach(() => {
    process.env.FLEET_PRODUCTS = "1";
    SNAPSHOTS[WITH_FLEET] = snapshot(["core", "gpu", "fleet"]);
    process.env.BUILDER_SNAPSHOT_ID = WITH_FLEET;
  });
  afterEach(() => {
    delete SNAPSHOTS[WITH_FLEET];
  });

  it("a brief without jetson-fleet stays as it was", () => {
    assert.deepEqual(allowedModelsFor(OTHER_BRIEF), ["muse-wonder-1.0"]);
    assert.deepEqual(capsBuildLines(OTHER_BRIEF), []);
    assert.equal(capsJudgeNotes(OTHER_BRIEF), "");
  });

  it("the token gets the marker and no model, so nothing can answer in the fleet's place", () => {
    assert.deepEqual(allowedModelsFor(FLEET_BRIEF), ["fleet"]);
    assert.ok(!allowedModelsFor(FLEET_BRIEF).includes("jetson-fleet"));
  });

  it("the writer may pick it, beside what it could pick before, and the gadget setting still holds", () => {
    const on = models(newBriefSchemaFor({ gadgets: true, targets: [], fleet: true }));
    assert.deepEqual(on, [...models(NewBriefSchema), "jetson-fleet"]);
    const noGadget = models(newBriefSchemaFor({ gadgets: false, targets: [], fleet: true }));
    assert.deepEqual(noGadget, [...models(NewBriefSchemaNoGadget), "jetson-fleet"]);
    assert.ok(!noGadget.includes("muse-gadget"));
  });

  it("the writer's call asks for it through this flag", () => {
    assert.match(file("lib/brief/write.ts"), /env\.fleetProductsForBuilds \? \{ fleet: true \}/);
  });

  it("the catalog has its line, keeps its cache apart, and names no model", () => {
    assert.ok(catalogSummary([]).includes(FLEET_CATALOG_LINE));
    delete process.env.FLEET_PRODUCTS;
    assert.ok(!catalogSummary([]).includes("jetson-fleet"));
    assert.match(FLEET_CATALOG_LINE, /Never pick it for health, student, legal, money or other personal data\./);
    for (const name of ["bolt", "nemotron", "gemma", "gemini", "llama", "combo"]) assert.ok(!FLEET_CATALOG_LINE.toLowerCase().includes(name), name);
    assert.ok(!FLEET_CATALOG_LINE.includes("—"));
  });

  it("a build needs no setting of its own: the helper reads GATEWAY_URL and PRODUCT_TOKEN", () => {
    assert.equal(capBuildEnv(FLEET_BRIEF), "");
    assert.deepEqual(capDeployEnv(FLEET_BRIEF, "live_tok"), {});
  });

  it("the build prompt has its section, the helper, the label word for word and the skill", () => {
    const text = capsBuildLines(FLEET_BRIEF).join("\n");
    assert.match(text, /## Platform services/);
    assert.match(text, /### The Jetson fleet/);
    assert.match(text, /askFleetOrMessage/);
    assert.ok(text.includes(FLEET_LABEL));
    assert.ok(text.includes(".agents/skills/jetson-fleet/SKILL.md"));
    assert.ok(!text.includes("—"));
    assert.match(capsRefineLines(FLEET_BRIEF).join("\n"), /askFleetOrMessage/);
    assert.match(capsJudgeNotes(FLEET_BRIEF), /simulated/);
  });

  it("the whole build prompt lists the model with its skill, and the section", () => {
    const text = renderBuildPrompt(FLEET_BRIEF, { inspoFiles: [], fixtures: [], maxModelSteps: 40, museAppLook: false });
    assert.ok(text.includes("`jetson-fleet`: Answer questions about the shop's hours."));
    assert.ok(text.includes("Skill: `.agents/skills/jetson-fleet`."));
    assert.ok(text.includes("### The Jetson fleet"));
    assert.ok(!text.includes("muse-glimmer"));
  });

  for (const where of ["on Vercel", "on a local run, whose product also gets template/ from the snapshot,"]) {
    it(`${where} it waits for a snapshot: none, or one without the overlay, tells builds nothing`, () => {
      if (where === "on Vercel") process.env.VERCEL = "1";
      delete process.env.BUILDER_SNAPSHOT_ID;
      assert.equal(env.fleetProducts, true, "the route itself follows the flag");
      assert.equal(env.fleetProductsForBuilds, false);
      assert.deepEqual(allowedModelsFor(FLEET_BRIEF), []);
      assert.deepEqual(capsBuildLines(FLEET_BRIEF), []);
      SNAPSHOTS["snap_before"] = snapshot(["core", "gpu"]);
      try {
        for (const before of ["snap_before", "snap_not_in_the_manifest"]) {
          process.env.BUILDER_SNAPSHOT_ID = before;
          assert.equal(env.fleetProductsForBuilds, false, before);
          assert.deepEqual(allowedModelsFor(FLEET_BRIEF), [], before);
          assert.ok(!catalogSummary([]).includes("jetson-fleet"), before);
        }
        process.env.BUILDER_SNAPSHOT_ID = WITH_FLEET;
        assert.equal(env.fleetProductsForBuilds, true);
      } finally {
        delete SNAPSHOTS["snap_before"];
      }
    });
  }

  it("a build token minted from this brief, which has no cap blocks and so no buildId, gets the simulated reply", async () => {
    // As provisionStep, chainReopen and reopenStep mint it (lib/pipeline/build-steps.ts).
    assert.equal(file("lib/pipeline/build-steps.ts").match(/\.\.\.\(caps \? \{ buildId: input\.buildId \} : \{\}\)/g)?.length, 3);
    const caps = capsFileFor(FLEET_BRIEF);
    assert.equal(caps, null);
    const token = { id: "t", productId: "p", scope: "build", allowedModels: allowedModelsFor(FLEET_BRIEF), dailyBudgetUsd: 1, buildId: caps ? "b1" : null };
    const rows: Array<string | null | undefined> = [];
    const untouched = () => assert.fail("a build reached past its stand-in");
    const deps: FleetDeps = {
      on: () => env.fleetProducts,
      allProducts: () => false,
      settings: untouched,
      adminEmails: [],
      findToken: async () => token,
      product: async () => ({ status: "building", manifest: null, liveUrl: null, takenDownAt: null, ownerId: "u", ownerEmail: "someone@example.com", ownerIsAdmin: false, ownerBannedAt: null }),
      hitRateLimits: async (keys) => Object.fromEntries(keys.map((k) => [k, 1])),
      acquireInFlight: untouched,
      releaseInFlight: untouched,
      recordUsage: async (ctx) => void rows.push(ctx.buildId),
      fetch: untouched as unknown as typeof fetch,
    };
    const req = new Request("https://platform.example/api/gateway/fleet/v1/chat/completions", { method: "POST", headers: { authorization: "Bearer mm_build_x" }, body: JSON.stringify({ messages: [{ role: "user", content: "When do you open?" }] }) });
    const res = await handleFleetChat(req, deps);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { simulated: boolean; choices: Array<{ message: { content: string } }> };
    assert.equal(body.simulated, true);
    assert.equal(body.choices[0]!.message.content, FLEET_SIMULATED_REPLY);
    assert.deepEqual(rows, [null]);
  });

  it("the overlay that marks it is real, and empty, so a snapshot from this checkout lists fleet by itself", async () => {
    const { capOverlaysIn, readCapFiles } = await import("@/lib/sandbox/setup");
    const caps = await readCapFiles(fileURLToPath(new URL("../../../../template", import.meta.url)));
    assert.ok(capOverlaysIn(caps).includes("fleet"));
    assert.deepEqual(caps.filter((f) => f.path.startsWith("caps/fleet/")).map((f) => f.path).sort(), ["caps/fleet/deps.json", "caps/fleet/platform-files.json"]);
  });

  it("no setting has a default: without them there's nothing to reach", async () => {
    const { fleetSettings } = await import("@/lib/caps/fleet/settings");
    assert.equal(fleetSettings(), null);
  });
});

describe("what a product on this model shows", () => {
  it("its platform chip says Jetson fleet, never Muse Glimmer", () => {
    assert.equal(modelLabel("jetson-fleet"), "Jetson fleet");
    assert.match(file("app/p/[slug]/page.tsx"), /modelLabel\(m\.id\)/);
  });

  it("the product's own chip can credit it, and its manifest may name it", () => {
    assert.match(file("template/components/ModelChip.tsx"), /"jetson-fleet": "Jetson fleet"/);
    const schema = JSON.parse(file("template/musemuse.schema.json")) as { properties: { models: { items: { properties: { id: { enum: string[] } } } } } };
    assert.ok(schema.properties.models.items.properties.id.enum.includes("jetson-fleet"));
  });

  it("its self-host kit says the fleet doesn't answer there, since the kit's gateway is Meta's", () => {
    const src = (path: string, content: string) => ({ path, content: Buffer.from(content) });
    const kit = selfHostKit({
      product: { slug: "shop-hours", name: "Shop Hours", tagline: "When we're open", liveUrl: "https://shop.example", manifest: null },
      deployment: "dpl_1",
      madeAt: new Date("2026-11-02T10:00:00Z"),
      files: [src("package.json", "{}"), src("app/api/ask/route.ts", 'import { askFleetOrMessage } from "@/lib/meta/fleet";\n'), src("lib/meta/fleet.ts", "export {}\n")],
    });
    const part = kit.manifest.platformOnly.find((p) => p.what.startsWith("The Jetson fleet"));
    assert.deepEqual(part?.files, ["app/api/ask/route.ts"]);
    const readme = kit.entries.find((e) => e.path === "README-SELF-HOST.md")!.content.toString();
    assert.ok(readme.includes(part!.what));
  });

  it("its privacy facts don't list it among Meta's models, and say where the text goes", () => {
    const facts = productPrivacyFor(FLEET_BRIEF) as { models: Array<{ id: string }>; services: string[] };
    assert.deepEqual(facts.models, []);
    assert.ok(facts.services.some((s) => s.includes("ngrok")));
    assert.ok(!(productPrivacyFor(OTHER_BRIEF) as { services: string[] }).services.some((s) => s.includes("ngrok")));
  });
});

describe("the helper and the skill", () => {
  const skill = () => file("template/.agents/skills/jetson-fleet/SKILL.md");

  it("the label is the same, word for word, in the platform, the helper and the skill", () => {
    assert.equal(FLEET_LABEL, "Answered on boards we run, with no cloud model. Your text passes through this product's server, Muse Muse, ngrok and our lead board, so don't send private things.");
    assert.ok(file("template/lib/meta/fleet.ts").includes(`"${FLEET_LABEL}"`));
    assert.ok(skill().includes(FLEET_LABEL));
    assert.match(skill(), /Always show this/);
  });

  it("the skill doesn't sell the model as local, private or offline", () => {
    const rest = skill().replace(FLEET_LABEL, "");
    assert.ok(!/\blocal(ly)?\b/i.test(rest));
    assert.ok(!/private/i.test(rest));
    const offline = rest.split("\n").filter((l) => /offline/i.test(l));
    assert.equal(offline.length, 1);
    assert.match(offline[0]!, /When the boards can't answer, `text` holds fixed words saying the fleet is offline/);
  });

  it("the skill keeps personal data away from it, and has no em dashes", () => {
    assert.match(skill(), /Never use it for health, student, legal, money or other personal data\./);
    assert.ok(!skill().includes("—"));
  });

  it("the skill the brief's model line points at exists", () => {
    assert.ok(file("lib/brief/render.ts").includes('"jetson-fleet": ".agents/skills/jetson-fleet"'));
    assert.ok(existsSync(new URL("../../../../template/.agents/skills/jetson-fleet/SKILL.md", import.meta.url)));
  });

  it(".env.example has the settings commented out, with no value and no model", () => {
    const text = file(".env.example");
    for (const name of ["FLEET_PRODUCTS", "FLEET_ALL_PRODUCTS", "FLEET_PRODUCTS_URL", "FLEET_PRODUCTS_KEY", "FLEET_PRODUCTS_MODEL"]) {
      assert.match(text, new RegExp(`^# ${name}=\\r?$`, "m"), name);
    }
  });
});
