/**
 * The edge target (docs/EDGE_DEMO.md), behind EDGE_ENABLED and EDGE_BUILDS: offered to the writer, settled by
 * applyTargets with its limits, written into the build prompt and the judge's instructions. With the flags off nothing
 * names it; the golden files in flags-off.test.ts and targets.test.ts hold that byte for byte.
 *
 *   npx tsx --test lib/brief/__tests__/edge-target.test.ts
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { briefToMarkdown, renderBuildPrompt, renderRefinePrompt } from "@/lib/brief/render";
import { newBriefSchemaFor, NewBriefSchemaNoGadget, type Brief } from "@/lib/brief/schema";
import { strictJsonSchema } from "@/lib/brief/strict-schema";
import { env } from "@/lib/env";
import { applyTargets, EDGE_SAM_LIMITS, TARGET_GUIDE, TARGET_LIMITS } from "@/lib/native/targets";
import { briefInstructions } from "@/lib/prompts/brief";
import { EDGE_BOARD_STATUS_JUDGE_NOTE } from "@/lib/edge/judge";
import { EDGE_JUDGE_NOTE, JUDGE_INSTRUCTIONS, judgeInstructions } from "@/lib/prompts/judge";
import { BRIEF } from "@/lib/promote/__tests__/fixtures";

const FLAGS = ["EDGE_ENABLED", "EDGE_BUILDS", "NATIVE_TARGETS", "VR_ENABLED", "GLASSES_ENABLED", "AGENTS_ENABLED"];
const RENDER = { inspoFiles: [], fixtures: [], maxModelSteps: 40 };
/** BRIEF counts birds with SAM 3.1, so this edge brief looks at photos. */
const edgeBrief = (): Brief => ({ ...BRIEF, targets: [{ id: "web", why: "Always" }, { id: "edge", why: "Keep answering when the cloud is cut." }] });
/** The same edge brief answering in text with Muse Wonder, no SAM. */
const textEdgeBrief = (): Brief => ({ ...edgeBrief(), capabilities: [{ need: "Read the log", model: "muse-wonder-1.0", why: "It reads text" }] });
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
    const out = applyTargets(textEdgeBrief(), { enabled: env.enabledTargets });
    assert.deepEqual(out.targets?.map((t) => t.id), ["web", "edge"]);
    for (const l of TARGET_LIMITS.edge!) assert.equal(out.limits.filter((x) => x === l.text).length, 1);
    const again = applyTargets(out, { enabled: env.enabledTargets });
    assert.equal(again.limits.length, out.limits.length);
    const sam = applyTargets(edgeBrief(), { enabled: env.enabledTargets });
    for (const l of EDGE_SAM_LIMITS) assert.equal(sam.limits.filter((x) => x === l.text).length, 1, "a brief that looks says its look has a backup too");
    for (const l of TARGET_LIMITS.edge!) assert.ok(!sam.limits.includes(l.text));
    assert.equal(applyTargets(sam, { enabled: env.enabledTargets }).limits.length, sam.limits.length);
    assert.deepEqual(applyTargets(edgeBrief(), { enabled: [] }), edgeBrief(), "nothing enabled, nothing changes");
    assert.deepEqual(applyTargets(edgeBrief(), { enabled: ["agent"] }).targets?.map((t) => t.id), ["web"], "edge off, edge dropped");
  });

  it("names nothing edge in a stored or imported edge brief's prompts while the flags are off", () => {
    const webOnly = (): Brief => ({ ...BRIEF, targets: [{ id: "web", why: "Always" }] });
    const refine = (brief: Brief) => renderRefinePrompt({ message: "Make the button bigger.", newReferences: [], brief });
    for (const flags of [[], ["EDGE_BUILDS"], ["EDGE_ENABLED"]]) {
      for (const f of FLAGS) delete process.env[f];
      for (const f of flags) process.env[f] = "1";
      const prompt = renderBuildPrompt(edgeBrief(), RENDER);
      assert.ok(!prompt.includes("### Edge") && !/muse-edge|respondJsonOrEdge|edge-drill/.test(prompt), flags.join(","));
      assert.equal(prompt, renderBuildPrompt(webOnly(), RENDER), "the same prompt as the brief without edge");
      assert.equal(refine(edgeBrief()), refine(webOnly()));
      assert.equal(briefToMarkdown(edgeBrief()), briefToMarkdown(webOnly()));
      assert.equal(judgeInstructions(edgeBrief()), JUDGE_INSTRUCTIONS, `judge, ${flags.join(",")}`);
    }
  });

  it("gives a non-edge brief no Edge section with the flags on", () => {
    on();
    const prompt = renderBuildPrompt(BRIEF, RENDER);
    assert.ok(!prompt.includes("### Edge") && !prompt.includes("muse-edge"));
  });

  it("tells the build about the skill, the label and the drill", () => {
    on();
    const prompt = renderBuildPrompt(edgeBrief(), RENDER);
    assert.match(prompt, /### Edge\n\nKeep answering when the cloud is cut\. Skill: `\.agents\/skills\/muse-edge`\./);
    assert.match(prompt, /respondJsonOrEdge/);
    assert.match(prompt, /edge-drill\.json/);
    assert.ok(!renderBuildPrompt(BRIEF, RENDER).includes("muse-edge"));
  });

  it("tells a build that looks at photos to use segmentOrEdge and drill its route, and a text-only build nothing of it", () => {
    on();
    const prompt = renderBuildPrompt(edgeBrief(), RENDER);
    assert.match(prompt, /segmentOrEdge/);
    assert.match(prompt, /EDGE_SAM_URL/);
    assert.match(prompt, /SIMULATED_PHOTO/);
    assert.match(prompt, /four more simulated drills/);
    const text = renderBuildPrompt(textEdgeBrief(), RENDER);
    assert.match(text, /respondJsonOrEdge/);
    assert.ok(!/segmentOrEdge|EDGE_SAM_URL|SIMULATED_PHOTO/.test(text));
    assert.match(TARGET_GUIDE.edge, /SAM 3\.1 runs on the board too: list sam-3\.1/);
    assert.match(EDGE_JUDGE_NOTE, /Seen on <board> by Meta SAM 3\.1/);
  });

  it("gives the judge one line about labeled answers, only for an edge product", () => {
    on();
    assert.equal(judgeInstructions({ ...BRIEF, targets: undefined }), JUDGE_INSTRUCTIONS);
    assert.equal(judgeInstructions(edgeBrief()), `${JUDGE_INSTRUCTIONS}\n\n${EDGE_JUDGE_NOTE}\n\n${EDGE_BOARD_STATUS_JUDGE_NOTE}`);
  });

  it("says nothing a person reads that the messaging rules rule out", () => {
    on();
    const copy = [TARGET_GUIDE.edge, ...TARGET_LIMITS.edge!.map((l) => l.text), ...EDGE_SAM_LIMITS.map((l) => l.text), EDGE_JUDGE_NOTE, EDGE_BOARD_STATUS_JUDGE_NOTE, renderBuildPrompt(edgeBrief(), RENDER), renderBuildPrompt(textEdgeBrief(), RENDER)].join("\n");
    assert.ok(!copy.includes("\u2014"), "no em dashes");
    assert.ok(!/attack-proof|stops hacks|food.safe/i.test(copy));
    // "works offline", "private" and "on-device" appear only as what never to say.
    for (const m of copy.matchAll(/works offline|private|on-device/gi)) {
      const line = copy.slice(copy.lastIndexOf("\n", m.index) + 1, copy.indexOf("\n", m.index) === -1 ? undefined : copy.indexOf("\n", m.index));
      assert.match(line, /never|fail it when/i, line);
    }
  });
});
