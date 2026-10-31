/**
 * Unit tests for the session bridge's build-room lines, on the real Muse Code 1.4.14 protocol streams from the Oct 30
 * spike (docs/MUSE_CODE_FULL.md): a goal set over the protocol with a steer sent mid-turn
 * (fixtures/msp-goal-steer.jsonl), and a goal that blocked because model calls were refused
 * (fixtures/msp-blocked-goal.jsonl). msp-records.ts turns the probe's recordings into the bridge's log. Kinds the
 * spike didn't produce (workflows, subagents, hook runs, questions) use items shaped like @muse-code/sdk 1.4.14's.
 *   npx tsx --test lib/sandbox/__tests__/msp-log.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import type { BridgeLogRecord } from "@/lib/sandbox/bridge-protocol";
import { type BridgeCondenseState, condenseBridgeLines, emptyBridgeState, parseBridgeLines } from "@/lib/sandbox/msp-log";
import type { MuseLogLine } from "@/lib/types";
import { probeToBridge, toLines, upsert } from "./msp-records";

const FIXTURES = path.join(import.meta.dirname, "fixtures");
const GOAL_STEER = probeToBridge(readFileSync(path.join(FIXTURES, "msp-goal-steer.jsonl"), "utf8"));
const BLOCKED = probeToBridge(readFileSync(path.join(FIXTURES, "msp-blocked-goal.jsonl"), "utf8"));
const OBJECTIVE =
  "Using the shell, run sleep 8, then create the file goal.txt containing OK. The goal is complete when goal.txt exists and contains OK.";
const STEER = "Also create the file steer.txt containing STEERED before you finish.";

const texts = (lines: MuseLogLine[]) => lines.map((l) => `${l.kind}: ${l.text}`);

let t = 0;
const note = (method: string, params: Record<string, unknown>): BridgeLogRecord => ({ t: ++t, kind: "note", method, params });
const itemNote = (method: "item/started" | "item/updated" | "item/completed", item: Record<string, unknown>) =>
  note(method, { item: { revision: 1, ...item }, sessionId: "s1" });
const exitRecord = (exitCode: number, extra: Partial<Extract<BridgeLogRecord, { kind: "bridge" }>> = {}): BridgeLogRecord => ({
  t: ++t,
  kind: "bridge",
  event: "exit",
  exitCode,
  ...extra,
});

/** Feeds records in polls cut at `cuts`, carrying the state, and returns every poll's lines and the last state. */
function polls(records: BridgeLogRecord[], cuts: number[]) {
  let state: BridgeCondenseState = emptyBridgeState();
  const out: MuseLogLine[][] = [];
  let from = 0;
  for (const to of [...cuts, records.length]) {
    // Each poll's state goes through JSON, as it does between workflow steps.
    const c = condenseBridgeLines(toLines(records.slice(from, to)), JSON.parse(JSON.stringify(state)));
    out.push(c.lines);
    state = c.state;
    from = to;
  }
  return { out, state };
}

describe("a real goal run with a steer", () => {
  const whole = condenseBridgeLines(toLines(GOAL_STEER));

  it("shows the goal, the steps, the observers, the owner's note and the end", () => {
    assert.deepEqual(texts(upsert(whole.lines)), [
      "start: Started",
      `goal: Goal met: ${OBJECTIVE}`,
      "reminder: Skill observer looked for skills that fit",
      // The model's own words, dash and all.
      "say: Running your timed file task \u2014 sleep first, then create the marker.",
      "tool: Sleep for eight seconds",
      `steer: ${STEER}`,
      "say: Sleep done \u2014 creating both marker files now.",
      "edit: Edited 1 file (+1 −0)",
      "tool: Edited `goal.txt`",
      "edit: Edited 1 file (+1 −0)",
      "tool: Edited `steer.txt`",
      "tool: Verify created marker files",
      "tool: Updated the goal",
      "reminder: Todo observer stopped",
      "say: Done. Ran `sleep 8`, then created:\n\n- [goal.txt](/tmp/c-live/goal.txt) containing OK\n- [steer.txt](/tmp/c-live/steer.txt) containing STEERED\n\nVerified both files exist with expected contents.",
      "usage: 5 model calls, 139k input tokens (111k cached), 936 output tokens, about $0.003",
      "done: Done. Ran `sleep 8`, then created:",
    ]);
    assert.deepEqual(whole.exit, { code: 0 });
    assert.match(whole.finalText ?? "", /^Done\. Ran `sleep 8`/);
    assert.deepEqual(whole.usage, [], "the engine charges from the session logs");
  });

  it("keeps one goal line that ends complete, and the steer as the owner sent it", () => {
    const goals = whole.lines.filter((l) => l.kind === "goal");
    assert.equal(goals.length, 1, "the update replaced the first goal line in the same poll");
    assert.deepEqual(goals[0]!.detail?.goal, { objective: OBJECTIVE, status: "complete", percentComplete: 100 });
    // Cut just after the goal was set: the first poll shows it active, the second replaces it.
    const set = GOAL_STEER.findIndex((r) => r.kind === "note" && r.method === "session/goalChanged") + 1;
    const { out } = polls(GOAL_STEER, [set]);
    assert.deepEqual(out[0]!.find((l) => l.kind === "goal")?.detail?.goal, { objective: OBJECTIVE, status: "active", percentComplete: 0 });
    assert.equal(out[0]!.find((l) => l.kind === "goal")?.text, `Goal: ${OBJECTIVE}`);
    assert.equal(out[1]!.find((l) => l.kind === "goal")?.itemId, "goal");

    const steer = whole.lines.find((l) => l.kind === "steer");
    assert.deepEqual(steer && { text: steer.text, ok: steer.ok, detail: steer.detail }, {
      text: STEER,
      ok: true,
      detail: { delivery: "steer", status: "delivered" },
    });
  });

  it("names each tool call once, with its outcome, and marks running ones", () => {
    const tools = upsert(whole.lines).filter((l) => l.kind === "tool");
    assert.deepEqual(
      tools.map((l) => [l.tool, l.ok, l.detail?.status]),
      [
        ["bash", true, "completed"],
        ["write_file", true, "completed"],
        ["write_file", true, "completed"],
        ["bash", true, "completed"],
        ["update_goal", true, "completed"],
      ],
    );
    // Cut while `sleep 8` runs: its line says so, then turns done in a later poll under the same id.
    const sleeping = GOAL_STEER.findIndex((r) => r.kind === "command") + 1;
    const { out } = polls(GOAL_STEER, [sleeping]);
    const running = out[0]!.find((l) => l.kind === "tool")!;
    assert.deepEqual([running.text, running.ok, running.detail?.status], ["Sleep for eight seconds", undefined, "inProgress"]);
    assert.equal(out[1]!.find((l) => l.itemId === running.itemId)?.ok, true);
  });

  it("announces each observer once, though the skill observer ran three times", () => {
    const runs = GOAL_STEER.filter((r) => r.kind === "note" && r.method === "item/started" && JSON.stringify(r.params).includes('"reminderChild"'));
    assert.equal(runs.length, 4);
    const observers = upsert(whole.lines).filter((l) => l.kind === "reminder");
    assert.deepEqual(
      observers.map((l) => [l.detail?.reminder, l.detail?.status]),
      [
        ["skill", "completed"],
        ["todo", "cancelled"],
      ],
    );
    assert.deepEqual(whole.state.announced, ["observer:skill", "observer:todo"]);
  });

  it("gives the same lines however the stream is cut into polls, and never repeats an unchanged line", () => {
    const final = upsert(whole.lines);
    for (const cuts of [[5], [12, 24], [20, 30, 40, 50, 60], Array.from({ length: GOAL_STEER.length - 1 }, (_, i) => i + 1)]) {
      const { out, state } = polls(GOAL_STEER, cuts);
      assert.deepEqual(upsert(out.flat()), final, `cut at ${cuts.join(",")}`);
      const last = new Map<string, string>();
      for (const l of out.flat()) {
        if (!l.itemId) continue;
        assert.notEqual(last.get(l.itemId), JSON.stringify(l), `${l.itemId} repeated unchanged (cuts ${cuts.join(",")})`);
        last.set(l.itemId, JSON.stringify(l));
      }
      // Finished items leave the state: only the goal stays to compare its next change against.
      assert.deepEqual(Object.keys(state.shown), ["goal"]);
    }
  });

  it("streams the final answer as it arrives, across polls", () => {
    const firstDelta = GOAL_STEER.findIndex((r) => r.kind === "note" && r.method === "item/delta" && JSON.stringify(r.params).includes('"field":"text"'));
    const { out } = polls(GOAL_STEER, [firstDelta + 2, firstDelta + 5]);
    const id = "ce79ebd7-5783-4a82-9d00-3e53c6e05dd2";
    const says = out.map((lines) => lines.find((l) => l.itemId === id)?.text);
    assert.deepEqual(says.slice(0, 2), ["Done. Ran `sleep 8`, then created:\n\n", "Done. Ran `sleep 8`, then created:\n\n- [goal.txt](/tmp/c-live/goal.txt) containing OK\n- [steer.txt](/tmp"]);
    assert.match(says[2] ?? "", /Verified both files exist with expected contents\.$/);
  });
});

describe("a real goal that blocked", () => {
  it("shows the blocked goal, the failed observer and why the run stopped", () => {
    const c = condenseBridgeLines(toLines(BLOCKED));
    assert.deepEqual(texts(upsert(c.lines)), [
      "start: Started",
      "goal: Goal blocked: Reply OK.",
      "reminder: Skill observer failed: model failed: API error 403: spike: model calls blocked",
      "error: The turn failed: API error 403: spike: model calls blocked",
      "error: Muse Code stopped (API error 403: spike: model calls blocked)",
    ]);
    assert.deepEqual(c.exit, { code: 1, reason: "API error 403: spike: model calls blocked" });
    assert.equal(c.finalText, null);
    assert.deepEqual(c.lines.find((l) => l.kind === "goal")?.detail?.goal, { objective: "Reply OK.", status: "blocked", percentComplete: 0 });
    assert.equal(c.lines.some((l) => l.kind === "usage"), false, "no model call completed");
  });
});

describe("kinds the spike didn't produce", () => {
  it("shows a workflow with its phase and each child's latest attempt", () => {
    const base = { itemId: "wf1", kind: "workflow", entryId: "check-everything", workflowRunId: "run-1" };
    const c = condenseBridgeLines(
      toLines([
        itemNote("item/started", {
          ...base,
          status: "inProgress",
          children: [
            { childId: "types", attempt: 1, label: "Typecheck", status: "running", phase: "Check" },
            { childId: "smoke", attempt: 1, label: "Smoke test", status: "pending" },
          ],
        }),
        itemNote("item/updated", {
          ...base,
          status: "inProgress",
          revision: 2,
          children: [
            { childId: "types", attempt: 1, label: "Typecheck", status: "completed", terminal: "failed" },
            { childId: "types", attempt: 2, label: "Typecheck", status: "running", phase: "Retry" },
            { childId: "smoke", attempt: 1, label: "Smoke test", status: "completed", terminal: "completed", failureKind: "assertion" },
          ],
        }),
      ]),
    );
    assert.deepEqual(c.lines, [
      {
        kind: "workflow",
        itemId: "wf1",
        text: "Workflow check-everything is running",
        detail: {
          status: "inProgress",
          children: [
            { label: "Typecheck", status: "running" },
            { label: "Smoke test", status: "failed" },
          ],
          label: "check-everything",
          phase: "Retry",
          workflowRunId: "run-1",
        },
      },
    ]);
    const done = condenseBridgeLines(
      toLines([
        itemNote("item/completed", {
          ...base,
          status: "completed",
          declaredPhase: "Review",
          finalSummary: "Both checks pass.\nDetails follow.",
          children: [{ childId: "types", attempt: 2, label: "Typecheck", status: "completed", terminal: "completed" }],
        }),
      ]),
      c.state,
    );
    assert.deepEqual(
      [done.lines[0]?.text, done.lines[0]?.ok, done.lines[0]?.detail?.phase],
      ["Workflow check-everything finished: Both checks pass.", true, "Review"],
    );
    assert.deepEqual(done.state.shown, {});
  });

  it("shows a subagent with its path, its session and how it ended", () => {
    const base = { itemId: "sub1", kind: "subagent", agentPath: "main/scout/1", childSessionId: "child-1", objective: "Find the API docs\nand list them" };
    const c = condenseBridgeLines(
      toLines([
        itemNote("item/started", { ...base, status: "inProgress", controlStatus: "running" }),
        itemNote("item/completed", { ...base, status: "completed", result: { summary: "Found 3 pages.", artifactRefs: [], evidenceRefs: [] } }),
        itemNote("item/started", { itemId: "sub2", kind: "subagent", agentPath: "main/scout/1/helper/1", status: "inProgress", controlStatus: "resultReady" }),
        itemNote("item/completed", { itemId: "sub3", kind: "subagent", agentPath: "main/critic/2", status: "failed", failureReason: "context limit" }),
      ]),
    );
    assert.deepEqual(c.lines, [
      {
        kind: "subagent",
        itemId: "sub1",
        text: "Subagent scout finished: Found 3 pages.",
        ok: true,
        detail: { status: "completed", agentPath: "main/scout/1", label: "scout", childSessionId: "child-1" },
      },
      {
        kind: "subagent",
        itemId: "sub2",
        text: "Subagent helper finished",
        ok: true,
        detail: { status: "completed", agentPath: "main/scout/1/helper/1", label: "helper" },
      },
      {
        kind: "subagent",
        itemId: "sub3",
        text: "Subagent critic failed: context limit",
        ok: false,
        detail: { status: "failed", agentPath: "main/critic/2", label: "critic" },
      },
    ]);
    const started = condenseBridgeLines(toLines([itemNote("item/started", { ...base, status: "inProgress" })]));
    assert.equal(started.lines[0]?.text, "Subagent scout is working: Find the API docs");
    // sub2's result is ready but its item is still open, so it waits in the state for the parent to read it.
    assert.deepEqual(Object.keys(c.state.shown), ["sub2"]);
  });

  it("shows each hook once per run, but a block every time", () => {
    const run = (itemId: string, hookKey: string, status: string, extra: Record<string, unknown> = {}) =>
      itemNote(status === "inProgress" ? "item/started" : "item/completed", { itemId, kind: "hookRun", event: "postToolUse", hookKey, status, ...extra });
    const first = condenseBridgeLines(
      toLines([run("h1", "notes", "inProgress"), run("h1", "notes", "completed", { runStatus: "completed" }), run("h2", "notes", "inProgress")]),
    );
    const second = condenseBridgeLines(
      toLines([
        run("h2", "notes", "completed", { runStatus: "completed" }),
        run("h3", "guard", "rejected", { event: "preToolUse", runStatus: "blocked", reason: "protected.txt belongs to the platform", label: "guard.mjs" }),
        run("h4", "guard", "rejected", { event: "preToolUse", runStatus: "blocked", reason: "so does .env" }),
        run("h5", "gate", "completed", { event: "stop", runStatus: "failed", reason: "exit 1" }),
      ]),
      first.state,
    );
    assert.deepEqual(texts(first.lines), ["hook: PostToolUse hook ran"]);
    assert.deepEqual(texts(second.lines), [
      "hook: PreToolUse hook (guard.mjs) blocked: protected.txt belongs to the platform",
      "hook: PreToolUse hook blocked: so does .env",
      "hook: Stop hook failed: exit 1",
    ]);
    assert.deepEqual(second.lines[0]?.detail, { status: "blocked", hookEvent: "preToolUse", hookKey: "guard" });
    assert.equal(second.lines[0]?.ok, false);
    assert.deepEqual(second.state.announced, ["hook:notes", "hook:guard", "hook:gate"]);
  });

  it("caps the announced keys it carries, as muse-log.ts does", () => {
    const hooks = Array.from({ length: 40 }, (_, i) =>
      itemNote("item/completed", { itemId: `h${i}`, kind: "hookRun", event: "postToolUse", hookKey: `k${i}`, status: "completed", runStatus: "completed" }),
    );
    const c = condenseBridgeLines(toLines(hooks));
    assert.equal(c.lines.length, 40);
    assert.equal(c.state.announced.length, 32);
  });

  it("asks a question with its options, then shows how it settled in the question's place", () => {
    const asked = note("userInput/requested", {
      userInputId: "ui-1",
      itemId: "tool-9",
      toolCallId: "call_1",
      toolName: "request_user_input",
      turnId: "turn-1",
      sessionId: "s1",
      viewCursor: "v",
      questions: [
        {
          id: "layout",
          header: "Layout",
          question: "Which layout should the gallery use?",
          options: [{ label: "Grid", description: "Square tiles" }, { label: "List" }],
          selection: { mode: "single" },
        },
        {
          id: "themes",
          header: "Themes",
          question: "Which themes should it ship with?",
          options: [{ label: "Dark" }, { label: "Light" }, { label: "Sepia" }],
          selection: { mode: "multiple", minSelections: 1, maxSelections: 2 },
        },
      ],
    });
    const first = condenseBridgeLines(toLines([asked]));
    assert.deepEqual(first.lines, [
      {
        kind: "question",
        itemId: "question:ui-1",
        text: "Muse Code asks: Which layout should the gallery use?",
        detail: {
          question: {
            userInputId: "ui-1",
            questions: [
              { id: "layout", text: "Which layout should the gallery use?", options: ["Grid", "List"], header: "Layout", descriptions: ["Square tiles", ""] },
              { id: "themes", text: "Which themes should it ship with?", options: ["Dark", "Light", "Sepia"], header: "Themes", multiple: true, min: 1, max: 2 },
            ],
          },
        },
      },
    ]);
    const settled = condenseBridgeLines(
      toLines([
        note("userInput/settled", {
          userInputId: "ui-1",
          outcome: "answered",
          answers: [
            { questionId: "layout", selectedLabel: "Grid" },
            { questionId: "themes", selectedLabels: ["Dark", "Light"] },
          ],
          clarification: null,
          decidedAt: null,
          decidedByCommandId: "c1",
          reason: null,
          sessionId: "s1",
        }),
        note("userInput/settled", { userInputId: "ui-2", outcome: "timedOut", answers: [] }),
      ]),
      first.state,
    );
    assert.deepEqual(
      settled.lines.map((l) => [l.kind, l.itemId, l.text]),
      [
        ["status", "question:ui-1", "Which layout should the gallery use? Answered: Grid; Dark, Light."],
        ["status", "question:ui-2", "Nobody answered in time, so Muse Code went on without an answer."],
      ],
    );
    assert.deepEqual(settled.state.shown, {});
  });

  it("shows each owner command in the owner's words, and a refused one with why", () => {
    const command = (command: Extract<BridgeLogRecord, { kind: "command" }>["command"], ok = true, error?: string): BridgeLogRecord => ({
      t: ++t,
      kind: "command",
      id: `c${t}`,
      command,
      ok,
      ...(error ? { error } : {}),
    });
    const c = condenseBridgeLines(
      toLines([
        command({ type: "queue", text: "Then add a dark mode." }),
        command({ type: "interrupt" }),
        command({ type: "goal", action: "edit", objective: "Ship the gallery only." }),
        command({ type: "goal", action: "pause" }),
        command({ type: "answer", userInputId: "ui-1", answers: [{ questionId: "q", freeText: "Use a grid" }] }),
        command({ type: "workflow", action: "cancel" }),
        command({ type: "subagent", action: "message", childSessionId: "child-1", text: "Skip the tests." }),
        command({ type: "end", reason: "time cap" }),
        command({ type: "steer", text: "Too late?" }, false, "no turn is running"),
      ]),
    );
    assert.deepEqual(
      c.lines.map((l) => [l.text, l.detail?.delivery, l.ok]),
      [
        ["Then add a dark mode.", "queue", true],
        ["Stop the current turn.", "interrupt", true],
        ["Change the goal to: Ship the gallery only.", "goal", true],
        ["Pause the goal.", "goal", true],
        ["Use a grid", "answer", true],
        ["Cancel the workflow.", "workflow", true],
        ["Tell the subagent: Skip the tests.", "subagent", true],
        ["End the run: time cap", "end", true],
        ["Too late?", "steer", false],
      ],
    );
    assert.deepEqual(c.lines.at(-1)?.detail, { delivery: "steer", status: "refused", error: "no turn is running" });
    assert.ok(c.lines.every((l) => l.itemId?.startsWith("command:")));
    assert.deepEqual(c.state.shown, {}, "commands are final on sight");
  });

  it("shows reasoning summaries, compaction, retries and unknown kinds, and skips the prompt", () => {
    const c = condenseBridgeLines(
      toLines([
        itemNote("item/started", { itemId: "u1", kind: "userMessage", status: "completed", text: "Build it." }),
        itemNote("item/started", { itemId: "r1", kind: "reasoning", status: "inProgress", summary: [] }),
        note("item/delta", { itemId: "r1", field: "summary.0", delta: "Plan" }),
        itemNote("item/completed", { itemId: "r1", kind: "reasoning", status: "completed", summary: ["Plan the pages first.", "Then the API."] }),
        itemNote("item/started", { itemId: "k1", kind: "compaction", status: "inProgress", trigger: "auto" }),
        itemNote("item/completed", { itemId: "k1", kind: "compaction", status: "completed", outcome: "compacted", tokensBefore: 812_000, tokensAfter: 41_250 }),
        note("turn/modelRetryScheduled", { attempt: 1, nextAttempt: 2, maxAttempts: 5, retryDelayMs: 1000, httpStatus: 529, turnId: "t1", sessionId: "s1" }),
        itemNote("item/completed", { itemId: "w1", kind: "webSearch", status: "completed" }),
        itemNote("item/completed", { itemId: "x1", kind: "scheduledFire", status: "completed", fallbackText: "The nightly job ran" }),
      ]),
    );
    assert.deepEqual(texts(c.lines), [
      "reasoning: Plan the pages first.\n\nThen the API.",
      "compaction: Muse Code compacted its context from 812k to 41k tokens",
      "status: Retrying a model call (attempt 2 of 5) after HTTP 529",
      "status: Web search",
      "status: The nightly job ran",
    ]);
  });

  it("joins a message's deltas across polls, and lets the finished item have the last word", () => {
    const a = condenseBridgeLines(
      toLines([
        itemNote("item/started", { itemId: "m1", kind: "agentMessage", status: "inProgress", text: "" }),
        note("item/delta", { itemId: "m1", delta: "Hel" }),
        note("item/delta", { itemId: "m1", field: "text", delta: "lo" }),
        note("item/delta", { itemId: "m1", field: "output", delta: "not text" }),
      ]),
    );
    const b = condenseBridgeLines(toLines([note("item/delta", { itemId: "m1", delta: " there" })]), a.state);
    const c = condenseBridgeLines(toLines([itemNote("item/completed", { itemId: "m1", kind: "agentMessage", status: "completed", text: "Hello there." })]), b.state);
    assert.deepEqual([a, b, c].map((p) => p.lines.map((l) => l.text)), [["Hello"], ["Hello there"], ["Hello there."]]);
    assert.deepEqual(c.state.shown, {});
  });

  it("surfaces the host's stderr only when the bridge exits non-zero", () => {
    const stderr: BridgeLogRecord = { t: ++t, kind: "stderr", text: "muse: Hooks: 3 runnable\nbwrap: no permissions\nmuse serve: config error: unknown key x\n" };
    const ok = condenseBridgeLines(toLines([stderr]));
    assert.deepEqual(ok.lines, []);
    assert.deepEqual(condenseBridgeLines(toLines([exitRecord(0, { finalText: "All set." })]), ok.state).lines, [{ kind: "done", ok: true, text: "Done. All set." }]);
    const bad = condenseBridgeLines(toLines([exitRecord(2, { reason: "config error" })]), ok.state);
    assert.deepEqual(bad.lines, [
      { kind: "error", ok: false, text: "Muse Code stopped (config error): muse: Hooks: 3 runnable muse serve: config error: unknown key x" },
    ]);
    assert.deepEqual(bad.exit, { code: 2, reason: "config error" });
    assert.deepEqual(condenseBridgeLines(toLines([exitRecord(1)])).lines, [{ kind: "error", ok: false, text: "Muse Code stopped (exit code 1)" }]);
  });

  it("says when one of the bridge's own requests fails, and leaves command requests to their commands", () => {
    const call = (method: string, ok: boolean, message?: string): BridgeLogRecord =>
      ok ? { t: ++t, kind: "call", method, ok, result: {} } : { t: ++t, kind: "call", method, ok, error: { message: message ?? "" } };
    const c = condenseBridgeLines(
      toLines([
        call("session/start", true),
        call("goal/set", false, "objective is empty after trimming"),
        call("turn/steer", false, "expectedTurnId is not the running turn"),
        call("usage/read", false),
      ]),
    );
    assert.deepEqual(texts(c.lines), ["status: Muse Code couldn't set the goal: objective is empty after trimming", "status: Muse Code couldn't answer usage/read"]);
  });

  it("skips torn, foreign and unknown lines", () => {
    const good = JSON.stringify(note("session/todoListChanged", { items: [{ text: "Write the page", status: "completed" }, { text: "Test it", status: "inProgress" }] }));
    const raw = ["", "not json", good.slice(0, 30), '{"foo":1}', '{"kind":"other"}', "[1,2]", "null", good];
    assert.equal(parseBridgeLines(raw).length, 1);
    assert.deepEqual(condenseBridgeLines(raw).lines, [
      {
        kind: "todo",
        itemId: "todos",
        text: "Todo list: 1 of 2 done",
        detail: {
          todos: [
            { text: "Write the page", status: "completed" },
            { text: "Test it", status: "inProgress" },
          ],
        },
      },
    ]);
  });
});
