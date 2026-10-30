"use client";

import { useId, useMemo, useRef, useState, type ReactNode } from "react";
import { CodeView, ErrorBox, ModelSelect, RunButton, DEFAULT_TEXT_MODEL } from "@/components/docs/kit";
import { EffortSelect, PresetPills, Toggle } from "@/components/docs/kit/Field";
import type { Effort } from "@/lib/docs/client/models";
import styles from "@/components/docs/playgrounds/cookbook-use-cases/cuc.module.css";
import { RunBar, Timeline } from "@/components/docs/playgrounds/cookbook-use-cases/Timeline";
import { runInSandbox } from "@/components/docs/playgrounds/cookbook-use-cases/sandbox-run";
import { useAgentRun, type ToolEntry, type ToolExecutor } from "@/components/docs/playgrounds/cookbook-use-cases/useAgentRun";
import { agentBase, type AgentDef } from "@/components/docs/playgrounds/cookbook-use-cases/lib/agent";
import { parseArguments } from "@/components/docs/playgrounds/cookbook-use-cases/lib/responses";
import { diffStats, normalizePath, treeDiff, unifiedDiff } from "@/components/docs/playgrounds/cookbook-use-cases/lib/vfs";
import {
  RUN_TOOL,
  SANDBOX_SYSTEM,
  SANDBOX_TASKS,
  WRITE_TOOL,
  passedTests,
  planCommand,
  promptLine,
  splitCommands,
  taskById,
  taskInstruction,
  testsEdited,
} from "@/components/docs/playgrounds/cookbook-use-cases/lib/sandbox-exec";

/**
 * cookbook/sandboxed-execution: the recipe's scaffold in the browser. A throwaway "container" (a virtual /testbed),
 * the two tools and nothing else (run and write_file), the rules as the system prompt, and the loop. Muse Spark picks
 * every command: `node` runs the project's real JavaScript in a sandboxed iframe that is thrown away after each run.
 * When the model stops, the script re-runs the failing tests itself, saves pred.patch, and deletes the sandbox.
 */

export interface SandboxExecProps {
  slug: string;
  task?: string;
  maxCalls?: number;
}

type Json = Record<string, unknown>;

interface Verify {
  failToPass: Array<{ id: string; ok: boolean }>;
  passToPass: Array<{ id: string; ok: boolean }>;
  editedTests: string[];
  patch: string;
  stdout: string;
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/x-diff" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function Diff({ patch }: { patch: string }): ReactNode {
  return (
    <pre className={styles.diff}>
      {patch.split("\n").map((line, i) => {
        const kind = line.startsWith("+++") || line.startsWith("---") ? "h" : line.startsWith("@@") ? "@" : line[0] === "+" ? "+" : line[0] === "-" ? "-" : " ";
        return (
          <span key={i} className={styles.diffLine} data-kind={kind}>
            {line || " "}
          </span>
        );
      })}
    </pre>
  );
}

export function SandboxExec({ task: initialTask = "requests-6028", maxCalls = 24 }: SandboxExecProps) {
  const id = useId();
  const run = useAgentRun();
  const [taskId, setTaskId] = useState(initialTask);
  const [model, setModel] = useState(DEFAULT_TEXT_MODEL);
  const [effort, setEffort] = useState<Effort | null>("low");
  const [verify, setVerify] = useState<Verify | null>(null);
  const [showCode, setShowCode] = useState(false);
  const files = useRef<Record<string, string>>({});
  const writes = useRef(new Map<string, string>());
  const task = taskById(taskId);

  const agent: AgentDef = useMemo(
    // The scaffold sends "the running conversation" every turn: a stateless replay (store: false).
    () => ({ name: "muse-spark", model, instructions: SANDBOX_SYSTEM, tools: [RUN_TOOL, WRITE_TOOL], effort, maxOutputTokens: 4000, maxCalls, parallelToolCalls: false, state: "replay" as const }),
    [model, effort, maxCalls],
  );

  const exec: ToolExecutor = async (_agent, call) => {
    const { value, error } = parseArguments(call.arguments);
    if (error) return { output: error, status: "error" };
    if (call.name === "run") {
      const line = String(value.command ?? "");
      const chunks: string[] = [];
      let code = 0;
      for (const cmd of splitCommands(line)) {
        const plan = planCommand(cmd, files.current, task.files, task);
        let out: string;
        if (plan.kind === "text") {
          out = plan.out;
          code = plan.code;
        } else {
          const r = await runInSandbox(files.current, plan.entry, plan.args, 6000);
          out = [r.stdout, r.error].filter(Boolean).join("\n");
          code = r.code;
        }
        chunks.push(`${promptLine(cmd)}\n${out.length > 9000 ? `${out.slice(0, 9000)}\n... (output cut at 9,000 characters)` : out}`);
        if (code !== 0 && /&&/.test(line)) break;
      }
      const text = `${chunks.join("\n")}\n[exit code ${code}]`;
      return { output: text, note: code === 0 ? "exit 0" : `exit ${code}` };
    }
    if (call.name === "write_file") {
      const path = normalizePath(String(value.path ?? ""));
      const content = String(value.content ?? "");
      if (!path) return { output: "write_file: path is required", status: "error" };
      const before = files.current[path];
      files.current = { ...files.current, [path]: content };
      writes.current.set(call.callId, unifiedDiff(path, before, content));
      const s = diffStats(writes.current.get(call.callId) ?? "");
      return { output: `Wrote ${new TextEncoder().encode(content).length} bytes to /testbed/${path}.`, note: `+${s.added} -${s.removed}${path.startsWith("tests/") ? ", a test file" : ""}` };
    }
    return { output: `Unknown tool ${call.name}. Only run and write_file exist.`, status: "error" };
  };

  const scriptVerify = async (): Promise<Verify> => {
    const finalFiles = files.current;
    // A fresh sandbox from the final tree, as the script's STAGE 3 does: the failing tests, then the ones that must keep passing.
    const runner = finalFiles["package.json"] && /"test":\s*"node ([^"\s]+)/.exec(finalFiles["package.json"])?.[1];
    const entry = runner ? normalizePath(runner) : Object.keys(task.files).find((p) => p.startsWith("tests/test_")) ?? "";
    const pristineTests = { ...finalFiles, ...Object.fromEntries(Object.entries(task.files).filter(([p]) => p.startsWith("tests/"))) };
    const r = await runInSandbox(pristineTests, entry, [], 6000);
    const passed = passedTests(r.stdout);
    return {
      failToPass: task.failToPass.map((t) => ({ id: t, ok: passed.has(t) })),
      passToPass: task.passToPass.map((t) => ({ id: t, ok: passed.has(t) })),
      editedTests: testsEdited(task.files, finalFiles),
      patch: treeDiff(task.files, finalFiles),
      stdout: r.stdout,
    };
  };

  const start = () => {
    setVerify(null);
    files.current = { ...task.files };
    writes.current.clear();
    void run.start(async (rt) => {
      rt.note(`Stage 1: the sandbox starts. Container ${task.container}, ${task.repo} checked out at /testbed (${Object.keys(task.files).length} files).`);
      const result = await rt.run(agent, taskInstruction(task));
      if (result.stoppedBy === "stopped") return rt.note("Stopped. The sandbox is deleted.", "warn");
      if (result.stoppedBy === "limit") rt.note(`Guard: stopped after ${maxCalls} model calls.`, "warn");
      if (result.stoppedBy === "error") return rt.note("The model call failed; the sandbox is deleted.", "bad");
      rt.note("Stage 5: the script verifies independently in a fresh sandbox (tests restored from the base commit).");
      const v = await scriptVerify();
      setVerify(v);
      const f2p = v.failToPass.filter((t) => t.ok).length;
      rt.note(
        `FAIL_TO_PASS ${f2p} of ${v.failToPass.length} pass, PASS_TO_PASS ${v.passToPass.filter((t) => t.ok).length} of ${v.passToPass.length} pass${v.editedTests.length ? `; the model edited ${v.editedTests.join(", ")}` : ""}. pred.patch saved (${diffStats(v.patch).added + diffStats(v.patch).removed} lines changed).`,
        f2p === v.failToPass.length && v.passToPass.every((t) => t.ok) ? "good" : "bad",
      );
      rt.note(`Stage 6: container ${task.container} deleted. Only pred.patch is left.`);
      files.current = {};
    }, exec);
  };

  const renderTool = (e: ToolEntry): ReactNode => {
    if (e.name === "run" && e.output) {
      return (
        <pre className="pg-pre" style={{ background: "#0f1115", color: "#d6dbe4", borderColor: "#23262d" }}>
          {e.output}
        </pre>
      );
    }
    if (e.name === "write_file") {
      const patch = writes.current.get(e.callId);
      return patch ? <Diff patch={patch} /> : undefined;
    }
    return undefined;
  };

  const firstBody: Json = { ...agentBase(agent), input: taskInstruction(task) };

  return (
    <div className="pg">
      <PresetPills
        presets={SANDBOX_TASKS.map((t) => ({ label: t.label }))}
        active={SANDBOX_TASKS.findIndex((t) => t.id === taskId)}
        onPick={(i) => {
          setTaskId(SANDBOX_TASKS[i].id);
          run.reset();
          setVerify(null);
        }}
        disabled={run.busy}
      />
      <details className="pg-system">
        <summary>The instruction (built from task.json)</summary>
        <pre className="pg-pre">{taskInstruction(task)}</pre>
      </details>
      <details className="pg-system">
        <summary>The scaffold&apos;s system prompt and toolset</summary>
        <pre className="pg-pre">{SANDBOX_SYSTEM}</pre>
        <p className="pg-hint">Tools: run (a shell command in the container) and write_file. The shell knows ls, cat, head, sed -n, grep, find, git log/show/diff, node and npm test.</p>
      </details>
      <div className="pg-bar">
        <ModelSelect kind="text" value={model} onChange={setModel} disabled={run.busy} />
        <EffortSelect id={`${id}-effort`} model={model} value={effort} onChange={setEffort} disabled={run.busy} />
        <Toggle id={`${id}-step`} label="Pause after each step" checked={run.stepMode} onChange={run.setStepMode} />
      </div>
      <div className="pg-actions">
        <RunButton running={run.busy} onRun={start} onStop={run.stop} label="Run the sandboxed fix" />
        <span className="pg-hint">Up to {maxCalls} model calls; a typical run is 6 to 15, about a tenth of a cent on Spark Contributor and 40 to 100 times that on Muse Wonder.</span>
      </div>
      <RunBar busy={run.busy} modelCalls={run.modelCalls} totalUsd={run.totalUsd} waitingStep={run.waitingStep} onAdvance={run.advance} />
      <ErrorBox error={run.error} />
      <Timeline entries={run.entries} onAnswer={run.answer} renderTool={renderTool} label="Sandbox run" />

      {verify ? (
        <div className={styles.card}>
          <p className={styles.cardTitle}>STAGE 3 VERIFY, run by the script</p>
          <ul className="pg-checks">
            {[...verify.failToPass.map((t) => ({ ...t, group: "FAIL_TO_PASS" })), ...verify.passToPass.map((t) => ({ ...t, group: "PASS_TO_PASS" }))].map((t) => (
              <li key={t.id} className={t.ok ? "pg-check-ok" : ""}>
                <span className="pg-check-mark">{t.ok ? "✓" : "✗"}</span> <span className={styles.mono}>{t.group}</span> {t.id.split("::")[1]}
              </li>
            ))}
            {verify.editedTests.length ? (
              <li>
                <span className="pg-check-mark">!</span> The model edited a test file: {verify.editedTests.join(", ")} (the tests above ran from the base commit)
              </li>
            ) : null}
          </ul>
          {verify.patch ? (
            <>
              <div className={styles.row}>
                <p className="pg-section-label">pred.patch</p>
                <button type="button" className="btn btn-sm" onClick={() => download("pred.patch", verify.patch)}>
                  Download pred.patch
                </button>
              </div>
              <Diff patch={verify.patch} />
            </>
          ) : (
            <p className="pg-hint pg-bad">No change was made, so there is no patch.</p>
          )}
        </div>
      ) : null}

      <div className="pg-actions">
        <Toggle id={`${id}-code`} label="Show code" checked={showCode} onChange={setShowCode} />
      </div>
      {showCode ? <CodeView method="POST" path="responses" body={firstBody} caption="The first call: the rules, the two tools and the task" /> : null}
    </div>
  );
}
