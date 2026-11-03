/**
 * With every target flag off, what the brief writer and Muse Code are given is byte for byte what it was before targets
 * existed. golden/ was written from the code at 723460f, before any of this. A later change to these prompts that isn't
 * behind a flag has to regenerate it on purpose, and the diff shows what changed:
 *
 *   UPDATE_GOLDEN=1 npx tsx --test lib/brief/__tests__/flags-off.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, it } from "node:test";
import { z } from "zod";
import { BriefSchema, NewBriefSchema, NewBriefSchemaNoGadget, TARGETS, newBriefSchemaFor } from "@/lib/brief/schema";
import { strictJsonSchema } from "@/lib/brief/strict-schema";
import { CAP_BRIEF_FIELDS } from "@/lib/caps/brief-fields";
import { CAP_FLAG, CAP_IDS } from "@/lib/caps/ids";
import { env } from "@/lib/env";
import { BRIEF } from "@/lib/promote/__tests__/fixtures";
import { flagsOffSurface } from "./flags-off-surface";

const GOLDEN = join(import.meta.dirname, "golden");
const FLAGS = [
  "NATIVE_TARGETS",
  "NATIVE_LAB",
  "NATIVE_DEVICE_FARM",
  "VR_ENABLED",
  "GLASSES_ENABLED",
  "GLASSES_NATIVE_CHECKS",
  "AGENTS_ENABLED",
  "RECIPES_ENABLED",
  "AGENT_LONG_RUNS",
  "VERIFY_AGENTS",
  "COMPOSIO_PERSONAL_ENABLED",
  "GADGETS_ENABLED",
  "MUSE_APP_LOOK",
  "FULL_BUILDS", "FULL_BUILD_WALL_MINUTES",
  "BUILD_RANGE",
  // Wave 3 (docs/CAPABILITIES.md): one line per unit, in plan order.
  "TRUST_SIGNED_IN_CAPS", "TRUST_BUILDER_DAILY_USD", "TRUST_AGE_GATE", "TRUST_LEGAL_PAGES", "TRUST_GEO_BLOCK", "TRUST_GEO_COUNTRIES", "TRUST_REPORTS", "TRUST_SPARK_TO_WONDER",
  "ENGINE_CHECK_ON_TIMEOUT", "ENGINE_ROUND_SCALING", "ENGINE_MILESTONES", "ENGINE_LIVE_SMOKE", "ENGINE_EXACT_LOGIC", "ENGINE_FIT_OUTPUT",
  "DATA_SIGN_IN", "DATA_PRODUCT_ROWS", "DATA_PRODUCT_MB", "DATA_DAILY_WRITES",
  "FILES_SEARCH", "FILES_DATASETS", "FILES_PRODUCT_MB", "FILES_MAX_FILE_MB", "FILES_BLOB_STORE_ID",
  "CONNECT_MORE_TOOLS", "CONNECT_VAULT", "CONNECT_VAULT_KEY", "CONNECT_SENDS", "CONNECT_SENDS_PRODUCTION",
  "JOBS_WEBHOOKS", "JOBS_DAILY_RUNS", "JOBS_DAILY_USD", "JOBS_RUN_USD", "JOBS_PAUSE_DAYS",
  ...CAP_IDS.map((id) => CAP_FLAG[id]),
  "LIVE_UPDATES", "LIVE_CAPTION_MINUTES",
  "MEDIA_SPEECH", "MEDIA_VIDEO", "MEDIA_MUSIC", "MEDIA_SAM_TILING",
  "CODE_EXEC", "CODE_EXEC_VISITORS", "CODE_EXEC_DAILY_USD", "CODE_EXEC_SNAPSHOT_ID", "CODE_BROWSE", "CODE_BROWSE_DAILY_USD", "MUSE_CODE_ENABLED", "MUSE_CODE_VISITORS",
  "RUNTIME_OUTPUTS",
  "GPU_GLIMMER_SHARED", "GPU_GLIMMER_DAILY_USD", "GPU_GLIMMER_ALL_PRODUCTS", "GPU_TRAIN_ON_DATA",
  "FLEET_PRODUCTS", "FLEET_ALL_PRODUCTS",
  "SPARK_OPEN_PRODUCTS", "SPARK_OPEN_PROVIDER",
  "DRIVE_EXPORT_ENABLED", "DRIVE_EXPORT_PRODUCTS",
  "HARDWARE_ENABLED", "HARDWARE_BOARD_TOOLS", "HARDWARE_BOARD_REGISTRY", "HARDWARE_BOARD_KEY", "HARDWARE_GADGET_OWNER_CHECK",
];

beforeEach(() => {
  for (const flag of FLAGS) delete process.env[flag];
});

describe("with every target flag off", () => {
  it("every prompt and schema is what it was before targets existed", () => {
    const surface = flagsOffSurface();
    assert.equal(Object.keys(surface).length, 11);
    for (const [name, text] of Object.entries(surface)) {
      if (process.env.UPDATE_GOLDEN) writeFileSync(join(GOLDEN, name), text);
      assert.equal(text, readFileSync(join(GOLDEN, name), "utf8"), `${name} changed`);
    }
  });

  it("the writer's schema is the same object it always was, with or without gadgets", () => {
    assert.deepEqual(env.enabledTargets, []);
    assert.equal(newBriefSchemaFor({ gadgets: true, targets: env.enabledTargets }), NewBriefSchema);
    assert.equal(newBriefSchemaFor({ gadgets: false, targets: env.enabledTargets }), NewBriefSchemaNoGadget);
    // Web alone is no target to choose from.
    assert.equal(newBriefSchemaFor({ gadgets: true, targets: ["web"] }), NewBriefSchema);
  });

  it("the writer can't send targets: they aren't in its schema, and a stray one is dropped", () => {
    assert.ok(!("targets" in NewBriefSchema.shape));
    assert.ok(!("targets" in NewBriefSchemaNoGadget.shape));
    const parsed = NewBriefSchema.parse({ ...BRIEF, targets: [{ id: "phone", why: "x" }] });
    assert.ok(!("targets" in parsed));
  });

  it("an older stored brief parses to the same thing, with no targets added", () => {
    assert.deepEqual(BriefSchema.parse(BRIEF), BRIEF);
    assert.ok(!("targets" in BriefSchema.parse(BRIEF)));
  });

  it("the stored schema differs from the one the writer used only by the optional targets, agent and askedLook", () => {
    const stored = strictJsonSchema(BriefSchema) as { properties: Record<string, unknown>; required: string[] };
    const written = strictJsonSchema(NewBriefSchema) as { properties: Record<string, unknown>; required: string[] };
    // Wave 3's optional fields, in the stored schema's order (wave3StoredFields): each cap's block, then unit 2's milestones.
    const differsOnlyBy = ["targets", "agent", "askedLook", "recipes", ...Object.keys(CAP_BRIEF_FIELDS), "milestones", "requirements", "chained", "fast", "scopeCheck", "direction"];
    assert.deepEqual(Object.keys(stored.properties).filter((k) => !(k in written.properties)), differsOnlyBy);
    assert.deepEqual(Object.keys(written.properties).filter((k) => !(k in stored.properties)), []);
  });
});

describe("newBriefSchemaFor with targets on", () => {
  const brief = (targets: unknown) => ({ ...BRIEF, targets });

  it("requires targets, and only web and the enabled ones", () => {
    const schema = newBriefSchemaFor({ gadgets: false, targets: ["phone", "vr"] });
    assert.equal(schema.safeParse(BRIEF).success, false, "targets is required");
    assert.equal(schema.safeParse(brief([{ id: "web", why: "Always" }, { id: "phone", why: "On the go" }])).success, true);
    assert.equal(schema.safeParse(brief([{ id: "desktop", why: "Not on" }])).success, false);
    assert.equal(schema.safeParse(brief([])).success, false, "at least web");
    assert.equal(schema.safeParse(brief([{ id: "phone", why: "" }])).success, false, "a why each");
    assert.equal(schema.safeParse(brief([{ id: "phone", why: "x".repeat(201) }])).success, false);
  });

  it("keeps the gadget choice as the flag says", () => {
    const capability = [{ need: "see", model: "muse-gadget", why: "a board" }];
    const targets = [{ id: "web", why: "Always" }];
    assert.equal(newBriefSchemaFor({ gadgets: true, targets: ["phone"] }).safeParse({ ...BRIEF, capabilities: capability, targets }).success, true);
    assert.equal(newBriefSchemaFor({ gadgets: false, targets: ["phone"] }).safeParse({ ...BRIEF, capabilities: capability, targets }).success, false);
  });

  it("makes a schema Meta's strict output accepts: every property required, the enum limited", () => {
    const strict = strictJsonSchema(newBriefSchemaFor({ gadgets: false, targets: ["agent"] })) as { required: string[]; properties: { targets: { items: { properties: { id: { enum: string[] } } } } } };
    assert.ok(strict.required.includes("targets"));
    assert.deepEqual(strict.properties.targets.items.properties.id.enum, ["web", "agent"]);
  });

  it("the stored schema takes every target, and refuses others", () => {
    assert.deepEqual([...TARGETS], ["web", "phone", "desktop", "vr", "glasses", "agent", "edge"]);
    assert.equal(BriefSchema.safeParse(brief(TARGETS.map((id) => ({ id, why: "y" })))).success, true);
    assert.equal(BriefSchema.safeParse(brief([{ id: "toaster", why: "y" }])).success, false);
    assert.ok(z.toJSONSchema(BriefSchema));
  });
});
