/**
 * Server-renders the build room's Muse Code turn and panel, outside Next: a session bridge round with its goal, todo
 * list, thinking, workflow, subagents, observers, owner notes and a question, and a `muse exec` round, which must show
 * none of it.
 *   npx tsx --test --experimental-test-module-mocks components/build/__tests__/render.test.tsx
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { before, describe, it, mock } from "node:test";
import { createElement, type ComponentType } from "react";
import type { BuildView } from "@/components/view-types";
import { condenseMuseLines } from "@/lib/sandbox/muse-log";
import type { BuildEvent, BuildEventBody, MuseLogLine } from "@/lib/types";

mock.module("next/navigation", {
  namedExports: { useRouter: () => ({ push() {}, refresh() {} }), usePathname: () => "/b/x" },
});
mock.module("next/link", {
  defaultExport: (props: Record<string, unknown>) => createElement("a", { ...props, href: String(props.href) }),
});

const t0 = Date.parse("2026-10-30T12:00:00.000Z");
const at = (s: number) => new Date(t0 + s * 1000).toISOString();

const build: BuildView = {
  id: "11111111-1111-4111-8111-111111111111",
  kind: "build",
  message: null,
  rebuildOf: null,
  productId: "22222222-2222-4222-8222-222222222222",
  userId: "u1",
  inspirationId: "i1",
  status: "building",
  step: "build",
  brief: null,
  buildModel: "muse-wonder-1.0",
  museSessionId: null,
  fixRounds: 0,
  previewUrl: null,
  costUsd: 0,
  error: null,
  startedAt: at(0),
  finishedAt: null,
};

const question: MuseLogLine = {
  kind: "question",
  itemId: "question:ui-1",
  text: "Muse Code asks: Which layout should the gallery use?",
  detail: {
    question: {
      userInputId: "ui-1",
      questions: [
        { id: "layout", header: "Layout", text: "Which layout should the gallery use?", options: ["Grid", "List"], descriptions: ["Square tiles", ""] },
        { id: "themes", text: "Which themes should it ship with?", options: ["Dark", "Light", "Sepia"], multiple: true, min: 1, max: 2 },
      ],
    },
  },
};

/** A bridge round with one of everything, as the condenser makes it. */
const bridgeLines: MuseLogLine[] = [
  { kind: "start", text: "Started" },
  { kind: "goal", itemId: "goal", text: "Goal: Build the gallery", detail: { goal: { objective: "Build the gallery.\n\n1. `npm run verify` exits 0.", status: "active", percentComplete: 40 } } },
  {
    kind: "todo",
    itemId: "todos",
    text: "Todo list: 1 of 3 done",
    detail: {
      todos: [
        { text: "Write the page", status: "completed" },
        { text: "Add the API route", status: "inProgress" },
        { text: "Old idea", status: "cancelled" },
      ],
    },
  },
  { kind: "reasoning", itemId: "r1", text: "The brief wants a grid first." },
  { kind: "say", itemId: "m1", text: "Starting with the layout." },
  { kind: "tool", itemId: "t1", tool: "bash", text: "Install the packages", detail: { status: "inProgress" } },
  { kind: "subagent", itemId: "s1", text: "Subagent scout finished: Found 3 pages.", ok: true, detail: { status: "completed", agentPath: "main/scout/1", label: "scout" } },
  { kind: "hook", itemId: "h1", text: "PreToolUse hook blocked: .env belongs to the platform", ok: false, detail: { status: "blocked", hookEvent: "preToolUse" } },
  { kind: "compaction", itemId: "k1", text: "Muse Code compacted its context from 812k to 41k tokens", detail: { status: "compacted" } },
  {
    kind: "workflow",
    itemId: "w1",
    text: "Workflow check-everything is running",
    detail: {
      status: "inProgress",
      label: "check-everything",
      phase: "Check",
      workflowRunId: "run-1",
      children: [
        { label: "Typecheck", status: "completed" },
        { label: "Smoke test", status: "running" },
      ],
    },
  },
  { kind: "steer", itemId: "command:c1", text: "Use a grid, not a list.", ok: true, detail: { delivery: "steer", status: "delivered" } },
  { kind: "steer", itemId: "command:c2", text: "Too late?", ok: false, detail: { delivery: "steer", status: "refused", error: "no turn is running" } },
  ...["verify", "goal", "skill", "todo"].map(
    (name, i): MuseLogLine => ({ kind: "reminder", itemId: `o${i}`, text: `${name} observer ran`, ok: true, detail: { reminder: name, status: "completed" } }),
  ),
  question,
];

let render: (c: ComponentType<never>, props: object) => string;
let MuseLog: ComponentType<never>;
let BuildPanel: ComponentType<never>;
let QuestionCard: ComponentType<never>;
let BuildRoom: ComponentType<never>;
let derive: typeof import("@/components/build/derive");
let session: typeof import("@/components/build/session");

before(async () => {
  const { renderToString } = await import("react-dom/server");
  // React separates adjacent text with <!-- -->; drop it so assertions read like the page.
  render = (c, props) => renderToString(createElement(c, props as never)).replace(/<!-- -->/g, "");
  MuseLog = (await import("@/components/build/turns")).MuseLog as ComponentType<never>;
  BuildPanel = (await import("@/components/build/BuildPanel")).BuildPanel as ComponentType<never>;
  session = await import("@/components/build/session");
  QuestionCard = session.QuestionCard as ComponentType<never>;
  derive = await import("@/components/build/derive");
  BuildRoom = (await import("@/components/build/BuildRoom")).BuildRoom as ComponentType<never>;
});

function clean(html: string) {
  assert.equal(html.includes(String.fromCharCode(0x2014)), false, "no em dash");
}

/** The control events for bridgeLines' two owner notes, listing the mailbox command ids the bridge's lines are for. */
const OWNER: BuildEventBody[] = [
  { type: "control", round: 0, action: "steer", text: "Use a grid, not a list.", ok: true, commandIds: ["c1"] },
  { type: "control", round: 0, action: "steer", text: "Too late?", ok: true, commandIds: ["c2"] },
];

function room(lines: MuseLogLine[], owner: BuildEventBody[] = []) {
  const bodies: BuildEventBody[] = [
    { type: "status", status: "building", step: "build" },
    { type: "muse", round: 0, lines },
    ...owner,
  ];
  return derive.deriveRoom(build, bodies.map((b, i) => ({ ...b, id: i + 1, at: at(i + 1) }) as BuildEvent));
}

function museRound(lines: MuseLogLine[], owner: BuildEventBody[] = []) {
  return room(lines, owner).segments.find((s) => s.type === "muse") as Extract<import("@/components/build/derive").Segment, { type: "muse" }>;
}

function panel(lines: MuseLogLine[], owner: BuildEventBody[] = []) {
  const r = room(lines, owner);
  return render(BuildPanel, {
    name: "Gallery",
    room: r,
    rail: derive.railStates(r, "build"),
    models: [],
    buildModel: "muse-wonder-1.0",
    sessionId: null,
    maxFixRounds: 2,
    elapsedMs: 60_000,
    tokens: { input: 0, cached: 0, output: 0 },
    liveUrl: null,
    demoUrl: null,
    productSlug: null,
    connectorUrl: null,
  });
}

describe("a session bridge round", () => {
  it("shows the goal with its status and progress, and the todo list with checked items", () => {
    const seg = museRound(bridgeLines, OWNER);
    const html = render(MuseLog, { lines: seg.lines, live: true, session: seg.session, buildId: build.id, canAnswer: true });
    clean(html);
    assert.match(html, /<section class="goal-card goal-building" aria-labelledby="[^"]+"><div class="goal-head"><h3 class="goal-title" id="[^"]+">/);
    assert.match(html, /<span class="pill pill-building"><span class="pill-dot" aria-hidden="true"><\/span>In progress<\/span>/);
    assert.match(html, /Build the gallery\./);
    assert.match(html, /<code>npm run verify<\/code>/);
    assert.match(html, /role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="40"/);
    assert.match(html, /style="width:40%"/);
    assert.match(html, /1 of 3 done/);
    assert.match(html, /<li class="todo todo-completed"><span class="todo-box" aria-hidden="true"><svg[^>]*>.*?<\/svg><\/span><span class="todo-text">Write the page<\/span><span class="sr-only"> \(Done\)<\/span>/);
    assert.match(html, /<li class="todo todo-inProgress">.*?Add the API route.*? \(In progress\)/);
    assert.match(html, /<li class="todo todo-cancelled">.*?Old idea/);
    // The goal and the list sit above the live log, which keeps only Muse Code's activity.
    assert.ok(html.indexOf("goal-card") < html.indexOf('role="log"'));
    assert.ok(html.indexOf("todo-card") < html.indexOf('role="log"'));
  });

  it("folds thinking, and shows tools, subagents, hooks, compaction, workflows and owner notes in order", () => {
    const seg = museRound(bridgeLines, OWNER);
    const html = render(MuseLog, { lines: seg.lines, live: false, session: seg.session });
    clean(html);
    assert.match(html, /<details class="thinking"><summary>Thinking<\/summary><div class="md say"><p>The brief wants a grid first\.<\/p><\/div><\/details>/);
    assert.match(html, /<li class="act act-tool act-running">.*?Install the packages<span class="sr-only"> \(running\)<\/span><\/span><code class="act-name">bash<\/code><\/li>/);
    assert.match(html, /<li class="act act-subagent">.*?Subagent scout finished: Found 3 pages\.<\/span><span class="pill pill-live pill-sm">.*?Done<\/span><\/li>/);
    assert.match(html, /<li class="act act-hook act-failed">.*?PreToolUse hook blocked: \.env belongs to the platform/);
    assert.match(html, /<li class="act act-compaction">.*?compacted its context from 812k to 41k tokens/);
    assert.match(html, /<div class="wf-card"><p class="wf-head"><svg[^>]*>.*?<\/svg><span class="wf-title">Workflow check-everything is running<\/span><span class="pill pill-building pill-sm">/);
    assert.match(html, /<p class="wf-phase">Phase: Check<\/p>/);
    assert.match(html, /<li class="wf-child"><span class="pill-dot dot-live" aria-hidden="true"><\/span><span class="wf-child-name">Typecheck<\/span><span class="muted">Done<\/span><\/li>/);
    assert.match(html, /<li class="wf-child"><span class="pill-dot dot-building" aria-hidden="true"><\/span><span class="wf-child-name">Smoke test<\/span><span class="muted">Running<\/span><\/li>/);
    assert.match(html, /<div class="steer"><p class="bubble bubble-steer"><span class="sr-only">From the owner: <\/span>Use a grid, not a list\.<\/p><p class="steer-meta">Delivered into the running turn<\/p><\/div>/);
    assert.match(html, /<div class="steer steer-refused">.*?Too late\?<\/p><p class="steer-meta">Not delivered: no turn is running<\/p>/);
    const order = ["thinking", "Starting with the layout", "Install the packages", "wf-card", "Use a grid", "Too late"].map((s) => html.indexOf(s));
    assert.deepEqual(order, [...order].sort((a, b) => a - b), "in the order they happened");
  });

  it("draws a command line no control event lists as a plain step, never as a note from the owner", () => {
    const seg = museRound(bridgeLines);
    const html = render(MuseLog, { lines: seg.lines, live: false, session: seg.session });
    clean(html);
    assert.doesNotMatch(html, /class="steer|bubble-steer|From the owner/);
    assert.match(html, /<li class="act act-status">.*?<span class="act-text">Muse Code got a command: Use a grid, not a list\.<\/span><\/li>/);
    assert.match(html, /<li class="act act-status">.*?<span class="act-text">Muse Code didn&#x27;t take a command \(no turn is running\): Too late\?<\/span><\/li>/);
  });

  it("folds observer runs when there are many, and lists a few as they are", () => {
    const seg = museRound(bridgeLines, OWNER);
    const many = render(MuseLog, { lines: seg.lines, live: false, session: seg.session });
    assert.match(many, /<details class="fold"><summary>4 observers ran<\/summary><ul class="notes observer-notes" aria-label="Observers">/);
    const few = museRound(bridgeLines.filter((l) => l.kind !== "reminder" || l.itemId === "o0"), OWNER);
    const html = render(MuseLog, { lines: few.lines, live: false, session: few.session });
    assert.match(html, /<ul class="notes observer-notes" aria-label="Observers"><li class="note"><svg[^>]*>.*?<\/svg><span>verify observer ran<\/span><\/li><\/ul>/);
    assert.doesNotMatch(html, /observers ran/);
  });

  it("asks the owner the question with its options and room for their own words", () => {
    const seg = museRound(bridgeLines, OWNER);
    const html = render(MuseLog, { lines: seg.lines, live: true, session: seg.session, buildId: build.id, canAnswer: true });
    clean(html);
    // The card sits after the live log, so answering it isn't part of the log's announcements.
    assert.ok(html.indexOf("question-card") > html.indexOf('role="log"'));
    assert.match(html, /<form class="question-card" aria-labelledby="([^"]+)-head"><h3 class="question-head" id="\1-head">/);
    assert.match(html, /<legend><span class="question-tag">Layout<\/span><span class="question-text">Which layout should the gallery use\?<\/span><\/legend>/);
    assert.match(html, /<input type="radio" name="[^"]+-layout" value="Grid"\/><span class="question-option-text"><span>Grid<\/span><span class="muted small">Square tiles<\/span><\/span>/);
    assert.match(html, /<input type="checkbox" name="[^"]+-themes" value="Dark"\/>/);
    assert.match(html, /<p class="question-hint">Pick up to 2\.<\/p>/);
    assert.equal((html.match(/Or answer in your own words/g) ?? []).length, 2);
    assert.match(html, /<textarea rows="2" maxLength="500"><\/textarea>/);
    assert.match(html, /<button type="submit" class="btn btn-primary btn-sm" disabled="">Send answer<\/button>/);
    assert.match(html, /<p class="muted small" role="status"><\/p>/);
  });

  it("shows the question read-only to others, and as unanswered once the run is over", () => {
    const q = { ...question.detail!.question!, itemId: question.itemId! };
    const visitor = render(QuestionCard, { question: q, buildId: build.id, canAnswer: false, live: true });
    assert.match(visitor, /<fieldset class="question" disabled="">/);
    assert.match(visitor, /Waiting for the owner to answer\./);
    assert.doesNotMatch(visitor, /Send answer|textarea/);
    const ended = render(QuestionCard, { question: q, buildId: build.id, canAnswer: true, live: false });
    assert.match(ended, /The run ended before this was answered\./);
    assert.doesNotMatch(ended, /Send answer/);
  });

  it("opens the question to whoever may steer, as the control route decides, not to whoever may refine", () => {
    const bodies: BuildEventBody[] = [
      { type: "status", status: "building", step: "build" },
      { type: "muse", round: 0, lines: [{ kind: "start", text: "Started" }, question] },
    ];
    const events = bodies.map((b, i) => ({ ...b, id: i + 1, at: at(i + 1) }) as BuildEvent);
    const page = (canRefine: boolean, canSteer: boolean) =>
      render(BuildRoom, {
        build,
        product: null,
        inspiration: null,
        events,
        history: [],
        tokens: { input: 0, cached: 0, output: 0 },
        canRefine,
        canSteer,
        signedIn: true,
        origin: "https://musemuse.example",
        serverNow: t0 + 60_000,
        focusRefine: false,
        rebuild: null,
        maxFixRounds: 2,
      });
    // An owner on a first build before its product row exists.
    assert.match(page(false, true), /Send answer/);
    // Steering is off, so the route would answer 503.
    assert.doesNotMatch(page(true, false), /Send answer/);
  });

  it("builds each answer the control route takes, and reads its errors", () => {
    const [layout, themes] = question.detail!.question!.questions;
    assert.deepEqual(session.answerFor(layout!, ["Grid"], ""), { questionId: "layout", selectedLabel: "Grid" });
    assert.deepEqual(session.answerFor(layout!, [], ""), null);
    assert.deepEqual(session.answerFor(layout!, ["Grid"], "  A masonry wall  "), { questionId: "layout", freeText: "A masonry wall" });
    assert.deepEqual(session.answerFor(themes!, ["Dark", "Light"], ""), { questionId: "themes", selectedLabels: ["Dark", "Light"] });
    assert.deepEqual(session.answerFor(themes!, ["Dark", "Light", "Sepia"], ""), null, "over the maximum");
    assert.deepEqual(session.answerFor(themes!, [], ""), null, "under the minimum");
    assert.equal(session.answerFor(layout!, [], "x".repeat(600))?.freeText?.length, 500);
    assert.equal(session.answerError(409, "Muse Code isn't waiting for an answer."), "Muse Code isn't waiting for an answer.");
    assert.equal(session.answerError(403, "forbidden"), "Only the product's owner can answer.");
    assert.equal(session.answerError(409, "not_running"), "That didn't go through (not_running). Try again in a moment.");
    assert.equal(session.answerError(500, undefined), "That didn't go through. Try again in a moment.");
  });

  it("lists the live agent tree in the panel", () => {
    const html = panel(
      [
        ...bridgeLines,
        { kind: "subagent", itemId: "s2", text: "Subagent helper is working", detail: { status: "inProgress", agentPath: "main/scout/1/helper/1", label: "helper" } },
      ],
      OWNER,
    );
    clean(html);
    assert.match(html, /<h3 class="panel-label" id="([^"]+)-agents">Agents<\/h3><ul class="agent-tree"><li><span class="agent-row"><svg[^>]*>.*?<\/svg><span class="agent-text"><span class="agent-name">Muse Code<\/span><\/span><\/span><ul>/);
    assert.match(html, /<span class="agent-name">scout<\/span><code class="agent-meta">main\/scout\/1<\/code><\/span><span class="pill pill-live pill-sm">.*?Done<\/span><\/span><ul><li><span class="agent-row">.*?<span class="agent-name">helper<\/span>.*?Running/);
    assert.match(html, /<span class="agent-name">check-everything<\/span><span class="agent-meta">Phase: Check<\/span>/);
    assert.match(html, /<span class="agent-name">Smoke test<\/span>.*?Running/);
    assert.ok(html.indexOf("Agents") > html.indexOf('class="rail"'), "under the status rail");
  });
});

describe("a muse exec round", () => {
  it("shows none of the session bridge's pieces", () => {
    const raw = readFileSync(path.join(import.meta.dirname, "../../../lib/sandbox/__tests__/fixtures/muse-exec-subagent.jsonl"), "utf8");
    const seg = museRound(condenseMuseLines(raw.split("\n")).lines);
    assert.equal(seg.session, null);
    const html = render(MuseLog, { lines: seg.lines, live: true, session: seg.session, buildId: build.id, canAnswer: true });
    assert.match(html, /^<div class="muse" role="log" aria-relevant="additions" aria-label="Muse Code activity">/);
    for (const piece of ["goal-card", "todo-card", "thinking", "steer", "wf-card", "question-card", "observer-notes", "act-running", "pill-sm"]) {
      assert.doesNotMatch(html, new RegExp(piece), piece);
    }
    assert.match(html, /Muse Code started a subagent: scout/);
    assert.doesNotMatch(panel(seg.lines), /Agents/);
  });
});
