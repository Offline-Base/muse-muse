/**
 * Target requirements proven by the target, not a web stand-in (target audit, Nov 3, issues 2, 4 and 10). The audit's own
 * requirement lines are the cases: a desktop shell passed on a web header, an edge backup passed on a cloud answer, and a
 * glasses voice question passed with the recording thrown away.
 * npx tsx --experimental-test-module-mocks --test lib/full/__tests__/target-checks.test.ts. Fakes only: no model call.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { briefToMarkdown, renderBuildPrompt } from "@/lib/brief/render";
import type { Brief } from "@/lib/brief/schema";
import { fullJudgeNote } from "@/lib/full/prompts";
import { requirementResults, type Requirement, unmetLines } from "@/lib/full/requirements";
import {
  judgeReadRequirements,
  NO_TARGET_FACTS,
  targetCheckOf,
  targetCheckResults,
  targetCheckVerdict,
  targetFactsFrom,
  TRANSCRIBE_MODEL,
} from "@/lib/full/target-checks";
import { judgeContent, withRequirements } from "@/lib/judge";
import { applyTargets, EDGE_SAM_LIMITS, takesVoiceQuestion } from "@/lib/native/targets";
import { EDGE_JUDGE_NOTE, GLASSES_JUDGE_NOTE, JUDGE_INSTRUCTIONS, judgeInstructions } from "@/lib/prompts/judge";
import { BRIEF } from "@/lib/promote/__tests__/fixtures";

const req = (n: number, text: string): Requirement => ({ id: `R${n}`, text, kind: "needed", words: "", savesData: false, canDo: true, cantDoWhy: null });
const withTargets = (ids: string[], requirements: Requirement[], over: Partial<Brief> = {}): Brief =>
  ({ ...BRIEF, targets: ["web", ...ids].map((id) => ({ id, why: "Picked" })), requirements, ...over }) as Brief;
const passed = (ids: string[]) => ids.map((id) => ({ id, ok: true }));
const PASS = { pass: true, blocking: false, reasons: ["ok"], mismatches: [] as string[] };
const drillSteps = (ids: number[], ok = true) => ids.map((id) => ({ name: `Simulated outage drill ${id}: drill ${id}`, ok }));

// The audit's requirement lines, word for word.
const DESKTOP_SHELL = "Provide a desktop app shell for a made-up bakery with its own invented name and products.";
const PHONE_LAYOUT = "Phone-first layout with bottom add bar and navigation between list, scan, and shopping screens.";
const GLASSES_HELPER = "Product works as a Meta glasses helper through the Muse Muse iPhone app, with glasses taking the photo and hearing the question and the phone showing the result";
const GLASSES_READ = "Product reads the sign and speaks what is in season there today with prices in 1 to 3 short sentences, plus a phone card with the full list.";
const GLASSES_VOICE = "Answer is hands free: one short voice question in, one short spoken answer out, with big touch targets and browser speech playback.";
const GLASSES_FALLBACK = "Phone fallback works without glasses using the phone camera or a sample stall photo, with a clear message about how to connect glasses.";
const EDGE_BACKUP = "Keep working on the office board when the cloud is down with a short labeled backup answer.";
const EDGE_DOOR = "Check a photo of the door to say if it was left open, with outline on the photo.";
const EDGE_LABEL = "Show cloud or edge label on every status and show notice that Meta may train on model inputs.";
const VR_HALL = "VR gallery hall for Quest that opens from the web and runs as a small walkable room.";
const VR_NAV = "Move between Welcome, Lantern Hall, Story Panel and Guest Wall with clear enter, back and close controls on web and in VR.";

describe("which requirements only a target can prove", () => {
  it("picks the audit's target lines and leaves web screens to the judge", () => {
    assert.equal(targetCheckOf(DESKTOP_SHELL, ["web", "desktop"]), "native");
    assert.equal(targetCheckOf(PHONE_LAYOUT, ["web", "phone"]), null);
    assert.equal(targetCheckOf(GLASSES_VOICE, ["web", "glasses"]), "voice");
    assert.equal(targetCheckOf(GLASSES_HELPER, ["web", "glasses"]), "voice");
    assert.equal(targetCheckOf(GLASSES_READ, ["web", "glasses"]), null, "a spoken answer out is on the phone's screen too");
    assert.equal(targetCheckOf(GLASSES_FALLBACK, ["web", "glasses"]), null, "the phone fallback is a web screen");
    assert.equal(targetCheckOf("Take the photo with the Meta glasses.", ["web", "glasses"]), "glasses");
    assert.equal(targetCheckOf(EDGE_BACKUP, ["web", "edge"]), "board");
    assert.equal(targetCheckOf(EDGE_DOOR, ["web", "edge"]), null);
    assert.equal(targetCheckOf(EDGE_LABEL, ["web", "edge"]), null);
    assert.equal(targetCheckOf(VR_HALL, ["web", "vr"]), "headset");
    assert.equal(targetCheckOf(VR_NAV, ["web", "vr"]), null);
    assert.equal(targetCheckOf("Send a request to the server.", ["web", "vr"]), null, "request is not Quest");
  });

  it("counts only the brief's own targets", () => {
    assert.equal(targetCheckOf(DESKTOP_SHELL, ["web"]), null);
    assert.equal(targetCheckOf(EDGE_BACKUP, ["web", "phone"]), null);
    assert.equal(targetCheckOf(GLASSES_VOICE, ["web", "agent"]), null);
  });

  it("keeps them out of what the judge reads", () => {
    const brief = withTargets(["desktop"], [req(1, DESKTOP_SHELL), req(2, "Show the weekly summary.")]);
    assert.deepEqual(judgeReadRequirements(brief).map((r) => r.id), ["R2"]);
    assert.deepEqual(judgeReadRequirements({ ...BRIEF, requirements: [req(1, DESKTOP_SHELL)] } as Brief).map((r) => r.id), ["R1"], "a web brief has no target to prove it");
  });
});

describe("the verdict on a target requirement", () => {
  it("never reads Works from the judge for an app package", () => {
    const brief = withTargets(["desktop"], [req(1, DESKTOP_SHELL), req(2, "Show the weekly summary.")]);
    const reads = [{ id: "R1", met: true, evidence: "A desktop header shows." }, { id: "R2", met: true, evidence: "seen" }];
    const v = withRequirements(PASS, brief, passed(["R1", "R2"]), reads);
    assert.equal(v.requirements![0]!.state, "unchecked");
    assert.match(v.requirements![0]!.detail!, /^Not proven in this build: phone and desktop packaging isn't set up here/);
    assert.equal(v.requirements![1]!.state, "met");
    assert.equal(v.pass, true, "a package nobody could make doesn't fail a good product");
    const ready = targetCheckVerdict(req(1, DESKTOP_SHELL), "native", { ...NO_TARGET_FACTS, packagerReady: true });
    assert.equal(ready.state, "unchecked");
    assert.match(ready.detail!, /made after the product goes live/);
  });

  it("a failed test still fails it", () => {
    const brief = withTargets(["desktop"], [req(1, DESKTOP_SHELL)]);
    const v = withRequirements(PASS, brief, [{ id: "R1", ok: false, detail: "broke" }], []);
    assert.equal(v.requirements![0]!.state, "unmet");
    assert.equal(v.pass, false);
  });

  it("a board backup needs the drills, and a cloud answer counts for nothing", () => {
    const brief = withTargets(["edge"], [req(1, EDGE_BACKUP)]);
    const cloud = [{ id: "R1", met: true, evidence: "Answered in the cloud, Muse Wonder." }];
    const none = withRequirements(PASS, brief, passed(["R1"]), cloud);
    assert.equal(none.requirements![0]!.state, "unchecked");
    assert.match(none.requirements![0]!.detail!, /An answer from the cloud doesn't count/);
    const facts = targetFactsFrom({ steps: [{ name: "smoke", ok: true }, ...drillSteps([1, 2, 3, 4])] });
    const drilled = withRequirements(PASS, brief, passed(["R1"]), cloud, facts);
    assert.equal(drilled.requirements![0]!.state, "met");
    assert.match(drilled.requirements![0]!.detail!, /simulated outage drills passed.*No real board was tried/);
    const failed = targetFactsFrom({ steps: [...drillSteps([1, 2]), ...drillSteps([3], false)] });
    assert.equal(targetCheckVerdict(req(1, EDGE_BACKUP), "board", failed).state, "unmet");
  });

  it("a board look at a photo needs the photo drills", () => {
    const look = req(1, "Check the door photo on the board when the cloud is down.");
    assert.equal(targetCheckOf(look.text, ["web", "edge"]), "board");
    assert.equal(targetCheckVerdict(look, "board", targetFactsFrom({ steps: drillSteps([1, 2, 3, 4]) })).state, "unchecked");
    const both = targetFactsFrom({ steps: drillSteps([1, 2, 3, 4, 12, 13, 14, 15]) });
    assert.equal(targetCheckVerdict(look, "board", both).state, "met");
    assert.match(targetCheckVerdict(look, "board", both).detail!, /Meta SAM 3\.1 on a simulated board/);
    // Plural photos count as a look; a door alone doesn't (a door sensor reading is the main answer).
    const photos = req(2, "Keep checking door photos on the board when the cloud is down.");
    assert.equal(targetCheckVerdict(photos, "board", both).detail, targetCheckVerdict(look, "board", both).detail);
    const sensor = req(3, "Keep showing the door sensor status on the board when the cloud is down.");
    assert.equal(targetCheckVerdict(sensor, "board", targetFactsFrom({ steps: drillSteps([1, 2, 3, 4]) })).state, "met");
  });

  it("a voice question needs the gateway's record of Muse Voice Transcribe", () => {
    const r = req(5, GLASSES_VOICE);
    const unknown = targetCheckVerdict(r, "voice", NO_TARGET_FACTS);
    assert.equal(unknown.state, "unchecked", "a local run's record says nothing");
    const thrownAway = targetCheckVerdict(r, "voice", { ...NO_TARGET_FACTS, modelsCalled: ["muse-wonder-1.0"], transcribeListed: true });
    assert.equal(thrownAway.state, "unmet");
    assert.match(thrownAway.detail!, /Never drop the recording for a typed question/);
    assert.ok(!/^not proven/i.test(thrownAway.detail!), "its own fix, not the sample one");
    assert.ok(!/glasses/i.test(thrownAway.detail!), "the same fix reads right for a VR product");
    assert.equal(targetCheckVerdict(r, "voice", { ...NO_TARGET_FACTS, modelsCalled: ["muse-wonder-1.0"] }).state, "unchecked", "not listed, so the gateway would refuse it");
    assert.equal(targetCheckVerdict(r, "voice", { ...NO_TARGET_FACTS, modelsCalled: [TRANSCRIBE_MODEL] }).state, "met");
    const brief = withTargets(["glasses"], [r]);
    const v = withRequirements(PASS, brief, passed(["R5"]), [], { ...NO_TARGET_FACTS, modelsCalled: [], transcribeListed: true });
    assert.equal(v.pass, false);
    assert.match(unmetLines(v.requirements!)[0]!, /^R5 is not met/);
  });

  it("a headset or glasses session is the smoke test's simulated one, said plainly", () => {
    const smoke = targetFactsFrom({ steps: [{ name: "smoke", ok: true }] });
    assert.match(targetCheckVerdict(req(1, VR_HALL), "headset", smoke).detail!, /simulated Meta Quest 3 session.*No real headset was tried/);
    assert.equal(targetCheckVerdict(req(1, VR_HALL), "headset", NO_TARGET_FACTS).state, "unchecked");
    assert.match(targetCheckVerdict(req(1, "Take the photo with the Meta glasses."), "glasses", smoke).detail!, /simulated glasses.*No real glasses were tried/);
  });

  it("without the map the old verdict holds", () => {
    assert.equal(requirementResults([req(1, DESKTOP_SHELL)], passed(["R1"]), [{ id: "R1", met: true, evidence: "x" }])[0]!.state, "met");
    assert.equal(targetCheckResults({ ...BRIEF, requirements: [req(1, DESKTOP_SHELL)] } as Brief, null).size, 0);
  });
});

describe("the judge's side", () => {
  afterEach(() => {
    delete process.env.EDGE_ENABLED;
    delete process.env.EDGE_BUILDS;
  });

  it("names target requirements apart and asks no read on them", () => {
    const brief = withTargets(["desktop"], [req(1, DESKTOP_SHELL), req(2, "Show the weekly summary.")]);
    const text = judgeInstructions(brief, { fullBuilds: true });
    const [list, apart] = text.split("Checked by code from the target, not by you:");
    assert.ok(apart, "the target ones are named apart");
    assert.ok(!list!.slice(list!.indexOf("Requirements:")).includes(`R1: ${DESKTOP_SHELL}`));
    assert.ok(list!.includes("- R2: Show the weekly summary."));
    assert.ok(apart!.includes(`- R1: ${DESKTOP_SHELL}`));
    assert.match(apart!, /one entry for each id under Requirements/);
    assert.equal(fullJudgeNote([req(1, "x")]).includes("Checked by code"), false, "nothing apart without target ones");
    assert.match(fullJudgeNote([req(1, "x")]), /one entry for each id above/);
  });

  it("shows the judge test results only for what it reads", () => {
    const brief = withTargets(["desktop"], [req(1, DESKTOP_SHELL), req(2, "Show the weekly summary.")]);
    const { content } = judgeContent({ brief, references: [], screenshots: [{ url: "https://x.public.blob.vercel-storage.com/01.png", caption: "Start" }], requirementTests: passed(["R1", "R2"]) });
    const tests = content.find((p) => p.type === "input_text" && p.text.startsWith("What the product's own tests did"));
    assert.ok(tests && tests.type === "input_text");
    assert.ok(!tests.text.includes("R1:"));
    assert.ok(tests.text.includes("R2: its test passed"));
  });

  it("fails a board screen with a cloud answer, and figures the spoken answer gets wrong", () => {
    assert.match(EDGE_JUDGE_NOTE, /An answer labeled in the cloud never shows the board backup working/);
    assert.match(EDGE_JUDGE_NOTE, /titled as the board, a board preview, a backup or offline mode that shows an answer labeled \\?"Answered in the cloud\\?"/);
    assert.match(JUDGE_INSTRUCTIONS, /a spoken answer, summary or recap that gives an item a different price, count or amount than the same screen shows for it/);
    assert.match(GLASSES_JUDGE_NOTE, /a price, count or name in the spoken answer or its list that differs from the read text is a defect/);
  });

  it("marks them in the brief and tells the build how each is checked", () => {
    process.env.EDGE_ENABLED = "1";
    process.env.EDGE_BUILDS = "1";
    const brief = withTargets(["edge"], [req(1, EDGE_BACKUP), req(2, EDGE_DOOR)]);
    const md = briefToMarkdown(brief);
    assert.ok(md.includes(`**R1**: ${EDGE_BACKUP} (checked from the target, not from a screenshot)`));
    assert.ok(md.includes(`**R2**: ${EDGE_DOOR}`));
    assert.ok(!md.includes(`${EDGE_DOOR} (checked`));
    const prompt = renderBuildPrompt(brief, { inspoFiles: [], fixtures: [], maxModelSteps: 40, fullBuild: true });
    assert.match(prompt, /the platform checks them from the target instead[\s\S]*\*\*R1\*\*: the outage drills prove it/);
    assert.match(prompt, /Never put a cloud answer under it\./);
  });

  it("uses no em dashes", () => {
    const brief = withTargets(["desktop", "edge", "glasses", "vr"], [req(1, DESKTOP_SHELL), req(2, EDGE_BACKUP), req(3, GLASSES_VOICE), req(4, VR_HALL)]);
    const details = [...targetCheckResults(brief, NO_TARGET_FACTS).values()].map((v) => v.detail ?? "");
    for (const text of [EDGE_JUDGE_NOTE, GLASSES_JUDGE_NOTE, judgeInstructions(brief, { fullBuilds: true }), ...details, ...EDGE_SAM_LIMITS.map((l) => l.text)]) assert.ok(!text.includes("—"), text.slice(0, 60));
  });
});

describe("applyTargets for glasses and SAM edge briefs", () => {
  const glasses = (over: Partial<Brief> = {}): Brief =>
    ({ ...BRIEF, capabilities: [{ need: "Read the sign", model: "muse-wonder-1.0", why: "It reads" }], targets: [{ id: "web", why: "Always" }, { id: "glasses", why: "Hands free" }], ...over }) as Brief;

  it("gives a glasses brief that takes a voice question Muse Voice Transcribe, once", () => {
    const brief = glasses({ requirements: [req(5, GLASSES_VOICE)] });
    assert.ok(takesVoiceQuestion(brief));
    const out = applyTargets(brief, { enabled: ["glasses"] });
    assert.deepEqual(out.capabilities.map((c) => c.model), ["muse-wonder-1.0", TRANSCRIBE_MODEL]);
    assert.deepEqual(applyTargets(out, { enabled: ["glasses"] }).capabilities, out.capabilities);
  });

  it("leaves one with no question, and every brief without the glasses target, alone", () => {
    const quiet = glasses({ tagline: "Read the sign you look at", primaryFlow: ["Look at a sign", "Hear what it says"], actions: [{ name: "read_sign", description: "Takes a photo, returns the sign's text." }] });
    assert.ok(!takesVoiceQuestion(quiet));
    assert.deepEqual(applyTargets(quiet, { enabled: ["glasses"] }).capabilities.map((c) => c.model), ["muse-wonder-1.0"]);
    const web = glasses({ targets: [{ id: "web", why: "Always" }], requirements: [req(5, GLASSES_VOICE)] });
    assert.deepEqual(applyTargets(web, { enabled: ["glasses"] }).capabilities.map((c) => c.model), ["muse-wonder-1.0"]);
  });

  it("swaps the writer's contradictory line for the SAM board line on a SAM edge brief", () => {
    // The audit's cold-room limits: its first line said images stop when the cloud is cut, beside a look's board backup.
    const writer = "Only the main status answer has an edge backup. Saved data, files and images go through Muse Muse and stop when the cloud is cut.";
    const brief = { ...BRIEF, targets: [{ id: "web", why: "Always" }, { id: "edge", why: "Keep going" }], limits: [writer, "Photo verdict can miss glare, frost, or a barely open door. Retake in good light."] } as Brief;
    const out = applyTargets(brief, { enabled: ["edge"] });
    assert.ok(!out.limits.includes(writer));
    assert.equal(out.limits[0], EDGE_SAM_LIMITS[0]!.text, "in the writer's line's place");
    assert.ok(out.limits.includes("Photo verdict can miss glare, frost, or a barely open door. Retake in good light."));
    assert.equal(out.limits.filter((l) => l === EDGE_SAM_LIMITS[0]!.text).length, 1);
    assert.deepEqual(applyTargets(out, { enabled: ["edge"] }).limits, out.limits);
    const textOnly = { ...brief, capabilities: [{ need: "Read the log", model: "muse-wonder-1.0", why: "It reads" }] } as Brief;
    assert.ok(applyTargets(textOnly, { enabled: ["edge"] }).limits.includes(writer), "without SAM the writer's line is right and stays");
  });
});
