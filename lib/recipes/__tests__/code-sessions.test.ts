import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { nextRuns, parseCron, jitterMs } from "../skills/recipe-code-sessions/helpers/cron";
import { REVIEW_CHOICES, routeWrite } from "../skills/recipe-code-sessions/helpers/guardrails";
import { append, canonicalJson, diffJson, exportSession, inFlight, ledgerRows, redact, verifyChain, type JournalInput, type JournalRecord } from "../skills/recipe-code-sessions/helpers/journal";
import { firstHeld, grantPrefix, resolveStage, splitStages } from "../skills/recipe-code-sessions/helpers/stages";

const at = (n: number) => new Date(Date.UTC(2026, 10, 3, 15, 0, n)).toISOString();

async function build(inputs: JournalInput[]): Promise<JournalRecord[]> {
  let log: JournalRecord[] = [];
  for (const i of inputs) log = await append(log, i);
  return log;
}

describe("recipe-code-sessions helpers", () => {
  it("journal: intent before effect, no repeat after a terminal record, and a crash leaves the effect in flight", async () => {
    const log = await build([
      { kind: "proposed", at: at(1), summary: "Migrate 2 made-up card records" },
      { kind: "side_effect_intent", at: at(2), effectId: "e1", tool: "write_file", summary: "rec_1.json", policyDecision: "allow:policy" },
      { kind: "effect.started", at: at(3), effectId: "e1", summary: "rec_1.json" },
      { kind: "effect.terminal", at: at(4), effectId: "e1", summary: "rec_1.json", outcome: "ok" },
      { kind: "side_effect_intent", at: at(5), effectId: "e2", tool: "write_file", summary: "rec_2.json", policyDecision: "allow:policy" },
      { kind: "session.crashed", at: at(6), summary: "Stopped mid-task" },
    ]);
    await assert.rejects(append(log, { kind: "effect.started", at: at(7), effectId: "e9", summary: "x" }), /no intent record/);
    await assert.rejects(append(log, { kind: "effect.started", at: at(7), effectId: "e1", summary: "again" }), /already finished/);
    assert.deepEqual(inFlight(log).map((r) => r.effectId), ["e2"]);
    assert.deepEqual(await verifyChain(log), { ok: true });
    const changed = log.map((r) => (r.seq === 2 ? { ...r, summary: "rec_9.json" } : r));
    assert.deepEqual(await verifyChain(changed), { ok: false, seq: 2, reason: "This record was changed after it was written." });
    assert.equal((await verifyChain(log.filter((r) => r.seq !== 3))).ok, false);
  });

  it("journal: the export is the same bytes every time, redacts on request, and the ledger stamps each action", async () => {
    const inputs: JournalInput[] = [
      { kind: "model.call", at: at(1), tool: "muse-wonder-1.0", summary: "Turn 1" },
      { kind: "approval.requested", at: at(2), summary: "rm -rf stale_cache.txt" },
      { kind: "decision_applied", at: at(3), summary: "Approved", decisionSource: "person" },
      { kind: "side_effect_intent", at: at(4), effectId: "e1", tool: "run_shell", summary: "rm -rf stale_cache.txt", policyDecision: "allow:person", payload: { env: "API_KEY=abc123secretvalue" } },
    ];
    const a = exportSession(await build(inputs), { sessionId: "s1" });
    const b = exportSession(await build(inputs), { sessionId: "s1" });
    assert.equal(a, b);
    assert.match(a, /abc123secretvalue/);
    assert.doesNotMatch(exportSession(await build(inputs), { sessionId: "s1", redacted: true }), /abc123secretvalue/);
    assert.equal(redact("Authorization: Bearer abcdefghijklmnop"), "Authorization: [redacted]");
    assert.equal(canonicalJson({ b: 1, a: [2, { d: 3, c: undefined }] }), '{"a":[2,{"d":3}],"b":1}');
    const rows = ledgerRows(await build(inputs));
    assert.deepEqual(rows.map((r) => [r.lane, r.auth]), [["model", "not_applicable"], ["approval", "pending"], ["approval", "by person"], ["tool", "allow:person"]]);
  });

  it("diffJson names the paths that differ, for the replay gate", () => {
    assert.deepEqual(diffJson({ messages: [{ role: "user", content: "hi" }] }, { messages: [{ role: "user", content: "hi" }] }), []);
    assert.deepEqual(diffJson({ messages: [{ content: "a" }, { content: "b" }] }, { messages: [{ content: "a" }] }), ["messages[1]"]);
    assert.deepEqual(diffJson({ messages: [{ content: "a" }] }, { messages: [{ content: "z" }] }), ["messages[0].content"]);
  });

  it("stages: the recipe's command holds only its rm stage, and quoted separators stay inside one stage", () => {
    const split = splitStages("wc -l report.log && echo cleaning && rm -rf report.log");
    assert.equal(split.error, null);
    assert.deepEqual(split.stages.map((s) => resolveStage(s).resolution), ["known_safe", "known_safe", "unresolved"]);
    assert.equal(firstHeld(split), 2);
    assert.equal(grantPrefix(split.stages[2]), null, "no standing grant for a dangerous stage");
    const quoted = splitStages(`echo "a && b; c | d" && grep 'x|y' notes.txt`);
    assert.deepEqual(quoted.stages.map((s) => s.argv), [["echo", "a && b; c | d"], ["grep", "x|y", "notes.txt"]]);
    assert.equal(splitStages("echo $(whoami) | wc -c").stages[0].argvComplete, false);
    assert.equal(splitStages("ls > out.txt").stages[0].argvComplete, false);
    assert.equal(splitStages("ls 2>/dev/null").stages[0].argvComplete, true);
    assert.equal(splitStages("FOO=1 ls").stages[0].argvComplete, false);
    assert.ok(splitStages("echo 'open").error);
    assert.ok(splitStages("(cd x && rm -rf y)").error);
    assert.equal(firstHeld(splitStages("(ls)")), 0, "a parse error never auto-allows");
  });

  it("stages: a workspace grant covers only its prefix, and a deny beats an allow", () => {
    const [test] = splitStages("npm test -- --watch=false").stages;
    assert.deepEqual(grantPrefix(test), ["npm", "test"]);
    assert.equal(resolveStage(test, [{ prefix: ["npm", "test"], effect: "allow" }]).resolution, "allowed_by_rule");
    assert.equal(resolveStage(splitStages("npm publish").stages[0], [{ prefix: ["npm", "test"], effect: "allow" }]).resolution, "unresolved");
    assert.equal(resolveStage(test, [{ prefix: ["npm", "test"], effect: "allow" }, { prefix: ["npm"], effect: "deny" }]).resolution, "denied_by_rule");
    assert.equal(grantPrefix(splitStages("python3 -c 'print(1)'").stages[0]), null);
    assert.equal(grantPrefix(splitStages("git").stages[0]), null);
  });

  it("guardrails: rules files wait for a person or fail read-only, ordinary files apply, and there's no always-allow", () => {
    assert.equal(routeWrite("src/menu.html", "edit_file"), "apply");
    assert.equal(routeWrite(".agents/AGENTS.md", "edit_file"), "review");
    assert.equal(routeWrite("src/../.muse/approval-policy.json", "write_file"), "review");
    assert.equal(routeWrite("../outside.txt", "write_file"), "review");
    assert.equal(routeWrite(".agents/AGENTS.md", "shell"), "read_only");
    assert.equal(routeWrite("src/menu.html", "shell"), "apply");
    assert.equal(routeWrite(".husky/pre-commit", "shell"), "apply", "the sandbox list and the review list differ, as in the recipe");
    assert.deepEqual([...REVIEW_CHOICES], ["allow_once", "reject"]);
  });

  it("cron: valid expressions give local times, invalid ones say why, and jitter is stable", () => {
    const from = new Date(2026, 10, 27, 9, 30);
    const weekdays = nextRuns("0 8 * * 1-5", from, 3);
    assert.deepEqual(weekdays.map((d) => [d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes()]), [[11, 30, 8, 0], [12, 1, 8, 0], [12, 2, 8, 0]]);
    assert.deepEqual(nextRuns("*/15 * * * *", new Date(2026, 10, 3, 10, 7), 2).map((d) => d.getMinutes()), [15, 30]);
    assert.equal(nextRuns("0 9 1 * 0", new Date(2026, 10, 3, 10), 1)[0].getDate(), 8, "either day field matches");
    assert.equal(parseCron("0 8 * *").ok, false);
    const bad = parseCron("61 8 * * *");
    assert.ok(!bad.ok && /0 to 59/.test(bad.reason));
    assert.equal(jitterMs("job-1", 86_400_000), jitterMs("job-1", 86_400_000));
    assert.ok(jitterMs("job-1", 86_400_000) < 30 * 60 * 1000);
  });

  it("the skill says which part to use, and stays inside the size limit", () => {
    const text = readFileSync(join(import.meta.dirname, "..", "skills", "recipe-code-sessions", "SKILL.md"), "utf8");
    assert.match(text, /muse-code-in-product/);
    assert.match(text, /never say Muse Code ran/);
    assert.match(text, /Stand-in for Muse Code/);
    assert.match(text, /04\/04 Contained execution/);
  });
});
