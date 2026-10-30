"use client";

import { useId, useMemo, useState } from "react";
import { ErrorBox } from "@/components/docs/kit/ErrorBox";
import { Field, PresetPills, Segmented, TextInput } from "@/components/docs/kit/Field";
import { JsonEditor } from "@/components/docs/kit/JsonEditor";
import { ModelSelect } from "@/components/docs/kit/ModelSelect";
import { ResponseView } from "@/components/docs/kit/ResponseView";
import { RunButton } from "@/components/docs/kit/RunButton";
import { useDocsRun } from "@/components/docs/kit/useDocsRun";
import { formatJson, parseJsonText } from "@/lib/docs/client/json";
import { DEFAULT_TEXT_MODEL } from "@/lib/docs/client/models";
import { collectReply } from "@/lib/docs/client/stream";
import { tokenUsage } from "@/lib/docs/client/cost";
import {
  authorFixture,
  CHECKOUT_PROBE,
  gate,
  inspectFixture,
  reportJson,
  reportText,
  resolveFixtureArg,
  sha256Hex,
  unknownReport,
  withAssistantText,
  withField,
  withoutKind,
  type Json,
  type RecordedRun,
} from "@/components/docs/playgrounds/muse-code-cookbook/logic/replay";
import { recordRunBody, TARIFF_OUTPUT, TARIFF_PROMPT } from "@/components/docs/playgrounds/muse-code-cookbook/logic/requests";
import { Section, ShowCode, Terminal, Verdict, linesOf, type TermLine } from "@/components/docs/playgrounds/muse-code-cookbook/parts";
import styles from "@/components/docs/playgrounds/muse-code-cookbook/mcc.module.css";

/**
 * The deterministic-replay recipe offline: a golden fixture in an editor, `muse trace inspect --fixture` and
 * replay_gate.sh run on it in the page (pure, instant, no model), presets for the recipe's drift and its failure
 * modes, and a byte-determinism check. "Record a live run" asks the model the recipe's question about tariff.py,
 * shows the run as evidence, and lets the reader author a fixture from it, the way the recipe says fixtures are made.
 */

export interface ReplayLabProps {
  slug: string;
}

const PROMPT = TARIFF_PROMPT;
const TOOL_OUTPUT = TARIFF_OUTPUT;

const PRESETS: ReadonlyArray<{ label: string; make: () => Json; note: string }> = [
  { label: "Committed fixture", make: () => CHECKOUT_PROBE, note: "The recipe's checkout_probe: the committed records reduce to the committed expectation." },
  { label: "Drift: 120.00", make: () => withAssistantText(CHECKOUT_PROBE, "Final total: 120.00"), note: "The recipe's jq edit: the assistant event changes, the expectation doesn't." },
  {
    label: "Tool output changed",
    make: () => {
      const f = JSON.parse(JSON.stringify(CHECKOUT_PROBE)) as Json;
      ((f.run_records as Json[])[1].payload as Json).text = "Final total: 138.0";
      return f;
    },
    note: "A tool result the projection now reads differently.",
  },
  { label: "Schema version 2", make: () => withField(CHECKOUT_PROBE, "schema_version", 2), note: "Golden fixtures are schema_version 1; anything else fails to load." },
  { label: "Lost its terminal", make: () => withoutKind(CHECKOUT_PROBE, "terminal"), note: "A fixture that dropped the terminal boundary it needs." },
];

export function ReplayLab(_props: ReplayLabProps) {
  const id = useId();
  const [preset, setPreset] = useState<number | null>(0);
  const [base, setBase] = useState(formatJson(CHECKOUT_PROBE));
  const [text, setText] = useState(base);
  const [arg, setArg] = useState("golden-traces/checkout_probe.json");
  const [format, setFormat] = useState<"text" | "json">("text");
  const [hashes, setHashes] = useState<[string, string] | null>(null);
  const [model, setModel] = useState(DEFAULT_TEXT_MODEL);
  const [recorded, setRecorded] = useState<RecordedRun | null>(null);
  const runner = useDocsRun();
  const recording = runner.state === "running";

  const parsed = useMemo(() => parseJsonText(text), [text]);
  const fixture = parsed.ok && parsed.value && typeof parsed.value === "object" && !Array.isArray(parsed.value) ? (parsed.value as Json) : null;
  const name = typeof fixture?.name === "string" ? fixture.name : "checkout_probe";
  const found = resolveFixtureArg(arg, name) === "found";
  const report = useMemo(() => (!found ? unknownReport(arg.trim() || name) : inspectFixture(fixture, arg.trim())), [found, arg, name, fixture]);
  const gated = useMemo(() => gate([fixture ? inspectFixture(fixture, `golden-traces/${name}.json`) : inspectFixture(null, "golden-traces/fixture.json")]), [fixture, name]);

  const load = (json: Json, i: number | null) => {
    const t = formatJson(json);
    setBase(t);
    setText(t);
    setPreset(i);
    setHashes(null);
  };

  const inspectLines: TermLine[] = [
    { text: `muse trace inspect --fixture ${arg.trim() || "<file>"}${format === "json" ? " --format json" : ""}`, tone: "cmd" },
    ...(parsed.ok
      ? linesOf(format === "json" ? reportJson(report) : reportText(report)).map((l) =>
          /^\s+\[|^\s+(expected|actual):|^load_status|^error/.test(l.text) ? { ...l, tone: "err" as const } : l,
        )
      : [{ text: `error: the fixture isn't valid JSON (${parsed.message})`, tone: "err" as const }]),
    // inspect is a viewer: it prints diffs and still exits zero (the recipe's "A Projection Diff Exits Zero").
    ...(parsed.ok && report.load_status === "complete" ? [{ text: "echo $?", tone: "cmd" as const }, { text: "0", tone: "muted" as const }] : []),
  ];
  const gateLines: TermLine[] = [
    { text: "./artifacts/replay_gate.sh golden-traces", tone: "cmd" },
    ...gated.lines.map((l) => ({ text: l, tone: l.startsWith("PASS") ? ("ok" as const) : l.startsWith("FAIL") ? ("err" as const) : ("muted" as const) })),
    { text: "echo $?", tone: "cmd" },
    { text: String(gated.exitCode), tone: gated.exitCode ? "err" : "ok" },
  ];

  const recordBody = recordRunBody(model);
  const record = async () => {
    const res = await runner.run("responses", { method: "POST", body: recordBody });
    if (!res.ok) return;
    const reply = collectReply("responses", res.json);
    const u = tokenUsage(reply.usage);
    setRecorded({
      prompt: PROMPT,
      toolOutput: TOOL_OUTPUT,
      answer: reply.text.trim(),
      responseId: reply.id ?? "resp_live",
      usage: { input_tokens: u?.input ?? 0, output_tokens: u?.output ?? 0, cached_tokens: u?.cached ?? 0 },
    });
  };
  const liveFixture = recorded ? authorFixture("live_probe", recorded) : null;

  return (
    <div className={`pg ${styles.stack}`}>
      <PresetPills label="Fixture" presets={PRESETS} active={preset} onPick={(i) => load(PRESETS[i].make(), i)} />
      {preset !== null ? <p className={styles.note}>{PRESETS[preset].note}</p> : null}
      <div className={styles.split}>
        <div className={styles.tight}>
          <JsonEditor id={`${id}-fixture`} label={`golden-traces/${name}.json`} value={text} onChange={(t) => { setText(t); setPreset(null); setHashes(null); }} resetTo={base} rows={18} />
          <p className={styles.note}>
            The recipe abbreviates each record to its payload, and so does this editor. This fixture has 6 records: the recipe&apos;s 4 plus the model_response_created and model_completed boundaries it says to keep. The committed file holds 7 full envelopes, so inspect prints run=7 there and run=6 here. Edit any field and the replay on the right updates.
          </p>
        </div>
        <div className={styles.stack}>
          <Field id={`${id}-arg`} label="--fixture" hint="Pass the file name with .json, or the path. A bare stem reports Result: unknown.">
            <TextInput id={`${id}-arg`} className="pg-code-input" value={arg} onChange={(e) => setArg(e.target.value)} spellCheck={false} aria-describedby={`${id}-arg-hint`} />
          </Field>
          <div className={styles.row}>
            <Segmented<"text" | "json"> label="Report format" size="sm" options={[{ value: "text", label: "Text" }, { value: "json", label: "--format json" }]} value={format} onChange={setFormat} />
          </div>
          <Terminal title="muse trace inspect" lines={inspectLines} live />
          {format === "json" ? (
            <p className={styles.note}>The recipe shows diffs, load_status: partial and errors in the JSON report; the other fields, and load_status: complete for a fixture that loads, are this demo&apos;s.</p>
          ) : null}
          <Terminal title="replay_gate.sh" lines={gateLines} live />
          {gated.exitCode ? (
            <Verdict tone="bad" title="The required check fails: the merge is blocked">
              <p className={styles.note}>inspect itself exited 0: it prints diffs but never fails on them. The gate reads <code>jq &apos;.diffs | length&apos;</code> and exits 1, until the behavior is restored or the fixture is updated in the same change.</p>
            </Verdict>
          ) : (
            <Verdict tone="ok" title="Zero diffs: the check passes" />
          )}
          <div className={styles.row}>
            <button
              type="button"
              className="btn btn-sm btn-outline"
              onClick={async () => {
                const a = reportJson(report);
                const b = reportJson(found ? inspectFixture(fixture, arg.trim()) : unknownReport(arg.trim() || name));
                setHashes([await sha256Hex(a), await sha256Hex(b)]);
              }}
            >
              Replay twice and compare
            </button>
            {hashes ? (
              <span className={styles.mono} role="status">
                a.json {hashes[0].slice(0, 12)}... b.json {hashes[1].slice(0, 12)}... {hashes[0] === hashes[1] ? "byte-identical" : "differ"}
              </span>
            ) : null}
          </div>
          {hashes ? (
            <p className={styles.note}>
              The same records give the same report bytes, which is what cmp a.json b.json checks for Muse Code&apos;s replay. Both runs here are this page&apos;s projection, so this illustrates the property rather than testing Muse Code.
            </p>
          ) : null}
        </div>
      </div>

      <Section title="Record a live run, then author a fixture from it">
        <p className={styles.note}>
          The model answers the recipe&apos;s question about tariff.py, with the script&apos;s output given as the tool result. Its words will differ from the committed fixture: that is the non-determinism replay is built to leave out. Under a cent.
        </p>
        <div className="pg-bar">
          <ModelSelect kind="text" value={model} onChange={setModel} disabled={recording} />
          <RunButton running={recording} onRun={() => void record()} onStop={runner.abort} label="Record a live run" />
        </div>
        {recording || runner.result ? (
          <ResponseView result={recording ? null : runner.result} running={recording} elapsedMs={runner.elapsedMs}>
            {recorded ? (
              <div className={styles.stack}>
                <Terminal
                  title="Recorded run events (the evidence)"
                  lines={[
                    { text: `started: ${PROMPT}` },
                    { text: `tool_result c1: ${TOOL_OUTPUT}` },
                    { text: `model_response_created: ${recorded.responseId}` },
                    { text: `assistant_message_committed: ${recorded.answer}`, tone: "ok" },
                    { text: `model_completed: ${recorded.usage.input_tokens} in, ${recorded.usage.output_tokens} out, ${recorded.usage.cached_tokens} cached` },
                    { text: "terminal: completed" },
                  ]}
                />
                <div className={styles.row}>
                  <button type="button" className="btn btn-sm btn-outline" onClick={() => load({ ...CHECKOUT_PROBE, run_records: liveFixture!.run_records }, null)}>
                    Replay it against the committed expectation
                  </button>
                  <button type="button" className="btn btn-sm btn-primary" onClick={() => { load(liveFixture!, null); setArg("golden-traces/live_probe.json"); }}>
                    Author a fixture from this run
                  </button>
                </div>
                <p className={styles.note}>Against the committed expectation, the live answer and usage show up as diffs. An authored fixture sets expected_model_context to what the records reduce to, for review before it is committed.</p>
              </div>
            ) : (
              <p className="pg-empty">{recording ? "Recording..." : "No answer in this reply."}</p>
            )}
          </ResponseView>
        ) : null}
        <ErrorBox error={runner.error} />
        <ShowCode body={recordBody} caption="The request Record sends" />
      </Section>
    </div>
  );
}
