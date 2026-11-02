import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, it } from "node:test";
import { goalObjective, renderBuildPrompt, renderFixPrompt } from "@/lib/brief/render";
import { normalizeRawBrief } from "@/lib/brief/normalize";
import type { Brief } from "@/lib/brief/schema";
import { newBriefSchemaFor } from "@/lib/brief/schema";
import { strictJsonSchema } from "@/lib/brief/strict-schema";
import { renderMilestonePrompt } from "@/lib/engine/prompts";
import { env } from "@/lib/env";
import { BRIEF } from "@/lib/promote/__tests__/fixtures";
import { briefInstructions } from "@/lib/prompts/brief";
import { JUDGE_INSTRUCTIONS, judgeInstructions } from "@/lib/prompts/judge";
import { contrast, DIRECTION_STARTS, directionProblems, directionStart, type Direction, isDefaultLook, recentFrom } from "@/lib/range/direction";
import { applyRangeScript, RANGE_OVERLAY, restoreRangeFilesScript } from "@/lib/sandbox/look";

const DIRECTION: Direction = {
  summary: "A printed almanac for bird watchers, warm and dense.",
  scheme: "light",
  palette: { background: "#f4ecd8", surface: "#fbf6e9", text: "#2a2118", mutedText: "#5c4e3c", accent: "#8c2f1b", onAccent: "#ffffff", secondary: "#3e6b57" },
  displayFont: { package: "@fontsource-variable/fraunces", family: "Fraunces Variable" },
  bodyFont: { package: "@fontsource/source-serif-4", family: "Source Serif 4" },
  density: "Tight, like a printed table.",
  layout: "One column on a phone, three panes on a desktop, sections split by rules rather than cards.",
  shape: "Square corners and thin double rules.",
  motion: "Rows fade in one after another.",
  imagery: "Engraving-style drawings made with Muse Image.",
};
const WITH: Brief = { ...BRIEF, direction: DIRECTION };
const OPTS = { inspoFiles: [], fixtures: [], maxModelSteps: 40, museAppLook: true };
const WRITER = { museAppLook: true, range: { start: DIRECTION_STARTS[0], recent: [] } };
const overlay = (f: string) => readFileSync(path.join("template/targets", RANGE_OVERLAY, "files", f), "utf8");

beforeEach(() => {
  delete process.env.BUILD_RANGE;
  delete process.env.MUSE_FULL;
  delete process.env.MUSE_APP_LOOK;
  delete process.env.BUILDS_ON_CONTRIBUTOR;
});

describe("BUILD_RANGE off", () => {
  it("is off by default and turns nothing else on", () => {
    assert.equal(env.buildRange, false);
    assert.equal(env.museFull, false);
    assert.equal(env.museAppLook, false);
  });

  it("a stored brief with a direction changes no prompt byte", () => {
    const { direction: _, ...plain } = WITH;
    assert.equal(renderBuildPrompt(WITH, OPTS), renderBuildPrompt(plain as Brief, OPTS));
    assert.equal(renderBuildPrompt({ ...WITH, complexity: "complex" }, { ...OPTS, playbook: true }), renderBuildPrompt({ ...plain, complexity: "complex" } as Brief, { ...OPTS, playbook: true }));
    assert.equal(judgeInstructions(WITH, { museAppLook: true }), judgeInstructions(plain as Brief, { museAppLook: true }));
    assert.equal(judgeInstructions(WITH), JUDGE_INSTRUCTIONS);
    assert.equal(goalObjective(WITH), goalObjective(plain as Brief));
  });

  it("the writer and its schema have no direction", () => {
    assert.doesNotMatch(briefInstructions({ museAppLook: true }), /direction/i);
    assert.ok(!("direction" in (strictJsonSchema(newBriefSchemaFor({ gadgets: false, targets: [], museAppLook: true })) as { properties: object }).properties));
  });

  it("a flag-off product's restore does nothing: no commit, no copy", () => {
    const script = restoreRangeFilesScript("/x");
    assert.equal(spawnSync("bash", ["-c", script], { cwd: "/tmp", encoding: "utf8" }).stdout, "");
  });
});

describe("BUILD_RANGE on", () => {
  beforeEach(() => {
    process.env.BUILD_RANGE = "1";
  });

  it("brings the look and the agent settings with it", () => {
    assert.equal(env.buildRange, true);
    assert.equal(env.museAppLook, true);
    assert.equal(env.museFull, true);
  });

  it("the writer must pick a direction, and doesn't default to the house look", () => {
    const text = briefInstructions(WRITER);
    assert.match(text, /Design direction\ndirection is this product's own look/);
    assert.match(text, /white page with hairline cards, Inter and one blue is not a default/);
    assert.ok(text.includes(DIRECTION_STARTS[0]));
    assert.doesNotMatch(text, /never as decoration|Every product follows Muse Muse's own app look|Use the fewest models|one to three screens|not hex values/);
    assert.match(text, /askedLook is null unless/);
    assert.match(briefInstructions({ ...WRITER, range: { start: "x", recent: [{ background: "#111111", accent: "#ff0000", displayFamily: "Bebas Neue" }] } }), /Bebas Neue with #ff0000 on #111111/);
  });

  it("the writer's schema requires a direction and takes more screens", () => {
    const schema = newBriefSchemaFor({ gadgets: false, targets: [], museAppLook: true, buildRange: true });
    assert.equal(schema.safeParse({ ...BRIEF, askedLook: null }).success, false);
    const screens = Array.from({ length: 12 }, (_, i) => ({ name: `S${i}`, purpose: "p" }));
    assert.equal(schema.safeParse({ ...BRIEF, askedLook: null, direction: DIRECTION, screens }).success, true);
    assert.equal(schema.safeParse({ ...BRIEF, askedLook: null, direction: DIRECTION, screens: [...screens, { name: "x", purpose: "p" }] }).success, false);
    assert.ok((strictJsonSchema(schema) as { required: string[] }).required.includes("direction"));
    assert.equal((normalizeRawBrief({ ...BRIEF, screens: [...screens, ...screens] }, [], { buildRange: true }) as Brief).screens.length, 12);
  });

  it("the build prompt follows the direction, with depth and no push to simpler", () => {
    const text = renderBuildPrompt(WITH, { ...OPTS, buildRange: true });
    assert.match(text, /## Design direction\n\nA printed almanac/);
    assert.match(text, /accent #8c2f1b/);
    assert.match(text, /`@fontsource-variable\/fraunces`/);
    assert.match(text, /## Depth/);
    assert.match(text, /The inspo's mood may show in colors, fonts/);
    assert.match(text, /really fails three times/);
    assert.doesNotMatch(text, /The look always comes|never as decoration|pick a simpler one and write|if at all|under 5 model calls/);
    assert.match(text, /exact look of a real product/, "never copying stays");
  });

  it("a brief from before the flag keeps its old prompt", () => {
    assert.equal(renderBuildPrompt(BRIEF, { ...OPTS, buildRange: true }), renderBuildPrompt(BRIEF, OPTS));
  });

  it("a refused brief gets no direction, depth or agent lines", () => {
    const text = renderBuildPrompt({ ...WITH, verdict: "no", refusal: "No." }, { ...OPTS, buildRange: true });
    assert.doesNotMatch(text, /Design direction|## Depth|How you must work/);
  });

  it("a complex build must use agents, in every kind of round", () => {
    const text = renderBuildPrompt({ ...WITH, complexity: "complex" }, { ...OPTS, buildRange: true, playbook: true });
    assert.match(text, /## How you must work\n\nThis build is complex, so these steps are required/);
    assert.match(text, /first tool call after reading this file is `subagent_spawn`/);
    assert.match(text, /at least two writer subagents with worktree isolation/);
    assert.match(text, /one `workflow`/);
    assert.match(text, /`read_skill` on `workflow-authoring`/);
    assert.match(text, /cut off at its time limit without warning/);
    assert.match(text, /Stay within the agent capacity|Never run more at once than the agent capacity/);
    assert.match(text, /which subagents and workflows ran/);
    assert.doesNotMatch(text, /work in parallel:|End with a read-only reviewer/, "not said twice as suggestions");
    assert.ok(text.indexOf("How you must work") < text.indexOf("## Product"), "before the product, not buried");

    const milestone = { title: "T", doneMeans: "D" };
    assert.match(renderMilestonePrompt({ index: 2, of: 3, milestone, verify: null, requiredAgents: true }), /these steps are required\. Start with `subagent_spawn`/);
    assert.doesNotMatch(renderMilestonePrompt({ index: 2, of: 3, milestone, verify: null }), /subagent/);

    const fix = renderFixPrompt({ verify: null, judge: null, round: 1, museAppLook: true, buildRange: true });
    assert.match(fix, /subagent with worktree isolation/);
    assert.match(fix, /Keep the Design direction/);
    assert.doesNotMatch(fix, /not with new colors, fonts or styles/);

    const goal = goalObjective(WITH, { requiredAgents: true });
    assert.match(goal, /which subagents and workflows ran/);
    assert.ok(goal.length <= 1000);
  });

  it("a build that isn't complex isn't forced to use agents", () => {
    assert.doesNotMatch(renderBuildPrompt({ ...WITH, complexity: "simple" }, { ...OPTS, buildRange: true, playbook: true }), /How you must work/);
  });

  it("the judge judges craft and fit, and keeps its rules on real products and Meta", () => {
    const text = judgeInstructions(WITH, { museAppLook: true, buildRange: true });
    assert.doesNotMatch(text, /house styles\. One has|flat white cards/);
    assert.match(text, /isn't expected to look like any other Muse Muse product/);
    assert.match(text, /on craft and on fit to this direction/);
    assert.match(text, /plainly ignore the direction/);
    assert.ok(text.includes("- It shows a name, logo, character or artwork taken from the inspiration, or copies a real product's look."));
    assert.ok(text.includes("- The page implies Meta made it, or uses Meta's logos or marks."));
    assert.equal(judgeInstructions(BRIEF, { museAppLook: true, buildRange: true }), judgeInstructions(BRIEF, { museAppLook: true }), "no direction, no change");
  });
});

describe("directionProblems", () => {
  it("passes a good direction", () => {
    assert.deepEqual(directionProblems(DIRECTION), []);
  });

  it("sends back a missing one, bad colors and a font that isn't from fontsource", () => {
    assert.match(directionProblems(null)[0], /required/);
    assert.match(directionProblems({ ...DIRECTION, palette: { ...DIRECTION.palette, accent: "red" } })[0], /#rrggbb/);
    assert.match(directionProblems({ ...DIRECTION, displayFont: { package: "left-pad", family: "x" } })[0], /@fontsource/);
  });

  it("sends back unreadable contrast", () => {
    assert.match(directionProblems({ ...DIRECTION, palette: { ...DIRECTION.palette, text: "#eeeeee" } }).join(), /text on background/);
    assert.ok((contrast("#000000", "#ffffff") ?? 0) > 20);
  });

  it("sends back white and blue, unless the person asked", () => {
    const blue = { ...DIRECTION, palette: { ...DIRECTION.palette, background: "#ffffff", accent: "#0064d4" } };
    assert.ok(isDefaultLook(blue));
    assert.match(directionProblems(blue).join(), /default white page/);
    assert.deepEqual(directionProblems(blue, { asked: "white and blue please" }), []);
    assert.equal(isDefaultLook({ palette: { ...DIRECTION.palette, background: "#ffffff" } }), false);
  });

  it("sends back the same face and accent as a recent product, but not one alone", () => {
    const recent = recentFrom([DIRECTION, "junk", null]);
    assert.equal(recent.length, 1);
    assert.match(directionProblems(DIRECTION, { recent }).join(), /too close/);
    assert.deepEqual(directionProblems({ ...DIRECTION, displayFont: { ...DIRECTION.displayFont, family: "Bebas Neue" } }, { recent }), []);
  });

  it("starting ideas spread over builds and stay put for one", () => {
    const picked = new Set(Array.from({ length: 200 }, (_, i) => directionStart(`build-${i}`)));
    assert.equal(picked.size, DIRECTION_STARTS.length);
    assert.equal(directionStart("a"), directionStart("a"));
  });
});

describe("the build-range overlay", () => {
  it("its final-screen script is the template's with only the two limits wider", () => {
    const base = readFileSync("template/scripts/smoke-report.mjs", "utf8");
    assert.equal(overlay("scripts/smoke-report.mjs").replace("RESULT_TOP_MAX = 2400", "RESULT_TOP_MAX = 1000").replace("PAGE_HEIGHT_MAX = 12000", "PAGE_HEIGHT_MAX = 4000"), base);
  });

  it("its platform files exist and the muse-app overlay is untouched by name", () => {
    const list = JSON.parse(readFileSync(path.join("template/targets", RANGE_OVERLAY, "platform-files.json"), "utf8")) as string[];
    for (const f of list) assert.ok(existsSync(path.join("template/targets", RANGE_OVERLAY, "files", f)), f);
  });

  it("turns the fixed look into overridable defaults", () => {
    const skill = overlay(".agents/skills/muse-app-ui/SKILL.md");
    assert.match(skill, /Design direction in brief\.md decides how this product looks/);
    assert.doesNotMatch(skill, /White and quiet|never a second font|The 720 px column\.|There is no other signature color|A card never gets a shadow|Don't add colors, fonts/);
    assert.match(overlay(".agents/skills/muse-app-ui/reference/screens.md"), /Five starting patterns/);
    const agents = overlay("AGENTS.md");
    assert.doesNotMatch(agents, /add no other fonts|only signature color|never as decoration|fails twice/);
    const ui = overlay(".agents/skills/product-ui/SKILL.md");
    assert.doesNotMatch(ui, /action blue|720 px column|never as decoration/);
  });

  it("keeps what must stay", () => {
    const skill = overlay(".agents/skills/muse-app-ui/SKILL.md");
    for (const keep of [/Keep the footer/, /Never remove focus outlines/, /44 px tall/, /data-result/, /aria-busy/, /WCAG AA/, /No Meta logos/, /real product's screens/]) assert.match(skill, keep);
    const agents = overlay("AGENTS.md");
    for (const keep of [/Keep the footer component/, /exact look of a real product/, /Never call `api\.meta\.ai` directly/, /Never skip, delete or weaken a test/, /next\/font\/google/, /impersonating a real person/]) assert.match(agents, keep);
    assert.match(overlay(".agents/skills/product-ui/SKILL.md"), /Every async action needs four states/);
  });

  it("applies over a product and survives the restores, only in a product that has it", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "range-"));
    const git = (...args: string[]) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: dir, encoding: "utf8" });
    git("init", "-q");
    mkdirSync(path.join(dir, "scripts"));
    writeFileSync(path.join(dir, "scripts/smoke-report.mjs"), "base");
    writeFileSync(path.join(dir, "AGENTS.md"), "base");
    git("add", ".");
    git("commit", "-qm", "base");
    const targets = path.resolve("template/targets");
    const run = (script: string) => spawnSync("bash", ["-c", script], { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" } });

    assert.equal(run(restoreRangeFilesScript(targets)).stdout, "");
    assert.equal(readFileSync(path.join(dir, "scripts/smoke-report.mjs"), "utf8"), "base", "no commit, no restore");

    assert.equal(run(applyRangeScript(targets)).status, 0);
    assert.match(git("log", "--format=%s", "-1").stdout, /Look: build range/);
    assert.match(readFileSync(path.join(dir, "AGENTS.md"), "utf8"), /Design direction/);

    writeFileSync(path.join(dir, "scripts/smoke-report.mjs"), "base");
    assert.equal(run(restoreRangeFilesScript(targets)).status, 0);
    assert.match(readFileSync(path.join(dir, "scripts/smoke-report.mjs"), "utf8"), /RESULT_TOP_MAX = 2400/);
    assert.equal(run(applyRangeScript(targets)).status, 0, "a retry does nothing");
    rmSync(dir, { recursive: true, force: true });
  });

  it("has no em dashes, and its scripts parse", () => {
    for (const f of ["AGENTS.md", ".agents/skills/muse-app-ui/SKILL.md", ".agents/skills/product-ui/SKILL.md", ".agents/skills/muse-app-ui/reference/screens.md"]) assert.doesNotMatch(overlay(f), /—/, f);
    for (const script of [applyRangeScript(), restoreRangeFilesScript()]) assert.equal(spawnSync("bash", ["-n", "-c", script]).status, 0);
  });
});
