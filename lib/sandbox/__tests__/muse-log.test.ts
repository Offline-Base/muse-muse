/**
 * Unit tests for the build-room lines about Muse Code's helper agents and for the usage run.usage leaves out, on real
 * Muse Code 1.4.14 output from Oct 27: a run that spawned one subagent (fixtures/muse-exec-subagent.jsonl), the same
 * session resumed with an image (fixtures/muse-exec-resumed-head.jsonl, first lines only), and trimmed copies of that
 * session's logs (fixtures/muse-data). SESSION_USAGE_SCRIPT runs in real node against them, and against copies with
 * records added for cases the real run didn't have (a resumed subagent, a nested one). From Oct 30: a workflow run whose
 * completion arrived as a second run (fixtures/muse-exec-workflow.jsonl) and the session bridge's spike stream
 * (fixtures/msp-goal-steer.jsonl), with session logs made in the shape that run's logs had.
 *   npx tsx --test lib/sandbox/__tests__/muse-log.test.ts
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { usageCost } from "@/lib/meta/pricing";
import {
  childUsageLine,
  completeLines,
  condenseMuseLines,
  highlightsFrom,
  ownersLabel,
  parseSessionUsage,
  reminderName,
  SESSION_USAGE_SCRIPT,
  subagentText,
} from "@/lib/sandbox/muse-log";

const FIXTURES = path.join(import.meta.dirname, "fixtures");
const SUBAGENT_RUN = path.join(FIXTURES, "muse-exec-subagent.jsonl");
const RESUMED_RUN = path.join(FIXTURES, "muse-exec-resumed-head.jsonl");
const SESSION = "0a3f3611-f27d-498f-b5a6-999d1d24fdbe";
const RUN_1 = "01a17fa6-2ecb-7c51-96d8-4aa4b9d3db6a";
const RUN_2 = "01a17fa6-69e8-7382-b966-33fe6f4b4626";
/** recorded_at (microseconds) of each run's first record in the parent session log. */
const RUN_1_START = 1793142959836818;
const RUN_2_START = 1793142974961192;
/** The first run's subagent, whose log is subagent/<SCOUT>/session.jsonl. */
const SCOUT = "01a17fa6-3c93-74d3-855a-9733d3ce2ee7";

const tmp = mkdtempSync(path.join(tmpdir(), "musemuse-muse-log-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

function event(payloadType: string, payload: Record<string, unknown>): string {
  return JSON.stringify({ stream: { kind: "session", id: SESSION }, payload_type: payloadType, payload });
}

function proposed(taskKind: string, taskId: string): string {
  return event("task.lifecycle.proposed", { event: { kind: "proposed", task_id: taskId, task_kind: taskKind }, task_id: taskId });
}

describe("helper agents in the build room", () => {
  const sample = readFileSync(SUBAGENT_RUN);

  it("turns a real subagent run into one line per reminder agent and a named subagent line", () => {
    const c = condenseMuseLines(completeLines(sample).lines);
    assert.deepEqual(
      c.lines.map((l) => `${l.kind}: ${l.text}`),
      [
        "start: Started",
        "status: Muse Code started its skill reminder",
        "tool: Muse Code started a subagent: scout",
        "tool: A subagent finished: Created scout.txt with the single word ok.",
        "say: The scout has finished.",
        "status: Muse Code started its goal reminder",
        "status: Muse Code started its verify reminder",
        "usage: 3 model calls, 85k input tokens (45k cached), 751 output tokens, about $0.060",
        "done: Done. The scout has finished.",
      ],
    );
    // The skill reminder ran three times in this run, but it is announced once.
    assert.equal((sample.toString("utf8").match(/reminder\.agent\.skill-reminder/g) ?? []).length, 3);
    assert.deepEqual(c.announced, ["reminder:skill", "reminder:goal", "reminder:verify"]);
    assert.deepEqual(
      c.lines.filter((l) => l.kind === "tool").map((l) => l.tool),
      ["subagent_spawn", "subagent_wait"],
    );
    assert.deepEqual(highlightsFrom(c.lines), [
      "2 tool calls, 0 edits touching 0 files",
      "Muse Code started a subagent: scout",
      "A subagent finished: Created scout.txt with the single word ok.",
    ]);
  });

  it("never repeats a reminder across polls of the same run, however the stream is cut", () => {
    const whole = condenseMuseLines(completeLines(sample).lines);
    for (const cut of [3000, 9000, 20_000, 40_000]) {
      const first = completeLines(sample.subarray(0, cut));
      const a = condenseMuseLines(first.lines);
      const b = condenseMuseLines(completeLines(sample.subarray(first.consumed)).lines, a.announced);
      const texts = [...a.lines, ...b.lines].filter((l) => l.kind !== "say").map((l) => l.text);
      assert.deepEqual(texts, whole.lines.filter((l) => l.kind !== "say").map((l) => l.text), `cut at ${cut}`);
    }
  });

  it("announces each reminder agent once per run, and nothing for model calls and tools", () => {
    const lines = [
      proposed("model.meta.response", "t1"),
      proposed("tool.read_file", "t2"),
      proposed("reminder.agent.verify-reminder", "t3"),
      proposed("reminder.agent.verify-reminder", "t4"),
      proposed("reminder.agent.todo-reminder", "t5"),
      proposed("reminder.agent.plugin:reminders:skill-reminder", "t6"),
    ];
    const c = condenseMuseLines(lines, ["reminder:skill"]);
    assert.deepEqual(
      c.lines.map((l) => l.text),
      ["Muse Code started its verify reminder", "Muse Code started its todo reminder"],
    );
    assert.deepEqual(c.announced, ["reminder:skill", "reminder:verify", "reminder:todo"]);
  });

  it("names reminder agents from their task kind", () => {
    assert.equal(reminderName("reminder.agent.verify-reminder"), "verify");
    assert.equal(reminderName("reminder.agent.plugin:reminders:skill-reminder"), "skill");
    assert.equal(reminderName("reminder.agent.memory_reminder"), "memory reminder");
    assert.equal(reminderName("reminder.agent."), null);
    assert.equal(reminderName("tool.subagent_spawn"), null);
  });

  it("reads subagent replies, and keeps other text as it was", () => {
    const spawn = (agentPath?: string) => JSON.stringify({ status: "accepted", subagent_id: "s1", agent_path: agentPath });
    assert.equal(subagentText("subagent_spawn", spawn("main/critic/2")), "Muse Code started a subagent: critic");
    assert.equal(subagentText("subagent_spawn", spawn("main/scout/1/helper/1")), "Muse Code started a subagent: helper");
    assert.equal(subagentText("subagent_spawn", spawn()), "Muse Code started a subagent");
    assert.equal(subagentText("subagent_wait", JSON.stringify({ status: "running", subagent_id: "s1" })), null);
    assert.equal(subagentText("subagent_spawn", "not json"), null);
    assert.equal(subagentText("read_file", spawn("main/x/1")), null);
    // A failed spawn keeps the tool's own words.
    const failed = event("tool.result", {
      correlation_facts: { outcome: "error", tool_name: "subagent_spawn" },
      text: "agent_name_conflict: scout is already running",
    });
    assert.deepEqual(condenseMuseLines([failed]).lines, [
      { kind: "tool", tool: "subagent_spawn", ok: false, text: "agent_name_conflict: scout is already running" },
    ]);
  });
});

/** A goal_usage_attribution record as a session log line, shaped like the fixtures' (only the fields that are read). */
function usageLine(o: {
  at: number;
  ownerType: string;
  runId: string;
  usageId: string;
  input: number;
  cached?: number;
  output: number;
  family?: string;
  /** The session the call belongs to: a reminder's own log names itself here. */
  ownerId?: string;
}): string {
  const record = {
    owner: { owner_type: o.ownerType, run_id: o.runId, ...(o.ownerId ? { owner_id: o.ownerId } : {}) },
    quantity: { input_tokens: o.input, cached_tokens: o.cached ?? 0, output_tokens: o.output },
    usage_family: o.family ?? "provider",
    usage_id: o.usageId,
  };
  return JSON.stringify({ recorded_at: o.at, payload_type: "runtime.session", payload: { event: { kind: "goal_usage_attribution", record } } });
}

describe("usage run.usage leaves out", () => {
  /** Runs SESSION_USAGE_SCRIPT the way pollMuse does, against a copy of the fixture session logs. */
  function readUsage(streamPath: string, dataDir = path.join(FIXTURES, "muse-data")) {
    const res = spawnSync("node", ["-e", SESSION_USAGE_SCRIPT, streamPath], {
      env: { ...process.env, XDG_DATA_HOME: dataDir },
      encoding: "utf8",
    });
    assert.equal(res.status, 0, res.stderr);
    return { stdout: res.stdout, usage: parseSessionUsage(res.stdout) };
  }

  const priced = (inputTokens: number, cachedInputTokens: number, outputTokens: number, model = "muse-spark-1.3") => {
    const u = { model, inputTokens, cachedInputTokens, outputTokens };
    return { ...u, costUsd: usageCost(u) };
  };

  /** A copy of the fixture session logs to add records to, and the session's folder in it. */
  function copyData(name: string) {
    const data = path.join(tmp, name);
    cpSync(path.join(FIXTURES, "muse-data"), data, { recursive: true });
    return { data, sessionDir: path.join(data, `muse/sessions/2026/10/27/${SESSION}`) };
  }

  it("carries run.usage's children_included out of the stream", () => {
    assert.equal(condenseMuseLines(completeLines(readFileSync(SUBAGENT_RUN)).lines).childrenIncluded, false);
    const runUsage = (extra: Record<string, unknown>) =>
      event("run.usage", { calls: 1, models: [{ model: "muse-spark-1.3", input_tokens: 10, cached_tokens: 0, output_tokens: 1, calls: 1 }], ...extra });
    assert.equal(condenseMuseLines([runUsage({ children_included: false })]).childrenIncluded, false);
    assert.equal(condenseMuseLines([runUsage({ children_included: true })]).childrenIncluded, true);
    // A run.usage that doesn't say counts as including them, so they are never charged twice.
    assert.equal(condenseMuseLines([runUsage({})]).childrenIncluded, true);
    assert.equal(condenseMuseLines([proposed("tool.read_file", "t1")]).childrenIncluded, null);
  });

  it("adds the reminder agents from the parent log and the subagent from its own log", () => {
    const { stdout, usage } = readUsage(SUBAGENT_RUN);
    const head = JSON.parse(stdout.split("\n")[0]!);
    assert.equal(head.run_id, RUN_1);
    assert.equal(head.model, "muse-spark-1.3");
    assert.match(head.session_log, new RegExp(`2026/10/27/${SESSION}/session\\.jsonl$`));
    assert.equal(usage.found, true);
    // The main agent matches the run's own run.usage line.
    assert.deepEqual(usage.main, { calls: 3, usage: [priced(84843, 44514, 751)] });
    // Five reminder calls (49004 / 13425 / 3520) and the subagent's two (43996 / 21873 / 144).
    assert.deepEqual(usage.children, { calls: 7, usage: [priced(93000, 35298, 3664)], owners: ["native_child", "reminder_child"] });
    assert.deepEqual(childUsageLine(usage.children), {
      kind: "status",
      text: "Muse Code's reminders and subagents also made 7 model calls, 93k input tokens (35k cached), 3664 output tokens, about $0.093",
    });
  });

  it("counts only the resumed run's own calls in a session that ran before", () => {
    const { usage } = readUsage(RESUMED_RUN);
    assert.equal(usage.runId, RUN_2);
    assert.deepEqual(usage.main, { calls: 1, usage: [priced(28957, 28657, 173)] });
    // The first run's subagent made its calls before this run started, so they aren't counted again.
    assert.deepEqual(usage.children, { calls: 3, usage: [priced(22550, 13681, 1622)], owners: ["reminder_child"] });
  });

  it("counts a subagent a later run resumed, for that run's calls only", () => {
    const { data, sessionDir } = copyData("resumed-subagent");
    // The resumed run sends the scout more work. Its log keeps the first run's two calls above these.
    appendFileSync(
      path.join(sessionDir, "subagent", SCOUT, "session.jsonl"),
      [
        usageLine({ at: RUN_2_START + 1_000_000, ownerType: "native_child", runId: SCOUT, usageId: "usage-scout-r2-a", input: 5000, cached: 1000, output: 50 }),
        usageLine({ at: RUN_2_START + 2_000_000, ownerType: "native_child", runId: SCOUT, usageId: "usage-scout-r2-b", input: 3000, output: 30 }),
      ].join("\n") + "\n",
    );
    const { usage } = readUsage(RESUMED_RUN, data);
    assert.deepEqual(usage.main, { calls: 1, usage: [priced(28957, 28657, 173)] });
    assert.deepEqual(usage.children, {
      calls: 5,
      usage: [priced(22550 + 8000, 13681 + 1000, 1622 + 80)],
      owners: ["native_child", "reminder_child"],
    });
  });

  it("finds a subagent's own subagents and the reminders that ran inside them, priced at their own model", () => {
    const { data, sessionDir } = copyData("nested-subagent");
    const helper = "01a17fa6-4000-7000-8000-000000000001";
    const reminder = "01a17fa6-4000-7000-8000-000000000002";
    const log = path.join(sessionDir, "subagent", SCOUT, "subagent", helper, "session.jsonl");
    const reminderLog = path.join(path.dirname(log), "subagent", reminder, "session.jsonl");
    mkdirSync(path.dirname(reminderLog), { recursive: true });
    const configured = { recorded_at: RUN_1_START + 5_000_000, payload_type: "run.model.configured", payload: { kind: "run_model", record: { model_id: "muse-wonder-1.0" } } };
    const at = RUN_1_START + 6_000_000;
    writeFileSync(
      log,
      [
        JSON.stringify(configured),
        usageLine({ at, ownerType: "native_child", runId: helper, usageId: "usage-helper-1", input: 1000, output: 10 }),
        // The helper's own reminder agent, recorded in the log of the agent it ran for. Tool records are all zero.
        usageLine({ at, ownerType: "reminder_child", runId: helper, ownerId: reminder, usageId: "usage-helper-reminder", input: 999, output: 9 }),
        usageLine({ at, ownerType: "native_child", runId: helper, usageId: "usage-helper-tool", input: 0, output: 0, family: "tool" }),
      ].join("\n") + "\n",
    );
    // The reminder's own log repeats that call under another usage id, naming itself as the owner.
    writeFileSync(reminderLog, `${usageLine({ at, ownerType: "reminder_child", runId: reminder, ownerId: reminder, usageId: "usage-reminder-copy", input: 999, output: 9 })}\n`);
    const { usage } = readUsage(SUBAGENT_RUN, data);
    assert.deepEqual(usage.children, {
      calls: 9,
      usage: [priced(93000, 35298, 3664), priced(1999, 0, 19, "muse-wonder-1.0")],
      owners: ["native_child", "reminder_child"],
    });
  });

  it("reads records inside retained frames, counts a usage id once, and skips tool records", () => {
    const data = path.join(tmp, "frames");
    cpSync(path.join(FIXTURES, "muse-data"), data, { recursive: true });
    const record = (usageId: string, family = "provider") => ({
      payload_type: "runtime.session",
      payload: {
        event: {
          kind: "goal_usage_attribution",
          record: {
            owner: { owner_type: "reminder_child", run_id: RUN_2 },
            quantity: { input_tokens: 1000, cached_tokens: 0, output_tokens: 10 },
            usage_family: family,
            usage_id: usageId,
          },
        },
      },
    });
    const frame = { retained_frame: "x", children: [{ record_json: JSON.stringify(record("usage-framed")) }] };
    appendFileSync(
      path.join(data, `muse/sessions/2026/10/27/${SESSION}/session.jsonl`),
      [frame, record("usage-framed"), record("usage-tool", "tool")].map((r) => JSON.stringify(r)).join("\n") + "\n",
    );
    const { usage } = readUsage(RESUMED_RUN, data);
    assert.deepEqual(usage.children, { calls: 4, usage: [priced(23550, 13681, 1632)], owners: ["reminder_child"] });
  });

  it("reports nothing found when the session log is missing", () => {
    const { stdout, usage } = readUsage(SUBAGENT_RUN, path.join(tmp, "empty"));
    assert.equal(JSON.parse(stdout.trim()).session_log, null);
    assert.deepEqual(usage, {
      runId: RUN_1,
      found: false,
      main: { calls: 0, usage: [] },
      unreported: { calls: 0, usage: [] },
      children: { calls: 0, usage: [], owners: [] },
      unknown: { calls: 0, usage: [], owners: [] },
    });
  });

  it("parses the script's output on its own terms", () => {
    const head = JSON.stringify({ session_id: SESSION, run_id: "run-a", model: "muse-wonder-1.0", session_log: "/x" });
    const rec = (ownerType: string, runId: string, input: number, ownerId?: string) =>
      JSON.stringify({
        usage_family: "provider",
        usage_id: `${ownerType}-${input}`,
        owner: { owner_type: ownerType, run_id: runId, ...(ownerId ? { owner_id: ownerId } : {}) },
        quantity: { input_tokens: input, cached_tokens: 0, output_tokens: 1 },
      });
    const child = (ownerType: string, input: number, model: string | null, ownerId?: string) =>
      JSON.stringify({ child_session: "c1", model, record: JSON.parse(rec(ownerType, "c1", input, ownerId)) });
    const out = parseSessionUsage(
      [
        head,
        rec("main_root", "run-a", 100),
        rec("reminder_child", "run-a", 50),
        rec("reminder_child", "run-b", 999),
        child("native_child", 70, "muse-spark-1.3"),
        child("workflow_child", 40, "muse-spark-1.3"),
        // A reminder that ran inside the child counts; a copy in a reminder's own log, or of the main agent, doesn't.
        child("reminder_child", 888, null, "r1"),
        child("reminder_child", 555, null, "c1"),
        child("main_root", 777, null),
        // The same call in two logs.
        child("native_child", 70, "muse-spark-1.3"),
        // Never measured, or not where it was measured: not charged, since run.usage or another log may have them.
        rec("workflow_child", "run-a", 30),
        rec("native_child", "run-a", 45),
        child("side_session", 60, "muse-spark-1.3"),
        "not json",
      ].join("\n"),
    );
    assert.equal(out.main.usage[0]!.model, "muse-wonder-1.0");
    assert.deepEqual(
      out.children.usage.map((u) => [u.model, u.inputTokens]),
      [
        ["muse-wonder-1.0", 938],
        ["muse-spark-1.3", 110],
      ],
    );
    assert.equal(out.children.calls, 4);
    assert.deepEqual(out.children.owners, ["native_child", "reminder_child", "workflow_child"]);
    assert.deepEqual(
      out.unknown.usage.map((u) => [u.model, u.inputTokens]),
      [
        ["muse-wonder-1.0", 75],
        ["muse-spark-1.3", 60],
      ],
    );
    assert.deepEqual([out.unknown.calls, out.unknown.owners], [3, ["native_child", "side_session", "workflow_child"]]);
    // A header from before run_ids and reported: one run, with no run.usage on record.
    assert.deepEqual(out.unreported, out.main);
    assert.equal(parseSessionUsage("").found, false);
  });

  /** recorded_at for the made-up session logs below: any time before the test runs, in microseconds. */
  const T = 1_793_300_000_000_000;
  const WF_SESSION = "c5a3919d-896c-48ec-848b-506bea42eeae";
  const WF_RUN_1 = "01a18fef-cc18-7310-8d8f-66de7ede076c";
  const WF_RUN_2 = "01a18fef-e6b3-78c3-aa33-da15ebd0a0d6";
  const WF_CHILD = "ef22baad-ff3c-7dc5-8064-0d92ac361f2d";
  const GOAL_REMINDER = "01a18fef-fa08-7b10-9e4f-28b288f2d456";
  const VERIFY_REMINDER = "01a18fef-fa0d-7f43-9422-9e7e8d482370";

  /**
   * Session logs shaped like the Oct 30 workflow run's (fixtures/muse-exec-workflow.jsonl): the parent log has both
   * runs' main agent calls (their sums match each run's run.usage) and three reminder calls; the workflow child's log
   * has its own calls and one reminder that ran inside it; two reminders' own logs repeat their parent records.
   */
  function workflowSession(name: string) {
    const data = path.join(tmp, name);
    const dir = path.join(data, `muse/sessions/2026/10/31/${WF_SESSION}`);
    const write = (rel: string, lines: string[]) => {
      mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      writeFileSync(path.join(dir, rel), `${lines.join("\n")}\n`);
    };
    const parent = (at: number, ownerType: string, runId: string, usageId: string, input: number, cached: number, output: number, ownerId?: string) =>
      usageLine({ at: T + at, ownerType, runId, usageId, input, cached, output, ownerId });
    write("session.jsonl", [
      // An earlier round's call, before this round's first line.
      parent(0, "main_root", "01a18fe0-0000-7000-8000-000000000000", "usage-old", 50_000, 0, 500),
      JSON.stringify({ recorded_at: T + 10, payload_type: "runtime.command.accepted", payload: { command_id: WF_RUN_1 } }),
      parent(20, "main_root", WF_RUN_1, "usage-m1", 25584, 0, 460),
      parent(21, "main_root", WF_RUN_1, "usage-m1-tool", 0, 0, 0).replace('"provider"', '"tool"'),
      parent(30, "reminder_child", WF_RUN_1, "usage-skill", 13000, 0, 400, "01a18fef-cc32-7720-8fda-bead823d7b35"),
      parent(40, "main_root", WF_RUN_2, "usage-m2a", 28773, 0, 180),
      parent(50, "main_root", WF_RUN_2, "usage-m2b", 28608, 28273, 71),
      parent(60, "reminder_child", WF_RUN_2, "usage-goal", 4200, 0, 300, GOAL_REMINDER),
      parent(61, "reminder_child", WF_RUN_2, "usage-verify", 4100, 0, 900, VERIFY_REMINDER),
    ]);
    const configured = JSON.stringify({ recorded_at: T + 25, payload_type: "run.model.configured", payload: { kind: "run_model", record: { model_id: "muse-spark-1.3-contributor" } } });
    write(`subagent/${WF_CHILD}/session.jsonl`, [
      configured,
      parent(26, "workflow_child", WF_CHILD, "usage-w1", 9000, 0, 120),
      parent(27, "workflow_child", WF_CHILD, "usage-w1-tool", 0, 0, 0).replace('"provider"', '"tool"'),
      parent(28, "workflow_child", WF_CHILD, "usage-w2", 9500, 8800, 40),
      parent(29, "reminder_child", WF_CHILD, "usage-w-reminder", 3000, 0, 50, "01a18fef-d000-7000-8000-000000000003"),
      parent(29, "team_child", WF_CHILD, "usage-team", 777, 0, 7),
    ]);
    write(`subagent/${GOAL_REMINDER}/session.jsonl`, [parent(60, "reminder_child", GOAL_REMINDER, "usage-goal-copy", 4200, 0, 300, GOAL_REMINDER)]);
    write(`subagent/${VERIFY_REMINDER}/session.jsonl`, [parent(61, "reminder_child", VERIFY_REMINDER, "usage-verify-copy", 4100, 0, 900, VERIFY_REMINDER)]);
    return data;
  }
  const contributor = (inputTokens: number, cachedInputTokens: number, outputTokens: number) => priced(inputTokens, cachedInputTokens, outputTokens, "muse-spark-1.3-contributor");

  it("sums every run's run.usage in one exec, as a workflow's completion arrives in a second run", () => {
    const c = condenseMuseLines(completeLines(readFileSync(path.join(FIXTURES, "muse-exec-workflow.jsonl"))).lines);
    assert.deepEqual(c.usage, [contributor(25584 + 57381, 28273, 460 + 251)]);
    assert.equal(c.childrenIncluded, false);
    assert.equal(c.finalText, "WORKFLOW-OK");
    assert.deepEqual(
      c.lines.filter((l) => l.kind !== "status").map((l) => `${l.kind}: ${l.text}`),
      [
        "start: Started",
        "tool: Muse Code started a workflow: echo-workflow-ok",
        "usage: 1 model call, 26k input tokens (0 cached), 460 output tokens, about $0.003",
        "done: Done",
        "start: Started",
        `tool: ${c.lines.find((l) => l.tool === "read_file")!.text}`,
        "say: WORKFLOW-OK",
        "usage: 2 model calls, 57k input tokens (28k cached), 251 output tokens, about $0.003",
        "done: Done. WORKFLOW-OK",
      ],
    );
  });

  it("charges a workflow's children and both of its runs, each call once", () => {
    const { stdout, usage } = readUsage(path.join(FIXTURES, "muse-exec-workflow.jsonl"), workflowSession("workflow"));
    const head = JSON.parse(stdout.split("\n")[0]!);
    assert.deepEqual([head.run_ids, head.reported, head.model], [[WF_RUN_1, WF_RUN_2], [WF_RUN_1, WF_RUN_2], "muse-spark-1.3-contributor"]);
    // The main agent's calls match the two run.usage events, so none is left unreported.
    assert.deepEqual(usage.main, { calls: 3, usage: [contributor(82965, 28273, 711)] });
    assert.deepEqual(usage.unreported, { calls: 0, usage: [] });
    // Three reminders from the parent log, two workflow-child calls and the reminder inside the child; never the
    // reminders' own copies.
    assert.deepEqual(usage.children, { calls: 6, usage: [contributor(21300 + 18500 + 3000, 8800, 1600 + 160 + 50)], owners: ["reminder_child", "workflow_child"] });
    assert.deepEqual(usage.unknown, { calls: 1, usage: [contributor(777, 0, 7)], owners: ["team_child"] });
    assert.match(childUsageLine(usage.children).text, /^Muse Code's reminders and workflow agents also made 6 model calls, 43k input tokens \(8800 cached\)/);
  });

  it("leaves a run that ended before its run.usage to the session log", () => {
    const stream = readFileSync(path.join(FIXTURES, "muse-exec-workflow.jsonl"), "utf8").split("\n");
    const lastUsage = stream.findLastIndex((l) => l.includes('"run.usage"'));
    const cut = path.join(tmp, "workflow-cut.jsonl");
    writeFileSync(cut, `${stream.slice(0, lastUsage).join("\n")}\n`);
    const { usage } = readUsage(cut, workflowSession("workflow-cut"));
    assert.deepEqual(usage.unreported, { calls: 2, usage: [contributor(28773 + 28608, 28273, 251)] });
    assert.equal(usage.main.calls, 3);
  });

  it("reads a session bridge log: the session, each turn as a run, and no run.usage at all", () => {
    // The Oct 30 spike's stream, as the bridge logs it.
    const spike = readFileSync(path.join(FIXTURES, "msp-goal-steer.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    const session = "01a18fef-7c76-73e1-b8e5-35e7c25ebd8b";
    const turn = "01a18fef-7d18-7000-8e07-b15f13c15afc";
    const records: Array<Record<string, unknown>> = [
      { t: 1, kind: "bridge", event: "started", sessionId: session },
      ...spike.flatMap((o): Array<Record<string, unknown>> => {
        if (o.note) return [{ t: o.t, kind: "note", method: (o.note as { method: string }).method, params: (o.note as { params: unknown }).params }];
        if (o.call) return [{ t: o.t, kind: "call", method: o.call, ok: o.ok, result: o.result }];
        if (o.sessionId) return [{ t: o.t, kind: "bridge", event: "session", sessionId: o.sessionId, reason: "started" }];
        return [];
      }),
      { t: 2, kind: "bridge", event: "exit", exitCode: 0, reason: "completed" },
    ];
    const log = path.join(tmp, "muse-r0.msp.jsonl");
    writeFileSync(log, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const data = path.join(tmp, "bridge-data");
    const dir = path.join(data, `muse/sessions/2026/10/31/${session}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "session.jsonl"),
      [
        usageLine({ at: T, ownerType: "main_root", runId: "01a18fee-0000-7000-8000-000000000000", usageId: "usage-earlier-round", input: 9999, output: 9 }),
        JSON.stringify({ recorded_at: T + 1, payload_type: "runtime.command.accepted", payload: { command_id: turn } }),
        ...[27129, 27512, 27995, 28238, 28478].map((input, i) => usageLine({ at: T + 2 + i, ownerType: "main_root", runId: turn, usageId: `usage-main-${i}`, input, output: 50 })),
        usageLine({ at: T + 9, ownerType: "reminder_child", runId: turn, ownerId: "01a18fef-7d5d-74e1-b7e8-d1fed03a8619", usageId: "usage-skill", input: 13000, output: 300 }),
      ].join("\n") + "\n",
    );
    const { stdout, usage } = readUsage(log, data);
    const head = JSON.parse(stdout.split("\n")[0]!);
    assert.deepEqual([head.session_id, head.run_ids, head.reported, head.model], [session, [turn], [], "muse-spark-1.3-contributor"]);
    assert.equal(usage.main.calls, 5);
    assert.deepEqual(usage.unreported, usage.main, "the bridge has no run.usage, so the log is the only count");
    assert.deepEqual(usage.children, { calls: 1, usage: [contributor(13000, 0, 300)], owners: ["reminder_child"] });
  });

  it("describes who the child calls were", () => {
    assert.equal(ownersLabel(["reminder_child"]), "reminders");
    assert.equal(ownersLabel(["native_child", "reminder_child"]), "reminders and subagents");
    assert.equal(ownersLabel(["workflow_child", "mystery", "native_child", "reminder_child"]), "reminders, subagents, workflow agents and helper agents");
    assert.equal(ownersLabel([]), "helper agents");
  });
});
