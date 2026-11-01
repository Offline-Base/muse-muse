import { EXPORT_KINDS, exportPlan, installerName, runLine, type ExportNotice } from "@/lib/train/export/installers";
import type { LocalFiles } from "@/lib/train/local-files";
import { deviceModelTarget } from "@/lib/train/quant-targets";
import { buildSize } from "@/components/train/format";

/**
 * Run it on your device (EXPORT_TUNED): one download per device kind, a small script that gets the checked file at its pinned
 * commit and runs it with llama.cpp, with an Ollama path. Which file a kind gets is deviceModelTarget's, and a kind this
 * version made no file for says so. No device has run a tuned file yet, and the row says that too.
 */
export function ExportTuned({ modelId, files, notice }: { modelId: string; files: LocalFiles | null; notice: ExportNotice }) {
  return (
    <section className="card section-card lab-try" id="export-tuned" aria-labelledby="export-tuned-title">
      <div className="lab-try-head">
        <h2 id="export-tuned-title">Run it on your device</h2>
      </div>
      <p className="lab-try-lead">Download one small script, run it once, and it does the rest: it gets the model and llama.cpp, checks both against pinned sha256 values, and starts a chat in your terminal.</p>
      <dl className="kv">
        {EXPORT_KINDS.map(({ kind, label }) => {
          const planned = exportPlan(kind, files, notice);
          const target = deviceModelTarget(kind);
          const href = `/api/models/${modelId}/export?kind=${kind}`;
          return (
            <div key={kind}>
              <dt>{label}</dt>
              <dd>
                {planned.ok ? (
                  <>
                    <a className="btn btn-outline" href={href} download={installerName(planned.plan)}>
                      Download for {label}
                    </a>
                    <p className="muted small">
                      {planned.plan.modelLabel}, {planned.plan.file.level}, {buildSize(planned.plan.file.bytes)}. Then run <code>{runLine(planned.plan)}</code>
                    </p>
                    {planned.plan.modelfile ? (
                      <p className="muted small">
                        With Ollama instead: <code>{runLine(planned.plan, true)}</code> (<a href={`${href}&format=modelfile`}>Modelfile</a>)
                      </p>
                    ) : null}
                    <p className="muted small">{planned.plan.fit}</p>
                  </>
                ) : (
                  <p className="muted small">
                    {target.label}: {planned.problem}
                  </p>
                )}
              </dd>
            </div>
          );
        })}
      </dl>
      <p className="muted small">
        {notice.line ? <strong>{notice.line}. </strong> : null}
        {notice.license} {notice.points.join(" ")}
      </p>
    </section>
  );
}
