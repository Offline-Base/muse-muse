/**
 * The replay simulator against the deterministic-replay recipe's own outputs: the committed fixture passes, the
 * recipe's drift prints its exact diff and gate lines, a schema_version 2 fixture fails to load, a bare stem reports
 * Result: unknown, and authoring a fixture from a recorded run replays clean.
 *
 *   npx tsx --test --experimental-test-module-mocks components/docs/playgrounds/muse-code-cookbook/__tests__/replay.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  authorFixture,
  CHECKOUT_PROBE,
  gate,
  inspectFixture,
  project,
  reportJson,
  reportText,
  resolveFixtureArg,
  sha256Hex,
  unknownReport,
  withAssistantText,
  withField,
  withoutKind,
} from "@/components/docs/playgrounds/muse-code-cookbook/logic/replay";

describe("inspect", () => {
  it("replays the committed fixture with no diffs", () => {
    const r = inspectFixture(CHECKOUT_PROBE, "golden-traces/checkout_probe.json");
    assert.equal(r.trace, "checkout_probe");
    assert.deepEqual(r.diffs, []);
    assert.equal(reportText(r), "Trace: checkout_probe\nResult: completed\nRecords: run=6 task=0\nDiffs:\n  none");
    assert.deepEqual(gate([r]), { lines: ["PASS  checkout_probe"], exitCode: 0 });
  });

  it("catches the recipe's drift with its exact report and gate lines", () => {
    const drifted = withAssistantText(CHECKOUT_PROBE, "Final total: 120.00");
    const r = inspectFixture(drifted, "checkout_probe.json");
    assert.equal(r.diffs.length, 1, "the answer shows once, under assistant_text");
    assert.match(reportText(r), /Diffs:\n {2}\[model_context\] model_context\.assistant_text\n {4}expected: Final total: 138\.00\n {4}actual: {3}Final total: 120\.00$/);
    assert.deepEqual(gate([r]), {
      lines: ["FAIL  checkout_probe: 1 projection diff(s)", "        model_context.assistant_text: expected Final total: 138.00, actual Final total: 120.00"],
      exitCode: 1,
    });
    assert.deepEqual(inspectFixture(CHECKOUT_PROBE).diffs, [], "the drift edits a copy, never the committed fixture");
  });

  it("reports other changed fields by path", () => {
    const fixture = JSON.parse(JSON.stringify(CHECKOUT_PROBE));
    fixture.run_records[1].payload.text = "Final total: 0.00";
    fixture.run_records[4].payload.usage.output_tokens = 19;
    const paths = inspectFixture(fixture).diffs.map((d) => d.path);
    assert.deepEqual(paths, ["model_context.messages[1].text", "model_context.usage.output_tokens"]);
    const noTerminal = inspectFixture(withoutKind(CHECKOUT_PROBE, "terminal"));
    assert.deepEqual(noTerminal.diffs.map((d) => [d.path, d.actual]), [["model_context.terminal", null]]);
    assert.equal(noTerminal.result, "unknown");
  });

  it("fails to load a schema_version 2 fixture", () => {
    const r = inspectFixture(withField(CHECKOUT_PROBE, "schema_version", 2));
    assert.equal(r.load_status, "partial");
    assert.deepEqual(r.errors, [{ category: "replay_schema", message: "unsupported fixture schema version 2" }]);
    assert.equal(gate([r]).exitCode, 1);
  });

  it("finds the fixture by file name or path, never by bare stem", () => {
    assert.equal(resolveFixtureArg("checkout_probe", "checkout_probe"), "unknown");
    assert.equal(resolveFixtureArg("checkout_probe.json", "checkout_probe"), "found");
    assert.equal(resolveFixtureArg("golden-traces/checkout_probe.json", "checkout_probe"), "found");
    assert.equal(reportText(unknownReport("checkout_probe")), "Trace: checkout_probe\nSource: checkout_probe\nResult: unknown\nRecords: run=0 task=0\nDiffs:\n  none");
  });
});

describe("authoring and determinism", () => {
  it("authors a fixture from a recorded run that replays clean", () => {
    const fixture = authorFixture("live_probe", {
      prompt: "Read tariff.py and tell me the exact final checkout total.",
      toolOutput: "Final total: 138.00",
      answer: "The final checkout total is 138.00.",
      responseId: "resp_live",
      usage: { input_tokens: 300, output_tokens: 40, cached_tokens: 0 },
    });
    const r = inspectFixture(fixture);
    assert.deepEqual(r.diffs, []);
    assert.equal(r.records.run, 6);
    // The live answer against the committed expectation is drift.
    const against = { ...CHECKOUT_PROBE, run_records: fixture.run_records };
    assert.deepEqual(inspectFixture(against).diffs.map((d) => d.path), [
      "model_context.messages[0].text",
      "model_context.assistant_text",
      "model_context.usage.input_tokens",
      "model_context.usage.output_tokens",
    ]);
  });

  it("projects the payloads it knows and skips the rest", () => {
    const ctx = project([{ payload: { kind: "started", prompt: "hi" } }, { nope: true }, { payload: { kind: "unknown_kind" } }]);
    assert.deepEqual(ctx, { messages: [{ role: "user", text: "hi" }], assistant_text: null, terminal: null });
  });

  it("gives the same bytes and the same hash for the same fixture", async () => {
    const a = reportJson(inspectFixture(CHECKOUT_PROBE));
    const b = reportJson(inspectFixture(JSON.parse(JSON.stringify(CHECKOUT_PROBE))));
    assert.equal(a, b);
    assert.equal(await sha256Hex(a), await sha256Hex(b));
    assert.match(await sha256Hex(a), /^[0-9a-f]{64}$/);
    assert.notEqual(await sha256Hex(a), await sha256Hex(reportJson(inspectFixture(withAssistantText(CHECKOUT_PROBE, "x")))));
  });
});
