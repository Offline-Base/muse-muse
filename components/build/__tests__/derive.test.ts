/**
 * The build room's model of a Muse Code round on the session bridge: lines upserted by item id, owner commands, and
 * the round's goal, todo list, agent tree, observers, hooks and open questions. The real goal run from the Oct 30
 * spike (lib/sandbox/__tests__/fixtures/msp-goal-steer.jsonl) runs through the condenser and into the room.
 *   npx tsx --test components/build/__tests__/derive.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { deriveRoom, groupLog, sessionOf, upsertLine, type Segment } from "@/components/build/derive";
import type { BuildView } from "@/components/view-types";
import { condenseBridgeLines, emptyBridgeState } from "@/lib/sandbox/msp-log";
import { probeToBridge, toLines, upsert } from "@/lib/sandbox/__tests__/msp-records";
import type { BuildEvent, BuildEventBody, MuseLogLine } from "@/lib/types";

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

function events(...bodies: BuildEventBody[]): BuildEvent[] {
  return bodies.map((b, i) => ({ ...b, id: i + 1, at: at(i + 1) }) as BuildEvent);
}

const muse = (lines: MuseLogLine[], round = 0): BuildEventBody => ({ type: "muse", round, lines });

function round(evs: BuildEvent[], n = 0) {
  const seg = deriveRoom(build, evs).segments.find((s): s is Extract<Segment, { type: "muse" }> => s.type === "muse" && s.round === n);
  assert.ok(seg, `round ${n}`);
  return seg;
}

const tool = (itemId: string, status: string, text: string, ok?: boolean): MuseLogLine => ({
  kind: "tool",
  itemId,
  tool: "bash",
  text,
  ...(ok === undefined ? {} : { ok }),
  detail: { status },
});

describe("lines with item ids", () => {
  it("replace the earlier line in place, so a live update never repeats", () => {
    const seg = round(
      events(
        muse([{ kind: "start", text: "Started" }, tool("t1", "inProgress", "Run the tests"), { kind: "say", itemId: "m1", text: "Testing" }]),
        muse([tool("t1", "completed", "Run the tests", true), { kind: "say", itemId: "m1", text: "Testing now." }, tool("t2", "inProgress", "Build")]),
        muse([
          { kind: "edit", itemId: "t2#patch", files: 2, added: 9, removed: 1, text: "Edited 2 files (+9 −1)" },
          tool("t2", "completed", "Build", true),
          { kind: "status", text: "A line without an id" },
        ]),
      ),
    );
    assert.deepEqual(
      seg.lines.map((l) => [l.kind, l.itemId ?? "", l.text, l.ok ?? null]),
      [
        ["start", "", "Started", null],
        ["tool", "t1", "Run the tests", true],
        ["say", "m1", "Testing now.", null],
        ["edit", "t2#patch", "Edited 2 files (+9 −1)", null],
        ["tool", "t2", "Build", true],
        ["status", "", "A line without an id", null],
      ],
    );
  });

  it("keep later lines in their places when an edit line goes in before its tool", () => {
    const lines: MuseLogLine[] = [];
    const slot = new Map<string, number>();
    for (const l of [tool("a", "inProgress", "A"), tool("b", "inProgress", "B")]) upsertLine(lines, slot, l);
    upsertLine(lines, slot, { kind: "edit", itemId: "a#patch", files: 1, added: 1, removed: 0, text: "Edited 1 file (+1 −0)" });
    upsertLine(lines, slot, tool("b", "completed", "B done", true));
    upsertLine(lines, slot, tool("a", "completed", "A done", true));
    assert.deepEqual(
      lines.map((l) => l.itemId),
      ["a#patch", "a", "b"],
    );
    assert.deepEqual(
      lines.map((l) => l.text),
      ["Edited 1 file (+1 −0)", "A done", "B done"],
    );
  });

  it("leave a muse exec round exactly as it was, with no session model", () => {
    const exec: MuseLogLine[] = [
      { kind: "start", text: "Started" },
      { kind: "say", text: "Hel" },
      { kind: "say", text: "lo" },
      { kind: "tool", tool: "read_file", ok: true, text: "Read `a.ts`" },
      { kind: "tool", tool: "read_file", ok: true, text: "Read `a.ts`" },
    ];
    const seg = round(events(muse(exec.slice(0, 3)), muse(exec.slice(3))));
    assert.deepEqual(seg.lines, exec);
    assert.equal(seg.session, null);
    assert.deepEqual(groupLog(seg.lines).groups[1], { type: "say", text: "Hello" });
  });
});

describe("the round's session model", () => {
  it("follows the goal and the todo list to their latest state", () => {
    const goal = (status: string, percentComplete: number): MuseLogLine => ({
      kind: "goal",
      itemId: "goal",
      text: "Goal",
      detail: { goal: { objective: "Ship it", status, percentComplete } },
    });
    const todos = (done: number): MuseLogLine => ({
      kind: "todo",
      itemId: "todos",
      text: "Todo list",
      detail: { todos: [{ text: "Write", status: done > 0 ? "completed" : "inProgress" }, { text: "Test", status: done > 1 ? "completed" : "pending" }] },
    });
    const seg = round(events(muse([goal("active", 0), todos(0)]), muse([goal("active", 50), todos(1)]), muse([goal("complete", 100), todos(2)])));
    assert.deepEqual(seg.session?.goal, { objective: "Ship it", status: "complete", percentComplete: 100 });
    assert.deepEqual(seg.session?.todos.map((t) => t.status), ["completed", "completed"]);
    assert.equal(seg.lines.filter((l) => l.kind === "goal").length, 1);
    const cleared = round(events(muse([goal("active", 10)]), muse([{ kind: "goal", itemId: "goal", text: "Goal cleared", detail: { goal: { objective: "", status: "cleared" } } }])));
    assert.equal(cleared.session?.goal, null);
  });

  it("builds the agent tree: subagents by path, a workflow's children under it", () => {
    const sub = (itemId: string, agentPath: string, status: string, workflowRunId?: string): MuseLogLine => ({
      kind: "subagent",
      itemId,
      text: `Subagent ${agentPath}`,
      detail: { agentPath, status, label: agentPath.split("/").filter((s) => !/^\d+$/.test(s)).pop(), ...(workflowRunId ? { workflowRunId } : {}) },
    });
    const wf = (itemId: string, runId: string, children: Array<{ label: string; status: string }>): MuseLogLine => ({
      kind: "workflow",
      itemId,
      text: "Workflow",
      detail: { label: `checks-${itemId}`, status: "inProgress", phase: "Check", children, workflowRunId: runId },
    });
    const seg = round(
      events(
        muse([sub("s1", "main/scout/1", "inProgress"), sub("s2", "main/scout/1/helper/1", "inProgress")]),
        muse([
          wf("w1", "run-1", [
            { label: "Typecheck", status: "completed" },
            { label: "Smoke", status: "running" },
          ]),
          sub("s3", "main/typecheck/3", "inProgress", "run-1"),
          wf("w2", "run-2", []),
          sub("s4", "main/review/4", "inProgress", "run-2"),
          sub("s1", "main/scout/1", "completed"),
        ]),
      ),
    );
    const tree = (nodes: NonNullable<typeof seg.session>["agents"]): unknown =>
      nodes.map((n) => [n.kind, n.name, n.status, ...(n.children.length ? [tree(n.children)] : [])]);
    assert.deepEqual(tree(seg.session!.agents), [
      ["subagent", "scout", "completed", [["subagent", "helper", "inProgress"]]],
      [
        "workflow",
        "checks-w1",
        "inProgress",
        [
          ["child", "Typecheck", "completed"],
          ["child", "Smoke", "running"],
        ],
      ],
      // A workflow that lists no children yet shows the subagents it runs.
      ["workflow", "checks-w2", "inProgress", [["subagent", "review", "inProgress"]]],
    ]);
    assert.equal(seg.session!.agents[1]!.phase, "Check");
    assert.equal(seg.session!.agents[0]!.path, "main/scout/1");
  });

  it("lists observer and hook runs, and keeps a question open until it settles in its place", () => {
    const question: MuseLogLine = {
      kind: "question",
      itemId: "question:ui-1",
      text: "Muse Code asks: Grid or list?",
      detail: { question: { userInputId: "ui-1", questions: [{ id: "q1", text: "Grid or list?", options: ["Grid", "List"] }] } },
    };
    const open = round(
      events(
        muse([
          { kind: "reminder", itemId: "r1", text: "Verify observer checked the work", ok: true, detail: { reminder: "verify", status: "completed" } },
          { kind: "hook", itemId: "h1", text: "PreToolUse hook blocked: no", ok: false, detail: { hookEvent: "preToolUse", hookKey: "guard", status: "blocked" } },
          question,
        ]),
      ),
    );
    assert.deepEqual(open.session?.observers, [{ id: "r1", name: "verify", status: "completed", text: "Verify observer checked the work", ok: true }]);
    assert.deepEqual(open.session?.hooks, [{ id: "h1", name: "preToolUse", key: "guard", status: "blocked", text: "PreToolUse hook blocked: no", ok: false }]);
    assert.deepEqual(open.session?.questions, [{ userInputId: "ui-1", questions: [{ id: "q1", text: "Grid or list?", options: ["Grid", "List"] }], itemId: "question:ui-1" }]);

    const settled = round(
      events(muse([question]), muse([{ kind: "status", itemId: "question:ui-1", text: "Grid or list? Answered: Grid.", detail: { status: "answered" } }])),
    );
    assert.deepEqual(settled.session?.questions, []);
    assert.deepEqual(
      settled.lines.map((l) => l.text),
      ["Grid or list? Answered: Grid."],
    );
  });
});

describe("owner commands", () => {
  const delivered = (id: string, text: string, delivery: "steer" | "end" = "steer"): MuseLogLine => ({
    kind: "steer",
    itemId: `command:${id}`,
    text,
    ok: true,
    detail: { delivery, status: "delivered" },
  });

  it("show at once, and the bridge's line for the same command takes the note's place", () => {
    const seg = round(
      events(
        muse([tool("t1", "inProgress", "Build")]),
        { type: "control", round: 0, action: "steer", text: "Use a grid. ", ok: true },
        { type: "control", round: 0, action: "stop", ok: true },
        muse([tool("t1", "completed", "Build", true), delivered("c1", "Use a grid.")]),
        muse([delivered("c2", "End the run.", "end")]),
      ),
    );
    assert.deepEqual(
      seg.lines.map((l) => [l.itemId, l.text, l.detail?.status ?? null]),
      [
        ["t1", "Build", "completed"],
        ["command:c1", "Use a grid.", "delivered"],
        ["command:c2", "End the run.", "delivered"],
      ],
    );
  });

  it("show a refused command with why, and never wait on it", () => {
    const seg = round(
      events(
        muse([tool("t1", "inProgress", "Build")]),
        { type: "control", round: 0, action: "steer", text: "Use a grid.", ok: false, error: "The build isn't running." },
        muse([delivered("c1", "Use a grid.")]),
      ),
    );
    assert.deepEqual(
      seg.lines.filter((l) => l.kind === "steer").map((l) => [l.text, l.ok, l.detail?.status, l.detail?.error ?? null]),
      [
        ["Use a grid.", false, "refused", "The build isn't running."],
        ["Use a grid.", true, "delivered", null],
      ],
    );
  });

  it("start their round when it has no lines yet, without taking the notes that follow", () => {
    const room = deriveRoom(
      build,
      events(
        { type: "status", status: "building", step: "build" },
        { type: "control", round: 0, action: "queue", text: "Then add dark mode.", ok: true },
        { type: "log", text: "A platform note" },
      ),
    );
    const seg = room.segments[0] as Extract<Segment, { type: "muse" }>;
    assert.deepEqual([seg.type, seg.lines.map((l) => [l.text, l.detail?.delivery, l.detail?.status])], ["muse", [["Then add dark mode.", "queue", "sent"]]]);
    assert.deepEqual(seg.notes, []);
    assert.deepEqual(room.preNotes.map((n) => n.text), ["A platform note"]);
    assert.notEqual(seg.session, null, "an exec round with a command still shows it");
  });
});

describe("a real session bridge run in the room", () => {
  it("ends with the condensed lines, the met goal and both observers", () => {
    const records = probeToBridge(readFileSync(path.join(import.meta.dirname, "../../../lib/sandbox/__tests__/fixtures/msp-goal-steer.jsonl"), "utf8"));
    let state = emptyBridgeState();
    const bodies: BuildEventBody[] = [];
    for (let from = 0; from < records.length; from += 7) {
      const c = condenseBridgeLines(toLines(records.slice(from, from + 7)), state);
      state = c.state;
      if (c.lines.length) bodies.push(muse(c.lines));
    }
    const seg = round(events(...bodies));
    assert.deepEqual(seg.lines, upsert(condenseBridgeLines(toLines(records)).lines));
    assert.equal(seg.session?.goal?.status, "complete");
    assert.equal(seg.session?.goal?.percentComplete, 100);
    assert.deepEqual(seg.session?.observers.map((o) => [o.name, o.status]), [
      ["skill", "completed"],
      ["todo", "cancelled"],
    ]);
    assert.deepEqual(seg.session?.agents, []);
    assert.deepEqual(seg.session?.questions, []);
    const { groups, summary } = groupLog(seg.lines);
    assert.deepEqual(groups.map((g) => g.type), ["activity", "say", "activity", "steer", "say", "activity", "say", "done"]);
    assert.deepEqual([summary.tools, summary.edits, summary.files, summary.usageText], [
      5,
      2,
      2,
      "5 model calls, 139k input tokens (111k cached), 936 output tokens, about $0.003",
    ]);
  });
});

describe("groupLog on bridge lines", () => {
  it("keeps whole messages apart, folds reasoning, and marks running tools", () => {
    const { groups } = groupLog([
      { kind: "reasoning", itemId: "r1", text: "First." },
      { kind: "reasoning", itemId: "r2", text: "Second." },
      { kind: "say", itemId: "m1", text: "One." },
      { kind: "say", itemId: "m2", text: "Two." },
      tool("t1", "inProgress", "Build"),
      { kind: "subagent", itemId: "s1", text: "Subagent scout is working", detail: { status: "inProgress", agentPath: "main/scout/1" } },
      { kind: "compaction", itemId: "k1", text: "Muse Code compacted its context" },
      { kind: "workflow", itemId: "w1", text: "Workflow checks is running", detail: { status: "inProgress", phase: "Check", children: [] } },
      { kind: "steer", itemId: "command:c1", text: "Use a grid.", ok: true, detail: { delivery: "steer", status: "delivered" } },
      { kind: "goal", itemId: "goal", text: "Goal: Ship", detail: { goal: { objective: "Ship", status: "active" } } },
      { kind: "question", itemId: "question:q", text: "Muse Code asks: Grid?" },
      { kind: "reminder", itemId: "o1", text: "Verify observer checked the work" },
    ]);
    assert.deepEqual(groups, [
      { type: "thinking", text: "First.\n\nSecond." },
      { type: "say", text: "One." },
      { type: "say", text: "Two." },
      {
        type: "activity",
        items: [
          { type: "tool", text: "Build", tool: "bash", ok: undefined, running: true },
          { type: "subagent", text: "Subagent scout is working", status: "inProgress" },
          { type: "compaction", text: "Muse Code compacted its context" },
        ],
      },
      { type: "workflow", text: "Workflow checks is running", status: "inProgress", phase: "Check", children: [] },
      { type: "steer", text: "Use a grid.", status: "delivered", delivery: "steer" },
    ]);
  });

  it("has no session model for lines without ids or bridge kinds", () => {
    assert.equal(sessionOf([{ kind: "tool", tool: "bash", ok: true, text: "ls" }]), null);
    assert.notEqual(sessionOf([{ kind: "tool", itemId: "t", tool: "bash", ok: true, text: "ls" }]), null);
  });
});
