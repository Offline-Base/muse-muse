"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  ObjectPromptError,
  buildObjectPrompt,
  decodeMaskToRLE,
  decodeMaskToRaster,
  decodeMaskToSVGPath,
  frameIndexOf,
  parseImageStream,
  parseVideoStream,
  recordsOfKind,
  type BuildObjectPromptOptions,
  type SegmentationMaskRecord,
  type SegmentationResult,
} from "@meta-sam/parser";
import { ErrorBox, JsonEditor, ModelSelect, ResponseView, RunButton } from "@/components/docs/kit";
import { Field, Segmented, TextInput, Toggle } from "@/components/docs/kit/Field";
import { TabPanel, Tabs } from "@/components/docs/kit/Tabs";
import { FilePicker } from "@/components/docs/media/FilePicker";
import { useObjectUrl } from "@/components/docs/media/hooks";
import media from "@/components/docs/media/media.module.css";
import { GroupedPresets } from "@/components/docs/playgrounds/voice-sam/GroupedPresets";
import { SnippetTabs } from "@/components/docs/playgrounds/voice-sam/SnippetTabs";
import { WireLine } from "@/components/docs/playgrounds/voice-sam/WireLine";
import { createEventChannel } from "@/components/docs/playgrounds/voice-sam/event-channel";
import { PARSER_ERRORS, SCENARIOS, runScenario, type ScenarioId, type ScenarioResult } from "@/components/docs/playgrounds/voice-sam/parser-scenarios";
import { pickSample } from "@/components/docs/playgrounds/voice-sam/pick-sample";
import { samCostUsd } from "@/components/docs/playgrounds/voice-sam/sam-wire";
import { samResultView, useSamRun } from "@/components/docs/playgrounds/voice-sam/useSamRun";
import type { Snippet } from "@/components/docs/playgrounds/voice-sam/voice-request";
import styles from "@/components/docs/playgrounds/voice-sam/voice-sam.module.css";
import { formatUsd } from "@/lib/docs/client/cost";
import { parseJsonText } from "@/lib/docs/client/json";
import { fileToDataUrl } from "@/lib/docs/media/base64";
import type { PickedMedia } from "@/lib/docs/media/prepare";
import { samRequest } from "@/lib/docs/media/requests";

/**
 * sam/client-libraries run in the page with Meta's own @meta-sam/parser (the package this site already uses for
 * masks): a live SAM 3.1 stream fed to parseImageStream or parseVideoStream as it arrives, with every snapshot's
 * revision, the final result's outcome and diagnostics, and the records recordsOfKind selects; each mask converted
 * three ways (decodeMaskToRaster, decodeMaskToRLE, decodeMaskToSVGPath); an overlay drawn from the parsed records
 * with the renderer's documented fill and outline opacity and hidden ids; buildObjectPrompt with the page's examples
 * and its error codes; and the stream lifecycle (completed, incomplete, and the errors a stream raises) on recorded streams.
 */

export interface ParserLabProps {
  slug?: string;
  sampleId?: string;
  videoSampleId?: string;
  prompt?: string;
  /** The tab it opens on. */
  tab?: ParserTab;
}

type ParserTab = "parse" | "decode" | "render" | "build" | "lifecycle";

interface ParseRun {
  kind: "image" | "video";
  file: PickedMedia;
  prompt: string;
  snapshots: Array<{ revision: number; records: number; diagnostics: number }>;
  result: SegmentationResult | null;
  error: { name: string; code: string; message: string } | null;
  done: boolean;
}

const PALETTE = ["#7489f7", "#f2b97c", "#5bbfa3", "#ec8a9e", "#9aa8b6", "#b99af0", "#e5c84a", "#4fb3d9"];

const BUILD_PRESETS: Array<{ label: string; options: unknown; note: string }> = [
  {
    label: "The page's image example",
    note: "Two objects on an 1800 x 1200 image: a box, and a point with a negative point. right and bottom are half-open, so x2 = right - 1.",
    options: {
      size: { width: 1800, height: 1200 },
      objects: [
        { id: 1, prompts: [{ box: { left: 444, top: 626, right: 676, bottom: 850 } }] },
        { id: 2, prompts: [{ points: [{ x: 1430, y: 700 }, { x: 1300, y: 450, label: "negative" }] }] },
      ],
    },
  },
  {
    label: "The page's video example",
    note: "One object prompted on frames 30 and 120. Frames come out in ascending order.",
    options: {
      size: { width: 640, height: 480 },
      objects: [
        {
          id: 1,
          prompts: [
            { frame: 30, box: { left: 10, top: 20, right: 40, bottom: 60 } },
            { frame: 120, points: [{ x: 20, y: 40 }, { x: 30, y: 50, label: "negative" }] },
          ],
        },
      ],
    },
  },
  {
    label: "Two dogs on the street photo",
    note: "Sized for the street sample (1280 x 853), so Send runs it on SAM: object 1 by its box, object 2 by a point.",
    options: {
      size: { width: 1280, height: 853 },
      objects: [
        { id: 1, prompts: [{ box: { left: 186, top: 587, right: 393, bottom: 835 } }] },
        { id: 2, prompts: [{ points: [{ x: 496, y: 690 }, { x: 700, y: 300, label: "negative" }] }] },
      ],
    },
  },
  {
    label: "duplicate_object_id",
    note: "The same id twice: the builder throws ObjectPromptError before anything is sent.",
    options: { size: { width: 640, height: 480 }, objects: [{ id: 1, prompts: [{ points: [{ x: 5, y: 5 }] }] }, { id: 1, prompts: [{ points: [{ x: 9, y: 9 }] }] }] },
  },
  {
    label: "invalid_point",
    note: "A point outside the size.",
    options: { size: { width: 640, height: 480 }, objects: [{ id: 1, prompts: [{ points: [{ x: 700, y: 10 }] }] }] },
  },
  {
    label: "invalid_point_label",
    note: 'A label other than "positive" or "negative".',
    options: { size: { width: 640, height: 480 }, objects: [{ id: 1, prompts: [{ points: [{ x: 10, y: 10, label: "maybe" }] }] }] },
  },
  {
    label: "empty_object",
    note: "An object with no prompts.",
    options: { size: { width: 640, height: 480 }, objects: [{ id: 3, prompts: [] }] },
  },
];

function errorOf(err: unknown): { name: string; code: string; message: string } {
  const code = (err as { code?: unknown } | null)?.code;
  const c = typeof code === "string" ? code : "";
  return { name: PARSER_ERRORS[c] ?? (err instanceof Error ? err.name : "Error"), code: c, message: err instanceof Error ? err.message : String(err) };
}

function tryBuild(text: string): { text?: string; error?: { code: string; message: string }; size?: { width: number; height: number } } {
  const parsed = parseJsonText(text);
  if (!parsed.ok) return { error: { code: "invalid_json", message: parsed.message } };
  try {
    const options = parsed.value as BuildObjectPromptOptions;
    return { text: buildObjectPrompt(options), size: options.size };
  } catch (err) {
    if (err instanceof ObjectPromptError) return { error: { code: err.code, message: err.message } };
    return { error: { code: "", message: err instanceof Error ? err.message : String(err) } };
  }
}

export function ParserLab({ sampleId = "street", videoSampleId = "street-pan", prompt: initialPrompt = "dog", tab: initialTab = "parse" }: ParserLabProps) {
  const idBase = useId();
  const id = useId();
  const sam = useSamRun();
  const running = sam.state === "running";
  const [tab, setTab] = useState<ParserTab>(initialTab);
  const [kind, setKind] = useState<"image" | "video">("image");
  const [image, setImage] = useState<PickedMedia | null>(null);
  const [video, setVideo] = useState<PickedMedia | null>(null);
  const [concept, setConcept] = useState(initialPrompt);
  const [encoding, setEncoding] = useState<"one_bit" | "lossless">("one_bit");
  const [confidence, setConfidence] = useState(true);
  const [run, setRun] = useState<ParseRun | null>(null);
  const [buildText, setBuildText] = useState(JSON.stringify(BUILD_PRESETS[2].options, null, 2));
  const [buildPreset, setBuildPreset] = useState<number | null>(2);
  const [lastBody, setLastBody] = useState<Record<string, unknown> | null>(null);
  const [showCode, setShowCode] = useState(false);
  const file = kind === "image" ? image : video;
  const built = useMemo(() => tryBuild(buildText), [buildText]);

  const parseRun = useCallback(
    async (mediaKind: "image" | "video", f: PickedMedia, promptText: string) => {
      const dataUrl = await fileToDataUrl(f.blob, f.mime);
      const { body } = samRequest({ prompt: promptText, media: { dataUrl }, kind: mediaKind, stream: true, maskEncoding: encoding, includeConfidence: confidence });
      const channel = createEventChannel<{ type: string }>();
      const parsed = mediaKind === "image" ? parseImageStream(channel.iterable) : parseVideoStream(channel.iterable);
      const snaps: ParseRun["snapshots"] = [];
      let frame: number | null = null;
      const base: ParseRun = { kind: mediaKind, file: f, prompt: promptText, snapshots: [], result: null, error: null, done: false };
      setRun(base);
      setLastBody({ ...body, input: [{ type: "message", role: "user", content: [{ type: "input_text", text: promptText }, { type: mediaKind === "image" ? "input_image" : "input_video" }] }] });
      // Consume snapshots while the stream arrives; the parser owns the one reader of the channel.
      const consumer = (async () => {
        try {
          for await (const s of parsed) {
            snaps.push({ revision: s.revision, records: s.records.length, diagnostics: s.diagnostics.length });
            frame ??= requestAnimationFrame(() => {
              frame = null;
              setRun((r) => (r && r.file === f ? { ...r, snapshots: [...snaps] } : r));
            });
          }
          return { result: await parsed.finalResult, error: null };
        } catch (err) {
          parsed.finalResult.catch(() => {});
          return { result: null, error: errorOf(err) };
        }
      })();
      const { result } = await sam.run({
        body,
        stream: true,
        onEvent: (event) => {
          if (typeof event.type === "string") channel.push(event as { type: string });
        },
      });
      if (result.ok) channel.end();
      else channel.fail(new Error(result.error?.message ?? "The request failed."));
      const outcome = await consumer;
      if (frame !== null) cancelAnimationFrame(frame);
      setRun({ ...base, snapshots: [...snaps], result: outcome.result, error: result.ok ? outcome.error : null, done: true });
    },
    [encoding, confidence, sam],
  );

  const sendBuilt = async () => {
    if (!built.text || built.size?.width !== 1280 || built.size?.height !== 853) return;
    const street = image?.sampleId === "street" ? image : await pickSample("street");
    if (!street) return;
    setKind("image");
    setImage(street);
    setTab("parse");
    await parseRun("image", street, built.text);
  };

  const fromLast = () => {
    if (!run?.result || !run.file.width || !run.file.height) return;
    const boxes = recordsOfKind(run.result.records, "box").filter((b) => (frameIndexOf(b) ?? 0) === (frameIndexOf(recordsOfKind(run.result!.records, "box")[0]) ?? 0));
    const options = {
      size: { width: run.file.width, height: run.file.height },
      objects: boxes.slice(0, 16).map((b) => ({
        id: b.objectId,
        prompts: [{ ...(run.kind === "video" ? { frame: frameIndexOf(b) ?? 0 } : {}), box: { left: b.left, top: b.top, right: b.right, bottom: b.bottom } }],
      })),
    };
    setBuildText(JSON.stringify(options, null, 2));
    setBuildPreset(null);
  };

  const result = run?.result ?? null;
  const masks = result ? recordsOfKind(result.records, "mask") : [];
  const boxes = result ? recordsOfKind(result.records, "box") : [];

  return (
    <div className={styles.lab}>
      <Tabs<ParserTab>
        label="Client libraries"
        idBase={idBase}
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "parse", label: "Parse a stream" },
          { id: "decode", label: "Decode masks", count: masks.length || undefined },
          { id: "render", label: "Render overlays" },
          { id: "build", label: "Build prompts" },
          { id: "lifecycle", label: "Stream lifecycle" },
        ]}
      />

      <TabPanel idBase={idBase} id="parse" active={tab === "parse"}>
        <div className={styles.stack}>
          <div className="pg-bar pg-advanced">
            <Segmented<"image" | "video">
              label="Media"
              value={kind}
              onChange={setKind}
              disabled={running}
              options={[
                { value: "image", label: "parseImageStream" },
                { value: "video", label: "parseVideoStream" },
              ]}
            />
            <ModelSelect kind="sam" value="sam-3.1" onChange={() => {}} />
          </div>
          {kind === "image" ? (
            <FilePicker label="Image" accept="image/png,image/jpeg,image/webp" value={image} onChange={setImage} samples={["image"]} defaultSampleId={sampleId} preview="compact" disabled={running} />
          ) : (
            <FilePicker label="Video" accept="video/mp4,video/quicktime" value={video} onChange={setVideo} samples={["video"]} defaultSampleId={videoSampleId} forSam preview="compact" disabled={running} />
          )}
          <div className={media.options}>
            <Field id={`${id}-c`} label="Concept">
              <TextInput id={`${id}-c`} value={concept} onChange={(e) => setConcept(e.target.value)} disabled={running} style={{ width: 220 }} />
            </Field>
            <span className={media.inline}>
              <span className={styles.label}>mask_encoding</span>
              <Segmented<"one_bit" | "lossless">
                size="sm"
                label="Mask encoding"
                value={encoding}
                onChange={setEncoding}
                disabled={running}
                options={[
                  { value: "one_bit", label: "one_bit" },
                  { value: "lossless", label: "lossless" },
                ]}
              />
            </span>
            <span className="pg-advanced">
              <Toggle id={`${id}-conf`} label='include_confidence: "true"' checked={confidence} onChange={setConfidence} disabled={running} />
            </span>
          </div>
          <div className={media.spread}>
            <RunButton running={running} onRun={() => file && void parseRun(kind, file, concept.trim())} onStop={sam.abort} label="Stream and parse" disabled={!file || !concept.trim() || (file?.problems.length ?? 0) > 0} />
          </div>
          <p className={`${styles.note} pg-advanced`}>{kind === "image" ? "$0.0025 an image." : `About ${formatUsd(samCostUsd("video", file?.frames ?? 50))} for the clip's ${file?.frames ?? 50} frames.`} The events go to the parser as they arrive.</p>
          <ErrorBox error={sam.error} />
          {running || (sam.result && run) ? (
            <ResponseView result={samResultView(sam.result, sam.out)} running={running} elapsedMs={sam.elapsedMs} model="sam-3.1" usage={sam.out?.usage ?? undefined} json={result ? { outcome: result.outcome, revision: result.revision, records: result.records.length, diagnostics: result.diagnostics } : undefined}>
              <div className={styles.stack} aria-live="polite">
                <span className={styles.label}>Snapshots ({run?.snapshots.length ?? 0}): revision and records so far</span>
                {run?.snapshots.length ? (
                  <ol className={styles.snapshots}>
                    {run.snapshots.slice(-160).map((s) => (
                      <li key={s.revision} className={styles.snapshot}>
                        r{s.revision}: {s.records}
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className={styles.note}>
                    {running
                      ? "Waiting for the first line..."
                      : run?.error
                        ? "No snapshots: the stream failed before any output text."
                        : "No snapshots: nothing changed the view (zero matches emit none)."}
                  </p>
                )}
                {run?.error ? (
                  <p className={media.problem}>
                    {run.error.name} ({run.error.code}): {run.error.message}
                  </p>
                ) : null}
                {result ? (
                  <>
                    <ul className={styles.counts}>
                      <li className={styles.count}>
                        outcome <b>{result.outcome.status}</b>
                        {result.outcome.status === "incomplete" ? ` (${result.outcome.reason})` : ""}
                      </li>
                      <li className={styles.count}>
                        records <b>{result.records.length}</b> ({boxes.length} box, {masks.length} mask)
                      </li>
                      <li className={styles.count}>
                        diagnostics <b>{result.diagnostics.length}</b>
                      </li>
                      <li className={styles.count}>
                        rawOutput <b>{result.rawOutput.length.toLocaleString("en-US")}</b> characters
                      </li>
                    </ul>
                    {boxes.length ? (
                      <div className={media.tableWrap}>
                        <table className={media.table}>
                          <thead>
                            <tr>
                              <th scope="col">objectId</th>
                              {result.media === "video" ? <th scope="col">frameIndexOf</th> : null}
                              <th scope="col">left, top</th>
                              <th scope="col">right, bottom (half-open)</th>
                              <th scope="col">confidence</th>
                            </tr>
                          </thead>
                          <tbody>
                            {boxes.slice(0, 40).map((b) => (
                              <tr key={b.order}>
                                <td className={styles.mono}>&quot;{b.objectId}&quot;</td>
                                {result.media === "video" ? <td className={styles.mono}>{frameIndexOf(b)}</td> : null}
                                <td className={styles.mono}>
                                  {b.left}, {b.top}
                                </td>
                                <td className={styles.mono}>
                                  {b.right}, {b.bottom}
                                </td>
                                <td className={styles.mono}>{b.confidence ?? "absent (not zero)"}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : null}
                    {boxes.length > 40 ? <p className={styles.note}>The first 40 of {boxes.length} box records.</p> : null}
                    {result.diagnostics.map((d, i) => (
                      <p key={i} className={styles.note}>
                        {d.severity} {d.code} on line {d.line}: {d.message}
                      </p>
                    ))}
                  </>
                ) : null}
              </div>
            </ResponseView>
          ) : null}
        </div>
      </TabPanel>

      <TabPanel idBase={idBase} id="decode" active={tab === "decode"}>
        {masks.length && run ? <DecodeView masks={masks} /> : <p className={styles.note}>Run Parse a stream first: its mask records show up here.</p>}
      </TabPanel>

      <TabPanel idBase={idBase} id="render" active={tab === "render"}>
        {masks.length && run ? <RenderView run={run} masks={masks} /> : <p className={styles.note}>Run Parse a stream first: the overlay is drawn from its records.</p>}
      </TabPanel>

      <TabPanel idBase={idBase} id="build" active={tab === "build"}>
        <div className={styles.stack}>
          <GroupedPresets
            presets={BUILD_PRESETS}
            active={buildPreset}
            onPick={(i) => {
              setBuildPreset(i);
              setBuildText(JSON.stringify(BUILD_PRESETS[i].options, null, 2));
            }}
          />
          {buildPreset !== null ? <p className={`${styles.note} pg-advanced`}>{BUILD_PRESETS[buildPreset].note}</p> : null}
          <JsonEditor
            id={`${id}-build`}
            label="buildObjectPrompt(options)"
            value={buildText}
            onChange={(t) => {
              setBuildPreset(null);
              setBuildText(t);
            }}
            rows={12}
          />
          {built.text ? (
            <div className={styles.stack} aria-live="polite">
              <span className={styles.label}>Returns the input_text</span>
              <WireLine line={built.text} full />
            </div>
          ) : built.error ? (
            <p className={media.problem} aria-live="polite">
              {built.error.code === "invalid_json" ? built.error.message : `ObjectPromptError, code ${built.error.code}: ${built.error.message}`}
            </p>
          ) : null}
          <div className={styles.row}>
            <RunButton running={running} onRun={() => void sendBuilt()} onStop={sam.abort} label="Send it to SAM" disabled={!built.text || built.size?.width !== 1280 || built.size?.height !== 853} />
            <button type="button" className="btn btn-outline btn-sm pg-advanced" onClick={fromLast} disabled={!run?.result || !boxes.length}>
              Prompt the last result&apos;s boxes again
            </button>
          </div>
          <p className={`${styles.note} pg-advanced`}>
            Send runs prompts sized 1280 x 853 on the street photo ($0.0025). A parsed box can go back in as is, with its objectId as the id: right
            and bottom are half-open on both sides, and the builder writes x2 = right - 1. The API checks the rest, such as the 16-object limit.
          </p>
        </div>
      </TabPanel>

      <TabPanel idBase={idBase} id="lifecycle" active={tab === "lifecycle"}>
        <Lifecycle />
      </TabPanel>

      <div className="pg-actions">
        <Toggle id={`${id}-code`} label="Show code" checked={showCode} onChange={setShowCode} />
      </div>
      {showCode ? (
        <div className="pg-advanced">
          <SnippetTabs snippets={parserSnippets(lastBody, built.text ?? null)} caption="The client code for this flow" />
        </div>
      ) : null}
    </div>
  );
}

function DecodeView({ masks }: { masks: readonly SegmentationMaskRecord[] }) {
  const [at, setAt] = useState(0);
  const record = masks[Math.min(at, masks.length - 1)];
  const out = useMemo(() => {
    try {
      const raster = decodeMaskToRaster(record.mask);
      let set = 0;
      for (const v of raster) set += v;
      return { raster, set, rle: decodeMaskToRLE(record.mask), svg: decodeMaskToSVGPath(record.mask), error: null };
    } catch (err) {
      return { raster: null, set: 0, rle: null, svg: "", error: errorOf(err) };
    }
  }, [record]);
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c || !out.raster) return;
    c.width = record.mask.width;
    c.height = record.mask.height;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const data = new Uint8ClampedArray(record.mask.width * record.mask.height * 4);
    for (let i = 0; i < out.raster.length; i++) {
      if (!out.raster[i]) continue;
      data[i * 4] = 41;
      data[i * 4 + 1] = 98;
      data[i * 4 + 2] = 216;
      data[i * 4 + 3] = 255;
    }
    ctx.putImageData(new ImageData(data, record.mask.width, record.mask.height), 0, 0);
  }, [out, record]);
  const scale = Math.max(1, Math.min(4, Math.floor(240 / Math.max(record.mask.width, record.mask.height))));
  return (
    <div className={styles.stack}>
      <div className={styles.row}>
        <label className={styles.label} htmlFor="parser-mask-pick">
          Mask record
        </label>
        <span className="select-wrap">
          <select id="parser-mask-pick" className="select pg-select" value={at} onChange={(e) => setAt(Number(e.target.value))}>
            {masks.slice(0, 300).map((m, i) => (
              <option key={m.order} value={i}>
                {m.identity} (object {m.objectId}, revision {m.revision})
              </option>
            ))}
          </select>
        </span>
      </div>
      <p className={`${styles.note} pg-advanced`}>
        mask: encoding {record.mask.encoding}, {record.mask.height} rows x {record.mask.width} columns, {record.mask.payload.length} payload characters; bounds{" "}
        {record.bounds.left}, {record.bounds.top} to {record.bounds.right}, {record.bounds.bottom} (half-open).
      </p>
      {out.error ? (
        <p className={media.problem}>
          {out.error.name} ({out.error.code}): {out.error.message}
        </p>
      ) : (
        <div className={styles.grid}>
          <div className={styles.card}>
            <p className={styles.cardTitle}>decodeMaskToRaster</p>
            <canvas ref={ref} className={styles.raster} style={{ width: record.mask.width * scale, height: record.mask.height * scale }} role="img" aria-label="The mask raster" />
            <p className={`${styles.note} pg-advanced`}>
              Uint8Array, length {out.raster?.length.toLocaleString("en-US")} (width x height), row-major, {out.set.toLocaleString("en-US")} ones.
            </p>
          </div>
          <div className={styles.card}>
            <p className={styles.cardTitle}>decodeMaskToSVGPath</p>
            <svg viewBox={`-1 -1 ${record.mask.width + 2} ${record.mask.height + 2}`} style={{ width: record.mask.width * scale, maxWidth: "100%", height: "auto" }} role="img" aria-label="The mask traced as an SVG path">
              <path d={out.svg} fill="var(--accent-soft)" stroke="var(--accent)" strokeWidth={Math.max(0.5, record.mask.width / 200)} fillRule="evenodd" />
            </svg>
            <p className={`${styles.note} pg-advanced`}>
              A polygonal M/L/Z path, {out.svg.length.toLocaleString("en-US")} characters: <code>{out.svg.slice(0, 60)}...</code>
            </p>
          </div>
          <div className={styles.card}>
            <p className={styles.cardTitle}>decodeMaskToRLE</p>
            <pre className={styles.pre}>{`{\n  "size": ${JSON.stringify(out.rle?.size)},\n  "counts": ${JSON.stringify(`${out.rle?.counts.slice(0, 40)}...`)}\n}\n${out.rle?.counts.length.toLocaleString("en-US")} characters of counts`}</pre>
            <p className={`${styles.note} pg-advanced`}>COCO compressed RLE, size [height, width], column-major: ready for IoU and evaluation tools.</p>
          </div>
        </div>
      )}
      <p className={`${styles.note} pg-advanced`}>In Python the same three are decode_mask_to_raster, decode_mask_to_rle and decode_mask_to_svg_path from meta_sam_parser.</p>
    </div>
  );
}

function RenderView({ run, masks }: { run: ParseRun; masks: readonly SegmentationMaskRecord[] }) {
  const url = useObjectUrl(run.file.blob);
  const canvas = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [fill, setFill] = useState(0.35);
  const [outline, setOutline] = useState(0.8);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [frame, setFrame] = useState(0);
  const [ready, setReady] = useState(0);
  const ids = useMemo(() => [...new Set(masks.map((m) => m.objectId))], [masks]);
  const frames = useMemo(() => [...new Set(masks.map((m) => frameIndexOf(m) ?? 0))].sort((a, b) => a - b), [masks]);
  const width = run.file.width ?? 0;
  const height = run.file.height ?? 0;
  const fps = run.file.fps ?? 24;

  useEffect(() => {
    if (run.kind !== "video" || !frames.length) return;
    setFrame((f) => (frames.includes(f) ? f : frames[0]));
  }, [frames, run.kind]);

  useEffect(() => {
    const v = videoRef.current;
    if (run.kind !== "video" || !v) return;
    const target = (frame + 0.5) / fps;
    if (Math.abs(v.currentTime - target) > 0.5 / fps) v.currentTime = target;
    else setReady((n) => n + 1);
  }, [frame, fps, run.kind, url]);

  useEffect(() => {
    const c = canvas.current;
    if (!c || !url || !width || !height) return;
    let cancelled = false;
    const draw = (source: CanvasImageSource) => {
      if (cancelled) return;
      c.width = width;
      c.height = height;
      const ctx = c.getContext("2d");
      if (!ctx) return;
      ctx.drawImage(source, 0, 0, width, height);
      const here = run.kind === "image" ? masks : masks.filter((m) => (frameIndexOf(m) ?? 0) === frame);
      for (const m of here) {
        if (hidden.has(m.objectId)) continue;
        const color = PALETTE[ids.indexOf(m.objectId) % PALETTE.length];
        const bw = m.bounds.right - m.bounds.left;
        const bh = m.bounds.bottom - m.bounds.top;
        let raster: Uint8Array;
        let svg: string;
        try {
          raster = decodeMaskToRaster(m.mask);
          svg = decodeMaskToSVGPath(m.mask);
        } catch {
          continue;
        }
        const piece = document.createElement("canvas");
        piece.width = m.mask.width;
        piece.height = m.mask.height;
        const pctx = piece.getContext("2d");
        if (!pctx) continue;
        const r = parseInt(color.slice(1, 3), 16);
        const g = parseInt(color.slice(3, 5), 16);
        const b = parseInt(color.slice(5, 7), 16);
        const data = new Uint8ClampedArray(m.mask.width * m.mask.height * 4);
        for (let i = 0; i < raster.length; i++) {
          if (!raster[i]) continue;
          data[i * 4] = r;
          data[i * 4 + 1] = g;
          data[i * 4 + 2] = b;
          data[i * 4 + 3] = Math.round(fill * 255);
        }
        pctx.putImageData(new ImageData(data, m.mask.width, m.mask.height), 0, 0);
        ctx.drawImage(piece, m.bounds.left, m.bounds.top, bw, bh);
        if (svg && typeof Path2D !== "undefined") {
          ctx.save();
          ctx.translate(m.bounds.left, m.bounds.top);
          ctx.scale(bw / m.mask.width, bh / m.mask.height);
          ctx.globalAlpha = outline;
          ctx.strokeStyle = color;
          ctx.lineWidth = Math.max(1.5, width / 500) / Math.max(bw / m.mask.width, 0.01);
          ctx.stroke(new Path2D(svg));
          ctx.restore();
        }
      }
    };
    if (run.kind === "image") {
      const img = new Image();
      img.onload = () => draw(img);
      img.src = url;
    } else if (videoRef.current && videoRef.current.readyState >= 2) {
      draw(videoRef.current);
    }
    return () => {
      cancelled = true;
    };
  }, [url, width, height, masks, hidden, fill, outline, frame, ready, ids, run.kind]);

  return (
    <div className={styles.stack}>
      <div className={`${media.options} pg-advanced`}>
        <label className={styles.slider}>
          maskFillOpacity {fill.toFixed(2)}
          <input type="range" min={0} max={1} step={0.05} value={fill} onChange={(e) => setFill(Number(e.target.value))} />
        </label>
        <label className={styles.slider}>
          maskOutline.opacity {outline.toFixed(2)}
          <input type="range" min={0} max={1} step={0.05} value={outline} onChange={(e) => setOutline(Number(e.target.value))} />
        </label>
      </div>
      <ul className={media.legend} aria-label="hiddenIds">
        {ids.map((oid) => (
          <li key={oid}>
            <button
              type="button"
              className={media.legendItem}
              aria-pressed={!hidden.has(oid)}
              onClick={() =>
                setHidden((h) => {
                  const next = new Set(h);
                  if (next.has(oid)) next.delete(oid);
                  else next.add(oid);
                  return next;
                })
              }
            >
              <span className={media.swatch} style={{ background: PALETTE[ids.indexOf(oid) % PALETTE.length] }} aria-hidden="true" />
              objectId &quot;{oid}&quot;
            </button>
          </li>
        ))}
      </ul>
      <div className={styles.canvasWrap}>
        <canvas ref={canvas} role="img" aria-label={`The ${run.kind} with ${ids.length - hidden.size} objects drawn over it`} />
      </div>
      {run.kind === "video" && url ? (
        <>
          <video
            ref={videoRef}
            src={url}
            muted
            playsInline
            preload="auto"
            style={{ display: "none" }}
            onLoadedData={() => setReady((n) => n + 1)}
            onSeeked={() => setReady((n) => n + 1)}
          />
          <div className={media.frameBar}>
            <input type="range" min={frames[0] ?? 0} max={frames.at(-1) ?? 0} value={frame} onChange={(e) => setFrame(Number(e.target.value))} aria-label="frameIndex" />
            <span>
              frameIndex {frame} ({fps} fps)
            </span>
          </div>
        </>
      ) : null}
      <p className={`${styles.note} pg-advanced`}>
        Drawn from the parser&apos;s records, the way @meta-sam/graphics&apos; SegmentationRenderer composes them: the decoded raster filled on its
        bounds at maskFillOpacity (default 0.35) and its outline at maskOutline.opacity (default 0.8); hidden ids stay hidden on every frame. The
        graphics, video and react packages aren&apos;t loaded on this page, so this mimics their documented options rather than running them.
      </p>
    </div>
  );
}

function Lifecycle() {
  const [busy, setBusy] = useState<ScenarioId | null>(null);
  const [result, setResult] = useState<ScenarioResult | null>(null);
  const pick = async (sid: ScenarioId) => {
    setBusy(sid);
    try {
      setResult(await runScenario(sid));
    } finally {
      setBusy(null);
    }
  };
  const scenario = SCENARIOS.find((s) => s.id === result?.id);
  return (
    <div className={styles.stack}>
      <p className={`${styles.note} pg-advanced`}>
        Each one feeds Meta&apos;s parser a short recorded stream built from the page&apos;s own video line, on this page, with no API call. Errors are
        thrown while iterating or reject finalResult; every one has a stable code.
      </p>
      <div className={styles.scenarios} role="group" aria-label="Scenarios">
        {SCENARIOS.map((s, i) => (
          <button key={s.id} type="button" className={i < 5 ? "pg-pill" : "pg-pill pg-advanced"} aria-pressed={result?.id === s.id} disabled={!!busy} onClick={() => void pick(s.id)}>
            {s.label}
          </button>
        ))}
      </div>
      {result && scenario ? (
        <div className={styles.card} aria-live="polite">
          <p className={styles.cardTitle}>{scenario.label}</p>
          <p className={`${styles.note} pg-advanced`}>The page says: {scenario.expect}</p>
          {result.fed.length ? (
            <ul className={styles.counts} aria-label="Events fed">
              {result.fed.map((t, i) => (
                <li key={i} className={styles.count}>
                  {t}
                </li>
              ))}
            </ul>
          ) : null}
          {result.error ? (
            <p>
              <span className={`${styles.badge} ${styles.badgeBad}`}>threw</span> {result.error.name}, code <code>{result.error.code}</code>: {result.error.message}
            </p>
          ) : (
            <p>
              <span className={`${styles.badge} ${result.outcome?.status === "completed" ? styles.badgeOk : styles.badgeWarn}`}>{result.outcome?.status}</span>{" "}
              outcome {JSON.stringify(result.outcome)}, {result.records ?? 0} records, {result.snapshots.length} snapshot{result.snapshots.length === 1 ? "" : "s"}
            </p>
          )}
          {result.boxes?.length ? (
            <p className={styles.note}>
              Boxes: {result.boxes.map((b) => `"${b.objectId}" ${b.left},${b.top} to ${b.right},${b.bottom}${b.confidence !== undefined ? ` c=${b.confidence}` : ""}`).join("; ")}
            </p>
          ) : null}
          {result.diagnostics?.map((d, i) => (
            <p key={i} className={styles.note}>
              Diagnostic: {d.severity} {d.code} on line {d.line}: {d.message} The other line&apos;s records were kept.
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function parserSnippets(body: Record<string, unknown> | null, builtText: string | null): Snippet[] {
  const content = (body?.input as Array<{ content?: Array<Record<string, unknown>> }> | undefined)?.[0]?.content ?? [];
  const text = (content.find((c) => c.type === "input_text")?.text as string | undefined) ?? "dog";
  const video = content.some((c) => c.type === "input_video");
  const metadata = (body?.metadata as Record<string, string> | undefined) ?? { mask_encoding: "one_bit" };
  const part = video ? `{ type: "input_video", video_url: "https://example.com/clip.mp4" }` : `{ type: "input_image", image_url: "https://example.com/street.jpg" }`;
  const fn = video ? "parseVideoStream" : "parseImageStream";
  const ts = [
    'import OpenAI from "openai";',
    `import { ${fn}, recordsOfKind, decodeMaskToRaster } from "@meta-sam/parser";`,
    "",
    'const client = new OpenAI({ baseURL: "https://api.meta.ai/v1", apiKey: process.env.MODEL_API_KEY });',
    "",
    "const events = await client.responses.create({",
    '  model: "sam-3.1",',
    "  input: [",
    '    { type: "message", role: "user", content: [',
    `        { type: "input_text", text: ${JSON.stringify(text)} },`,
    `        ${part},`,
    "    ]},",
    "  ],",
    "  stream: true,",
    `  metadata: ${JSON.stringify(metadata).replace(/"([a-z_]+)":/g, "$1: ")},`,
    "});",
    "",
    `const parsed = ${fn}(events); // consume once: iterate, then read finalResult`,
    "for await (const snapshot of parsed) {",
    "  console.log(snapshot.revision, snapshot.records.length); // cumulative: render the latest",
    "}",
    "const result = await parsed.finalResult;",
    'if (result.outcome.status !== "completed") console.warn("Segmentation ended early:", result.outcome);',
    "for (const d of result.diagnostics) console.warn(d.severity, d.code, d.message);",
    "",
    'for (const box of recordsOfKind(result.records, "box")) {',
    "  console.log(box.objectId, box.left, box.top, box.right, box.bottom, box.confidence);",
    "}",
    'for (const record of recordsOfKind(result.records, "mask")) {',
    "  const raster = decodeMaskToRaster(record.mask); // 0 or 1, width * height, row-major",
    "  console.log(record.objectId, record.bounds, raster.length);",
    "}",
  ].join("\n");
  const py = [
    "import os",
    "",
    "from openai import OpenAI",
    "from meta_sam_parser import FramePrompt, PromptBox, PromptObject, PromptPoint, build_object_prompt",
    "",
    'client = OpenAI(base_url="https://api.meta.ai/v1", api_key=os.environ["MODEL_API_KEY"])',
    "",
    "# Box and point prompts, built instead of written by hand (or send a noun phrase).",
    "text = build_object_prompt(",
    "    size=(1280, 853),  # (width, height) of the image as displayed",
    "    objects=[",
    "        PromptObject(id=1, prompts=[FramePrompt(box=PromptBox(186, 587, 393, 835))]),",
    '        PromptObject(id=2, prompts=[FramePrompt(points=[PromptPoint(496, 690), PromptPoint(700, 300, label="negative")])]),',
    "    ],",
    ")",
    builtText ? `# ${builtText.length > 90 ? `${builtText.slice(0, 90)}...` : builtText}` : "",
    "",
    'output = ""',
    "with client.responses.stream(",
    '    model="sam-3.1",',
    "    input=[{",
    '        "type": "message",',
    '        "role": "user",',
    '        "content": [',
    '            {"type": "input_text", "text": text},',
    '            {"type": "input_image", "image_url": "https://example.com/street.jpg"},',
    "        ],",
    "    }],",
    '    metadata={"mask_encoding": "one_bit"},',
    ") as stream:",
    "    for event in stream:",
    '        if event.type == "response.output_text.delta":',
    "            output += event.delta",
    "",
    "# meta_sam_parser parses this into the same records as the TypeScript parser; convert each mask",
    "# with decode_mask_to_raster, decode_mask_to_rle or decode_mask_to_svg_path.",
    "print(output)",
  ]
    .filter((l, i, all) => l !== "" || all[i - 1] !== "")
    .join("\n");
  return [
    { lang: "typescript", label: "TypeScript (@meta-sam/parser)", syntax: "typescript", code: ts },
    { lang: "python", label: "Python (meta_sam_parser)", syntax: "python", code: py },
  ];
}
