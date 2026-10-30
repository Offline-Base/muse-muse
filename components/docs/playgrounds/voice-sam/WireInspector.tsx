"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ErrorBox, ModelSelect, PresetPills, ResponseView, RunButton } from "@/components/docs/kit";
import { Field, Segmented, TextInput, Toggle } from "@/components/docs/kit/Field";
import { FilePicker } from "@/components/docs/media/FilePicker";
import { MaskOverlay } from "@/components/docs/media/MaskOverlay";
import { useObjectUrl } from "@/components/docs/media/hooks";
import "@/components/docs/media/mask-decoder";
import media from "@/components/docs/media/media.module.css";
import { DOC_VIDEO_LINE } from "@/components/docs/playgrounds/voice-sam/parser-scenarios";
import { WireLegend, WireLine } from "@/components/docs/playgrounds/voice-sam/WireLine";
import { frameOrder, objectTracks, samCostUsd } from "@/components/docs/playgrounds/voice-sam/sam-wire";
import { failureEvents, samResultView, useSamRun } from "@/components/docs/playgrounds/voice-sam/useSamRun";
import styles from "@/components/docs/playgrounds/voice-sam/voice-sam.module.css";
import { formatUsd } from "@/lib/docs/client/cost";
import { fileToDataUrl } from "@/lib/docs/media/base64";
import type { PickedMedia } from "@/lib/docs/media/prepare";
import { samRequest } from "@/lib/docs/media/requests";
import { parseSamLine, type SamMask, type SamRecord } from "@/lib/docs/media/sam";
import { decodeMaskRaster, rasterArea } from "@/lib/docs/media/sam-mask";

/**
 * sam/reading-segmentation as an inspector: SAM's raw output on the left, line by line with every part colored
 * (frame marker, object id, box, mask, separator), and what it means on the right: each frame's records with box
 * corners, frame size, confidence, the mask's rows and columns, its encoding marker and the decoded raster. The text
 * comes from a live SAM call, from the page's own examples, or from what the reader pastes. Below: frames that
 * skipped or arrived out of order, sparse ids, and each object followed across frames by id.
 */

export interface WireInspectorProps {
  slug?: string;
  /** Where it starts: the page's examples, a live run, or pasted text. */
  source?: "examples" | "live" | "paste";
  sampleId?: string;
  videoSampleId?: string;
  prompt?: string;
}

type Source = "examples" | "live" | "paste";

/** The second record of the page's video line, reused to build lines with sparse ids and a skipped frame. */
const SECOND = DOC_VIDEO_LINE.slice(DOC_VIDEO_LINE.indexOf(",1<|box") + 2).trim();
const FIRST = DOC_VIDEO_LINE.slice(4, DOC_VIDEO_LINE.indexOf(",1<|box"));

/** The page's own examples. The first and the last have complete mask payloads; the image one elides them, as the page does. */
const EXAMPLES: Array<{ label: string; text: string; note: string }> = [
  {
    label: "Video line (full payloads)",
    text: DOC_VIDEO_LINE.trim(),
    note: "Frame 0 of a six-frame clip, prompt button, 320 x 334, two objects. Its mask payloads are complete, so they decode.",
  },
  {
    label: "Image, three matches",
    text: "<0f>0<|box;x1=353;y1=382;x2=453;y2=427;w=537;h=561|><|mask;x=0;y=0;data=46,101,~...|>,1<|box;x1=260;y1=382;x2=340;y2=427;w=537;h=561|><|mask;x=0;y=0;data=46,81,~...|>,2<|box;x1=516;y1=117;x2=536;y2=150;w=537;h=561|><|mask;x=0;y=0;data=34,21,~...|>",
    note: "An image is one line, frame <0f>. The page elides the payloads (~...), so these masks can't decode.",
  },
  {
    label: "With confidence",
    text: "<0f>1<|box;x1=444;y1=625;x2=679;y2=850;w=1800;h=1200;c=0.9609375|><|mask;x=0;y=0;c=0.9609375;data=226,236,!...|>",
    note: 'include_confidence: "true" adds c after h on the box and between y and data on the mask, the same value on both.',
  },
  {
    label: "Sparse ids, a skipped frame",
    text: [`<0f>${FIRST},2${SECOND}`, `<2f>2${SECOND}`].join("\n"),
    note: "Built from the page's line: ids 0 and 2 (not dense), and frame 1 emitted no line because nothing was visible on it.",
  },
];

interface ParsedLine {
  lineNo: number;
  text: string;
  frame: number | null;
  records: SamRecord[];
  diagnostics: Array<{ code: string; message: string }>;
  isText: boolean;
}

function parseLines(text: string): ParsedLine[] {
  return text
    .split(/\r?\n/)
    .map((t, i) => ({ t: t.replace(/\r$/, ""), i }))
    .filter(({ t }) => t.trim())
    .map(({ t, i }) => {
      const p = parseSamLine(t, i + 1);
      return {
        lineNo: i + 1,
        text: t,
        frame: p.frame?.frame ?? null,
        records: p.frame?.records ?? [],
        diagnostics: p.diagnostics.map((d) => ({ code: d.code, message: d.message })),
        isText: p.text !== null,
      };
    });
}

export function WireInspector({ source: initialSource = "examples", sampleId = "street", videoSampleId = "street-pan", prompt: initialPrompt = "dog" }: WireInspectorProps) {
  const id = useId();
  const sam = useSamRun();
  const running = sam.state === "running";
  const [source, setSource] = useState<Source>(initialSource);
  const [example, setExample] = useState(0);
  const [pasted, setPasted] = useState(EXAMPLES[0].text);
  const [kind, setKind] = useState<"image" | "video">("image");
  const [image, setImage] = useState<PickedMedia | null>(null);
  const [video, setVideo] = useState<PickedMedia | null>(null);
  const [concept, setConcept] = useState(initialPrompt);
  const [confidence, setConfidence] = useState(true);
  const [encoding, setEncoding] = useState<"one_bit" | "lossless">("lossless");
  const [full, setFull] = useState(false);
  const [pick, setPick] = useState<{ line: number; record: number }>({ line: 0, record: 0 });
  const [ranFile, setRanFile] = useState<PickedMedia | null>(null);
  const file = kind === "image" ? image : video;
  const url = useObjectUrl(ranFile?.blob ?? null);

  const text = source === "examples" ? EXAMPLES[example].text : source === "paste" ? pasted : (sam.out?.raw ?? "");
  const lines = useMemo(() => parseLines(text), [text]);
  const records = useMemo(() => lines.flatMap((l) => l.records), [lines]);
  const arrival = lines.filter((l) => l.frame !== null).map((l) => l.frame as number);
  const order = frameOrder(arrival);
  const sortedFrames = [...new Set(arrival)].sort((a, b) => a - b);
  const skipped = sortedFrames.length ? sortedFrames[sortedFrames.length - 1] - sortedFrames[0] + 1 - sortedFrames.length : 0;
  const sparse = lines.some((l) => l.records.some((r, i) => Number(r.objectId) !== i));
  const line = lines[Math.min(pick.line, Math.max(0, lines.length - 1))];
  const record = line?.records[Math.min(pick.record, Math.max(0, line.records.length - 1))];

  useEffect(() => setPick({ line: 0, record: 0 }), [text]);

  const run = async () => {
    if (!file || !concept.trim()) return;
    const dataUrl = await fileToDataUrl(file.blob, file.mime);
    const { body } = samRequest({ prompt: concept.trim(), media: { dataUrl }, kind, stream: true, maskEncoding: encoding, includeConfidence: confidence });
    setRanFile(file);
    await sam.run({ body, stream: true });
  };

  return (
    <div className={styles.lab}>
      <Segmented<Source>
        label="Wire text from"
        value={source}
        onChange={setSource}
        disabled={running}
        options={[
          { value: "examples", label: "The page's examples" },
          { value: "live", label: "A live SAM call" },
          { value: "paste", label: "Paste your own" },
        ]}
      />

      {source === "examples" ? (
        <div className={styles.stack}>
          <PresetPills label="Example" presets={EXAMPLES} active={example} onPick={setExample} />
          <p className={styles.note}>{EXAMPLES[example].note}</p>
        </div>
      ) : source === "paste" ? (
        <div className={styles.stack}>
          <label className={styles.label} htmlFor={`${id}-paste`}>
            Output text, one line per frame
          </label>
          <textarea id={`${id}-paste`} className={styles.textarea} value={pasted} rows={5} spellCheck={false} onChange={(e) => setPasted(e.target.value)} />
        </div>
      ) : (
        <div className={styles.stack}>
          <div className="pg-bar">
            <Segmented<"image" | "video">
              label="Media"
              value={kind}
              onChange={setKind}
              disabled={running}
              options={[
                { value: "image", label: "Image" },
                { value: "video", label: "Video" },
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
              <Segmented<"lossless" | "one_bit">
                size="sm"
                label="Mask encoding"
                value={encoding}
                onChange={setEncoding}
                disabled={running}
                options={[
                  { value: "lossless", label: "lossless (~)" },
                  { value: "one_bit", label: "one_bit (!)" },
                ]}
              />
            </span>
            <Toggle id={`${id}-conf`} label='include_confidence: "true"' checked={confidence} onChange={setConfidence} disabled={running} />
          </div>
          <div className={media.spread}>
            <RunButton running={running} onRun={() => void run()} onStop={sam.abort} label="Segment" disabled={!file || !concept.trim() || (file?.problems.length ?? 0) > 0} />
          </div>
          <p className={styles.note}>
            {kind === "image" ? "$0.0025 an image." : `About ${formatUsd(samCostUsd("video", file?.frames ?? 50))} for ${file?.frames ?? "the"} frames ($0.20 per 1,000, 50-frame minimum).`}
          </p>
          <ErrorBox error={sam.error} />
          {running || sam.result ? (
            <ResponseView result={samResultView(sam.result, sam.out)} running={running} elapsedMs={sam.elapsedMs} model="sam-3.1" usage={sam.out?.usage ?? undefined} json={sam.out?.response ?? undefined}>
              <p className={styles.note} aria-live="polite">
                {!sam.out
                  ? "Segmenting..."
                  : sam.out.error
                    ? `${sam.out.deltas} response.output_text.delta event${sam.out.deltas === 1 ? "" : "s"}, then ${failureEvents(sam.out)}: the request failed inside the stream under HTTP 200. That is a failure, not zero matches.`
                    : `${sam.out.deltas} response.output_text.delta event${sam.out.deltas === 1 ? "" : "s"}, one line each${sam.out.done ? ", then response.completed." : " so far..."}${sam.out.done && !sam.out.raw.trim() ? " The lane is empty: zero matches, a valid result." : ""}`}
              </p>
            </ResponseView>
          ) : null}
        </div>
      )}

      {lines.length ? (
        <>
          <div className={styles.row}>
            <WireLegend />
            <Toggle id={`${id}-full`} label="Full mask payloads" checked={full} onChange={setFull} />
          </div>
          <div className={styles.split}>
            <section className={styles.stack} aria-label="Raw wire">
              <p className={styles.cardTitle}>Raw wire ({lines.length} line{lines.length === 1 ? "" : "s"})</p>
              <ol className={styles.wireLines}>
                {lines.slice(0, 200).map((l, i) => (
                  <li key={l.lineNo}>
                    <WireLine line={l.text} full={full} lineNo={l.lineNo} selected={pick.line === i ? pick.record : null} onPick={(r) => setPick({ line: i, record: r })} />
                  </li>
                ))}
              </ol>
              {lines.length > 200 ? <p className={styles.note}>Showing the first 200 of {lines.length} lines.</p> : null}
            </section>
            <section className={styles.stack} aria-label="Parsed" aria-live="polite">
              <p className={styles.cardTitle}>Parsed{line ? `: line ${line.lineNo}` : ""}</p>
              {line ? <LineDetail line={line} selected={pick.record} onSelect={(r) => setPick({ line: pick.line, record: r })} /> : null}
              {record ? <RecordDetail record={record} /> : null}
            </section>
          </div>
          <ul className={styles.counts} aria-label="What the lines show">
            <li className={styles.count}>
              frames <b>{sortedFrames.length}</b>
              {sortedFrames.length ? ` (${sortedFrames[0]} to ${sortedFrames[sortedFrames.length - 1]})` : ""}
            </li>
            {skipped > 0 ? (
              <li className={styles.count}>
                skipped <b>{skipped}</b>: frames with nothing visible emit no line
              </li>
            ) : null}
            <li className={styles.count}>
              order <b>{order === "single" ? "one line" : order === "ascending" ? "ascending" : order === "descending" ? "descending" : order === "forward-then-backward" ? "forward, then backward" : "out of order"}</b>
            </li>
            <li className={styles.count}>
              objects <b>{objectTracks(records).length}</b>
              {sparse ? ": ids aren't a dense 0-based sequence" : ""}
            </li>
            <li className={styles.count}>
              encodings <b>{[...new Set(records.map((r) => (r.mask.encoding === "lossless" ? "~ lossless" : "! one_bit")))].join(", ") || "none"}</b>
            </li>
            <li className={styles.count}>
              confidence <b>{records.some((r) => r.box.confidence !== undefined) ? "present" : "absent"}</b>
            </li>
          </ul>
          {sortedFrames.length > 1 ? <TrackRows records={records} last={sortedFrames[sortedFrames.length - 1]} /> : null}
          {source === "live" && url && ranFile && sam.out?.done && records.length ? (
            <MaskOverlay src={url} media={kind} records={records} fps={ranFile.fps ?? 24} frames={ranFile.frames} label={concept} alt={ranFile.description} />
          ) : null}
        </>
      ) : source === "live" && !running && !sam.out?.error ? (
        <p className={styles.note}>Run SAM to see its output here, or pick the page&apos;s examples.</p>
      ) : source === "live" ? null : (
        <p className={styles.note}>No lines yet. An empty output_text means zero matches, which is a valid result.</p>
      )}
    </div>
  );
}

function LineDetail({ line, selected, onSelect }: { line: ParsedLine; selected: number; onSelect(i: number): void }) {
  if (line.isText) return <p className={styles.note}>A line that doesn&apos;t start with &lt; is plain text, not segmentation.</p>;
  return (
    <>
      {line.frame !== null ? (
        <p className={styles.note}>
          Frame marker <code>&lt;{line.frame}f&gt;</code>: source frame {line.frame}. Read it from the marker; never assume the Nth line is frame N.
        </p>
      ) : null}
      {line.diagnostics.map((d, i) => (
        <p key={i} className={d.code === "malformed_record" ? media.problem : styles.note}>
          {d.code}: {d.message}
        </p>
      ))}
      {line.records.length ? (
        <div className={media.tableWrap}>
          <table className={media.table}>
            <thead>
              <tr>
                <th scope="col">id</th>
                <th scope="col">Box x1, y1 to x2, y2</th>
                <th scope="col">w x h</th>
                <th scope="col">c</th>
                <th scope="col">Mask H x W</th>
                <th scope="col">Encoding</th>
              </tr>
            </thead>
            <tbody>
              {line.records.map((r, i) => (
                <tr key={`${r.objectId}-${i}`} aria-selected={selected === i} onClick={() => onSelect(i)} style={{ cursor: "pointer", background: selected === i ? "var(--accent-soft)" : undefined }}>
                  <td className={styles.mono}>{r.objectId}</td>
                  <td className={styles.mono}>
                    {r.box.x1}, {r.box.y1} to {r.box.x2}, {r.box.y2}
                  </td>
                  <td className={styles.mono}>
                    {r.box.w} x {r.box.h}
                  </td>
                  <td className={styles.mono}>{r.box.confidence ?? ""}</td>
                  <td className={styles.mono}>
                    {r.mask.height} x {r.mask.width}
                  </td>
                  <td className={styles.mono}>{r.mask.encoding === "lossless" ? "~ lossless" : "! one_bit"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </>
  );
}

function RecordDetail({ record }: { record: SamRecord }) {
  const res = decodeMaskRaster(record.mask);
  const boxW = record.box.x2 - record.box.x1 + 1;
  const boxH = record.box.y2 - record.box.y1 + 1;
  return (
    <div className={styles.card}>
      <p className={styles.cardTitle}>
        Object {record.objectId} on frame {record.frame}
      </p>
      <ul className={styles.checkList}>
        <li>
          Box: corners ({record.box.x1}, {record.box.y1}) and ({record.box.x2}, {record.box.y2}) in source pixels, x2 and y2 inclusive, so {boxW} x {boxH}{" "}
          pixels inside a {record.box.w} x {record.box.h} frame. Scale by display size over {record.box.w} x {record.box.h} to draw it.
        </li>
        <li>
          Mask: data={record.mask.height},{record.mask.width}: {record.mask.height} rows by {record.mask.width} columns (height first), then{" "}
          {record.mask.encoding === "lossless" ? "~, lossless" : "!, one_bit"}, then {record.mask.payload.length - 1} base85 characters (not base64).
        </li>
        {record.box.confidence !== undefined ? <li>Confidence c={record.box.confidence} on the box and the mask: this frame&apos;s value for this object.</li> : null}
      </ul>
      {res.ok ? (
        <div className={styles.stack}>
          <RasterCanvas mask={record.mask} raster={res.raster} />
          <p className={styles.note}>
            decodeMaskToRaster: a row-major Uint8Array of 0 and 1, length {record.mask.height} x {record.mask.width} = {res.raster.length.toLocaleString("en-US")},{" "}
            {rasterArea(res.raster).toLocaleString("en-US")} set. It sits on the box.
          </p>
        </div>
      ) : (
        <p className={styles.note}>{/\.\.\.$/.test(record.mask.payload) ? "The payload is elided in this example, so it can't decode." : `The mask didn't decode: ${res.message}`}</p>
      )}
    </div>
  );
}

function RasterCanvas({ mask, raster }: { mask: SamMask; raster: Uint8Array }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    c.width = mask.width;
    c.height = mask.height;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const data = new Uint8ClampedArray(mask.width * mask.height * 4);
    for (let i = 0; i < raster.length; i++) {
      const on = raster[i] === 1;
      data[i * 4] = on ? 41 : 255;
      data[i * 4 + 1] = on ? 98 : 255;
      data[i * 4 + 2] = on ? 216 : 255;
      data[i * 4 + 3] = on ? 255 : 0;
    }
    ctx.putImageData(new ImageData(data, mask.width, mask.height), 0, 0);
  }, [mask, raster]);
  const scale = Math.max(1, Math.min(8, Math.floor(260 / Math.max(mask.width, mask.height))));
  return (
    <canvas
      ref={ref}
      className={styles.raster}
      style={{ width: mask.width * scale, height: mask.height * scale }}
      role="img"
      aria-label={`The decoded mask: ${mask.height} rows by ${mask.width} columns`}
    />
  );
}

function TrackRows({ records, last }: { records: SamRecord[]; last: number }) {
  const tracks = objectTracks(records);
  const width = Math.min(last + 1, 400);
  return (
    <section className={styles.card} aria-label="Objects across frames">
      <p className={styles.cardTitle}>Objects across frames</p>
      {tracks.map((t) => {
        const present = new Set(t.frames);
        return (
          <div key={t.objectId} className={styles.track}>
            <span className={styles.mono}>id {t.objectId}</span>
            <div className={styles.trackBar} role="img" aria-label={`Object ${t.objectId}: ${t.frames.length} frames from ${t.first} to ${t.last}`}>
              {Array.from({ length: width }, (_, f) => (
                <span key={f} className={styles.trackCell} style={{ background: present.has(f) ? "var(--accent)" : "transparent" }} />
              ))}
            </div>
          </div>
        );
      })}
      <p className={styles.note}>Key masks by object id, never by position on the line: an id is the same object on every frame it appears on.</p>
    </section>
  );
}
