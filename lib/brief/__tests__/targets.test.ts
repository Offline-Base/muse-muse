/**
 * The targets, wired through the writer, the prompts and the judge. The writer's own calls run with Meta faked, so this
 * shows what the model is really sent, with every flag off (byte for byte the golden files) and on.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/brief/__tests__/targets.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, before, beforeEach, describe, it, mock } from "node:test";
import { briefToMarkdown, renderBuildPrompt, renderRefinePrompt } from "@/lib/brief/render";
import type { Brief } from "@/lib/brief/schema";
import { applyTargets, requestedTargetsFrom } from "@/lib/native/targets";
import { briefInstructions, briefRequestText, rebuildRequestText } from "@/lib/prompts/brief";
import { catalogSummary } from "@/lib/prompts/catalog";
import { JUDGE_INSTRUCTIONS, judgeInstructions } from "@/lib/prompts/judge";
import { BRIEF } from "@/lib/promote/__tests__/fixtures";
import { liveFrameAllow } from "@/lib/product-frame";
import type { RebuildTarget } from "@/lib/types";

const canMock = typeof (mock as { module?: unknown }).module === "function";
const at = (rel: string) => new URL(rel, import.meta.url).href;
const GOLDEN = join(import.meta.dirname, "golden");
const FLAGS = ["NATIVE_TARGETS", "VR_ENABLED", "GLASSES_ENABLED", "AGENTS_ENABLED", "COMPOSIO_PERSONAL_ENABLED", "GADGETS_ENABLED"];
const RENDER = { inspoFiles: [], fixtures: [], maxModelSteps: 40 };
const web = { id: "web" as const, why: "Always" };
const on = (targets: Brief["targets"]): Brief => ({ ...BRIEF, targets });

/** What Meta was sent, and what it answers. */
let sent: Array<{ instructions: string; input: Array<{ content: unknown }>; text: { format: { schema: unknown } } }> = [];
let replies: unknown[] = [];
let writeBrief: typeof import("../write").writeBrief;

beforeEach(() => {
  for (const f of FLAGS) delete process.env[f];
  sent = [];
  replies = [];
});
afterEach(() => {
  for (const f of FLAGS) delete process.env[f];
});

describe("writeBrief", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  before(async () => {
    mock.module(at("../../meta/platform.ts"), {
      namedExports: {
        metaPlatform: () => ({
          responses: {
            create: async (body: (typeof sent)[number]) => {
              sent.push(body);
              return { output_text: JSON.stringify(replies.shift() ?? BRIEF), usage: { input_tokens: 10, output_tokens: 10 } };
            },
          },
        }),
      },
    });
    ({ writeBrief } = await import(at("../write.ts")));
  });

  const requestText = () => JSON.stringify(sent[0]?.input[0]?.content);

  it("with every flag off, sends what it always sent and adds nothing to the brief", async () => {
    const { brief } = await writeBrief({ note: "Count the birds at my feeder.", references: [], requestedTargets: ["phone"] });
    assert.equal(sent[0]?.instructions, readFileSync(join(GOLDEN, "brief-instructions.txt"), "utf8"));
    assert.equal(`${JSON.stringify(sent[0]?.text.format.schema, null, 2)}\n`, readFileSync(join(GOLDEN, "new-brief-no-gadget.schema.json"), "utf8"));
    assert.ok(requestText().includes(JSON.stringify(readFileSync(join(GOLDEN, "brief-request.txt"), "utf8")).slice(1, -1)));
    assert.doesNotMatch(requestText(), /picked/, "a pick with no flag on says nothing");
    assert.ok(!("targets" in brief));
    assert.ok(!("agent" in brief));
  });

  it("with a flag on, asks for targets, limited to web and that flag, and settles the answer", async () => {
    process.env.NATIVE_TARGETS = "phone";
    replies = [on([{ id: "phone", why: "Used on the go" }])];
    const { brief } = await writeBrief({ note: "A habit tracker for my phone.", references: [] });
    const schema = sent[0]?.text.format.schema as { required: string[]; properties: { targets: { items: { properties: { id: { enum: string[] } } } } } };
    assert.ok(schema.required.includes("targets"));
    assert.deepEqual(schema.properties.targets.items.properties.id.enum, ["web", "phone"]);
    assert.match(sent[0]!.instructions, /\nWhere it runs\n/);
    assert.deepEqual(brief.targets?.map((t) => t.id), ["web", "phone"]);
    assert.equal(sent.length, 1);
  });

  it("passes the person's picks on, and they win over the writer's", async () => {
    process.env.NATIVE_TARGETS = "phone,desktop";
    replies = [on([web, { id: "phone", why: "On the go" }])];
    const { brief } = await writeBrief({ note: "A timer.", references: [], requestedTargets: ["web", "desktop"] });
    assert.match(requestText(), /Where the person picked for it to run: web \(Web\), desktop \(Desktop\)\. Use exactly these plus web\./);
    assert.deepEqual(brief.targets?.map((t) => t.id), ["web", "desktop"]);
    assert.equal(brief.targets?.[1]?.why, "You asked for it.");
  });

  it("forgets a pick whose flag went off, and never lets the writer pick one", async () => {
    process.env.NATIVE_TARGETS = "phone";
    replies = [on([web])];
    const { brief } = await writeBrief({ note: "A timer.", references: [], requestedTargets: ["vr"] });
    assert.doesNotMatch(requestText(), /picked/);
    assert.deepEqual(brief.targets?.map((t) => t.id), ["web"]);
  });

  it("spends one repair on an agent target with no agent, and patches it if that fails too", async () => {
    process.env.AGENTS_ENABLED = "1";
    const noAgent = { ...BRIEF, targets: [web, { id: "agent", why: "It looks things up" }], agent: null };
    replies = [noAgent, noAgent];
    const { brief } = await writeBrief({ note: "Research agent.", references: [] });
    assert.equal(sent.length, 2);
    assert.match(JSON.stringify(sent[1]?.input), /agent must be filled in/);
    assert.deepEqual(brief.agent?.tools.map((t) => t.id), ["web_search"]);
  });

  it("a refused brief stays web only", async () => {
    process.env.NATIVE_TARGETS = "phone";
    replies = [{ ...on([web, { id: "phone", why: "x" }]), verdict: "no", refusal: "It clones a real app." }];
    const { brief } = await writeBrief({ note: "Clone an app.", references: [], requestedTargets: ["phone"] });
    assert.deepEqual(brief.targets?.map((t) => t.id), ["web"]);
    assert.deepEqual(brief.limits, BRIEF.limits);
  });
});

describe("the writer's instructions", () => {
  it("say to pick nothing beyond web unless the muse asks", () => {
    process.env.VR_ENABLED = "1";
    assert.match(briefInstructions(), /Most muses are web only: add another only when the muse asks for it/);
    assert.match(briefInstructions(), /- web: the web product/);
    assert.match(briefInstructions(), /- vr: a VR app for Meta Quest/);
  });

  it("name only the targets that are on", () => {
    process.env.GLASSES_ENABLED = "1";
    const text = briefInstructions();
    assert.match(text, /- glasses: works with the wearer's Meta AI glasses/);
    assert.match(text, /For glasses, primaryFlow starts with connecting the glasses/);
    assert.doesNotMatch(text, /- vr: |- phone: |- desktop: |For vr, /);
    delete process.env.GLASSES_ENABLED;
    process.env.VR_ENABLED = "1";
    assert.match(briefInstructions(), /For vr, primaryFlow includes the step that enters VR\./);
    assert.doesNotMatch(briefInstructions(), /- glasses: /);
  });

  it("leave the catalog alone for targets other than agent, so its cache has one entry for them", () => {
    const off = catalogSummary();
    process.env.NATIVE_TARGETS = "phone,desktop";
    process.env.VR_ENABLED = "1";
    process.env.GLASSES_ENABLED = "1";
    assert.equal(catalogSummary(), off);
  });

  it("add a request line only when something was picked", () => {
    assert.equal(briefRequestText("x", []), briefRequestText("x", [], []));
    assert.equal(briefRequestText("x", []), briefRequestText("x", [], null));
    assert.match(briefRequestText("x", [], ["phone"]), /\nWhere the person picked for it to run: phone \(Phone\)\./);
    const target = { title: "t", url: "u", era: "e", demonstrates: "d", rebuild: { fit: "clean", plan: "p", models: [], note: "n" } } as unknown as RebuildTarget;
    assert.equal(rebuildRequestText(target, null), rebuildRequestText(target, null, []));
    assert.match(rebuildRequestText(target, null, ["vr"]), /\nWhere the person picked for it to run: vr \(VR\)\./);
  });
});

describe("requestedTargetsFrom", () => {
  it("ignores targets with every flag off, as any stray field is", () => {
    assert.deepEqual(requestedTargetsFrom(["phone"], []), { ok: true, value: [] });
    assert.deepEqual(requestedTargetsFrom("garbage", []), { ok: true, value: [] });
  });

  it("refuses a target whose flag is off once any flag is on", () => {
    assert.equal(requestedTargetsFrom(["vr"], ["phone"]).ok, false);
    assert.deepEqual(requestedTargetsFrom(["phone", "web"], ["phone"]), { ok: true, value: ["web", "phone"] });
    assert.deepEqual(requestedTargetsFrom(undefined, ["phone"]), { ok: true, value: [] });
  });
});

describe("limits a target brings", () => {
  it("adds VR's and glasses' when the writer left them out, once", () => {
    const vr = applyTargets(on([web, { id: "vr", why: "A space" }]), { enabled: ["vr"] });
    assert.ok(vr.limits.includes("Made for Meta Quest in Quest Browser. On a computer it runs in a simulated headset."));
    assert.equal(applyTargets(vr, { enabled: ["vr"] }).limits.length, vr.limits.length);
    const glasses = applyTargets(on([web, { id: "glasses", why: "Hands free" }]), { enabled: ["glasses"] });
    assert.ok(glasses.limits.includes("Needs the Muse Muse iPhone app and Meta glasses. Without them it uses your phone's camera."));
    assert.ok(glasses.limits.includes("Start it on your phone. The glasses can't open it."));
  });

  it("adds none for web or a target that was dropped", () => {
    const out = applyTargets(on([web, { id: "vr", why: "A space" }]), { enabled: ["phone"] });
    assert.deepEqual(out.limits, BRIEF.limits);
  });
});

describe("the build prompt's Where it runs", () => {
  it("isn't there for a brief with no targets or only web", () => {
    const plain = renderBuildPrompt(BRIEF, RENDER);
    assert.doesNotMatch(plain, /Where it runs/);
    assert.equal(renderBuildPrompt(on([web]), RENDER), plain);
    assert.equal(briefToMarkdown(on([web])), briefToMarkdown(BRIEF));
  });

  it("gives phone its size, insets, bridge and skill", () => {
    const prompt = renderBuildPrompt(on([web, { id: "phone", why: "used on the go" }]), RENDER);
    assert.ok(prompt.indexOf("## Product") < prompt.indexOf("## Where it runs"));
    assert.ok(prompt.indexOf("## Where it runs") < prompt.indexOf("## Primary flow"));
    assert.match(prompt, /### Phone\n\nUsed on the go\. Skill: `\.agents\/skills\/muse-native`\./);
    for (const part of [/390x844/, /safe-area insets/, /at least 44 px/, /`lib\/native\/bridge\.ts`/, /`preview_devices` and `native_run`/]) assert.match(prompt, part);
  });

  it("gives desktop, VR and glasses their own skill and rules", () => {
    const prompt = renderBuildPrompt(on([web, { id: "desktop", why: "at a desk" }, { id: "vr", why: "a room" }, { id: "glasses", why: "hands free" }]), RENDER);
    assert.match(prompt, /### Desktop[\s\S]*muse-native[\s\S]*### VR[\s\S]*muse-vr[\s\S]*### Glasses[\s\S]*muse-glasses/);
    assert.match(prompt, /`xr\.enter\(page\)` from `tests\/xr\.ts`/);
    assert.match(prompt, /at most 100 draw calls/);
    assert.match(prompt, /`tests\/glasses\.ts`/);
    assert.doesNotMatch(prompt, /—/);
  });

  it("isn't there for a refused brief", () => {
    const prompt = renderBuildPrompt({ ...on([web, { id: "phone", why: "x" }]), verdict: "no", refusal: "No." }, RENDER);
    assert.doesNotMatch(prompt, /Where it runs/);
  });

  it("shows on the brief's page with each why", () => {
    const md = briefToMarkdown(on([web, { id: "phone", why: "Used on the go" }]));
    assert.match(md, /## Where it runs\n\n- \*\*Web\*\*: Always\n- \*\*Phone\*\*: Used on the go\n/);
  });

  it("tells a change to keep the product working where it runs, and says nothing for web only", () => {
    const plain = renderRefinePrompt({ message: "Add a dark theme.", newReferences: [] });
    assert.equal(renderRefinePrompt({ message: "Add a dark theme.", newReferences: [], brief: on([web]) }), plain);
    assert.equal(renderRefinePrompt({ message: "Add a dark theme.", newReferences: [], brief: null }), plain);
    const phone = renderRefinePrompt({ message: "Add a dark theme.", newReferences: [], brief: on([web, { id: "phone", why: "x" }, { id: "desktop", why: "y" }]) });
    assert.match(phone, /- This product also runs on: Phone, Desktop\. Keep it working there, and follow `\.agents\/skills\/muse-native`\./);
  });
});

describe("the judge", () => {
  it("is the same text for a web product, phone or desktop", () => {
    assert.equal(judgeInstructions(BRIEF), JUDGE_INSTRUCTIONS);
    assert.equal(judgeInstructions(on([web, { id: "phone", why: "x" }, { id: "desktop", why: "y" }])), JUDGE_INSTRUCTIONS);
  });

  it("holds an agent to an answer with links, finished steps and no raw tool output", () => {
    const text = judgeInstructions(on([web, { id: "agent", why: "x" }]));
    assert.ok(text.startsWith(JUDGE_INSTRUCTIONS));
    assert.match(text, /doesn't show the answer with source links/);
    assert.match(text, /example\.com are expected/);
    assert.match(text, /still running or waiting/);
    assert.match(text, /raw tool JSON/);
    assert.match(text, /connect an account is fine on the start screen, but not on the final screen/);
  });

  it("knows VR is emulated and glasses are simulated", () => {
    assert.match(judgeInstructions(on([web, { id: "vr", why: "x" }])), /simulated Meta Quest 3 view drawn without a graphics card[\s\S]*blank, black or one color/);
    assert.match(judgeInstructions(on([web, { id: "glasses", why: "x" }])), /a sample photo under 'What your glasses saw' is the product working/);
    assert.doesNotMatch(judgeInstructions(on([web, { id: "vr", why: "x" }])), /glasses were simulated/);
  });
});

describe("the product page's iframe", () => {
  it("reads the targets as a stored brief has them", () => {
    assert.match(liveFrameAllow(applyTargets(on([{ id: "glasses", why: "Hands free" }]), { enabled: ["glasses"] })), /camera; microphone/);
    assert.doesNotMatch(liveFrameAllow(applyTargets(on([{ id: "phone", why: "x" }]), { enabled: ["phone"] })), /camera/);
  });
});
