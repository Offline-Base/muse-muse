"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { CodeView, ErrorBox, ModelSelect, RunButton, DEFAULT_TEXT_MODEL } from "@/components/docs/kit";
import { useDocsRun } from "@/components/docs/kit/useDocsRun";
import { EffortSelect, PresetPills, Segmented, TextArea, Toggle } from "@/components/docs/kit/Field";
import { UsageLine } from "@/components/docs/kit/UsageLine";
import { FilePicker } from "@/components/docs/media/FilePicker";
import { useObjectUrl } from "@/components/docs/media/hooks";
import { fileToDataUrl } from "@/lib/docs/media/base64";
import type { PickedMedia } from "@/lib/docs/media/prepare";
import type { SseEvent } from "@/lib/docs/client/api";
import type { Effort } from "@/lib/docs/client/models";
import { responsesCollector } from "@/lib/docs/client/stream";
import styles from "@/components/docs/playgrounds/cookbook-use-cases/cuc.module.css";
import { SandboxFrame } from "@/components/docs/playgrounds/cookbook-use-cases/SandboxFrame";
import { extractHtml } from "@/components/docs/playgrounds/cookbook-use-cases/lib/harness";
import { responseText } from "@/components/docs/playgrounds/cookbook-use-cases/lib/responses";
import { parseStrictJson } from "@/components/docs/playgrounds/cookbook-use-cases/lib/strict-json";
import {
  DEFAULT_DIET_PROMPT,
  dedupePoints,
  foodSchema,
  htmlPrompt,
  overlayHtml,
  pointsPrompt,
  readFoodPoints,
  tooltipBox,
  type FoodPoint,
} from "@/components/docs/playgrounds/cookbook-use-cases/lib/grounding-overlay";

/**
 * cookbook/perception-grounding: the fridge photo and a dietary prompt in one call, a dot on every food out. "Points"
 * asks for strict JSON on the 0 to 1000 grid and draws the dots here (green or red, the health score above, a
 * tooltip that stays inside the image), with the self-contained overlay page to download. "One call, HTML out" is the
 * recipe's own mode: the model writes the whole interactive page, shown in a sandboxed frame.
 */

export interface GroundingOverlayProps {
  slug: string;
  sampleId?: string;
  prompt?: string;
  presets?: Array<{ label: string; prompt: string }>;
  mode?: "points" | "html";
}

type Mode = "points" | "html";

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/html" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function GroundingOverlay({ sampleId = "fridge", prompt = DEFAULT_DIET_PROMPT, presets = [], mode: initialMode = "points" }: GroundingOverlayProps) {
  const id = useId();
  const runner = useDocsRun();
  const [image, setImage] = useState<PickedMedia | null>(null);
  const [diet, setDiet] = useState(prompt);
  const [mode, setMode] = useState<Mode>(initialMode);
  const [model, setModel] = useState(DEFAULT_TEXT_MODEL);
  const [effort, setEffort] = useState<Effort | null>("low");
  const [preset, setPreset] = useState<number | null>(null);
  const [points, setPoints] = useState<FoodPoint[] | null>(null);
  const [removed, setRemoved] = useState(0);
  const [sentUrl, setSentUrl] = useState<string | null>(null);
  const [html, setHtml] = useState<string | null>(null);
  const [streamed, setStreamed] = useState(0);
  const [usage, setUsage] = useState<unknown>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [active, setActive] = useState<number | null>(null);
  const [showCode, setShowCode] = useState(false);
  const imageUrl = useObjectUrl(image?.blob ?? null);
  const running = runner.state === "running";

  const body = useMemo(() => {
    const content = [
      { type: "input_text", text: mode === "points" ? pointsPrompt(diet) : htmlPrompt(diet, image?.width ?? 853, image?.height ?? 1280) },
      { type: "input_image", image_url: "data:image/jpeg;base64,<BASE64>" },
    ];
    return {
      model,
      input: [{ role: "user", content }],
      ...(effort ? { reasoning: { effort } } : {}),
      max_output_tokens: mode === "points" ? 4000 : 12000,
      ...(mode === "points"
        ? { text: { format: { type: "json_schema", name: "food_points", strict: true, schema: foodSchema() } } }
        : { stream: true }),
    };
  }, [mode, diet, image, model, effort]);

  const run = async () => {
    if (!image) return;
    setPoints(null);
    setHtml(null);
    setParseError(null);
    setUsage(null);
    setStreamed(0);
    setActive(null);
    const dataUrl = await fileToDataUrl(image.blob, image.mime);
    setSentUrl(dataUrl);
    const sent = {
      ...body,
      input: [{ role: "user", content: [body.input[0].content[0], { type: "input_image", image_url: dataUrl }] }],
    };
    if (mode === "points") {
      const res = await runner.run("responses", { method: "POST", body: sent });
      if (!res.ok) return;
      setUsage((res.json as { usage?: unknown } | null)?.usage ?? null);
      const parsed = parseStrictJson(responseText(res.json));
      if (!parsed.ok) {
        setParseError(parsed.error);
        return;
      }
      const clean = dedupePoints(readFoodPoints(parsed.value));
      setPoints(clean.points);
      setRemoved(clean.removed);
      return;
    }
    const collector = responsesCollector();
    const onEvent = (e: SseEvent) => {
      collector.push(e);
      setStreamed(collector.snapshot().text.length);
    };
    const res = await runner.run("responses", { method: "POST", body: sent, stream: true, onEvent });
    const reply = collector.snapshot();
    setUsage(reply.usage);
    if (!res.ok) return;
    const page = extractHtml(reply.text);
    if (!page) {
      setParseError(reply.finishReason === "max_output_tokens" ? "The page was cut off at the output limit before it finished." : "The reply had no HTML page in it.");
      return;
    }
    setHtml(page.split("IMAGE_SRC").join(dataUrl));
  };

  const overlay = points && sentUrl ? overlayHtml(points, sentUrl, "Fridge overlay") : null;

  return (
    <div className="pg">
      <div className="pg-bar">
        <Segmented<Mode>
          label="Output"
          options={[
            { value: "points", label: "Points as JSON" },
            { value: "html", label: "One call, HTML out" },
          ]}
          value={mode}
          onChange={(m) => {
            setMode(m);
            runner.reset();
          }}
          disabled={running}
        />
        <ModelSelect kind="vision" value={model} onChange={setModel} disabled={running} />
        <EffortSelect id={`${id}-effort`} model={model} value={effort} onChange={setEffort} disabled={running} />
      </div>
      <p className="pg-hint">
        {mode === "points"
          ? "Strict JSON on the 0 to 1000 grid; this page draws the dots and builds the overlay file. Fast and cheap."
          : "The recipe's way: the model writes the whole interactive page in one call (several thousand output tokens, still well under a cent on Contributor)."}
      </p>

      <div className={styles.grid2}>
        <FilePicker accept="image/*" value={image} onChange={setImage} samples={["fridge", "living-room", "street"]} defaultSampleId={sampleId} preview="compact" disabled={running} />
        <div className={styles.stack}>
          {presets.length ? (
            <PresetPills
              presets={presets}
              active={preset}
              onPick={(i) => {
                setPreset(i);
                setDiet(presets[i].prompt);
              }}
              disabled={running}
            />
          ) : null}
          <label className="pg-label" htmlFor={`${id}-diet`}>
            Dietary prompt
          </label>
          <TextArea id={`${id}-diet`} rows={5} value={diet} onChange={(e) => setDiet(e.target.value)} disabled={running} />
        </div>
      </div>

      <div className="pg-actions">
        <RunButton running={running} onRun={() => void run()} onStop={runner.abort} label={mode === "points" ? "Pin the dots" : "Generate the overlay"} disabled={!image || !diet.trim()} />
        {running && mode === "html" ? <span className="pg-hint">Writing the page: {streamed.toLocaleString()} characters so far</span> : null}
        {usage ? <UsageLine model={runner.result?.model ?? model} usage={usage} /> : null}
      </div>

      <ErrorBox error={runner.error} />
      {parseError ? <p className="pg-hint pg-bad">{parseError}</p> : null}

      {points && imageUrl ? (
        <div className={styles.stack}>
          <DotsStage src={sentUrl ?? imageUrl} points={points} active={active} setActive={setActive} alt={image?.description ?? "The photo"} />
          <p className="pg-hint" role="status">
            {points.length} item{points.length === 1 ? "" : "s"}: {points.filter((p) => p.recommended).length} green, {points.filter((p) => !p.recommended).length} red
            {removed ? `. Removed ${removed} duplicate dot${removed === 1 ? "" : "s"}` : ""}. Hover or focus a dot for its details.
          </p>
          <div className={styles.row}>
            {overlay ? (
              <button type="button" className="btn btn-sm" onClick={() => download("food_in_fridge_grounded.html", overlay)}>
                Download the HTML overlay
              </button>
            ) : null}
          </div>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Dot</th>
                  <th className={styles.num}>Score</th>
                  <th className={styles.num}>kcal</th>
                  <th className={styles.num}>Carbs</th>
                  <th className={styles.num}>Protein</th>
                  <th className={styles.num}>Fat</th>
                  <th className={styles.num}>x, y</th>
                </tr>
              </thead>
              <tbody>
                {points.map((p, i) => (
                  <tr key={i} onMouseEnter={() => setActive(i)} onMouseLeave={() => setActive(null)}>
                    <td>{p.name}</td>
                    <td>
                      <span className={styles.chip} data-tone={p.recommended ? "good" : "bad"}>
                        {p.recommended ? "green" : "red"}
                      </span>
                    </td>
                    <td className={styles.num}>{p.health_score}/10</td>
                    <td className={styles.num}>{p.calories}</td>
                    <td className={styles.num}>{p.carbs_g} g</td>
                    <td className={styles.num}>{p.protein_g} g</td>
                    <td className={styles.num}>{p.fat_g} g</td>
                    <td className={styles.num}>
                      {p.x}, {p.y}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {html ? (
        <div className={styles.stack}>
          <SandboxFrame html={html} title="food_in_fridge_grounded.html" height={640} />
          <div className={styles.row}>
            <button type="button" className="btn btn-sm" onClick={() => download("food_in_fridge_grounded.html", html)}>
              Download the model&apos;s HTML
            </button>
            <span className="pg-hint">The page runs sandboxed: scripts only, no access to this site.</span>
          </div>
        </div>
      ) : null}

      <div className="pg-actions">
        <Toggle id={`${id}-code`} label="Show code" checked={showCode} onChange={setShowCode} />
      </div>
      {showCode ? <CodeView method="POST" path="responses" body={body} /> : null}
    </div>
  );
}

function DotsStage({
  src,
  points,
  active,
  setActive,
  alt,
}: {
  src: string;
  points: FoodPoint[];
  active: number | null;
  setActive(i: number | null): void;
  alt: string;
}) {
  const box = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const tipW = Math.min(240, Math.max(160, size.w - 16));
  const tipH = 120;
  const p = active !== null ? points[active] : null;
  const tip = p && size.w ? tooltipBox((p.x / 1000) * size.w, (p.y / 1000) * size.h, tipW, tipH, size.w, size.h) : null;
  return (
    <div className={styles.stage} ref={box} style={{ lineHeight: 1, width: "fit-content", maxWidth: "100%", margin: "0 auto" }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt={alt} style={{ width: "auto", maxWidth: "100%", maxHeight: 620 }} />
      <div className={styles.overlay}>
        {points.map((pt, i) => (
          <span key={i}>
            <span className={styles.dotScore} style={{ left: `${pt.x / 10}%`, top: `${pt.y / 10}%` }} aria-hidden>
              {pt.health_score}/10
            </span>
            <button
              type="button"
              className={styles.dot}
              data-tone={pt.recommended ? "good" : "bad"}
              style={{ left: `${pt.x / 10}%`, top: `${pt.y / 10}%`, zIndex: active === i ? 3 : 1 }}
              aria-label={`${pt.name}: ${pt.recommended ? "recommended" : "not recommended"}, health score ${pt.health_score} of 10`}
              aria-describedby={active === i ? "grounding-tip" : undefined}
              onMouseEnter={() => setActive(i)}
              onMouseLeave={() => setActive(null)}
              onFocus={() => setActive(i)}
              onBlur={() => setActive(null)}
            />
          </span>
        ))}
        {p && tip ? (
          <div className={styles.tip} id="grounding-tip" role="tooltip" style={{ left: tip.left, top: tip.top, width: tipW }}>
            <strong>{p.name}</strong>
            {p.justification}
            <br />
            <span style={{ opacity: 0.8 }}>
              {p.calories} kcal · {p.carbs_g} g carbs · {p.protein_g} g protein · {p.fat_g} g fat
            </span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
