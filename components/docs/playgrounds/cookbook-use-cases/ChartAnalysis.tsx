"use client";

import { useId, useMemo, useState } from "react";
import { CodeView, ErrorBox, ModelSelect, RunButton, DEFAULT_TEXT_MODEL } from "@/components/docs/kit";
import { useDocsRun } from "@/components/docs/kit/useDocsRun";
import { EffortSelect, Segmented, TextInput, Toggle } from "@/components/docs/kit/Field";
import { UsageLine } from "@/components/docs/kit/UsageLine";
import { FilePicker } from "@/components/docs/media/FilePicker";
import { useObjectUrl } from "@/components/docs/media/hooks";
import { MarkdownText } from "@/components/markdown/MarkdownText";
import { fileToDataUrl } from "@/lib/docs/media/base64";
import type { PickedMedia } from "@/lib/docs/media/prepare";
import type { Effort } from "@/lib/docs/client/models";
import styles from "@/components/docs/playgrounds/cookbook-use-cases/cuc.module.css";
import { responseText } from "@/components/docs/playgrounds/cookbook-use-cases/lib/responses";
import { parseStrictJson } from "@/components/docs/playgrounds/cookbook-use-cases/lib/strict-json";
import { withRetries } from "@/components/docs/playgrounds/cookbook-use-cases/lib/retry";
import { useRetryGuard } from "@/components/docs/playgrounds/cookbook-use-cases/useRetryGuard";
import {
  EXPLAIN_PROMPT,
  SAMPLE_CHART,
  STRUCTURED_PROMPT,
  VERIFY_PROMPT,
  barSchema,
  checkBars,
  checkSummary,
  gridlinePatches,
  readBarAnalysis,
  recipeSchema,
  summaryFacts,
  valueLabelRects,
  type BarAnalysis,
  type BarCheck,
} from "@/components/docs/playgrounds/cookbook-use-cases/lib/chart";

/**
 * cookbook/perception-chart-analysis, the recipe's pipeline on a chart image: (1) a grounded explanation that
 * describes only what is visible, (2) a structured analysis under a strict JSON schema, (3) verification of every
 * number against the chart's known values, plus "how did you read each one", (4) a summary card and a redrawn chart
 * built only from the extracted JSON, and (5) follow-ups in the same session (previous_response_id).
 */

export interface ChartAnalysisProps {
  slug: string;
  sampleId?: string;
  /** Start with the printed values covered, so the model has to read the axis. */
  coverValues?: boolean;
}

type Json = Record<string, unknown>;
type SchemaKind = "bars" | "recipe";

interface Step {
  text: string;
  id: string | null;
  usage: unknown;
  model: string | null;
}

async function coveredCopy(blob: Blob): Promise<Blob> {
  const bmp = await createImageBitmap(blob);
  const c = document.createElement("canvas");
  c.width = bmp.width;
  c.height = bmp.height;
  const ctx = c.getContext("2d")!;
  ctx.drawImage(bmp, 0, 0);
  ctx.fillStyle = "#ffffff";
  const sx = bmp.width / SAMPLE_CHART.geometry.width;
  const sy = bmp.height / SAMPLE_CHART.geometry.height;
  for (const r of valueLabelRects()) ctx.fillRect(r.x * sx, r.y * sy, r.w * sx, r.h * sy);
  ctx.fillStyle = SAMPLE_CHART.geometry.gridColor;
  for (const r of gridlinePatches()) ctx.fillRect(r.x * sx, r.y * sy, r.w * sx, r.h * sy);
  return new Promise((resolve) => c.toBlob((b) => resolve(b ?? blob), "image/png"));
}

const STATUS_LABEL: Record<BarCheck["status"], string> = {
  exact: "exact",
  close: "close",
  wrong: "misread",
  missing: "missing",
  unreadable: "marked unreadable",
  extra: "not on the chart",
};

export function ChartAnalysis({ sampleId = "bar-chart", coverValues = false }: ChartAnalysisProps) {
  const id = useId();
  const runner = useDocsRun();
  const [image, setImage] = useState<PickedMedia | null>(null);
  const [cover, setCover] = useState(coverValues);
  const [schemaKind, setSchemaKind] = useState<SchemaKind>("bars");
  const [model, setModel] = useState(DEFAULT_TEXT_MODEL);
  const [effort, setEffort] = useState<Effort | null>("low");
  const [sent, setSent] = useState<Blob | null>(null);
  const [explain, setExplain] = useState<Step | null>(null);
  const [structured, setStructured] = useState<(Step & { json: unknown; recovered: string | null }) | null>(null);
  const [verify, setVerify] = useState<Step | null>(null);
  const [followUps, setFollowUps] = useState<Array<Step & { q: string }>>([]);
  const [question, setQuestion] = useState("Which drink sold the most, and by how much did it beat the second?");
  const [phase, setPhase] = useState<string | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [showCode, setShowCode] = useState(false);
  const sentUrl = useObjectUrl(sent);
  const guard = useRetryGuard(runner.abort);
  const running = runner.state === "running" || guard.waiting;
  const isSample = image?.sampleId === "bar-chart";

  const schema = schemaKind === "bars" ? barSchema() : recipeSchema();
  const explainBody: Json = useMemo(
    () => ({
      model,
      input: [{ role: "user", content: [{ type: "input_text", text: EXPLAIN_PROMPT }, { type: "input_image", image_url: "data:image/png;base64,<BASE64>" }] }],
      ...(effort ? { reasoning: { effort } } : {}),
      max_output_tokens: 1500,
    }),
    [model, effort],
  );
  const structuredBody = (prev: string | null): Json => ({
    model,
    ...(prev ? { previous_response_id: prev } : {}),
    input: STRUCTURED_PROMPT,
    ...(effort ? { reasoning: { effort } } : {}),
    max_output_tokens: 2500,
    text: { format: { type: "json_schema", name: schemaKind === "bars" ? "bar_chart" : "chart_analysis", strict: true, schema } },
  });
  const followBody = (prev: string | null, input: string): Json => ({
    model,
    ...(prev ? { previous_response_id: prev } : {}),
    input,
    ...(effort ? { reasoning: { effort } } : {}),
    max_output_tokens: 1500,
  });

  const step = (res: { json: unknown; model: string | null }): Step => {
    const j = res.json as Json | null;
    return { text: responseText(j), id: typeof j?.id === "string" ? j.id : null, usage: j?.usage ?? null, model: res.model };
  };

  const runPipeline = async () => {
    if (!image) return;
    guard.begin();
    setExplain(null);
    setStructured(null);
    setVerify(null);
    setFollowUps([]);
    setParseError(null);
    const blob = cover && isSample ? await coveredCopy(image.blob) : image.blob;
    setSent(blob);
    const dataUrl = await fileToDataUrl(blob, cover && isSample ? "image/png" : image.mime);
    setPhase("Step 1: understanding the chart");
    const body1 = { ...explainBody, input: [{ role: "user", content: [{ type: "input_text", text: EXPLAIN_PROMPT }, { type: "input_image", image_url: dataUrl }] }] };
    const r1 = await withRetries(() => runner.run("responses", { method: "POST", body: body1 }), guard.options);
    if (!r1.ok) return setPhase(null);
    const s1 = step(r1);
    setExplain(s1);
    setPhase("Step 2: structured analysis");
    const r2 = await withRetries(() => runner.run("responses", { method: "POST", body: structuredBody(s1.id) }), guard.options);
    setPhase(null);
    if (!r2.ok) return;
    const s2 = step(r2);
    const parsed = parseStrictJson(s2.text);
    if (!parsed.ok) setParseError(parsed.error);
    setStructured({ ...s2, json: parsed.ok ? parsed.value : null, recovered: parsed.ok ? parsed.recovered : null });
  };

  const runVerify = async () => {
    const prev = structured?.id ?? explain?.id ?? null;
    if (!prev) return;
    setPhase("Step 3: how each value was read");
    const r = await runner.run("responses", { method: "POST", body: followBody(prev, VERIFY_PROMPT) });
    setPhase(null);
    if (r.ok) setVerify(step(r));
  };

  const ask = async () => {
    const last = followUps[followUps.length - 1]?.id ?? verify?.id ?? structured?.id ?? explain?.id ?? null;
    if (!last || !question.trim()) return;
    const q = question.trim();
    const r = await runner.run("responses", { method: "POST", body: followBody(last, q) });
    if (r.ok) setFollowUps((f) => [...f, { ...step(r), q }]);
  };

  const analysis: BarAnalysis | null = schemaKind === "bars" && structured?.json ? readBarAnalysis(structured.json) : null;
  const checks = analysis && isSample ? checkBars(analysis.bars, SAMPLE_CHART.bars, 0.03, analysis.unreadable) : null;

  return (
    <div className="pg">
      <div className={styles.grid2}>
        <FilePicker accept="image/*" value={image} onChange={setImage} samples={["bar-chart", "receipt", "error-screenshot"]} defaultSampleId={sampleId} preview="compact" disabled={running} />
        <div className={`${styles.stack} pg-advanced`}>
          <Toggle id={`${id}-cover`} label="Cover the printed values (read the axis)" checked={cover} onChange={setCover} disabled={running || !isSample} />
          <p className="pg-hint">
            {isSample
              ? cover
                ? "The numbers above the bars are painted over before sending, so every value has to be read off the gridlines."
                : "The bar chart's true values are known, so step 3 checks each number the model reads."
              : "For your own chart there are no known values to check against; step 3 asks the model how it read each one."}
          </p>
          <span className="pg-label">Schema for step 2</span>
          <Segmented<SchemaKind>
            label="Schema"
            size="sm"
            options={[
              { value: "bars", label: "Bar values (checkable)" },
              { value: "recipe", label: "The recipe's price-chart schema" },
            ]}
            value={schemaKind}
            onChange={setSchemaKind}
            disabled={running}
          />
        </div>
      </div>

      <div className="pg-bar">
        <ModelSelect kind="vision" value={model} onChange={setModel} disabled={running} />
        <EffortSelect id={`${id}-effort`} model={model} value={effort} onChange={setEffort} disabled={running} />
      </div>

      <div className="pg-actions">
        <RunButton running={running} onRun={() => void runPipeline()} onStop={guard.stop} label="Run steps 1 and 2" disabled={!image} />
        {phase ? (
          <span className="pg-hint" role="status">
            {phase}...
          </span>
        ) : null}
      </div>
      {guard.waitNote ? (
        <div className="pg-hint" role="status">
          {guard.waitNote}
        </div>
      ) : null}
      <ErrorBox error={guard.waiting ? null : runner.error} />

      {explain ? (
        <div className={styles.card}>
          <p className={styles.cardTitle}>1. Understand: what the model sees</p>
          {sentUrl ? <img src={sentUrl} alt="The chart as sent" className={styles.shot} style={{ maxHeight: 260, width: "auto" }} /> : null}
          <MarkdownText className={styles.answer} text={explain.text} />
          <UsageLine model={explain.model ?? model} usage={explain.usage} />
        </div>
      ) : null}

      {structured ? (
        <div className={parseError ? styles.card : `${styles.card} pg-advanced`}>
          <p className={styles.cardTitle}>2. Structured analysis (strict JSON schema)</p>
          {structured.recovered ? <p className="pg-hint">Recovered the JSON from {structured.recovered === "fences" ? "markdown fences" : "surrounding text"}.</p> : null}
          {parseError ? <div className="pg-hint pg-bad">{parseError}</div> : null}
          <pre className="pg-pre">{structured.json ? JSON.stringify(structured.json, null, 2) : structured.text}</pre>
          <UsageLine model={structured.model ?? model} usage={structured.usage} />
        </div>
      ) : null}

      {structured ? (
        <div className={styles.card}>
          <p className={styles.cardTitle}>3. Verify the numbers</p>
          {checks ? (
            <>
              <p className={`pg-verdict ${checks.every((c) => c.status === "exact" || c.status === "close") ? "pg-good" : "pg-bad"}`} role="status">
                {checkSummary(checks)}
              </p>
              <div className={styles.tableWrap}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>Bar</th>
                      <th className={styles.num}>True</th>
                      <th className={styles.num}>Read</th>
                      <th className={styles.num}>Off by</th>
                      <th>Result</th>
                      <th>How it was read</th>
                    </tr>
                  </thead>
                  <tbody>
                    {checks.map((c) => (
                      <tr key={c.label}>
                        <td>{c.label}</td>
                        <td className={styles.num}>{c.known ?? ""}</td>
                        <td className={styles.num}>{c.read ?? "null"}</td>
                        <td className={styles.num}>{c.delta === null ? "" : c.delta > 0 ? `+${c.delta}` : c.delta}</td>
                        <td>
                          <span className={styles.chip} data-tone={c.status === "exact" ? "good" : c.status === "close" ? "warn" : "bad"}>
                            {STATUS_LABEL[c.status]}
                          </span>
                        </td>
                        <td className="pg-small">{c.how ?? ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <p className="pg-hint">
              {schemaKind === "recipe"
                ? "The recipe's schema has no per-bar values to check; switch to bar values, or ask how each level was read."
                : "No known values for this image. Ask how each value was read, then check them by eye."}
            </p>
          )}
          <div className="pg-actions pg-advanced">
            <button type="button" className="btn btn-sm" onClick={() => void runVerify()} disabled={running}>
              Ask how it read each value
            </button>
          </div>
          {verify ? (
            <>
              <MarkdownText className={styles.answer} text={verify.text} />
              <UsageLine model={verify.model ?? model} usage={verify.usage} />
            </>
          ) : null}
        </div>
      ) : null}

      {analysis ? <SummaryCard analysis={analysis} checks={checks} imageUrl={sentUrl} /> : null}

      {structured ? (
        <div className={`${styles.card} pg-advanced`}>
          <p className={styles.cardTitle}>5. Follow up in the same session</p>
          {followUps.map((f, i) => (
            <div key={i} className={styles.stack}>
              <p className="pg-small">
                <strong>You: </strong>
                {f.q}
              </p>
              <MarkdownText className={styles.answer} text={f.text} />
              <UsageLine model={f.model ?? model} usage={f.usage} />
            </div>
          ))}
          <div className={styles.textAnswer}>
            <label className="sr-only" htmlFor={`${id}-follow`}>
              Follow-up question
            </label>
            <TextInput id={`${id}-follow`} value={question} onChange={(e) => setQuestion(e.target.value)} disabled={running} />
            <button type="button" className="btn btn-sm btn-primary" onClick={() => void ask()} disabled={running || !question.trim()}>
              Ask
            </button>
          </div>
          <p className="pg-hint">Each follow-up continues with previous_response_id, so the chart and the analysis stay in context without resending the image.</p>
        </div>
      ) : null}

      <div className="pg-actions">
        <Toggle id={`${id}-code`} label="Show code" checked={showCode} onChange={setShowCode} />
      </div>
      {showCode ? (
        <>
          <CodeView method="POST" path="responses" body={explainBody} caption="Step 1: chart image in, grounded explanation out" />
          <CodeView method="POST" path="responses" body={structuredBody(explain?.id ?? "resp_from_step_1")} caption="Step 2: the structured analysis, chained to step 1" />
        </>
      ) : null}
    </div>
  );
}

/** Step 4: the card render-summary.py makes, from the extracted JSON alone, and the chart redrawn from it. */
function SummaryCard({ analysis, checks, imageUrl }: { analysis: BarAnalysis; checks: BarCheck[] | null; imageUrl: string | null }) {
  const facts = summaryFacts(analysis);
  const bars = analysis.bars;
  const max = Math.max(1, ...bars.map((b) => b.value ?? 0), ...(checks ?? []).map((c) => c.known ?? 0));
  const W = 560;
  const H = 220;
  const pad = 28;
  const bw = (W - pad * 2) / Math.max(1, bars.length);
  return (
    <div className={styles.card}>
      <p className={styles.cardTitle}>4. Summary card, built from the JSON</p>
      <div className={styles.row}>
        <strong>{analysis.title || "Untitled chart"}</strong>
        <span className={styles.chip} data-tone="accent">
          trend: {analysis.trend || "n/a"}
        </span>
        {facts.leader ? (
          <span className={styles.chip} data-tone="good">
            top: {facts.leader.label} {facts.leader.value}
          </span>
        ) : null}
        {facts.last ? <span className={styles.chip}>lowest: {facts.last.label} {facts.last.value}</span> : null}
        {facts.gap !== null ? <span className={styles.chip}>lead over #2: {facts.gap}</span> : null}
        {facts.total !== null ? <span className={styles.chip}>total: {facts.total.toLocaleString()}</span> : null}
        {analysis.unreadable.map((u) => (
          <span key={u} className={styles.chip} data-tone="warn">
            unreadable: {u}
          </span>
        ))}
      </div>
      <svg viewBox={`0 0 ${W} ${H + 36}`} role="img" aria-label={`Redrawn chart: ${bars.map((b) => `${b.label} ${b.value ?? "unreadable"}`).join(", ")}`} style={{ width: "100%", height: "auto" }}>
        <line x1={pad} y1={H} x2={W - pad} y2={H} stroke="var(--line-strong)" />
        {bars.map((b, i) => {
          // The same match the verification table made (labels normalized), so "Cold-brew" keeps its true-value outline.
          const known = checks?.find((c) => c.readLabel === b.label)?.known ?? null;
          const h = ((b.value ?? 0) / max) * (H - 30);
          const kh = known !== null ? (known / max) * (H - 30) : null;
          const x = pad + i * bw + bw * 0.18;
          const w = bw * 0.64;
          return (
            <g key={i}>
              {kh !== null ? <rect x={x - 3} y={H - kh} width={w + 6} height={kh} fill="none" stroke="var(--muted)" strokeDasharray="4 3" /> : null}
              <rect x={x} y={H - h} width={w} height={h} rx={4} fill="var(--chart-1)" />
              <text x={x + w / 2} y={H - h - 6} textAnchor="middle" fontSize="12" fill="var(--fg)">
                {b.value ?? "?"}
              </text>
              <text x={x + w / 2} y={H + 16} textAnchor="middle" fontSize="11" fill="var(--fg-2)">
                {b.label}
              </text>
            </g>
          );
        })}
      </svg>
      <p className="pg-hint">
        Solid bars: what the model read. {checks ? "Dashed outlines: the chart's true values. " : ""}Like the recipe&apos;s render-summary.py, nothing here is drawn by a model.
      </p>
      {imageUrl ? <img src={imageUrl} alt="The original chart" className={styles.shot} style={{ maxHeight: 180, width: "auto" }} /> : null}
    </div>
  );
}
