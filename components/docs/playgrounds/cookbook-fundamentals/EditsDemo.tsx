"use client";

import { useId, useMemo, useRef, useState } from "react";
import { CodeView } from "@/components/docs/kit/CodeView";
import { ErrorBox } from "@/components/docs/kit/ErrorBox";
import { EffortSelect, Field, TextArea, Toggle } from "@/components/docs/kit/Field";
import { JsonTree } from "@/components/docs/kit/JsonTree";
import { ModelSelect } from "@/components/docs/kit/ModelSelect";
import { latencyLabel } from "@/components/docs/kit/ResponseView";
import { RunButton } from "@/components/docs/kit/RunButton";
import { UsageLine } from "@/components/docs/kit/UsageLine";
import { ProjectFs } from "@/components/docs/playgrounds/cookbook-fundamentals/agent";
import styles from "@/components/docs/playgrounds/cookbook-fundamentals/cookbook.module.css";
import { unifiedDiff } from "@/components/docs/playgrounds/cookbook-fundamentals/diff";
import { applyEdit, parseEditCall, pythonProblems, type EditCall, type EditResult } from "@/components/docs/playgrounds/cookbook-fundamentals/edits";
import { BROKEN_EDITS, EDIT_TASKS, SAM_FILES } from "@/components/docs/playgrounds/cookbook-fundamentals/sam-files";
import { DiffView, Note, SplitPills, StatusPill } from "@/components/docs/playgrounds/cookbook-fundamentals/ui";
import { useToolLoop } from "@/components/docs/playgrounds/cookbook-fundamentals/useToolLoop";
import { MarkdownText } from "@/components/markdown/MarkdownText";
import type { NeutralRequest, ToolDef } from "@/lib/docs/client/body";
import { DEFAULT_TEXT_MODEL, fitEffort, type Effort } from "@/lib/docs/client/models";
import { nextModelBody, requestedCalls } from "@/lib/docs/client/toolloop";
import type { ResolvedTool } from "@/lib/docs/client/tools";

/**
 * The search-and-replace-edits recipe, live: the recipe's sample files from segment-anything and its six prompts.
 * The model answers with OpenCode-shaped edit and write tool calls; the page applies each one under the exactly-once
 * rule (zero matches or several is a rejection, with the reason sent back so the model can retry), shows the payload,
 * the diff it produces and a light syntax check, and has hand-made broken edits to show each failure mode.
 */

export interface EditsDemoProps {
  slug: string;
}

const EDIT_TOOL: ToolDef = {
  name: "edit",
  description:
    "Replace text in an existing file. oldString must be the exact current text (whitespace included) and match exactly once; add surrounding lines to make it unique. newString replaces it. Set replaceAll only to change every occurrence.",
  parameters: {
    type: "object",
    properties: {
      filePath: { type: "string", description: "The file's path." },
      oldString: { type: "string", description: "The exact text to replace." },
      newString: { type: "string", description: "The text to put in its place; must differ from oldString." },
      replaceAll: { type: "boolean", description: "Replace every occurrence instead of exactly one." },
    },
    required: ["filePath", "oldString", "newString"],
    additionalProperties: false,
  },
};

const WRITE_TOOL: ToolDef = {
  name: "write",
  description: "Create a new file with the given content. Use it only for files that don't exist yet.",
  parameters: {
    type: "object",
    properties: { filePath: { type: "string" }, content: { type: "string", description: "The whole file." } },
    required: ["filePath", "content"],
    additionalProperties: false,
  },
};

const INSTRUCTIONS =
  "You are a coding agent editing files. Make the smallest precise change. For an existing file use the edit tool: oldString must be copied exactly from the file as shown and match exactly once, so include a few surrounding lines when the text repeats. Use write only to create a new file. Make every edit the task needs in this turn, then stop with a one-line summary.";

function filesPrompt(files: Record<string, string>): string {
  return Object.entries(files)
    .map(([path, text]) => `${path}\n\`\`\`python\n${text}\`\`\``)
    .join("\n\n");
}

interface Applied {
  call: EditCall | null;
  result: EditResult | null;
  error: string | null;
  manual?: string;
}

function ResultCard({ a }: { a: Applied }) {
  const r = a.result;
  return (
    <li className={styles.turn}>
      <div className={styles.turnHead}>
        <span className={styles.turnTitle}>
          {a.call?.tool ?? "?"} {a.call ? <code>{a.call.filePath}</code> : null}
        </span>
        {a.error ? (
          <StatusPill tone="bad">bad call</StatusPill>
        ) : r?.ok ? (
          <StatusPill tone={r.warnings.length ? "warn" : "ok"}>{r.call.tool === "write" ? (r.before === null ? "file created" : "file replaced") : `applied: ${r.matches} match${r.matches === 1 ? "" : "es"}`}</StatusPill>
        ) : (
          <StatusPill tone="bad">rejected{r && "matches" in r && r.matches !== undefined ? `: ${r.matches} matches` : ""}</StatusPill>
        )}
        {a.manual ? <span className="pg-muted pg-small">{a.manual}</span> : null}
      </div>
      {a.error ? <p className="pg-bad">{a.error}</p> : null}
      {r && !r.ok ? <p className={styles.result}>{r.message}</p> : null}
      {r?.ok && r.warnings.length ? <p className={styles.note}>{r.warnings.join(" ")}</p> : null}
      {a.call ? (
        <details className="pg-raw pg-advanced">
          <summary>Payload</summary>
          <JsonTree value={a.call} openDepth={2} />
        </details>
      ) : null}
    </li>
  );
}

export function EditsDemo(_props: EditsDemoProps) {
  const id = useId();
  const [model, setModel] = useState(DEFAULT_TEXT_MODEL);
  const [effort, setEffort] = useState<Effort | null>("low");
  const [taskIndex, setTaskIndex] = useState(0);
  const [prompt, setPrompt] = useState(EDIT_TASKS[0].prompt);
  const [manual, setManual] = useState<Applied[]>([]);
  const [showCode, setShowCode] = useState(false);
  const [version, setVersion] = useState(0);
  const fs = useRef(new ProjectFs(SAM_FILES));

  const tools: ResolvedTool[] = useMemo(
    () =>
      [EDIT_TOOL, WRITE_TOOL].map((def) => ({
        def,
        builtIn: false,
        source: "mock" as const,
        run: async (args: Record<string, unknown>) => {
          const call = parseEditCall(def.name, JSON.stringify(args));
          if ("error" in call) return { error: call.error };
          const result = applyEdit(fs.current.files, call);
          if (!result.ok) {
            return { status: "rejected", filePath: result.path, reason: result.message, current_file: fs.current.files[result.path] ?? null };
          }
          fs.current.files = { ...fs.current.files, [result.path]: result.after };
          fs.current.writes++;
          setVersion((v) => v + 1);
          return { status: "applied", filePath: result.path, matches: result.matches, ...(result.warnings.length ? { note: result.warnings.join(" ") } : {}) };
        },
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fs.current],
  );

  // Only the first call carries the files (later ones continue with previous_response_id), so quoting the files as
  // they are at this render is quoting what the model starts from.
  const base: NeutralRequest = useMemo(
    () => ({
      model,
      system: INSTRUCTIONS,
      messages: [{ role: "user", content: `${prompt.trim()}\n\nThe files, as they are now:\n\n${filesPrompt(fs.current.files)}` }],
      tools: [EDIT_TOOL, WRITE_TOOL],
      effort: fitEffort(model, effort),
    }),
    // version changes whenever the files do.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [model, prompt, effort, version],
  );

  const loop = useToolLoop({ protocol: "responses", base, tools, maxCalls: 3 });

  // Every edit and write the model made, with what applying it did, in order.
  const applied: Applied[] = [];
  for (const s of loop.steps) {
    if (s.kind !== "tools") continue;
    for (const r of s.results) {
      const call = parseEditCall(r.call.name, r.call.arguments);
      const v = r.run?.value as { status?: string; reason?: string; matches?: number; note?: string; error?: string; filePath?: string } | undefined;
      if ("error" in call) {
        applied.push({ call: null, result: null, error: call.error });
        continue;
      }
      if (!v) {
        applied.push({ call, result: null, error: null });
        continue;
      }
      if (v.error) applied.push({ call, result: null, error: v.error });
      else if (v.status === "rejected") {
        applied.push({ call, result: { ok: false, call, path: v.filePath ?? call.filePath, problem: "no_match", message: v.reason ?? "Rejected." }, error: null });
      } else {
        applied.push({
          call,
          result: { ok: true, call, path: v.filePath ?? call.filePath, before: null, after: "", matches: v.matches ?? 0, warnings: v.note ? [v.note] : [] },
          error: null,
        });
      }
    }
  }

  const resetFiles = () => {
    loop.reset();
    fs.current = new ProjectFs(SAM_FILES);
    setManual([]);
    setVersion((v) => v + 1);
  };

  const applyBroken = (i: number) => {
    const b = BROKEN_EDITS[i];
    const result = applyEdit(fs.current.files, b.call);
    if (result.ok) {
      fs.current.files = { ...fs.current.files, [result.path]: result.after };
      setVersion((v) => v + 1);
    }
    setManual((cur) => [...cur, { call: b.call, result, error: null, manual: `by hand, no API call: ${b.why}` }]);
  };

  const start = () => void loop.runAll();

  const changed = fs.current.changed();
  const diff = changed.map((p) => unifiedDiff(p, fs.current.original[p] ?? null, fs.current.files[p] ?? null)).filter(Boolean).join("\n\n");
  const problems = changed.filter((p) => p.endsWith(".py") && fs.current.files[p] !== undefined).flatMap((p) => pythonProblems(fs.current.files[p]).map((x) => `${p}: ${x}`));
  const models = loop.steps.filter((s) => s.kind === "model");
  const finished = loop.next === "done" || loop.next === "limit";
  const rejected = applied.filter((a) => a.result && !a.result.ok).length;

  return (
    <div className="pg">
      <div className="pg-bar">
        <ModelSelect kind="text" value={model} onChange={setModel} disabled={loop.busy} />
        <EffortSelect id={`${id}-effort`} model={model} value={effort} onChange={setEffort} disabled={loop.busy} />
      </div>
      <SplitPills
        label="Task"
        presets={EDIT_TASKS}
        active={taskIndex}
        disabled={loop.busy}
        onPick={(i) => {
          setTaskIndex(i);
          setPrompt(EDIT_TASKS[i].prompt);
          loop.reset();
        }}
        simple={4}
      />
      <Field id={`${id}-prompt`} label="The prompt, as typed into OpenCode in the recipe">
        <TextArea id={`${id}-prompt`} rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} disabled={loop.busy || loop.steps.length > 0} />
      </Field>
      <div className={styles.spread}>
        <span className="pg-muted pg-small pg-advanced">The prompt quotes the three files as they are now. Usually two calls, well under a cent.</span>
        <span className={styles.row}>
          {loop.steps.length || changed.length || manual.length ? (
            <button type="button" className="btn btn-sm" onClick={resetFiles} disabled={loop.busy}>
              Reset the files
            </button>
          ) : null}
          {finished ? (
            <button type="button" className="btn btn-sm btn-outline" onClick={() => loop.reset()} disabled={loop.busy}>
              New run on these files
            </button>
          ) : null}
          <RunButton running={loop.busy} onRun={start} onStop={loop.stop} disabled={finished || !prompt.trim()} label="Ask for the edits" />
        </span>
      </div>
      <ErrorBox error={loop.error} />

      {models.length ? (
        <p className={styles.turnHead}>
          {models.map((s, i) =>
            s.kind === "model" ? (
              <span key={i} className={styles.row}>
                <StatusPill tone={!s.collected?.done ? "busy" : s.collected.error ? "bad" : "idle"}>
                  call {s.call}: {!s.collected?.done ? "running" : requestedCalls(s).length ? `${requestedCalls(s).length} tool call${requestedCalls(s).length === 1 ? "" : "s"}` : "answered"}
                </StatusPill>
                {s.elapsedMs ? <span className="pg-meta pg-advanced">{latencyLabel(s.elapsedMs)}</span> : null}
                {s.collected?.usage ? (
                  <span className="pg-advanced">
                    <UsageLine model={s.model ?? model} usage={s.collected.usage} />
                  </span>
                ) : null}
              </span>
            ) : null,
          )}
        </p>
      ) : null}

      {applied.length || manual.length ? (
        <ol className={styles.turns} aria-label="Edits" aria-live="polite">
          {[...applied, ...manual].map((a, i) => (
            <ResultCard key={i} a={a} />
          ))}
        </ol>
      ) : null}
      {rejected && !loop.busy ? (
        <Note advanced>
          {rejected} edit{rejected === 1 ? " was" : "s were"} rejected. The reason and the current file went back to the model as the tool&apos;s
          output, so its next call can copy oldString exactly: the recipe&apos;s recovery.
        </Note>
      ) : null}
      {finished ? (
        (() => {
          const last = [...loop.steps].reverse().find((s) => s.kind === "model");
          return last && last.kind === "model" && last.collected?.text ? <MarkdownText className={styles.thought} text={last.collected.text} /> : null;
        })()
      ) : null}

      <div className={`${styles.row} pg-advanced`}>
        <span className={styles.inlineLabel}>Try a broken edit (no API call)</span>
        {BROKEN_EDITS.map((b, i) => (
          <button key={b.label} type="button" className="btn btn-sm btn-outline" onClick={() => applyBroken(i)} disabled={loop.busy} title={b.why}>
            {b.label}
          </button>
        ))}
      </div>

      <p className="pg-section-label">The diff{changed.length ? ` (${changed.length} file${changed.length === 1 ? "" : "s"})` : ""}</p>
      <DiffView diff={diff} label="What the edits changed" />
      {changed.length ? (
        problems.length ? (
          <div className="pg-warn" role="note">
            <p className="pg-warn-title">The light syntax check found:</p>
            <ul>
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </div>
        ) : (
          <Note advanced>A light syntax check in the page (brackets, strings, indentation, colons) passes. Run python -m py_compile and flake8 on the real project: applying cleanly isn&apos;t the same as being correct.</Note>
        )
      ) : null}

      <div className="pg-actions">
        <Toggle id={`${id}-code`} label="Show code" checked={showCode} onChange={setShowCode} />
      </div>
      {showCode ? <CodeView method="POST" path="responses" body={nextModelBody("responses", base, loop.steps)} caption={loop.steps.length ? "The next request" : "The first request"} /> : null}
    </div>
  );
}
