// Platform file (Muse Muse platform services). Don't edit: put it right under the code that made the run.
//
// One run's output, the same way for every engine: a status line, then stdout, then errors in their own color.
//   <CodeOutput run={run} running={busy} />
import type { CodeRun } from "@/lib/platform/code-run";

const WHERE: Record<CodeRun["runtime"], string> = { pyodide: "in your browser", quickjs: "in your browser", exec: "on Muse Muse" };

function seconds(ms: number): string {
  return ms < 1000 ? `${Math.max(0, Math.round(ms))} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/** The status line, in plain words. */
export function statusLine(run: CodeRun): string {
  if (run.status === "timeout") return `Stopped at its time limit, ${WHERE[run.runtime]}`;
  if (run.status === "error") return run.exitCode !== undefined && run.exitCode !== null ? `Exited with code ${run.exitCode} after ${seconds(run.ms)}` : `Stopped with an error after ${seconds(run.ms)}`;
  return `Finished in ${seconds(run.ms)}, ${WHERE[run.runtime]}`;
}

const pre = { margin: 0, padding: "12px", whiteSpace: "pre-wrap", overflowWrap: "anywhere", font: "400 14px/20px var(--font-mono)", background: "var(--surface-2)", borderRadius: "8px", maxHeight: "320px", overflowY: "auto" } as const;

export function CodeOutput({ run, running = false, emptyText = "Run the code to see its output here." }: { run: CodeRun | null; running?: boolean; emptyText?: string }) {
  return (
    <section className="stack" aria-busy={running ? "true" : "false"} aria-live="polite" data-testid="code-output" style={{ gap: "8px" }}>
      {running ? (
        <p className="hint">Running...</p>
      ) : !run ? (
        <p className="hint">{emptyText}</p>
      ) : (
        <>
          <p className="hint" data-status={run.status}>
            {statusLine(run)}
            {run.truncated ? ". The output was cut at 64 KB." : ""}
          </p>
          {run.stdout ? (
            <pre style={pre} data-testid="code-stdout">
              {run.stdout}
            </pre>
          ) : null}
          {run.stderr ? (
            <pre style={{ ...pre, color: "var(--negative)", background: "var(--negative-soft)" }} data-testid="code-stderr">
              {run.stderr}
            </pre>
          ) : null}
          {!run.stdout && !run.stderr ? <p className="hint">No output.</p> : null}
        </>
      )}
    </section>
  );
}
