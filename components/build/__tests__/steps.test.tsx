/**
 * The build room mapped onto the chat kit (docs/UI_MUSE_APP.md, "Where each thing went"): every piece of the old room
 * still shows, on a stored running, failed and finished build and a plain `muse exec` build.
 *   npx tsx --test --experimental-test-module-mocks components/build/__tests__/steps.test.tsx
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { before, describe, it, mock } from "node:test";
import { createElement, type ComponentType } from "react";
import { FIXTURES, inspiration, picture, tokens } from "@/components/build/__tests__/room-fixture";
import type { StepItem } from "@/components/chat";
import type { BuildEvent } from "@/lib/types";

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
let SteerBox: ComponentType<never>;
let steps: typeof import("@/components/build/steps");
let derive: typeof import("@/components/build/derive");

before(async () => {
  const { renderToString } = await import("react-dom/server");
  render = (c, props) => renderToString(createElement(c, props as never)).replace(/<!-- -->/g, "");
  BuildRoom = (await import("@/components/build/BuildRoom")).BuildRoom as ComponentType<never>;
  StepList = (await import("@/components/chat")).StepList as ComponentType<never>;
  SteerBox = (await import("@/components/build/SteerBox")).SteerBox as ComponentType<never>;
  steps = await import("@/components/build/steps");
  derive = await import("@/components/build/derive");
});

const roomOf = (name: FixtureName, events: BuildEvent[] = FIXTURES[name].events) => derive.deriveRoom(FIXTURES[name].build, events);

function rowsOf(name: FixtureName, targets?: readonly StepItem[]) {
  const room = roomOf(name);
  return steps.roomSteps({ room, rail: derive.railStates(room, "build"), isRefine: false, ...(targets ? { targets } : {}) });
}

function stepsHtml(name: FixtureName) {
  return render(StepList, { steps: rowsOf(name), end: steps.stepsEnd(roomOf(name)) });
}

function page(name: FixtureName, over: Record<string, unknown> = {}) {
  const f = FIXTURES[name];
  return render(BuildRoom, {
    build: f.build,
    product: f.product,
    inspiration,
    events: f.events,
    history: [{ id: f.build.id, kind: "build", status: f.build.status, startedAt: f.build.startedAt, finishedAt: f.build.finishedAt, costUsd: f.build.costUsd, fixRounds: f.build.fixRounds, message: null, name: "Feeder Count", slug: f.product.slug, note: null }],
    tokens,
    canRefine: true,
    canSteer: true,
    signedIn: true,
    origin: "https://musemuse.example",
    serverNow: Date.parse(f.build.startedAt) + 60_000,
    focusRefine: false,
    rebuild: null,
    maxFixRounds: 3,
    ...over,
  });
}

const titles = (rows: readonly StepItem[]) => rows.map((r) => r.title);

function noEmDash(html: string) {
  assert.equal(html.includes(String.fromCharCode(0x2014)), false, "no em dash");
}

describe("the steps list", () => {
  it("lists a running build in order, with the running round last and no end row", () => {
    assert.deepEqual(titles(rowsOf("running")), ["Wrote the brief", "Set up the sandbox", "Muse Code is working"]);
    assert.equal(rowsOf("running").at(-1)!.state, "running");
    assert.equal(steps.stepsEnd(roomOf("running")), undefined);
  });

  it("nests everything a session bridge round did under it", () => {
    const html = stepsHtml("running");
    noEmDash(html);
    for (const piece of [
      "goal-card",
      "todo-card",
      "Muse Code&#x27;s todo list",
      ">Agents<",
      "scout",
      "main/scout/1/helper/1",
      "check-everything",
      "Phase: Check",
      "Smoke test",
      "Thinking",
      "I&#x27;m starting with the upload page",
      "Install the packages · bash",
      "Subagent scout finished: Found 3 pages.",
      "PreToolUse hook blocked",
      "compacted its context",
      "Note from the owner",
      "4 observers ran",
      "verify observer ran",
      "Muse Code asks",
    ]) {
      assert.ok(html.includes(piece), piece);
    }
  });

  it("gives each round its costs and counts", () => {
    const round = rowsOf("running").find((r) => r.id === "muse:0")!;
    assert.match(round.description!, /6 tool calls · Edited 3 files \+120 −4/);
    assert.match(round.description!, /\$0\.60 est\./);
    const exec = rowsOf("failed").find((r) => r.id === "muse:0")!;
    assert.match(exec.description!, /1 failed/);
    assert.match(exec.description!, /Input 12k · Output 3k/);
  });

  it("heads a round with how it runs, not the turn before it", () => {
    const rows = rowsOf("running");
    const brief = rows.find((r) => r.id === "brief")!;
    const round = rows.find((r) => r.id === "muse:0")!;
    assert.equal(brief.children?.length, 0);
    assert.match(round.children![0]!.title, /^Muse Code runs this round on its session host/);
    const fix = rowsOf("failed").find((r) => r.id === "muse:1")!;
    assert.equal(fix.children![0]!.title, "Muse Code runs this round with muse exec.");
  });

  it("shows a failed build's checks, with what failed, and ends it in Didn't finish", () => {
    const rows = rowsOf("failed");
    assert.deepEqual(titles(rows), ["Wrote the brief", "Set up the sandbox", "Muse Code built it", "Started the live preview", "Checks found problems", "Fix round 1", "Checks found problems, try 2"]);
    assert.ok(rows.filter((r) => r.title.startsWith("Checks")).every((r) => r.state === "failed"));
    const html = stepsHtml("failed");
    noEmDash(html);
    for (const piece of ["npm run verify", "Production build", "Module not found: ./count", "Failing output", "Screenshot judge", "The upload button does nothing.", "the page shows none", "Didn&#x27;t finish"]) {
      assert.ok(html.includes(piece), piece);
    }
    assert.match(html, /<details class="room-fold" open="">/, "a failed check starts open");
    assert.equal(steps.stepsEnd(roomOf("failed")), "unfinished");
  });

  it("ends a build the owner stopped in Stopped, naming the round that stopped", () => {
    const events: BuildEvent[] = [
      ...FIXTURES.running.events,
      { type: "status", status: "failed", step: "build", message: "Stopped by you.", id: 900, at: "2026-10-31T13:00:00.000Z" },
    ];
    const room = roomOf("running", events);
    assert.equal(steps.stepsEnd(room), "stopped");
    const round = steps.roomSteps({ room, rail: derive.railStates(room, "build"), isRefine: false }).at(-1)!;
    assert.equal(round.title, "Muse Code didn't finish");
    assert.equal(round.state, "failed");
  });

  it("says which stage failed when no turn can", () => {
    const events: BuildEvent[] = [
      { type: "status", status: "provisioning", step: "provision", id: 1, at: "2026-10-31T12:00:01.000Z" },
      { type: "error", message: "The sandbox didn't answer.", id: 2, at: "2026-10-31T12:00:02.000Z" },
      { type: "status", status: "failed", step: "provision", id: 3, at: "2026-10-31T12:00:03.000Z" },
    ];
    const room = derive.deriveRoom({ ...FIXTURES.failed.build, brief: null }, events);
    const last = steps.roomSteps({ room, rail: derive.railStates(room, "build"), isRefine: false }).at(-1)!;
    assert.equal(last.title, "The sandbox didn't start");
    assert.equal(last.description, "The sandbox didn't answer.");
  });

  it("makes screenshots and the demo its thumbnails, and ends a finished build in Done", () => {
    const rows = rowsOf("finished");
    assert.deepEqual(titles(rows), ["Wrote the brief", "Set up the sandbox", "Muse Code built it", "Started the live preview", "Checks passed", "Recorded the demo", "Deployed"]);
    const check = rows.find((r) => r.id.startsWith("check:"))!;
    assert.deepEqual([check.media].flat().map((m) => m?.alt), ["The upload page", "Birds outlined"]);
    const demo = rows.find((r) => r.id === "record")!;
    assert.equal([demo.media].flat()[0]?.kind, "video");
    assert.equal([demo.media].flat()[0]?.href, "/fixture-demo.mp4");
    const html = stepsHtml("finished");
    assert.match(html, /chat-steplist-play/);
    assert.match(html, /Live at <a href="https:\/\/feeder-count\.example\.com"/);
    assert.match(html, /chat-steplist-end is-done/);
    assert.equal(steps.stepsEnd(roomOf("finished")), "done");
  });

  it("marks nothing as working once its round has ended", () => {
    const running = (rows: readonly StepItem[]): string[] => rows.flatMap((r) => [...(r.state === "running" ? [r.title] : []), ...running(r.children ?? [])]);
    assert.deepEqual(running(rowsOf("finished")), []);
    assert.deepEqual(running(rowsOf("failed")), []);
    assert.ok(running(rowsOf("running")).includes("Muse Code is working"));
  });

  it("shows a plain muse exec build with its tools, folded when there are many", () => {
    const rows = rowsOf("exec");
    const round = rows.at(-1)!;
    assert.equal(round.title, "Muse Code is working");
    const html = stepsHtml("exec");
    noEmDash(html);
    assert.match(html, /I&#x27;ll write the upload page first\./);
    assert.match(html, /Run step 8|Run step 6/);
    assert.match(html, /Edited 2 files \+40 −1/);
    assert.match(html, /Couldn&#x27;t read `missing\.ts` · read_file/);
    for (const piece of ["goal-card", "todo-card", ">Agents<", "observers ran"]) assert.ok(!html.includes(piece), piece);
    // Finished, the same run folds behind its summary.
    assert.match(stepsHtml("failed"), /<summary class="chat-steplist-title">7 steps, edited 2 files \(\+40 −1\)/);
  });

  it("folds a running round's older lines, and keeps the newest in view", () => {
    const lines = Array.from({ length: 20 }, (_, i) => ({ kind: "tool" as const, itemId: `t${i}`, tool: "bash", ok: true, text: `Line ${i}`, detail: { status: "completed" } }));
    const events: BuildEvent[] = [
      { type: "status", status: "building", step: "build", id: 1, at: "2026-10-31T12:00:01.000Z" },
      { type: "muse", round: 0, lines, id: 2, at: "2026-10-31T12:00:02.000Z" },
    ];
    const room = derive.deriveRoom({ ...FIXTURES.exec.build, brief: null }, events);
    const round = steps.roomSteps({ room, rail: derive.railStates(room, "build"), isRefine: false }).find((r) => r.id === "muse:0")!;
    assert.equal(round.children![0]!.title, "12 earlier steps");
    assert.equal(round.children![0]!.folded, true);
    assert.equal(round.children!.length, 9);
    assert.equal(round.children!.at(-1)!.title, "Line 19 · bash");
  });

  it("has a slot for native targets that leaves no trace while it's empty", () => {
    const plain = rowsOf("finished");
    assert.deepEqual(rowsOf("finished", []), plain);
    assert.doesNotMatch(stepsHtml("finished"), /Apps|native/i);
    const android: StepItem = { id: "native:android", title: "Android", state: "done", media: { kind: "video", src: picture("Pixel", 200), alt: "On a Pixel 9", href: "https://example.com/clip.mp4" } };
    const rows = rowsOf("finished", [android]);
    assert.equal(rows.indexOf(rows.find((r) => r.id === "native:android")!), plain.length);
    assert.ok(rows.findIndex((r) => r.id === "deploy") < plain.length, "under the deploy");
    const html = render(StepList, { steps: rows, end: "done" });
    assert.ok(html.indexOf("On a Pixel 9") < html.indexOf("chat-steplist-end"), "above the end row");
  });
});

describe("the sources list", () => {
  it("lists references, models, docs, the catalog, skills and web searches, each once", () => {
    const room = roomOf("finished");
    const sources = steps.roomSources({ room, inspiration, showReferences: true, models: ["sam-3.1", "muse-wonder-1.0"] });
    assert.deepEqual(sources.map((s) => [s.kind, s.title]), [
      ["inspiration", "feeder.jpg"],
      ["file", "feeder-notes.pdf"],
      ["model", "SAM 3.1"],
      ["model", "Muse Wonder"],
      ["docs", "media-segmentation"],
      ["docs", "Searched for track objects in video"],
      ["model", "The model catalog"],
      ["skill", "meta-ui"],
      ["web", "sparrow field marks"],
    ]);
    assert.equal(sources.find((s) => s.title === "media-segmentation")?.href, "/docs/media-segmentation");
    assert.equal(sources[0]?.detail, "Three sparrows at a tube feeder");
  });

  it("leaves out references a change didn't bring, and reads docs reads from a muse exec log", () => {
    const events: BuildEvent[] = [
      { type: "muse", round: 0, lines: [{ kind: "tool", tool: "mcp__musemuse__docs_read", ok: true, text: "Tool calling" }, { kind: "tool", tool: "mcp__musemuse__models_list", ok: true, text: "The models" }], id: 1, at: "2026-10-31T12:00:01.000Z" },
    ];
    const room = derive.deriveRoom({ ...FIXTURES.exec.build, brief: null }, events);
    assert.deepEqual(
      steps.roomSources({ room, inspiration, showReferences: false, models: [] }).map((s) => s.title),
      ["Tool calling", "The model catalog"],
    );
  });
});

describe("the conversation", () => {
  it("folds each finished round into Show thinking, and opens the panel at a fix round", () => {
    const items = steps.conversationItems(roomOf("failed"));
    assert.deepEqual(items.flatMap((i) => (i.type === "thinking" ? [i.step] : [])), [null, "muse:1"]);
    assert.deepEqual(items.flatMap((i) => (i.type === "say" ? [i.text] : [])), [
      "The upload page and the count route are in. It counts birds in a clip and outlines each one.",
      "Added the missing file.",
    ]);
    const lines = items.flatMap((i) => (i.type === "step" ? [i] : []));
    assert.deepEqual(lines.map((l) => [l.title, l.state]), [["Checks found problems", "failed"], ["Checks found problems, try 2", "failed"]]);
    assert.equal(lines[0]?.description, "build, start");
    assert.equal(lines[1]?.description, "The upload button does nothing.");
  });

  it("shows a running round as its current step, with what's running under it", () => {
    const current = steps.currentStep(roomOf("running"))!;
    assert.equal(current.title, "Muse Code is building");
    assert.equal(current.description, "I'm starting with the upload page, then the route that counts birds.");
    assert.deepEqual(current.children.map((c) => c.title), ["Install the packages", "Subagent helper is working", "Smoke test"]);
    assert.equal(steps.currentStep(roomOf("finished")), null);
    assert.ok(!steps.conversationItems(roomOf("running")).some((i) => i.type === "thinking"));
  });

  it("puts a shipped build's last words under what it made, not above", () => {
    const room = roomOf("finished");
    assert.match(steps.finalWords(room)!, /^Feeder Count is ready\./);
    assert.ok(!steps.conversationItems(room).some((i) => i.type === "say"));
    assert.equal(steps.finalWords(roomOf("failed")), undefined);
  });

  it("shares the live product once it ships, and the build room before", () => {
    assert.equal(steps.shareLink({ liveUrl: "https://a.example", origin: "https://m.example", buildId: "b1" }), "https://a.example");
    assert.equal(steps.shareLink({ liveUrl: null, origin: "https://m.example", buildId: "b1" }), "https://m.example/b/b1");
  });
});

describe("the room", () => {
  it("floats the product's name, share and more over a running build, with the panel open beside it", () => {
    const html = page("running");
    noEmDash(html);
    assert.match(html, /<div class="room chat-split" data-settled="false">/);
    assert.match(html, /<h1 class="chat-title-chip">Feeder Count<\/h1>/);
    assert.match(html, /aria-label="Copy this product&#x27;s link"/);
    assert.match(html, /aria-label="Build details"/);
    assert.match(html, /<aside class="chat-panel" aria-label="Steps and sources">/);
    assert.match(html, /<div role="log" aria-relevant="additions" aria-label="Muse Code activity">/);
    assert.doesNotMatch(html, /Build details<\/strong>|class="toolbar"|class="turn[ "]/);
  });

  it("keeps every fact the old panel and toolbar had in the More menu", () => {
    const html = page("finished");
    for (const piece of ["muse-wonder-1.0", "Elapsed", "$0.90 est.", "In 412k · Out 38k", "Muse Code session", "0a3f3611", "Fix rounds", "0 of 3", "Provision", "Models in the product", "Open preview", "Live product", "Product page", "Demo video", "New muse", "Connector URL", "/api/mcp/feeder-count-finished", "custom connector", "This product&#x27;s builds", "First build"]) {
      assert.ok(html.includes(piece), piece);
    }
  });

  it("runs the preview as the media card, with the sandbox attributes it always had", () => {
    const html = page("running");
    assert.match(html, /<figure class="chat-media"><div class="chat-media-frame has-ratio" style="aspect-ratio:16 \/ 10"><iframe src="data:text\/html[^"]*" title="Live preview of Feeder Count" loading="lazy" sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads" referrerPolicy="no-referrer">/);
    assert.match(html, /Open preview<svg/);
    assert.doesNotMatch(page("finished"), /<iframe/);
  });

  it("shows the demo as the media card once it's done, then the answer in plain text, the costs and the links", () => {
    const html = page("finished");
    noEmDash(html);
    assert.match(html, /<video src="\/fixture-demo\.mp4" poster="data:image[^"]*" controls="" preload="metadata" playsInline="" aria-label="Recorded demo">/);
    assert.ok(html.indexOf("<video") < html.indexOf("Feeder Count is ready"), "the answer under the output");
    assert.match(html, /It&#x27;s live\./);
    assert.match(html, /class="ship-link"/);
    assert.match(html, /10 m · Input 412k · Output 38k · \$0\.90 est\./);
    assert.match(html, /Show thinking/);
    // The panel starts closed on a finished build, and opens from Show thinking.
    assert.match(html, /<aside class="chat-panel" aria-label="Steps and sources" hidden="">/);
  });

  it("says plainly that a failed build didn't ship", () => {
    const html = page("failed");
    noEmDash(html);
    assert.match(html, /This build didn&#x27;t ship\./);
    assert.match(html, /The checks didn&#x27;t pass after the last fix round\./);
    assert.match(html, /Try another muse/);
    assert.doesNotMatch(html, /<video|<iframe/);
  });

  it("shows a declined build's reason in the conversation", () => {
    const events: BuildEvent[] = [{ type: "status", status: "refused", step: "brief", message: "Muse Muse can't make this one.", id: 1, at: "2026-10-31T12:00:01.000Z" }];
    const html = page("failed", { build: { ...FIXTURES.failed.build, status: "refused", brief: null, error: null }, events });
    assert.match(html, /Muse Muse can&#x27;t make this one\./);
    assert.match(html, /Show thinking|chat-panel/);
  });

  it("turns the steer box into the composer, with Stop where send was until there's a note", () => {
    const html = render(SteerBox, { buildId: "b1" });
    noEmDash(html);
    assert.match(html, /<form class="composer" aria-label="Steer Muse Code">/);
    assert.match(html, /placeholder="Tell Muse Code something while it works"/);
    assert.match(html, /<button type="button" class="composer-pill">After this step<\/button>/);
    assert.match(html, /<button type="button" class="send-btn" aria-label="Stop" title="Stop"><span class="composer-stop" aria-hidden="true">/);
    assert.match(html, /Send now reaches Muse Code at its next step\./);
    assert.match(page("running"), /aria-label="Steer Muse Code"/);
    assert.doesNotMatch(page("running", { canSteer: false }), /aria-label="Steer Muse Code"/);
  });

  it("offers the refine composer on a shipped build, and pins it over a floor in the page's color", () => {
    assert.match(page("finished"), /<div id="refine" class="room-composer">/);
    assert.doesNotMatch(page("finished", { canRefine: false }), /id="refine"/);
    const css = readFileSync(path.join(import.meta.dirname, "../../../app/globals.css"), "utf8");
    assert.match(css, /\.room-composer \.composer \{\s*--composer-floor: 0 56px 0 var\(--chat-bg\);/);
  });

  it("uses the swappable working icon for every working state", () => {
    const html = page("running");
    assert.match(html, /chat-working-icon is-working/);
    assert.doesNotMatch(html, /working-dot/);
    const css = readFileSync(path.join(import.meta.dirname, "../../chat/WorkingIcon.tsx"), "utf8");
    assert.match(css, /every surface asks for a WorkingIcon/);
  });
});
