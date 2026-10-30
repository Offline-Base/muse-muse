/**
 * The scheduling, fanout and goal logic against their recipes: cron parsing, words and next runs in local time, the
 * seven-day lifetime and bounded recovery; the concurrency limit, queueing, late steers and cooperative cancels; the
 * step probe and the completion audit.
 *
 *   npx tsx --test --experimental-test-module-mocks components/docs/playgrounds/muse-code-cookbook/__tests__/cron-fanout-goal.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { describeCron, firesWithinLifetime, formatFireWindow, formatLocal, isFixedDate, jobId, nextFire, nextRuns, parseCron, recovery, type Job } from "@/components/docs/playgrounds/muse-code-cookbook/logic/cron";
import { BASTION_PLAN, cancel, concurrencyLimit, mergeOrderProblems, overlaps, spawnAll, statusOf, steer, tick, type Board } from "@/components/docs/playgrounds/muse-code-cookbook/logic/fanout";
import { evidenceInReport, gateCompletion, goalIndicator, GOAL_PRESETS, remindersAfter } from "@/components/docs/playgrounds/muse-code-cookbook/logic/goal";

const cron = (e: string) => {
  const p = parseCron(e);
  assert.ok(p.ok, e);
  return p.cron;
};
const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi);

describe("cron", () => {
  it("shows a recurring job's next fire as its jitter window, and a one-time job's as its base time", () => {
    assert.equal(formatFireWindow(at(2026, 10, 30, 8), true), "Fri, Oct 30, 8:00 AM to 8:30 AM");
    assert.equal(formatFireWindow(at(2026, 10, 30, 23, 45), true), "Fri, Oct 30, 11:45 PM to Sat, Oct 31, 12:15 AM", "a window past midnight names the next day");
    assert.equal(formatFireWindow(at(2026, 10, 31, 14), false), "Sat, Oct 31, 2:00 PM");
  });

  it("parses and describes the recipe's daily digest", () => {
    assert.equal(describeCron(cron("0 8 * * *")), "At 8:00 AM, every day");
    const [first, second] = nextRuns(cron("0 8 * * *"), at(2026, 10, 30, 9, 0), 2);
    assert.deepEqual([first, second], [at(2026, 10, 31, 8), at(2026, 11, 1, 8)]);
    assert.equal(formatLocal(at(2026, 10, 31, 8)), "Sat, Oct 31, 8:00 AM");
  });

  it("describes steps, weekday ranges, names and one-time dates", () => {
    assert.equal(describeCron(cron("*/15 * * * *")), "Every 15 minutes");
    assert.deepEqual(nextRuns(cron("*/15 * * * *"), at(2026, 10, 30, 9, 7), 3), [at(2026, 10, 30, 9, 15), at(2026, 10, 30, 9, 30), at(2026, 10, 30, 9, 45)]);
    assert.equal(describeCron(cron("30 9 * * 1-5")), "At 9:30 AM on Monday through Friday");
    assert.deepEqual(nextRuns(cron("30 9 * * 1-5"), at(2026, 10, 31, 10), 1), [at(2026, 11, 2, 9, 30)], "Saturday to Monday");
    assert.deepEqual(cron("0 10 * * MON").fields[4].values, [1]);
    assert.deepEqual(cron("0 10 * * 7").fields[4].values, [0], "7 is Sunday");
    assert.equal(describeCron(cron("0 14 31 10 *")), "At 2:00 PM on October 31");
    assert.equal(isFixedDate(cron("0 14 31 10 *")), true);
    assert.equal(isFixedDate(cron("0 8 * * *")), false);
  });

  it("uses either day field when both are restricted", () => {
    const runs = nextRuns(cron("0 0 13 * 5"), at(2026, 11, 1), 3);
    assert.deepEqual(runs, [at(2026, 11, 6), at(2026, 11, 13), at(2026, 11, 20)], "Fridays and the 13th");
  });

  it("rejects what isn't a five-field expression", () => {
    assert.deepEqual(parseCron("0 8 * *"), { ok: false, errors: ["A cron expression has 5 fields (minute hour day-of-month month day-of-week); this one has 4."] });
    assert.deepEqual(parseCron("61 8 * * *"), { ok: false, errors: ['minute: "61" is outside 0 to 59'] });
    assert.equal(parseCron("0 8 * * FUNDAY").ok, false);
    assert.equal(parseCron("*/0 * * * *").ok, false);
  });

  it("counts fires inside the seven-day lifetime and stops after it", () => {
    const job: Job = { id: "3a3a0d42", cron: "0 8 * * *", recurring: true, task: "triage", createdAt: at(2026, 10, 30, 9).getTime(), session: "s1", lastFiredAt: null, fireCount: 0 };
    assert.equal(firesWithinLifetime(job), 7);
    assert.deepEqual(nextFire(job, at(2026, 10, 30, 9).getTime()), at(2026, 10, 31, 8));
    assert.equal(nextFire(job, at(2026, 11, 6, 9).getTime()), null, "expired");
    // Seven days in June have no daylight-saving change, so a job every minute fires 7 x 24 x 60 times.
    assert.equal(firesWithinLifetime({ ...job, cron: "* * * * *", createdAt: at(2026, 6, 1, 9).getTime() }), 10_080);
  });

  it("delivers at most one catch-up after Muse Code was closed", () => {
    const job: Job = { id: "a", cron: "0 8 * * *", recurring: true, task: "t", createdAt: at(2026, 10, 30, 7).getTime(), session: "s", lastFiredAt: null, fireCount: 0 };
    const r = recovery(job, at(2026, 10, 30, 7).getTime(), at(2026, 11, 2, 12).getTime());
    assert.deepEqual([r.missed, r.catchUpRuns], [4, 1]);
    const once: Job = { ...job, cron: "0 14 31 10 *", recurring: false };
    assert.deepEqual([recovery(once, at(2026, 10, 31, 9).getTime(), at(2026, 10, 31, 18).getTime()).catchUpRuns], [1]);
    assert.equal(recovery({ ...once, fireCount: 1 }, at(2026, 10, 31, 9).getTime(), at(2026, 10, 31, 18).getTime()).missed, 0, "already delivered");
    assert.equal(nextFire({ ...once, fireCount: 1 }, at(2026, 10, 30).getTime()), null, "a one-time job deletes itself after delivery");
  });

  it("makes 8-hex job ids", () => {
    let i = 0;
    const digits = [3, 3, 10, 3, 0, 13, 4, 2].map((d) => (d + 0.5) / 16);
    assert.equal(jobId(() => digits[i++ % 8]), "33a30d42");
    assert.match(jobId(), /^[0-9a-f]{8}$/);
  });
});

describe("fanout board", () => {
  it("clamps the concurrency limit to 4 through 8", () => {
    assert.deepEqual([2, 6, 8, 10, 16, 64].map(concurrencyLimit), [4, 4, 6, 8, 8, 8]);
  });

  it("spawns up to the limit and queues the rest in submission order", () => {
    let board = spawnAll(BASTION_PLAN, { cores: 4, isolation: true });
    assert.equal(board.limit, 4);
    assert.deepEqual(board.children.map((c) => c.state), ["running", "running", "running", "running", "queued", "queued"]);
    assert.equal(board.children[0].worktree, ".muse/worktrees/subagent-v2-...-subagent-1");
    assert.match(board.children[0].events.join("\n"), /workspace_scope_activated \(base_commit e426b70, base_ref HEAD, cleanup_policy remove_if_clean\)/);
    for (let i = 0; i < 8 && board.children.some((c) => c.state !== "result_ready"); i++) board = tick(board);
    assert.equal(board.children.every((c) => c.state === "result_ready"), true);
    assert.deepEqual(statusOf(board)[5], { subagent_id: "subagent-6", state: "result_ready", task: BASTION_PLAN.tasks[5].objective, worktree: ".muse/worktrees/subagent-v2-...-subagent-6" });
  });

  it("rejects worktree spawns when isolation is off", () => {
    const board = spawnAll(BASTION_PLAN, { cores: 8, isolation: false });
    assert.equal(board.children.every((c) => c.state === "rejected"), true);
    assert.match(board.children[0].events[0], /"reason":"worktree_isolation_unavailable","cause":"isolation_not_enabled_in_profile"/);
  });

  it("lets a queued steer arrive too late, and an interrupt land now", () => {
    const one = { ...BASTION_PLAN, tasks: [BASTION_PLAN.tasks[0]] };
    let board: Board = spawnAll(one, { cores: 8, isolation: true });
    const needed = board.children[0].turnsNeeded;
    for (let i = 0; i < needed - 1; i++) board = tick(board);
    board = steer(board, "subagent-1", "name the file ENGINE_NOTES.md", "queue");
    board = tick(board);
    assert.equal(board.children[0].state, "result_ready");
    assert.equal(board.children[0].steers[0].status, "too_late");

    let b2 = spawnAll(one, { cores: 8, isolation: true });
    b2 = steer(b2, "subagent-1", "stop and rename", "interrupt");
    assert.equal(b2.children[0].steers[0].status, "delivered");
    assert.equal(b2.children[0].turnsNeeded, needed + 1);
  });

  it("cancels cooperatively, and only records the reason for a finished child", () => {
    let board = spawnAll(BASTION_PLAN, { cores: 8, isolation: true });
    board = cancel(board, "subagent-2", "descoping render notes");
    assert.equal(board.children[1].state, "closing");
    board = tick(board);
    assert.equal(board.children[1].state, "cancelled");
    for (let i = 0; i < 6; i++) board = tick(board);
    board = cancel(board, "subagent-6", "descoping power-ups for this batch");
    assert.equal(board.children[5].cancel?.outcome, "already_terminal");
    assert.equal(
      board.children[5].events.at(-1),
      JSON.stringify({ kind: "cancel_outcome", subagent_id: "subagent-6", outcome: "already_terminal", reason: "descoping power-ups for this batch" }),
    );
  });

  it("lets a child mid-write finish when the cancel lands", () => {
    const one = { ...BASTION_PLAN, tasks: [BASTION_PLAN.tasks[2]] };
    let board = spawnAll(one, { cores: 8, isolation: true });
    for (let i = 0; i < board.children[0].turnsNeeded - 1; i++) board = tick(board);
    board = tick(cancel(board, "subagent-1", "stop"));
    assert.equal(board.children[0].state, "result_ready");
    assert.match(board.children[0].note ?? "", /cooperative/);
  });

  it("finds file overlaps and checks the merge order", () => {
    assert.ok(overlaps(BASTION_PLAN.tasks).some((o) => o.a === "fix-enemy-laser" && o.b === "combo" && o.files.includes("game/engine.py")));
    assert.deepEqual(mergeOrderProblems(BASTION_PLAN), []);
    assert.deepEqual(mergeOrderProblems({ ...BASTION_PLAN, merge_order: ["combo", "combo", "ghost"] }).slice(0, 3), [
      "merge_order lists combo twice",
      "merge_order names ghost, which isn't a task",
      "merge_order leaves out fix-enemy-laser",
    ]);
  });
});

describe("goal tracking", () => {
  const preset = GOAL_PRESETS[0];
  const all = (status: "pass" | "fail", evidence: string) => preset.checks.map((c) => ({ id: c.id, status, evidence }));

  it("reminds every ten calls without progress", () => {
    assert.deepEqual([0, 9, 10, 19, 25].map(remindersAfter), [0, 0, 1, 1, 2]);
    assert.equal(goalIndicator("Migrate the Perigord API gateway from the legacy Kestrel token scheme"), "Goal(Migrate the Perigord API gateway from the...)");
    assert.equal(goalIndicator("Ship it"), "Goal(Ship it)");
  });

  it("closes the goal only when every check passes with evidence from the report", () => {
    const report = preset.reports[1].text;
    const ok = gateCompletion(preset.checks, all("pass", "6 passed in 0.14s"), report);
    assert.equal(ok.allowed, true);
    assert.match(ok.reply, /accepted/);
    const red = gateCompletion(preset.checks, [...all("pass", "6 passed in 0.14s").slice(0, 4), { id: "acceptance-green", status: "fail", evidence: "4 passed, 2 failed" }], report);
    assert.equal(red.allowed, false);
    assert.deepEqual(red.failing, ["acceptance-green"]);
    const noProof = gateCompletion(preset.checks, all("pass", ""), report);
    assert.deepEqual(noProof.unproven.length, preset.checks.length);
    const madeUp = gateCompletion(preset.checks, all("pass", "all 12 integration suites green on staging"), report);
    assert.equal(madeUp.allowed, false, "evidence that isn't in the report doesn't count");
    const skipped = gateCompletion(preset.checks, [], report);
    assert.match(skipped.reply, /refused by the completion audit: 5 without evidence/);
  });

  it("accepts a quote with different spacing or a close paraphrase, not an invention", () => {
    const report = "$ python3 -m pytest -q test_falcon_acceptance.py\n6 passed in 0.14s";
    assert.equal(evidenceInReport('"6 passed  in 0.14s"', report), true);
    assert.equal(evidenceInReport("pytest -q test_falcon_acceptance.py: 6 passed", report), true);
    assert.equal(evidenceInReport("the deploy pipeline is green", report), false);
    assert.equal(evidenceInReport("", report), false);
  });
});
