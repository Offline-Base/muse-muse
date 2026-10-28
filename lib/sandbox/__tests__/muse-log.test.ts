/**
 * Unit tests for the build-room lines about Muse Code's helper agents and for the usage run.usage leaves out, on real
 * Muse Code 1.4.14 output from Oct 27: a run that spawned one subagent (fixtures/muse-exec-subagent.jsonl), the same
 * session resumed with an image (fixtures/muse-exec-resumed-head.jsonl, first lines only), and trimmed copies of that
 * session's logs (fixtures/muse-data). SESSION_USAGE_SCRIPT runs in real node against them, and against copies with
 * records added for cases the real run didn't have (a resumed subagent, a nested one).
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
function usageLine(o: { at: number; ownerType: string; runId: string; usageId: string; input: number; cached?: number; output: number; family?: string }): string {
  const record = {
    owner: { owner_type: o.ownerType, run_id: o.runId },
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

  it("finds a subagent's own subagents, priced at their own model", () => {
    const { data, sessionDir } = copyData("nested-subagent");
    const helper = "01a17fa6-4000-7000-8000-000000000001";
    const log = path.join(sessionDir, "subagent", SCOUT, "subagent", helper, "session.jsonl");
    mkdirSync(path.dirname(log), { recursive: true });
    const configured = { recorded_at: RUN_1_START + 5_000_000, payload_type: "run.model.configured", payload: { kind: "run_model", record: { model_id: "muse-wonder-1.0" } } };
    const at = RUN_1_START + 6_000_000;
    writeFileSync(
      log,
      [
        JSON.stringify(configured),
        usageLine({ at, ownerType: "native_child", runId: helper, usageId: "usage-helper-1", input: 1000, output: 10 }),
        // Its reminder agent's calls repeat another log's, and tool records are all zero.
        usageLine({ at, ownerType: "reminder_child", runId: helper, usageId: "usage-helper-reminder", input: 999, output: 9 }),
        usageLine({ at, ownerType: "native_child", runId: helper, usageId: "usage-helper-tool", input: 0, output: 0, family: "tool" }),
      ].join("\n") + "\n",
    );
    const { usage } = readUsage(SUBAGENT_RUN, data);
    assert.deepEqual(usage.children, {
      calls: 8,
      usage: [priced(93000, 35298, 3664), priced(1000, 0, 10, "muse-wonder-1.0")],
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
      children: { calls: 0, usage: [], owners: [] },
      unknown: { calls: 0, usage: [], owners: [] },
    });
  });

  it("parses the script's output on its own terms", () => {
    const head = JSON.stringify({ session_id: SESSION, run_id: "run-a", model: "muse-wonder-1.0", session_log: "/x" });
    const rec = (ownerType: string, runId: string, input: number) =>
      JSON.stringify({ usage_family: "provider", usage_id: `${ownerType}-${input}`, owner: { owner_type: ownerType, run_id: runId }, quantity: { input_tokens: input, cached_tokens: 0, output_tokens: 1 } });
    const child = (ownerType: string, input: number, model: string | null) =>
      JSON.stringify({ child_session: "c1", model, record: JSON.parse(rec(ownerType, "c1", input)) });
    const out = parseSessionUsage(
      [
        head,
        rec("main_root", "run-a", 100),
        rec("reminder_child", "run-a", 50),
        rec("reminder_child", "run-b", 999),
        child("native_child", 70, "muse-spark-1.3"),
        child("reminder_child", 888, null),
        child("main_root", 777, null),
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
        ["muse-wonder-1.0", 50],
        ["muse-spark-1.3", 70],
      ],
    );
    assert.equal(out.children.calls, 2);
    assert.deepEqual(out.children.owners, ["native_child", "reminder_child"]);
    assert.deepEqual(
      out.unknown.usage.map((u) => [u.model, u.inputTokens]),
      [
        ["muse-wonder-1.0", 75],
        ["muse-spark-1.3", 60],
      ],
    );
    assert.deepEqual([out.unknown.calls, out.unknown.owners], [3, ["native_child", "side_session", "workflow_child"]]);
    assert.equal(parseSessionUsage("").found, false);
  });

  it("describes who the child calls were", () => {
    assert.equal(ownersLabel(["reminder_child"]), "reminders");
    assert.equal(ownersLabel(["native_child", "reminder_child"]), "reminders and subagents");
    assert.equal(ownersLabel(["workflow_child", "mystery", "native_child", "reminder_child"]), "reminders, subagents, workflow agents and helper agents");
    assert.equal(ownersLabel([]), "helper agents");
  });
});
