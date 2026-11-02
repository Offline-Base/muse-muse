/**
 * The edge target (docs/EDGE_DEMO.md), behind EDGE_ENABLED and EDGE_BUILDS: offered to the writer, settled by
 * applyTargets with its limits, written into the build prompt and the judge's instructions. With the flags off nothing
 * names it; the golden files in flags-off.test.ts and targets.test.ts hold that byte for byte.
 *
 *   npx tsx --test lib/brief/__tests__/edge-target.test.ts
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { renderBuildPrompt } from "@/lib/brief/render";
import { newBriefSchemaFor, NewBriefSchemaNoGadget, type Brief } from "@/lib/brief/schema";
import { strictJsonSchema } from "@/lib/brief/strict-schema";
import { env } from "@/lib/env";
import { applyTargets, TARGET_GUIDE, TARGET_LIMITS } from "@/lib/native/targets";
import { briefInstructions } from "@/lib/prompts/brief";
import { EDGE_JUDGE_NOTE, JUDGE_INSTRUCTIONS, judgeInstructions } from "@/lib/prompts/judge";
import { BRIEF } from "@/lib/promote/__tests__/fixtures";

const FLAGS = ["EDGE_ENABLED", "EDGE_BUILDS", "NATIVE_TARGETS", "VR_ENABLED", "GLASSES_ENABLED", "AGENTS_ENABLED"];
const RENDER = { inspoFiles: [], fixtures: [], maxModelSteps: 40 };
const edgeBrief = (): Brief => ({ ...BRIEF, targets: [{ id: "web", why: "Always" }, { id: "edge", why: "Keep answering when the cloud is cut." }] });
const on = () => {
  process.env.EDGE_ENABLED = "1";
  process.env.EDGE_BUILDS = "1";
};

beforeEach(() => {
  for (const f of FLAGS) delete process.env[f];
});
afterEach(() => {
  for (const f of FLAGS) delete process.env[f];
});

describe("the edge target", () => {
  it("is offered only with EDGE_ENABLED and EDGE_BUILDS both on", () => {
    assert.deepEqual(env.enabledTargets, []);
    process.env.EDGE_ENABLED = "1";
    assert.deepEqual(env.enabledTargets, [], "EDGE_ENABLED alone");
    process.env.EDGE_BUILDS = "1";
    assert.deepEqual(env.enabledTargets, ["edge"]);
    process.env.AGENTS_ENABLED = "1";
    assert.deepEqual(env.enabledTargets, ["agent", "edge"]);
  });

  it("leaves the writer's schema and instructions as they were while off", () => {
    assert.equal(newBriefSchemaFor({ gadgets: false, targets: env.enabledTargets }), NewBriefSchemaNoGadget);
    assert.ok(!briefInstructions().includes("edge"));
    process.env.EDGE_BUILDS = "1";
    assert.ok(!briefInstructions().includes("edge:"), "EDGE_BUILDS alone offers no target");
  });

  it("is a choice in the writer's schema and instructions once on", () => {
    on();
    const strict = strictJsonSchema(newBriefSchemaFor({ gadgets: false, targets: env.enabledTargets })) as { required: string[]; properties: { targets: { items: { properties: { id: { enum: string[] } } } } } };
    assert.ok(strict.required.includes("targets"));
    assert.deepEqual(strict.properties.targets.items.properties.id.enum, ["web", "edge"]);
    const text = briefInstructions();
    assert.ok(text.includes(`- edge: ${TARGET_GUIDE.edge}`));
    for (const l of TARGET_LIMITS.edge!) assert.ok(text.includes(l.text));
  });

  it("brings its limits through applyTargets, once each", () => {
    on();
    const out = applyTargets(edgeBrief(), { enabled: env.enabledTargets });
    assert.deepEqual(out.targets?.map((t) => t.id), ["web", "edge"]);
    for (const l of TARGET_LIMITS.edge!) assert.equal(out.limits.filter((x) => x === l.text).length, 1);
    const again = applyTargets(out, { enabled: env.enabledTargets });
    assert.equal(again.limits.length, out.limits.length);
    assert.deepEqual(applyTargets(edgeBrief(), { enabled: [] }), edgeBrief(), "nothing enabled, nothing changes");
    assert.deepEqual(applyTargets(edgeBrief(), { enabled: ["agent"] }).targets?.map((t) => t.id), ["web"], "edge off, edge dropped");
  });

  it("tells the build about the skill, the label and the drill", () => {
    const prompt = renderBuildPrompt(edgeBrief(), RENDER);
    assert.match(prompt, /### Edge\n\nKeep answering when the cloud is cut\. Skill: `\.agents\/skills\/muse-edge`\./);
    assert.match(prompt, /respondJsonOrEdge/);
    assert.match(prompt, /edge-drill\.json/);
    assert.ok(!renderBuildPrompt(BRIEF, RENDER).includes("muse-edge"));
  });

  it("gives the judge one line about labeled answers, only for an edge product", () => {
    assert.equal(judgeInstructions({ ...BRIEF, targets: undefined }), JUDGE_INSTRUCTIONS);
    assert.equal(judgeInstructions(edgeBrief()), `${JUDGE_INSTRUCTIONS}\n\n${EDGE_JUDGE_NOTE}`);
  });

  it("says nothing a person reads that the messaging rules rule out", () => {
    const copy = [TARGET_GUIDE.edge, ...TARGET_LIMITS.edge!.map((l) => l.text), EDGE_JUDGE_NOTE, renderBuildPrompt(edgeBrief(), RENDER)].join("\n");
    assert.ok(!copy.includes("\u2014"), "no em dashes");
    assert.ok(!/attack-proof|stops hacks|food.safe/i.test(copy));
    // "works offline", "private" and "on-device" appear only as what never to say.
    for (const m of copy.matchAll(/works offline|private|on-device/gi)) {
      const line = copy.slice(copy.lastIndexOf("\n", m.index) + 1, copy.indexOf("\n", m.index) === -1 ? undefined : copy.indexOf("\n", m.index));
      assert.match(line, /never|fail it when/i, line);
    }
  });
});
