"use client";

import { useEffect, useId, useState } from "react";
import { CodeView, DEFAULT_TEXT_MODEL, ErrorBox, Field, ModelSelect, PresetPills, RunButton, Segmented, Tabs, TextArea, TextInput, Toggle, UsageLine, isAborted, useDocsRun } from "@/components/docs/kit";
import { MarkdownText } from "@/components/markdown/MarkdownText";
import type { DocsResult } from "@/lib/docs/client/api";
import { estimateCost, formatUsd, tokenUsage } from "@/lib/docs/client/cost";
import { collectReply } from "@/lib/docs/client/stream";
import { CodeBlock } from "@/components/docs/playgrounds/muse-code/CodeBlock";
import { recoverySteps } from "@/components/docs/playgrounds/muse-code/control-room";
import { ControlRoom } from "@/components/docs/playgrounds/muse-code/ControlRoom";
import styles from "@/components/docs/playgrounds/muse-code/muse-code.module.css";
import { Check, Chip, Notes, NumberField, Panel, Problems, SelectField } from "@/components/docs/playgrounds/muse-code/ui";
import { MINI_CHILDREN, MINI_SYNTHESIS, SAMPLE_SERVICE } from "@/components/docs/playgrounds/muse-code/workflow-sample";
import {
  ACTIVE_CAP,
  capacity,
  childBody,
  destination,
  LIFETIME_CHILDREN,
  nameProblems,
  saveCommand,
  scriptProblems,
  synthesisBody,
  workflowRequest,
  requestWarnings,
  type MiniChild,
  type Scope,
  type Writes,
} from "@/components/docs/playgrounds/muse-code/workflows";

/**
 * The workflows page's demo: write a workflow request in the page's structure, save it as a named workflow (with the
 * name and file rules checked as you type, a script file checked in the browser without uploading it, and both ways
 * to recover a failed run), see how the child limits play out, drive the control room's keys on a pretend session,
 * and run a three-child workflow live on the Model API (three calls in parallel, then a synthesis call) to see the
 * pattern and what it costs in tokens.
 */

export interface WorkflowPlannerProps {
  slug: string;
  /** The live tab's starting code. */
  code?: string;
}

type View = "request" | "save" | "capacity" | "monitor" | "live";

interface Draft {
  label: string;
  goal: string;
  stages: string[];
  verify: boolean;
  deliverable: string;
  writes: Writes;
  runTests: boolean;
  commit: boolean;
}

const DRAFTS: Draft[] = [
  {
    label: "Review a service",
    goal: "review this service",
    stages: ["Inspect the API design\nInspect the security boundaries\nInspect the test coverage"],
    verify: true,
    deliverable: "one prioritized report",
    writes: "read-only",
    runTests: false,
    commit: false,
  },
  {
    label: "Dependency upgrade",
    goal: "prepare this repository for the dependency upgrade",
    stages: ["Inspect production call sites and compatibility risks", "Inspect tests\nInspect build configuration\nInspect release constraints"],
    verify: true,
    deliverable: "an ordered implementation plan with file references",
    writes: "read-only",
    runTests: false,
    commit: false,
  },
  {
    label: "Independent packages",
    goal: "update these independent packages",
    stages: ["Update packages/api\nUpdate packages/web\nUpdate packages/cli"],
    verify: false,
    deliverable: "a summary of the commits for review",
    writes: "worktrees",
    runTests: true,
    commit: true,
  },
];

const AUTHOR_PROMPT =
  "Create review-change.js as a reusable workflow that reviews the current change for\nAPI compatibility, security risks, and missing tests in parallel, then synthesizes\none prioritized report. Keep every child read-only.";

type LiveStage = "idle" | "children" | "synthesis" | "done" | "failed";

function textOf(result: DocsResult | null): string {
  return result?.ok ? collectReply("responses", result.json).text : "";
}

export function WorkflowPlanner({ code: startCode }: WorkflowPlannerProps) {
  const idBase = useId();
  const [view, setView] = useState<View>("request");

  const [draft, setDraft] = useState<Draft>(DRAFTS[0]);
  const [draftPreset, setDraftPreset] = useState<number | null>(0);
  const edit = (patch: Partial<Draft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setDraftPreset(null);
  };
  const requestInput = { ...draft, stages: draft.stages.map((s) => ({ children: s.split("\n") })) };
  const request = workflowRequest(requestInput);
  const warnings = requestWarnings(requestInput);

  const [name, setName] = useState("review-change");
  const [scope, setScope] = useState<Scope>("project");
  const [file, setFile] = useState("./review-change.js");
  const [overwrite, setOverwrite] = useState(false);
  const [script, setScript] = useState<{ name: string; bytes: number; problems: string[] } | null>(null);
  const [runId, setRunId] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [scriptPath, setScriptPath] = useState("");
  const recovery = recoverySteps({ runId, sessionId, scriptPath });

  const [cpu, setCpu] = useState<number | null>(8);
  const [stagesText, setStagesText] = useState("12, 40, 1");
  const [perChild, setPerChild] = useState<number | null>(30000);
  useEffect(() => {
    const cores = navigator.hardwareConcurrency;
    if (cores) setCpu(cores);
  }, []);
  const cap = capacity({ cpuLimit: cpu ?? 1, stages: stagesText.split(/[,\s]+/).filter(Boolean).map(Number), tokensPerChild: perChild ?? 0 });

  const [code, setCode] = useState(startCode ?? SAMPLE_SERVICE);
  const [children, setChildren] = useState<MiniChild[]>([...MINI_CHILDREN]);
  const [synthText, setSynthText] = useState(MINI_SYNTHESIS);
  const [model, setModel] = useState(DEFAULT_TEXT_MODEL);
  const [live, setLive] = useState<LiveStage>("idle");
  const [showCode, setShowCode] = useState(false);
  const r0 = useDocsRun();
  const r1 = useDocsRun();
  const r2 = useDocsRun();
  const synth = useDocsRun();
  const runners = [r0, r1, r2];
  const budget = model === "muse-wonder-1.0" ? 800 : undefined;
  const childBodies = children.map((c) => childBody(model, c, code, budget));
  const running = live === "children" || live === "synthesis";

  const runWorkflow = async () => {
    setLive("children");
    synth.reset();
    const results = await Promise.all(runners.map((r, i) => r.run("responses", { body: childBodies[i] })));
    if (results.some((r) => !r.ok)) {
      setLive(results.some(isAborted) ? "idle" : "failed");
      return;
    }
    setLive("synthesis");
    const findings = results.map((r, i) => ({ title: children[i].title, text: textOf(r) }));
    const s = await synth.run("responses", { body: synthesisBody(model, synthText, code, findings, budget) });
    setLive(s.ok ? "done" : isAborted(s) ? "idle" : "failed");
  };
  const stopAll = () => {
    runners.forEach((r) => r.abort());
    synth.abort();
  };

  const allResults = [...runners.map((r) => r.result), synth.result];
  const totals = allResults.reduce(
    (acc, r) => {
      const u = tokenUsage((r?.json as { usage?: unknown } | null)?.usage);
      const c = estimateCost(r?.model ?? model, (r?.json as { usage?: unknown } | null)?.usage);
      return { tokens: acc.tokens + (u?.total ?? 0), usd: acc.usd + (c?.usd ?? 0), calls: acc.calls + (u ? 1 : 0) };
    },
    { tokens: 0, usd: 0, calls: 0 },
  );
  const firstError = runners.map((r) => r.error).find(Boolean) ?? synth.error;

  return (
    <div className="pg">
      <Tabs<View>
        label="Workflows"
        idBase={idBase}
        value={view}
        onChange={setView}
        tabs={[
          { id: "request", label: "Write the request" },
          { id: "save", label: "Save a workflow" },
          { id: "capacity", label: "Child limits" },
          { id: "monitor", label: "Control room" },
          { id: "live", label: "Run a mini workflow" },
        ]}
      />

      <Panel idBase={idBase} id="request" active={view === "request"}>
        <div className="pg-col">
          <PresetPills
            presets={DRAFTS}
            active={draftPreset}
            onPick={(i) => {
              setDraft(DRAFTS[i]);
              setDraftPreset(i);
            }}
          />
          <Field id={`${idBase}-goal`} label="Use a workflow to">
            <TextInput id={`${idBase}-goal`} value={draft.goal} onChange={(e) => edit({ goal: e.target.value })} />
          </Field>
          <ol className={styles.steps} aria-label="Stages">
            {draft.stages.map((s, i) => (
              <li key={i} className={styles.step}>
                <div className={styles.stepBody}>
                  <Field id={`${idBase}-stage-${i}`} label={`Stage ${i + 1}: one child per line (two or more run in parallel)`}>
                    <TextArea
                      id={`${idBase}-stage-${i}`}
                      rows={Math.max(2, s.split("\n").length)}
                      value={s}
                      onChange={(e) => edit({ stages: draft.stages.map((x, j) => (j === i ? e.target.value : x)) })}
                    />
                  </Field>
                  {draft.stages.length > 1 ? (
                    <div className="pg-advanced">
                      <button type="button" className="btn btn-outline btn-sm" onClick={() => edit({ stages: draft.stages.filter((_, j) => j !== i) })}>
                        Remove stage {i + 1}
                      </button>
                    </div>
                  ) : null}
                </div>
              </li>
            ))}
          </ol>
          <div className="pg-actions pg-advanced">
            <button type="button" className="btn btn-outline btn-sm" onClick={() => edit({ stages: [...draft.stages, ""] })} disabled={draft.stages.length >= 6}>
              Add a stage
            </button>
          </div>
          <div className={styles.row}>
            <Field id={`${idBase}-deliv`} label="Final deliverable" className={styles.grow}>
              <TextInput id={`${idBase}-deliv`} value={draft.deliverable} onChange={(e) => edit({ deliverable: e.target.value })} />
            </Field>
            <SelectField<Writes>
              id={`${idBase}-writes`}
              label="Writing"
              className={`${styles.narrow} pg-advanced`}
              value={draft.writes}
              onChange={(writes) => edit({ writes })}
              options={[
                { value: "read-only", label: "Keep it read-only" },
                { value: "worktrees", label: "Writers get isolated worktrees" },
                { value: "shared", label: "Writers share the checkout" },
              ]}
            />
          </div>
          <div className="pg-bar pg-advanced">
            <Check id={`${idBase}-verify`} label="A verifier challenges high-risk findings" checked={draft.verify} onChange={(verify) => edit({ verify })} />
            {draft.writes === "worktrees" ? (
              <>
                <Check id={`${idBase}-tests`} label="Run the package tests" checked={draft.runTests} onChange={(runTests) => edit({ runTests })} />
                <Check id={`${idBase}-commit`} label="Each writer commits" checked={draft.commit} onChange={(commit) => edit({ commit })} />
              </>
            ) : null}
          </div>
          <CodeBlock code={request} label="Type this in a Muse Code session" syntax="text" />
          <Problems warnings={warnings} ok="A bounded responsibility per child and a final deliverable: enough structure for the workflow author." />
          <Notes
            className="pg-advanced"
            items={[
              "An explicit request like this starts the workflow without an extra confirmation.",
              "With /settings > Tools > Workflows on auto, Muse Code can also propose one for workflow-scale work; explicit launches only when you ask; off removes the tool.",
              "Workflows need a build with the workflow engine and the staged rollout. The current public Apple silicon macOS package doesn't include it.",
            ]}
          />
        </div>
      </Panel>

      <Panel idBase={idBase} id="save" active={view === "save"}>
        <div className="pg-col">
          <div className={styles.row}>
            <Field id={`${idBase}-name`} label="Workflow name" className={styles.grow}>
              <TextInput id={`${idBase}-name`} className="pg-code-input" value={name} spellCheck={false} onChange={(e) => setName(e.target.value)} />
            </Field>
            <div className="pg-field">
              <span className="pg-label">Scope</span>
              <Segmented<Scope>
                label="Scope"
                size="sm"
                value={scope}
                onChange={setScope}
                options={[
                  { value: "project", label: "Project" },
                  { value: "user", label: "User" },
                ]}
              />
            </div>
            <Field id={`${idBase}-file`} label="Script file" className={styles.narrow}>
              <TextInput id={`${idBase}-file`} className="pg-code-input" value={file} spellCheck={false} onChange={(e) => setFile(e.target.value)} />
            </Field>
          </div>
          <Check id={`${idBase}-over`} className="pg-advanced" label="--overwrite (replace a workflow saved under this name in this scope)" checked={overwrite} onChange={setOverwrite} />
          <Problems errors={nameProblems(name)} ok={`Saves to ${destination(name, scope)}.`} />
          <CodeBlock
            label="bash"
            code={[
              `# Ask Muse Code to author the script first, or bring a .js written for your Muse Code version.`,
              saveCommand(name, file, scope, overwrite),
              "",
              "# Start Muse Code in the repo and trust the workspace once, exit, then:",
              "muse workflows list",
            ].join("\n")}
          />
          <CodeBlock className="pg-advanced" label="Then, in a new session" syntax="text" code={`Run the saved ${name || "<name>"} workflow against my current changes.`} />
          <div className={`${styles.card} ${styles.cardMuted} pg-advanced`}>
            <p className={styles.cardTitle}>Check a script before you save it</p>
            <p className="pg-small">Saving checks that the source is a regular, nonempty UTF-8 file of at most 512 KiB. It doesn&apos;t parse or run the JavaScript: syntax errors show when the workflow launches. The file stays in your browser.</p>
            <input
              type="file"
              accept=".js,.mjs,.cjs,text/javascript"
              aria-label="Choose a workflow script to check"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (!f) return setScript(null);
                const bytes = new Uint8Array(await f.arrayBuffer());
                setScript({ name: f.name, bytes: bytes.length, problems: scriptProblems(bytes) });
              }}
            />
            {script ? <Problems errors={script.problems} ok={`${script.name} (${(script.bytes / 1024).toFixed(1)} KiB) passes the save checks. It must also return a JSON-serializable value when it completes.`} /> : null}
          </div>
          <Notes
            className="pg-advanced"
            items={[
              "The save is local: commit .agents/workflows/ so other clones can find it. User-scoped workflows stay local to your account.",
              "A project and a user workflow can share a name; discovery picks the project one.",
              "Muse Code loads named workflows once when a session starts, and project workflows only after you trust the workspace. Save first, then start the session that runs it.",
            ]}
          />
          <CodeBlock className="pg-advanced" label="Or ask Muse Code to write the script" syntax="text" code={AUTHOR_PROMPT} />
          <div className={`${styles.card} ${styles.cardMuted} pg-advanced`}>
            <p className={styles.cardTitle}>Recover and revise a failed run</p>
            <div className={styles.row}>
              <Field id={`${idBase}-runid`} label="Run id" className={styles.narrow}>
                <TextInput id={`${idBase}-runid`} className="pg-code-input" value={runId} placeholder="<run-id>" spellCheck={false} onChange={(e) => setRunId(e.target.value)} />
              </Field>
              <Field id={`${idBase}-sessid`} label="Session id" className={styles.narrow}>
                <TextInput id={`${idBase}-sessid`} className="pg-code-input" value={sessionId} placeholder="<session-id>" spellCheck={false} onChange={(e) => setSessionId(e.target.value)} />
              </Field>
              <Field id={`${idBase}-spath`} label="scriptPath from the Workflow result" className={styles.grow}>
                <TextInput id={`${idBase}-spath`} className="pg-code-input" value={scriptPath} placeholder="<scriptPath>" spellCheck={false} onChange={(e) => setScriptPath(e.target.value)} />
              </Field>
            </div>
            <CodeBlock label="In the same process: edit the script, then ask in the session" syntax="text" code={recovery.sameProcess} />
            <CodeBlock label="After a process restart, on a build with the workflow engine" code={recovery.afterRestart} />
            <Notes
              items={[
                "In the same process: wait for the failed workflow owner to stop, edit the scriptPath the Workflow result returned, and resume with that path and the same run's resumeFromRunId. The script runs again from the top and reuses the longest unchanged prefix of completed child calls.",
                "After a restart: recover reads the retained workflow records and script, reuses committed results and restarts only the remaining child work.",
                "One workflow owner runs at a time: wait for the current attempt to finish or fail before you resume it.",
                "A session without a workflow session directory, muse --no-session-log included, keeps generated scripts in temporary storage that's gone when the process exits, so nothing is left to recover after a restart.",
              ]}
            />
          </div>
        </div>
      </Panel>

      <Panel idBase={idBase} id="capacity" active={view === "capacity"}>
        <div className="pg-col">
          <div className={styles.row}>
            <NumberField id={`${idBase}-cpu`} label="CPU-derived active-child limit" value={cpu} min={1} onChange={setCpu} hint="Defaults to your browser's core count; the exact formula isn't published." />
            <Field id={`${idBase}-stages`} label="Children per stage (comma-separated)" className={styles.grow}>
              <TextInput id={`${idBase}-stages`} className="pg-code-input" value={stagesText} onChange={(e) => setStagesText(e.target.value)} />
            </Field>
            <NumberField id={`${idBase}-tok`} label="Tokens per child" value={perChild} min={0} step={1000} onChange={setPerChild} />
          </div>
          <div className={`${styles.card} ${styles.cardMuted}`} role="status" aria-live="polite">
            <p className={styles.big}>
              Up to {cap.activeLimit} children at once{cap.activeLimit === ACTIVE_CAP ? " (the cap)" : ""}, {cap.total.toLocaleString("en-US")} over the workflow&apos;s life
            </p>
            <div className={styles.meter} aria-hidden>
              <div className={`${styles.meterFill} ${cap.failsAt ? styles.meterFillBad : cap.total > 800 ? styles.meterFillWarn : ""}`} style={{ width: `${Math.min(100, (cap.total / LIFETIME_CHILDREN) * 100)}%` }} />
            </div>
            <ul className={styles.notes}>
              {cap.waves.map((w, i) => (
                <li key={i}>
                  Stage {i + 1}: {cap.queued[i] ? `${cap.queued[i].toLocaleString("en-US")} of its children queue behind the limit, so it runs in ${w} waves.` : w ? "every child starts at once." : "no children."}
                </li>
              ))}
              <li>
                {cap.failsAt
                  ? `The workflow fails before child ${cap.failsAt.toLocaleString("en-US")} launches: a workflow can call up to ${LIFETIME_CHILDREN.toLocaleString("en-US")} child tasks over its lifetime.`
                  : `Within the ${LIFETIME_CHILDREN.toLocaleString("en-US")}-child lifetime limit.`}
              </li>
              <li>About {cap.tokens.toLocaleString("en-US")} tokens across children, since each child makes its own model calls.</li>
            </ul>
          </div>
        </div>
      </Panel>

      <Panel idBase={idBase} id="monitor" active={view === "monitor"}>
        <ControlRoom />
      </Panel>

      <Panel idBase={idBase} id="live" active={view === "live"}>
        <div className="pg-col">
          <p className="pg-hint">
            The page&apos;s first example as API calls: three children inspect the same code in parallel, each with one bounded responsibility, then a
            synthesis call verifies their findings and returns one report. Muse Code runs real agents with tools; this shows the shape and the token cost.
          </p>
          <Field id={`${idBase}-code`} label="Code the children inspect">
            <TextArea id={`${idBase}-code`} className="pg-code-input" rows={10} value={code} spellCheck={false} onChange={(e) => setCode(e.target.value)} disabled={running} />
          </Field>
          <div className={`${styles.grid} pg-advanced`}>
            {children.map((c, i) => (
              <Field key={i} id={`${idBase}-child-${i}`} label={`Child ${i + 1}`}>
                <TextInput
                  id={`${idBase}-child-${i}`}
                  value={c.task}
                  disabled={running}
                  onChange={(e) => setChildren((cur) => cur.map((x, j) => (j === i ? { title: e.target.value.replace(/^inspect (the )?/i, "") || `Child ${i + 1}`, task: e.target.value } : x)))}
                />
              </Field>
            ))}
          </div>
          <Field id={`${idBase}-synth`} label="Synthesis step" className="pg-advanced">
            <TextInput id={`${idBase}-synth`} value={synthText} disabled={running} onChange={(e) => setSynthText(e.target.value)} />
          </Field>
          <div className="pg-bar">
            <ModelSelect kind="text" value={model} onChange={setModel} disabled={running} />
            <RunButton running={running} onRun={() => void runWorkflow()} onStop={stopAll} label="Run the workflow" />
          </div>
          <ErrorBox error={firstError ?? null} />
          {live !== "idle" || totals.calls ? (
            <>
              <ol className={`${styles.grid} ${styles.plainList}`} aria-label="Children" aria-live="polite">
                {runners.map((r, i) => (
                  <li key={i} className={styles.card}>
                    <div className={styles.cardHead}>
                      <p className={styles.cardTitle}>
                        Child {i + 1}: {children[i].title}
                      </p>
                      <Chip tone={r.state === "done" ? "ok" : r.state === "error" ? "bad" : r.state === "running" ? "accent" : "plain"}>
                        {r.state === "running" ? "Running" : r.state === "done" ? "Done" : r.state === "error" ? "Failed" : "Waiting"}
                      </Chip>
                    </div>
                    <MarkdownText className={styles.msgAssistant} text={textOf(r.result) || (r.state === "running" ? "Inspecting..." : "")} />
                    <p className="pg-small">
                      <UsageLine model={r.result?.model ?? model} usage={(r.result?.json as { usage?: unknown } | null)?.usage ?? null} />
                    </p>
                  </li>
                ))}
              </ol>
              <section className={styles.card} aria-label="Synthesis" aria-live="polite">
                <div className={styles.cardHead}>
                  <p className={styles.cardTitle}>Synthesis</p>
                  <Chip tone={synth.state === "done" ? "ok" : synth.state === "error" ? "bad" : synth.state === "running" ? "accent" : "plain"}>
                    {synth.state === "running" ? "Running" : synth.state === "done" ? "Done" : synth.state === "error" ? "Failed" : live === "children" ? "Waits for every child" : "Waiting"}
                  </Chip>
                </div>
                <MarkdownText className={styles.msgAssistant} text={textOf(synth.result)} />
                <p className="pg-small">
                  <UsageLine model={synth.result?.model ?? model} usage={(synth.result?.json as { usage?: unknown } | null)?.usage ?? null} />
                </p>
              </section>
              {totals.calls && (live === "done" || live === "failed") ? (
                <div className="pg-hint" role="status">
                  {totals.calls} model calls, {totals.tokens.toLocaleString("en-US")} tokens, about {formatUsd(totals.usd)} in total. Each child makes its own model calls, so a broad workflow uses
                  far more tokens than one turn.
                </div>
              ) : null}
            </>
          ) : null}
          <Toggle id={`${idBase}-show`} label="Show code" checked={showCode} onChange={setShowCode} />
          {showCode ? (
            <>
              <CodeView method="POST" path="responses" body={childBodies[0]} caption="Child 1's request (the other children differ only in their responsibility)" />
              <CodeView
                method="POST"
                path="responses"
                body={synthesisBody(model, synthText, code, children.map((c, i) => ({ title: c.title, text: textOf(runners[i].result) || "<child findings>" })), budget)}
                caption="The synthesis request, sent once every child has answered"
              />
            </>
          ) : null}
        </div>
      </Panel>
    </div>
  );
}
