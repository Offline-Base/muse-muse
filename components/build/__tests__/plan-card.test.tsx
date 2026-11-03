/**
 * The plan card in the build room's conversation: the Muse mascot for the build's state at the top left, and a short
 * plan beside it (owner, Nov 1), its name, tagline and at most four lines, with every part of the brief folded under it. The steps panel's "Read the brief" still folds the same brief.
 *   npx tsx --test --experimental-test-module-mocks components/build/__tests__/plan-card.test.tsx
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { before, describe, it, mock } from "node:test";
import { createElement, type ComponentType } from "react";
import { FIXTURES, at, brief, inspiration, tokens } from "@/components/build/__tests__/room-fixture";
import type { Brief, BuildEvent, BuildEventBody, BuildStatus } from "@/lib/types";

mock.module("next/navigation", {
  namedExports: { useRouter: () => ({ push() {}, refresh() {} }), usePathname: () => "/b/x" },
});
mock.module("next/link", {
  defaultExport: (props: Record<string, unknown>) => createElement("a", { ...props, href: String(props.href) }),
});

type FixtureName = keyof typeof FIXTURES;

let render: (c: ComponentType<never>, props: object) => string;
let BuildRoom: ComponentType<never>;
let StepList: ComponentType<never>;
let PlanCard: ComponentType<never>;
let plan: typeof import("@/components/build/PlanCard");
let steps: typeof import("@/components/build/steps");
let derive: typeof import("@/components/build/derive");

before(async () => {
  const { renderToString } = await import("react-dom/server");
  render = (c, props) => renderToString(createElement(c, props as never)).replace(/<!-- -->/g, "");
  BuildRoom = (await import("@/components/build/BuildRoom")).BuildRoom as ComponentType<never>;
  StepList = (await import("@/components/chat")).StepList as ComponentType<never>;
  plan = await import("@/components/build/PlanCard");
  PlanCard = plan.PlanCard as ComponentType<never>;
  steps = await import("@/components/build/steps");
  derive = await import("@/components/build/derive");
});

const ROOT = path.join(import.meta.dirname, "../../..");
const css = () => readFileSync(path.join(ROOT, "components/build/plan-card.css"), "utf8");
const stamp = (bodies: BuildEventBody[]): BuildEvent[] => bodies.map((b, i) => ({ ...b, id: i + 1, at: at(10 * (i + 1)) }) as BuildEvent);

/** A new build that wrote `b` as its brief, then reached `status`. */
function roomAt(status: BuildStatus, opts: { brief?: Brief; message?: string } = {}) {
  const events = stamp([
    { type: "status", status: "briefing", step: "brief" },
    { type: "brief", brief: opts.brief ?? brief },
    { type: "status", status, ...(opts.message ? { message: opts.message } : {}) },
  ]);
  return derive.deriveRoom({ ...FIXTURES.running.build, status: "queued", brief: null }, events);
}

const roomOf = (name: FixtureName) => derive.deriveRoom(FIXTURES[name].build, FIXTURES[name].events);

function page(name: FixtureName, over: Record<string, unknown> = {}) {
  const f = FIXTURES[name];
  return render(BuildRoom, {
    build: f.build,
    product: f.product,
    inspiration,
    events: f.events,
    history: [],
    tokens,
    canRefine: false,
    canSteer: false,
    signedIn: true,
    origin: "https://musemuse.example",
    serverNow: Date.parse(f.build.startedAt) + 60_000,
    focusRefine: false,
    rebuild: null,
    maxFixRounds: 3,
    ...over,
  });
}

/** The conversation column, without the steps panel beside it. */
const conversation = (html: string) => html.slice(0, html.indexOf('class="room-panel"'));
const count = (html: string, s: string) => html.split(s).length - 1;
const yes: Brief = { ...brief, verdict: "yes" };

function card(over: Partial<Brief> = {}, props: Record<string, unknown> = {}) {
  return render(PlanCard, { brief: { ...yes, ...over }, art: "building", running: false, ...props });
}

describe("the mascot", () => {
  it("presents while the plan is new and the sandbox is set up, builds while Muse Code works, and stands as the pair once live", () => {
    const art = (status: BuildStatus) => plan.planCardState(roomAt(status))?.art;
    for (const s of ["queued", "briefing", "provisioning"] as const) assert.equal(art(s), "present", s);
    for (const s of ["building", "previewing", "verifying", "fixing", "recording", "deploying"] as const) assert.equal(art(s), "building", s);
    for (const s of ["live", "partial"] as const) assert.equal(art(s), "shield", s);
  });

  it("goes back to presenting the plan when the build fails or its owner stops it", () => {
    assert.equal(plan.planCardState(roomAt("failed", { message: "The checks didn't pass after the last fix round." }))?.art, "present");
    const stopped = roomAt("failed", { message: "Stopped by you." });
    assert.equal(steps.stepsEnd(stopped), "stopped");
    assert.equal(plan.planCardState(stopped)?.art, "present");
  });

  it("follows the stored builds: building while running, the pair once live, presenting after a failure", () => {
    assert.equal(plan.planCardState(roomOf("running"))?.art, "building");
    assert.equal(plan.planCardState(roomOf("finished"))?.art, "shield");
    assert.equal(plan.planCardState(roomOf("failed"))?.art, "present");
  });

  it("has no card for a declined brief or a refused build, which keep their declined message", () => {
    assert.equal(plan.planCardState(roomAt("refused")), null, "refused");
    assert.equal(plan.planCardState(roomAt("refused", { brief: { ...brief, verdict: "no", refusal: null } })), null, "verdict no");
    assert.equal(plan.planCardState(roomAt("building", { brief: { ...brief, verdict: "no" } })), null, "a no never gets a card");
    assert.equal(plan.planCardState(roomAt("refused", { brief: { ...brief, verdict: "yes", refusal: "That would copy a real product." } })), null, "a refusal");
  });

  it("has no card on a change, which carries its product's brief but didn't write a plan", () => {
    const room = derive.deriveRoom({ ...FIXTURES.running.build, kind: "refine", message: "Make the count bigger." }, stamp([{ type: "status", status: "building", step: "build" }]));
    assert.ok(room.brief, "the refine row has the product's brief");
    assert.equal(plan.planCardState(room), null);
  });

  it("shows the state's picture, decorative, with all three loaded while the build runs so a swap has nothing to wait for", () => {
    const live = card({}, { art: "building", running: true });
    assert.equal(count(live, "<img"), 3);
    assert.match(live, /<img class="is-on" src="\/muse\/muse-building\.jpg" alt="" width="564" height="640" decoding="async"\/>/);
    assert.match(live, /<img src="\/muse\/muse-present\.jpg" alt=""[^>]*fetchPriority="low"\/>/);
    assert.match(live, /<img src="\/muse\/muse-shield\.jpg" alt=""[^>]*fetchPriority="low"\/>/);
    const done = card({}, { art: "shield", running: false });
    assert.equal(count(done, "<img"), 1, "a finished build loads only its own picture");
    assert.match(done, /<img class="is-on" src="\/muse\/muse-shield\.jpg" alt=""/);
    assert.doesNotMatch(live + done, /alt="[^"]+"/, "every picture is decorative");
  });

  it("fetches the opening pictures while the brief is written, so the card's mascot doesn't pop in after it", () => {
    const briefing = (kind: "build" | "refine") =>
      page("running", {
        build: { ...FIXTURES.running.build, kind, status: "briefing", step: "brief", previewUrl: null, costUsd: 0, message: kind === "refine" ? "Make the count bigger." : null },
        events: stamp([{ type: "status", status: "briefing", step: "brief" }]),
      });
    const html = briefing("build");
    assert.match(html, /<link rel="preload" href="\/muse\/muse-present\.jpg" as="image"\/>/);
    assert.match(html, /<link rel="preload" href="\/muse\/muse-building\.jpg" as="image" fetchPriority="low"\/>/);
    assert.doesNotMatch(html, /plan-card|muse-shield/, "no card until the brief is in");
    assert.doesNotMatch(briefing("refine"), /\/muse\/muse-/, "a change checks its request in briefing too, and never gets a card");
    // React's server render preloads the card's visible picture itself. The early fetch stops once the card is up.
    assert.doesNotMatch(page("running"), /rel="preload"[^>]*muse-present/, "once the card is up, it loads its own pictures");
  });

  it("ships the three pictures web-sized, and not the originals", () => {
    for (const name of ["present", "building", "shield"]) {
      const file = path.join(ROOT, "public/muse", `muse-${name}.jpg`);
      assert.ok(existsSync(file), file);
      assert.ok(statSync(file).size < 120_000, `${name} is under 120 KB`);
      assert.equal(plan.PLAN_ART[name as keyof typeof plan.PLAN_ART], `/muse/muse-${name}.jpg`);
    }
    for (const name of ["present.png", "building.png", "shield.png"]) assert.ok(!existsSync(path.join(ROOT, "public/muse", name)), name);
  });
});

describe("the build's own picture (PLAN_ART)", () => {
  const OWN = "https://blob.example/fixtures/b1/plan-art-x1.jpg";

  it("reads the picture from the build's log, and has none without one", () => {
    assert.equal(roomAt("building").planArtUrl, null);
    const events = stamp([
      { type: "status", status: "briefing", step: "brief" },
      { type: "brief", brief },
      { type: "status", status: "provisioning", step: "provision" },
      { type: "plan_art", url: OWN },
      { type: "status", status: "building", step: "build" },
    ]);
    const room = derive.deriveRoom({ ...FIXTURES.running.build, status: "queued", brief: null }, events);
    assert.equal(room.planArtUrl, OWN);
    const brief0 = room.segments.find((s) => s.type === "brief")!;
    assert.equal(brief0.endAt, events[1]!.at, "it moves no turn's times");
    assert.equal(derive.deriveRoom(FIXTURES.running.build, stamp([{ type: "plan_art", url: "javascript:alert(1)" }])).planArtUrl, null, "only a web address");
  });

  it("shows it instead of the stock mascot for every state, in the same box, decorative", () => {
    for (const art of ["present", "building", "shield"] as const) {
      for (const running of [true, false]) {
        const html = card({}, { art, running, artUrl: OWN });
        assert.equal(count(html, "<img"), 1, `${art}, running ${running}: only its own picture loads`);
        if (art === "present" && running) {
          // A new plan: Muse talks first (TALK_MS), and the build's picture waits under him for the slow fade.
          assert.match(html, new RegExp(`<div class="plan-card-stack"><video class="is-on" [^>]*></video><img src="${OWN.replace(/[./]/g, "\\$&")}" alt="" width="564" height="640" decoding="async"/></div>`));
          continue;
        }
        assert.match(html, new RegExp(`<div class="plan-card plan-card-wrap" data-art="${art}"><div class="plan-card-art"><div class="plan-card-stack"><img class="is-on" src="${OWN.replace(/[./]/g, "\\$&")}" alt="" width="564" height="640" decoding="async"/></div></div>`));
      }
    }
  });

  it("is exactly today's card until the picture comes in", () => {
    for (const art of ["present", "building", "shield"] as const) {
      for (const running of [true, false]) {
        assert.equal(card({}, { art, running, artUrl: null }), card({}, { art, running }), `${art}, running ${running}`);
      }
    }
  });

  it("puts it in the room's card once the log has it", () => {
    const f = FIXTURES.running;
    const last = f.events.at(-1)!;
    const convo = conversation(page("running", { events: [...f.events, { type: "plan_art", url: OWN, id: last.id + 1, at: last.at }] }));
    assert.match(convo, new RegExp(`<li class="room-plan"><div class="plan-card plan-card-wrap" data-art="building">.*?<img class="is-on" src="${OWN.replace(/[./]/g, "\\$&")}"`));
    assert.doesNotMatch(convo, /src="\/muse\/muse-/);
    assert.equal(count(convo, 'class="rich"'), 1, "still one plan in the conversation");
  });

  it("doesn't fetch the stock mascot early once the build has its own picture", () => {
    const f = FIXTURES.running;
    const html = page("running", {
      build: { ...f.build, status: "briefing", step: "brief", previewUrl: null, costUsd: 0 },
      events: stamp([{ type: "status", status: "briefing", step: "brief" }, { type: "brief", brief }, { type: "plan_art", url: OWN }]),
    });
    // Muse talks first on a new plan; the build's own picture is the only one fetched, waiting for the fade.
    assert.match(html, new RegExp(`<video class="is-on" [^>]*></video><img src="${OWN.replace(/[./]/g, "\\$&")}"`));
    assert.doesNotMatch(html, /rel="preload"[^>]*\/muse\/muse-/);
  });

  it("goes back to the stock mascot when its own picture fails to load", () => {
    const src = readFileSync(path.join(ROOT, "components/build/PlanCard.tsx"), "utf8");
    // A broken picture (a 404, a block) is dropped, and the stock pictures render in its place.
    assert.match(src, /const ownUrl = artUrl && artUrl !== ownBroken \? artUrl : null;/);
    assert.match(src, /const arts = ownFirst && ownUrl \? \[\] : all \? ART_ORDER : \[art\];/);
    assert.match(src, /onError=\{\(\) => broke\(ownUrl\)\}/);
    // One that failed before the page hydrated, when no onError was listening yet.
    assert.match(src, /img\?\.complete && img\.naturalWidth === 0\) broke\(ownUrl\)/);
  });
});

describe("the full plan", () => {
  it("names the plan and gives its tagline, then who it's for and how it works, numbered", () => {
    const html = card();
    assert.match(html, /<h2 class="plan-card-name"><span class="sr-only">The plan: <\/span>Feeder Count<\/h2>/);
    assert.match(html, /<p class="plan-card-tagline">Counts and outlines the birds in a short feeder video\.<\/p>/);
    assert.match(html, /<h3>Who it&#x27;s for<\/h3><p>Backyard bird watchers<\/p>/);
    assert.match(html, /<h3>How it works<\/h3><ol><li>Upload a clip<\/li><li>See each bird outlined<\/li><li>Get a count<\/li><\/ol>/);
    assert.ok(html.indexOf("plan-card-art") < html.indexOf("plan-card-head"), "the picture first, at the top left");
    assert.equal(html.includes(String.fromCharCode(0x2014)), false, "no em dash");
  });

  it("writes out every part of the brief once, in order: screens, what goes in and out, models and why, limits, inspo, cost", () => {
    const html = card();
    const parts = [
      "<h3>Who it&#x27;s for</h3>",
      "<h3>How it works</h3>",
      "<h3>Screens</h3><ul><li><strong>Upload.</strong> Pick a clip</li></ul>",
      "<h3>What goes in</h3><ul><li><strong>Video</strong>: Under 30 s</li></ul>",
      "<h3>What comes out</h3><ul><li><strong>Overlay</strong>: Masks</li></ul>",
      "<h3>Models</h3>",
      "<td><strong>SAM 3.1</strong></td><td>Find and track birds</td><td>Segments objects across frames</td>",
      "<td><strong>Muse Wonder</strong></td><td>Name the species</td><td>Reads the frames</td>",
      "<h3>Limits</h3><ul><li>Species names are guesses.</li></ul>",
      "<h3>From your inspo</h3><p>A short phone video of birds at a feeder.</p>",
      "<h4>Takes</h4><ul><li>The job: count birds</li><li>Calm green mood</li></ul>",
      "<h4>Leaves out</h4><ul><li>The feeder brand logo</li></ul>",
      "<strong>Cost per run:</strong> about $0.04 (est.). <span class=\"muted\">50 frames at the SAM minimum plus one Spark call.</span>",
    ];
    let at = -1;
    for (const piece of parts) {
      assert.equal(count(html, piece), 1, `once: ${piece}`);
      assert.ok(html.indexOf(piece) > at, `in order: ${piece}`);
      at = html.indexOf(piece);
    }
    // The name and tagline are the card's own; the brief under them doesn't say them again.
    assert.equal(count(html, "Feeder Count"), 1);
    assert.equal(count(html, "Counts and outlines the birds"), 1);
    assert.doesNotMatch(html, /class="lead"/);
    assert.match(html, /<details class="plan-card-full"><summary>See the full plan<\/summary><div class="rich">/, "the steps panel's own brief, folded");
  });

  it("shows at most four short lines above the fold, and leaves the brief itself whole", () => {
    const long = { ...yes, primaryFlow: ["Paste a long description of the harbor schedule, the boats, the tide tables and everything else it should know about. Then wait.", "Two", "Three", "Four", "Five", "Six"] };
    const before = JSON.stringify(long);
    const view = plan.planViewFromBrief(long);
    const lines = view.sections.flatMap((s) => [...(s.steps ?? []), ...(s.text ? [s.text] : [])]);
    assert.equal(lines.length, plan.PLAN_LINES);
    assert.ok(lines.every((l) => l.length <= 93), lines.join("|"));
    assert.equal(JSON.stringify(long), before);
    const html = render(PlanCard, { brief: long, art: "present", running: false });
    assert.ok(html.indexOf("<summary>") < html.indexOf("Six"), "the rest folds");
    assert.ok(!html.slice(0, html.indexOf("<summary>")).includes("Who it&#x27;s for"));
  });

  it("gives its last line to what it won't do when it can build only part", () => {
    const view = plan.planViewFromBrief({ ...yes, verdict: "partly", primaryFlow: ["A", "B", "C", "D", "E"], limits: ["No payments."] });
    assert.deepEqual(view.sections, [{ steps: ["A", "B", "C"] }, { text: "Won't do: No payments" }]);
  });

  it("says when an input is optional", () => {
    const html = card({ inputs: [{ kind: "image", required: false, notes: " " }, { kind: "text", required: true, notes: "A question" }] });
    assert.match(html, /<h3>What goes in<\/h3><ul><li><strong>Image<\/strong> \(optional\)<\/li><li><strong>Text<\/strong>: A question<\/li><\/ul>/);
  });

  it("says when Muse can build only part of it, and nothing extra when it can build all of it", () => {
    assert.match(card({ verdict: "partly" }), /<span class="pill pill-partial"><span class="pill-dot" aria-hidden="true"><\/span>Can build part of it<\/span>/);
    assert.doesNotMatch(card(), /class="pill/);
  });

  it("leaves out a part that's empty instead of showing its heading alone", () => {
    const html = card({
      tagline: "  ",
      user: "",
      primaryFlow: [" ", ""],
      screens: [],
      inputs: [],
      outputs: [],
      limits: [" "],
      costNotes: " ",
      inspiration: { summary: " ", references: [], borrow: [], dontCopy: [""] },
    });
    for (const gone of ["plan-card-tagline", "Who it&#x27;s for", "How it works", "<ol", "Screens", "What goes in", "What comes out", "Limits", "From your inspo", "two-col", "Takes", "Leaves out", 'class="muted"']) {
      assert.ok(!html.includes(gone), gone);
    }
    assert.match(html, /Feeder Count<\/h2>/);
    assert.match(html, /<h3>Models<\/h3>/);
    assert.match(html, /<strong>Cost per run:<\/strong> about \$0\.04 \(est\.\)\. <\/p>/);
    const some = card({ primaryFlow: ["Upload a clip", "  ", "Get a count"], inspiration: { ...yes.inspiration, borrow: [] } });
    assert.match(some, /<ol><li>Upload a clip<\/li><li>Get a count<\/li><\/ol>/, "blank steps are skipped, so the numbers run on");
    assert.match(some, /<div class="two-col"><div><h4>Leaves out<\/h4>/, "one column of the inspo can stand alone");
  });

  // Nov 3 audit: the parking plan's parts came to about $0.02 under "Total about $0.12".
  it("gives the cost per run as the sum of the parts it lists, so the numbers on screen agree", () => {
    const html = card({
      estimatedCostPerRunUsd: 0.12,
      costNotes: "Assumes one summary and one fact check.",
      costItems: [
        { what: "Summary call, 10k in and 600 out", usd: 0.0011 },
        { what: "Fact check, 4 web searches.", usd: 0.01 },
        { what: "Fact check agent tokens", usd: 0.005 },
      ],
    });
    assert.match(html, /<strong>Cost per run:<\/strong> about \$0\.0161 \(est\.\), from these parts: <\/p>/);
    assert.match(html, /<ul><li>Summary call, 10k in and 600 out: \$0\.0011<\/li><li>Fact check, 4 web searches: \$0\.01<\/li><li>Fact check agent tokens: \$0\.005<\/li><\/ul>/);
    assert.match(html, /<p class="muted">Assumes one summary and one fact check\.<\/p>/);
    assert.doesNotMatch(html, /\$0\.12/);
  });

  it("has no link to the brief, which is all in the card now", () => {
    assert.doesNotMatch(card(), /Read the full brief|room-steps-link|<button/);
  });
});

describe("the card in the room", () => {
  it("sits under the running step, above the live preview, and reads the plan once in the conversation", () => {
    const html = page("running");
    const convo = conversation(html);
    const cardAt = convo.indexOf('<li class="room-plan">');
    assert.ok(cardAt > convo.indexOf("Muse Code is building"), "under the building status");
    assert.ok(cardAt > convo.indexOf("Hide steps"));
    assert.ok(cardAt < convo.indexOf("<iframe"), "above the preview");
    assert.ok(convo.indexOf('class="turn-user"') < cardAt, "after the person's message");
    assert.equal(count(convo, "Backyard bird watchers"), 1);
    assert.equal(count(convo, "Counts and outlines the birds in a short feeder video."), 1);
    assert.equal(count(convo, "Species names are guesses."), 1, "the whole plan, once");
    assert.equal(count(convo, 'class="rich"'), 1, "the brief once in the conversation: the card's");
    assert.match(convo, /<li class="room-plan"><div class="plan-card plan-card-wrap" data-art="building">/);

  });

  it("sits above what a finished build made, with the pair, and above a failed build's words, presenting", () => {
    const done = conversation(page("finished"));
    assert.match(done, /<div class="plan-card plan-card-wrap" data-art="shield">/);
    assert.ok(done.indexOf("room-plan") < done.indexOf("<video"));
    assert.equal(count(done, 'src="/muse/'), 1, "only the pair loads on a finished build");
    const failed = conversation(page("failed"));
    assert.match(failed, /<div class="plan-card plan-card-wrap" data-art="present">/);
    assert.ok(failed.indexOf("room-plan") < failed.indexOf("This build didn&#x27;t ship."));
  });

  it("keeps a declined brief's message as it was, with no card and no mascot", () => {
    const declined: Brief = { ...brief, verdict: "no", refusal: null, limits: ["It needs live bird audio, which no model here takes."] };
    const events = stamp([
      { type: "status", status: "briefing", step: "brief" },
      { type: "brief", brief: declined },
      { type: "status", status: "refused", step: "brief", message: "Muse Muse can't make this one." },
    ]);
    const html = conversation(page("failed", { build: { ...FIXTURES.failed.build, status: "refused", brief: declined, error: null }, events }));
    assert.doesNotMatch(html, /plan-card|\/muse\/muse-/);
    assert.match(html, /<span class="pill pill-failed"><span class="pill-dot" aria-hidden="true"><\/span>Can&#x27;t build this<\/span>/);
    assert.match(html, /<div class="callout callout-bad" role="note">/);
    assert.match(html, /It needs live bird audio/);
  });

  it("keeps the whole brief, models and all, in the steps panel's Read the brief", () => {
    const room = roomOf("finished");
    const rows = steps.roomSteps({ room, rail: derive.railStates(room, "build"), isRefine: false });
    const row = rows.find((r) => r.id === "brief");
    assert.equal(row?.title, "Wrote the brief");
    const html = render(StepList, { steps: rows });
    assert.match(html, /<li data-step="brief"[^>]*>.*?<details class="room-fold"><summary>Read the brief<\/summary><div class="rich">/);
    for (const piece of ["Who it&#x27;s for", "How it works", "<table class=\"data\">", "SAM 3.1", "Muse Wonder", "Species names are guesses.", "What goes in", "What comes out", "From your inspo", "Cost per run"]) {
      assert.ok(html.includes(piece), piece);
    }
    // Open beside a running build, the panel already holds it.
    assert.match(page("running").slice(page("running").indexOf('class="room-panel"')), /Read the brief<\/summary><div class="rich">/);
  });
});

describe("the card's look", () => {
  it("holds its pictures in one fixed box, so a swap never moves the text", () => {
    const s = css();
    assert.match(s, /\.plan-card-art \{[^}]*aspect-ratio: 564 \/ 640;/);
    assert.match(s, /\.plan-card-stack > img \{[^}]*position: absolute;[^}]*inset: 0;/);
  });

  it("crossfades the pictures, and doesn't move at all under reduced motion", () => {
    const s = css();
    assert.match(s, /\.plan-card-stack > img\.is-on \{[^}]*transition: opacity var\(--plan-swap\)/);
    const reduced = s.slice(s.indexOf("@media (prefers-reduced-motion: reduce)"));
    assert.ok(reduced.length > 0 && s.includes("@media (prefers-reduced-motion: reduce)"));
    assert.match(reduced, /\.plan-card \{\s*animation: none;\s*\}/);
    assert.match(reduced, /\.plan-card-stack > img,\s*\.plan-card-stack > img\.is-on \{\s*transition: none;\s*\}/);
  });

  it("shows the pictures as given, with no tile, border or blend behind them, and no raw colors of its own", () => {
    const s = css();
    const art = s.match(/\.plan-card-art \{[^}]*\}/)?.[0] ?? "";
    assert.ok(art, "the picture box is styled");
    assert.doesNotMatch(art, /background|border:/, "owner, Oct 31: no grey tile or border behind the mascot");
    assert.match(art, /border-radius: 18px;/);
    assert.doesNotMatch(s, /mix-blend-mode|media-stage/, "nothing changes the pictures' own colors");
    const raw = s.split("\n").filter((l) => /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|oklch\(/i.test(l));
    assert.deepEqual(raw, [], "colors come from the tokens in app/globals.css");
  });

  it("fits a phone: a smaller picture beside the name, and the wide layout only where the column has room", () => {
    const s = css();
    assert.match(s, /\.room-plan \{[^}]*container-type: inline-size;/);
    assert.match(s, /\.plan-card \{[^}]*grid-template-columns: 112px minmax\(0, 1fr\);/);
    assert.match(s, /@container \(min-width: 520px\) \{\s*\.plan-card \{[^}]*grid-template-columns: 240px minmax\(0, 1fr\);/);
  });

  it("wraps the plan beside the picture and on under it on a wide column, and keeps the small layout on a narrow one", () => {
    const s = css();
    const wide = s.slice(s.indexOf("@container (min-width: 520px) {\n  .plan-card.plan-card-wrap"));
    assert.ok(wide.length > 0 && s.includes("@container (min-width: 520px) {\n  .plan-card.plan-card-wrap"), "only where the column has room");
    assert.match(wide, /\.plan-card\.plan-card-wrap \{\s*display: flow-root;\s*\}/, "its own box, so the float stays inside the card");
    assert.match(wide, /\.plan-card-wrap \.plan-card-art \{\s*float: left;\s*width: 240px;/, "at the size the wide card had");
    // A flex or grid box would sit beside the picture whole. Plain blocks let each line flow around it and under it.
    assert.match(wide, /\.plan-card-wrap \.plan-card-head \{\s*display: block;/);
    assert.match(wide, /\.plan-card-wrap \.plan-card-body,\s*\.plan-card-wrap \.plan-card-body \.rich \{\s*display: block;/);
    // Below 520 px (a phone, a narrow column): the grid as it was, a 112 px picture beside the name and the plan under both.
    assert.match(s, /\.plan-card \{[^}]*grid-template-columns: 112px minmax\(0, 1fr\);[^}]*"art head"\s*"body body";/);
    assert.equal(s.indexOf("float:"), s.indexOf("float: left;"), "the picture floats only in the wide rule");
    // The full-width models table can't sit beside the picture, so its heading starts under the picture with it.
    assert.match(wide, /\.plan-card-wrap \.plan-card-body \.rich > h3:has\(\+ \.table-wrap\) \{\s*clear: left;\s*\}/);
    assert.ok(s.indexOf("float: left;") > s.indexOf("@container (min-width: 520px) {\n  .plan-card.plan-card-wrap"));
  });

  it("fades a picture that comes in later over the stock mascot, once it has loaded, in the same box", () => {
    const src = readFileSync(path.join(ROOT, "components/build/PlanCard.tsx"), "utf8");
    // The stock picture keeps is-on until the build's own has loaded, so the swap never fades to an empty box.
    // While Muse talks on a new plan (TALK_MS) neither shows; then the same rule, with a slower fade.
    assert.match(src, /className=\{a === art && !own && !talking \? "is-on" : undefined\}/);
    assert.match(src, /className=\{own && !talking \? "is-on" : undefined\}[\s\S]*?onLoad=\{\(\) => setOwnLoaded\(true\)\}/);
    assert.match(css(), /\.plan-card-stack > img \{[^}]*position: absolute;[^}]*object-fit: cover;/, "every picture fills the one box");
  });

  it("keeps the walking Muse off the page while the card shows, so it never covers the plan's text", () => {
    assert.match(css(), /:root:has\(\.plan-card\) \.mascot,\s*:root:has\(\.plan-card\) \.mascot-climb \{\s*display: none;\s*\}/);
  });

  it("keeps the picture's box the same size, wrapped or not, so nothing jumps", () => {
    const s = css();
    assert.match(s, /\.plan-card-art \{[^}]*aspect-ratio: 564 \/ 640;/);
    assert.doesNotMatch(s, /\.plan-card-wrap \.plan-card-art \{[^}]*(height|aspect-ratio)/, "the float takes the box's own ratio");
  });

  it("keeps the fine-tune room's card on its grid, with no wrap", () => {
    const html = render(plan.PlanViewCard as ComponentType<never>, { view: plan.planViewFromBrief(yes), art: "present", running: false });
    assert.match(html, /<div class="plan-card" data-art="present">/);
    assert.doesNotMatch(html, /plan-card-wrap/);
  });

  it("loads with the build room page", () => {
    const route = readFileSync(path.join(ROOT, "app/b/[buildId]/page.tsx"), "utf8");
    assert.match(route, /import "@\/components\/build\/plan-card\.css";/);
  });
});

describe("Muse talking beside the plan (owner, Nov 2)", () => {
  it("says one short line for each state, with no em dashes", async () => {
    const { planSays } = await import("@/components/build/PlanCard");
    assert.match(planSays("present", true), /^Here's my plan!/);
    assert.match(planSays("present", false), /didn't ship/);
    assert.match(planSays("building", true), /building it now/);
    assert.match(planSays("shield", false), /live/);
    for (const art of ["present", "building", "shield"] as const) for (const r of [true, false]) assert.doesNotMatch(planSays(art, r), /—/);
  });

  it("talks first on a new plan, under every picture's own fade, and only on the build room's card", async () => {
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { createElement } = await import("react");
    const { PlanViewCard, PLAN_TALK, TALK_MS } = await import("@/components/build/PlanCard");
    const view = { name: "Made-up plan", sections: [] };
    const html = (props: Record<string, unknown>) => renderToStaticMarkup(createElement(PlanViewCard as never, { view, running: true, ...props } as never));
    const talking = html({ art: "present", say: "Hi" });
    assert.match(talking, /<video class="is-on" poster="\/muse\/muse-talk\.png"/, "the transparent clip, its file picked in the browser");
    assert.doesNotMatch(talking, /<img class="is-on"/, "no picture shows while Muse talks");
    assert.match(talking, /<p class="plan-card-say">Hi<\/p>/);
    assert.equal(TALK_MS, 8000);
    assert.match(PLAN_TALK.webm, /\.webm$/);
    assert.match(PLAN_TALK.hevc, /\.mov$/);
    // A build's own picture is there from the start: Muse still talks first, then fades to it.
    const own = html({ art: "present", say: "Hi", artUrl: "https://blob.example/x.jpg" });
    assert.match(own, /<video class="is-on"/);
    assert.match(own, /<img src="https:\/\/blob\.example\/x\.jpg"/, "the build's picture waits under him");
    assert.doesNotMatch(html({ art: "present" }), /<video/, "the fine-tune room's card has no bubble and no clip");
    assert.doesNotMatch(html({ art: "present", say: "Hi", running: false }), /<video/, "a plan that's over doesn't talk");
    assert.doesNotMatch(html({ art: "building", say: "Hi" }), /<video/, "a build already under way doesn't talk");
  });
});
