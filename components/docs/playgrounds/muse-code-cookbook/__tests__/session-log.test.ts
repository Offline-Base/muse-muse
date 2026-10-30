/**
 * The audit demo's log reader against the real `muse exec --json` sample and the excerpts rebuilt from the audit
 * recipe: lanes, the ledger in build_ledger.py's plain format, who authorized each intent, the approval chain,
 * what a resume finds after a cut, diagnostics, redaction and the recipe's jq views.
 *
 *   npx tsx --test --experimental-test-module-mocks components/docs/playgrounds/muse-code-cookbook/__tests__/session-log.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  approvalChains,
  authorizationSummary,
  buildLedger,
  diagnostics,
  exportDocument,
  jqDuplicateKeys,
  jqSpine,
  jqWindow,
  ledgerPlain,
  liveOnlyRecords,
  parseSessionLog,
  redactString,
  redactValue,
  resumeReport,
  sessionIdOf,
  sessionSummaries,
} from "@/components/docs/playgrounds/muse-code-cookbook/logic/session-log";
import { LOG_SAMPLES, logSample } from "@/components/docs/playgrounds/muse-code-cookbook/logic/samples";

const exec = parseSessionLog(logSample("exec").lines);
const approval = parseSessionLog(logSample("approval").lines);
const crash = parseSessionLog(logSample("crash").lines);

describe("the real exec sample", () => {
  it("parses all 89 envelopes, in two streams", () => {
    assert.equal(exec.records.length, 89);
    assert.deepEqual(exec.unparseable, []);
    assert.equal(sessionIdOf(exec.records), "7661c49d-b561-4b2e-8cce-541a6cb64df2");
    assert.ok(exec.records.some((r) => r.stream === "exec.usage" && r.kind === "run_usage"));
  });

  it("names each record by event kind, then its own kind, then payload_type", () => {
    const by = (seq: number) => exec.records.find((r) => r.sequence === seq && r.stream === "session")!;
    assert.equal(by(1).kind, "command_accepted");
    assert.equal(by(1).jqKind, "runtime.command.accepted");
    assert.equal(by(10).kind, "side_effect_intent");
    assert.equal(by(10).jqKind, "side_effect_intent");
    assert.equal(by(29).kind, "tool_result");
    assert.equal(by(88).kind, "run_terminal");
    assert.match(by(88).summary, /Run completed: Done\. The h1/);
  });

  it("puts the edit in the edit lane and model calls in the model lane", () => {
    const intents = exec.records.filter((r) => r.kind === "side_effect_intent");
    assert.equal(intents.length, 9);
    const lane = (op: string) => intents.find((r) => r.operation === op)!.lane;
    assert.equal(lane("tool:edit_file"), "edit");
    assert.equal(lane("tool:read_file"), "tool");
    assert.equal(lane("model.meta.response"), "model");
    assert.equal(lane("reminder.child_run"), "reminder");
    assert.equal(exec.records.find((r) => r.sequence === 55)!.lane, "edit", "the edit_file tool.result");
    assert.equal(exec.records.find((r) => r.sequence === 52)!.summary, "Patch: 1 file(s), +1 -1");
  });

  it("answers who authorized each action", () => {
    const summary = Object.fromEntries(authorizationSummary(exec.records).map((s) => [s.decision, s.count]));
    assert.deepEqual(summary, {
      "reminder_child:read_only:subagent_tool_auto_approval": 4,
      not_applicable: 3,
      "allow:policy": 2,
    });
  });

  it("finds every effect committed in the whole log, and the in-flight ones after a cut", () => {
    const whole = resumeReport(exec.records);
    assert.equal(whole.committed.length, 9);
    assert.equal(whole.inFlight.length, 0);
    assert.deepEqual(whole.duplicateKeys, []);
    assert.equal(whole.orderlyEnd, false, "no session.end in an exec stream");
    assert.equal(whole.ending, "run completed");

    const cut = resumeReport(exec.records, 51);
    assert.deepEqual(
      cut.inFlight.map((s) => s.intent.sequence),
      [35, 50],
      "the second skill reminder and the edit were announced, not confirmed",
    );
    assert.equal(cut.lastSequence, 51);
    assert.equal(cut.ending, "none");
  });

  it("counts diagnostics with the export's keys, in the recipe's order", () => {
    const d = diagnostics(exec);
    assert.deepEqual(Object.keys(d), ["unparseable_lines", "unknown_payload_kinds", "gaps", "omitted_live_only", "duplicate_records"]);
    assert.deepEqual(d, { unparseable_lines: 0, unknown_payload_kinds: 0, gaps: 0, omitted_live_only: 0, duplicate_records: 0 });
    assert.equal(liveOnlyRecords(exec), 7, "the --json stream keeps its live-only records inline, so none were omitted");
    const odd = parseSessionLog([...logSample("exec").lines.slice(0, 2), JSON.stringify({ sequence: 3, payload_type: "brand.new.kind", payload: {} })]);
    assert.equal(diagnostics(odd).unknown_payload_kinds, 1, "a kind the parser doesn't read is counted");
    const broken = parseSessionLog([...logSample("exec").lines.slice(0, 3), "not json", logSample("exec").lines[5]]);
    assert.deepEqual(broken.unparseable, [4]);
    assert.equal(diagnostics(broken).gaps, 1, "sequence 4 and 5 are missing");
  });
});

describe("the approval window excerpt", () => {
  it("prints the recipe's plain ledger lines", () => {
    const rows = buildLedger(approval.records);
    const text = ledgerPlain(sessionIdOf(approval.records), approval.records, rows, "clean");
    const lines = text.split("\n");
    assert.equal(lines[0], `audit ledger  c7dfaecc-adf6-4348-87df-95576e15136e  (${approval.records.length} events, termination: clean)`);
    assert.deepEqual(lines.slice(1), [
      "  43  +  16.9s  tool run   bash       auth=allow:policy",
      "  71  +  20.7s  edit       edit_file  auth=allow:policy",
      " 193  +  57.8s  approval   REQUESTED  bash: rm -rf stale_cache.txt",
      " 196  +  57.8s  approval   APPROVED  by llm_judge",
      " 200  +  57.8s  tool run   bash       auth=allow:llm_judge",
    ]);
  });

  it("threads the approval by pending_action_id and names the authorizer", () => {
    const [chain] = approvalChains(approval.records);
    assert.equal(chain.command, "rm -rf stale_cache.txt");
    assert.deepEqual(
      chain.steps.map((s) => s.sequence),
      [193, 194, 195, 196, 197, 200],
    );
    assert.equal(chain.decision, "approved");
    assert.equal(chain.authorizer?.kind, "llm_judge");
    assert.equal(chain.authorizer?.prompt_version, 1);
    assert.equal(chain.intent?.policyDecision, "allow:llm_judge");
    assert.ok(chain.intent!.sequence < approval.records.find((r) => r.sequence === 201)!.sequence, "the intent lands before the effect starts");
  });

  it("shows the approval window the way jq would", () => {
    const { command, output } = jqWindow(approval.records, 193, 202);
    assert.match(command, /select\(\.sequence>=193 and \.sequence<=202\)/);
    assert.deepEqual(output, [
      '{"seq":193,"kind":"requested"}',
      '{"seq":194,"kind":"approval_wait.effect.started"}',
      '{"seq":195,"kind":"stage_requirement_resolved"}',
      '{"seq":196,"kind":"decision_applied"}',
      '{"seq":197,"kind":"approval_wait.effect.terminal"}',
      '{"seq":200,"kind":"side_effect_intent"}',
      '{"seq":201,"kind":"tool_batch.effect.started"}',
      '{"seq":202,"kind":"tool_batch.effect.terminal"}',
    ]);
    const end = resumeReport(approval.records);
    assert.equal(end.orderlyEnd, true);
    assert.equal(end.ending, "clean");
  });
});

describe("the crash and resume excerpt", () => {
  it("reports the in-flight gate call as unknown and where the resume picked up", () => {
    const report = resumeReport(crash.records);
    assert.deepEqual(report.committed.map((s) => [s.intent.sequence, s.terminal!.sequence]), [
      [478, 482],
      [552, 556],
    ]);
    assert.deepEqual(report.inFlight.map((s) => s.intent.sequence), [504]);
    assert.equal(report.ending, "crash_inferred");
    assert.equal(report.resumedFrom, 500);
    assert.deepEqual(report.duplicateKeys, []);
    assert.deepEqual(jqDuplicateKeys(crash.records).output, [], "no key fired twice across the crash boundary");
  });

  it("prints the recipe's jq spine line for line", () => {
    const { command, output } = jqSpine(crash.records);
    assert.match(command, /tool_batch\\\\.effect\\\\.terminal/);
    assert.deepEqual(output, [
      "478  side_effect_intent  tool:bash",
      "482  tool_batch.effect.terminal",
      "504  side_effect_intent  tool:bash",
      "507  session.end  crash_inferred",
      "510  session.resumed",
      "552  side_effect_intent  tool:bash",
    ]);
  });

  it("before the resume, the crash is all the log knows", () => {
    const beforeResume = resumeReport(crash.records, crash.records.findIndex((r) => r.kind === "session_resumed"));
    assert.equal(beforeResume.resumedFrom, null);
    assert.equal(beforeResume.ending, "crash_inferred");
    assert.deepEqual(beforeResume.inFlight.map((s) => s.intent.sequence), [504]);
  });
});

describe("export", () => {
  it("has the recipe's header keys, with each session's turns, records and end", () => {
    const doc = exportDocument(logSample("approval").lines, undefined, false);
    assert.deepEqual(Object.keys(doc), ["export_schema_version", "redaction", "session_terminated_abnormally", "sessions", "diagnostics", "events"]);
    assert.deepEqual(doc.sessions, [{ session_id: "c7dfaecc-adf6-4348-87df-95576e15136e", turn_count: 1, step_count: approval.records.length, session_end: { exit_reason: "clean", uptime_ms: 153580 } }]);
    const run = sessionSummaries(exec.records);
    assert.deepEqual(run.map((r) => [r.turn_count, r.step_count, r.session_end]), [[1, 88, null]], "a muse exec stream has one turn and no session.end");
    assert.equal(exportDocument(logSample("exec").lines, undefined, false).session_terminated_abnormally, true);
    assert.equal(resumeReport(exec.records).ending, "run completed", "what the Export tab names instead of suggesting /quit");
  });

  it("is a pure function of the log bytes and flags, and says when no orderly end was recorded", () => {
    const lines = logSample("approval").lines;
    assert.equal(JSON.stringify(exportDocument(lines, undefined, false)), JSON.stringify(exportDocument([...lines], undefined, false)));
    const whole = exportDocument(lines, undefined, false);
    assert.equal(whole.session_terminated_abnormally, false, "the excerpt ends with session.end clean");
    assert.equal((whole.events as unknown[]).length, approval.records.length);
    const midSession = exportDocument(lines, 10, false);
    assert.equal(midSession.session_terminated_abnormally, true, "exported mid-session: no orderly end recorded");
    assert.equal(exportDocument(lines, undefined, true).redaction, "redacted");
    assert.notEqual(JSON.stringify(exportDocument(lines, undefined, true)), JSON.stringify(whole), "raw and --redacted exports don't match");
  });
});

describe("redaction", () => {
  it("removes the kinds of secrets --redacted names, and leaves ordinary text alone", () => {
    const token = ["sk", "live", "x".repeat(24)].join("-");
    const jwt = ["eyJhbGciOi", "eyJzdWIiOiIx", "c2lnbmF0dXJl"].join(".");
    const cases: Array<[string, RegExp]> = [
      ["Authorization: Bearer abcdefghijklmnop", /Authorization: \[REDACTED\]/],
      [`curl -H "Bearer ${"q".repeat(20)}"`, /Bearer \[REDACTED\]/],
      [`MY_API_KEY=${"z".repeat(12)}`, /MY_API_KEY=\[REDACTED\]/],
      [`token is ${token}`, /\[REDACTED TOKEN\]/],
      [`jwt ${jwt}`, /\[REDACTED JWT\]/],
      ["-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----", /\[REDACTED PEM\]/],
    ];
    for (const [input, expected] of cases) assert.match(redactString(input).text, expected, input);
    assert.deepEqual(redactString("Read text file `app/page.tsx`.").hits, []);
    const { value, hits } = redactValue({ a: ["Authorization: Bearer abcdefghijkl"], n: 3 });
    assert.deepEqual(hits.length > 0, true);
    assert.equal((value as { n: number }).n, 3);
  });

  it("finds nothing to redact in the real sample", () => {
    const { hits } = redactValue(exec.records.map((r) => r.raw));
    assert.deepEqual(hits, []);
  });
});

describe("samples", () => {
  it("marks the rebuilt excerpts as excerpts", () => {
    assert.deepEqual(
      LOG_SAMPLES.map((s) => [s.id, s.excerpt]),
      [
        ["exec", false],
        ["approval", true],
        ["crash", true],
      ],
    );
    for (const s of LOG_SAMPLES) assert.equal(s.description.includes(String.fromCharCode(0x2014)), false);
  });
});
