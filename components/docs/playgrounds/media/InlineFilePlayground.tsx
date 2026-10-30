"use client";

import { useId, useMemo, useState } from "react";
import { CodeView, DEFAULT_TEXT_MODEL, ErrorBox, ModelSelect, ResponseView, RunButton } from "@/components/docs/kit";
import { EffortSelect, Field, PresetPills, Segmented, TextArea, TextInput, Toggle, runOnModEnter } from "@/components/docs/kit/Field";
import { StreamView } from "@/components/docs/kit/StreamView";
import { useDocsRun } from "@/components/docs/kit/useDocsRun";
import { FilePicker } from "@/components/docs/media/FilePicker";
import { inlineFileBody, inlineSendCountable, urlLooksLikeVideo, type Api, type InlineSend, type Json } from "@/components/docs/playgrounds/media/bodies";
import styles from "@/components/docs/playgrounds/media/demos.module.css";
import { docsCall } from "@/lib/docs/client/api";
import type { Effort } from "@/lib/docs/client/models";
import { chatCollector, responsesCollector, type Collected } from "@/lib/docs/client/stream";
import { dataUrlLength, fileToDataUrl, formatBytes } from "@/lib/docs/media/base64";
import type { PickedMedia } from "@/lib/docs/media/prepare";

export interface InlinePreset {
  label: string;
  send: InlineSend;
  sampleId?: string;
  question?: string;
  /** For file_url. */
  url?: string;
}

export interface InlineFilePlaygroundProps {
  slug?: string;
  /** The first one loads on start. */
  presets: InlinePreset[];
  /** The public file file_url starts with: the page's own example PDF. */
  fileUrl?: string;
  model?: string;
  models?: string[];
  effort?: Effort | null;
}

const SEND_LABEL: Record<InlineSend, string> = {
  responses_file_data: "input_file file_data",
  chat_file: "file block, file_data",
  responses_file_url: "input_file file_url",
  responses_video_url: "input_video video_url",
};

/** The ways each API carries a file inline (file-handling, "Send a file inline"). */
const SENDS: Record<Api, InlineSend[]> = {
  responses: ["responses_file_data", "responses_file_url", "responses_video_url"],
  chat: ["chat_file"],
};

const apiOf = (send: InlineSend): Api => (send === "chat_file" ? "chat" : "responses");

const SEND_NOTE: Record<InlineSend, string> = {
  responses_file_data: "An input_file part carries file_data (a base64 data URL) and an optional filename.",
  chat_file: "A file content block whose nested file object carries file_data (a base64 data URL) and filename.",
  responses_file_url: "An input_file part carries file_url, an http or https link the server fetches and reads by type. Other URL schemes return HTTP 400.",
  responses_video_url: "Inline video goes in an input_video part's video_url, as a base64 data URL or a public URL.",
};

/** 50 MB inline (file_data or file_url), 1 GiB through the Files API (file-handling, "Size limits"). */
const INLINE_MAX = 50_000_000;

/**
 * Files inline, the first path on file-handling: a PDF, image or clip as a base64 data URL in a Responses input_file
 * (file_data and filename) or a Chat Completions file block, a public URL in input_file's file_url, or inline video
 * in input_video. Shows what the file adds to the body against the 50 MB inline limit, and counts the input tokens
 * a Responses request would bill for a PDF or an image, for free (input_tokens doesn't count video).
 */
export function InlineFilePlayground({
  presets,
  fileUrl = "https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf",
  model: initialModel = DEFAULT_TEXT_MODEL,
  models,
  effort: initialEffort = "low",
}: InlineFilePlaygroundProps) {
  const id = useId();
  const first = presets[0] ?? { label: "Summarize", send: "responses_file_data" as const };
  const runner = useDocsRun();
  const counter = useDocsRun();
  const [model, setModel] = useState(initialModel);
  const [effort, setEffort] = useState<Effort | null>(initialEffort);
  const [send, setSend] = useState<InlineSend>(first.send);
  // Back to Responses from Chat Completions lands on the Responses way used last.
  const [lastResponsesSend, setLastResponsesSend] = useState<InlineSend>(first.send === "chat_file" ? "responses_file_data" : first.send);
  const [picked, setPicked] = useState<PickedMedia | null>(null);
  const [sample, setSample] = useState(first.sampleId ?? (first.send === "responses_video_url" ? "street-pan" : "field-report"));
  const [url, setUrl] = useState(first.url ?? fileUrl);
  const [question, setQuestion] = useState(first.question ?? "Summarize this document.");
  const [preset, setPreset] = useState<number | null>(presets.length ? 0 : null);
  const [live, setLive] = useState<Collected | null>(null);
  const [tokens, setTokens] = useState<{ total: number; textOnly: number | null } | null>(null);
  const [showCode, setShowCode] = useState(false);

  const urlMode = send === "responses_file_url";
  const videoMode = send === "responses_video_url";
  const accept = videoMode ? "video/mp4" : "application/pdf,image/png,image/jpeg,image/webp,image/gif";
  const running = runner.state === "running";
  const busy = running || counter.state === "running";
  const ready = urlMode ? /^https?:\/\/\S+$/.test(url.trim()) : !!picked && picked.problems.length === 0 && (!videoMode || picked.kind === "video");
  // input_tokens counts PDFs and images, not video, and only takes the Responses shape.
  const countable = inlineSendCountable(send, videoMode || (urlMode ? urlLooksLikeVideo(url) : picked?.kind === "video"));

  const applyPreset = (i: number) => {
    const p = presets[i];
    setPreset(i);
    setSend(p.send);
    if (p.send !== "chat_file") setLastResponsesSend(p.send);
    if (p.url) setUrl(p.url);
    if (p.question) setQuestion(p.question);
    const nextSample = p.sampleId ?? (p.send === "responses_video_url" ? "street-pan" : sample);
    if (nextSample !== picked?.sampleId) {
      setPicked(null);
      setSample(nextSample);
    }
    runner.reset();
    counter.reset();
    setLive(null);
    setTokens(null);
  };

  const changeSend = (next: InlineSend) => {
    setSend(next);
    if (next !== "chat_file") setLastResponsesSend(next);
    setTokens(null);
    // Video in input_video, documents and images in file_data: switch the sample to one the new part takes.
    if (next === "responses_video_url" && picked?.kind !== "video") {
      setPicked(null);
      setSample("street-pan");
    } else if (next !== "responses_video_url" && next !== "responses_file_url" && picked?.kind === "video") {
      setPicked(null);
      setSample("field-report");
    }
  };

  const valueOf = async (): Promise<string> => (urlMode ? url.trim() : fileToDataUrl(picked!.blob, picked!.mime));

  const run = async () => {
    if (busy || !ready || !question.trim()) return;
    setLive(null);
    setTokens(null);
    const value = await valueOf();
    const { path, body } = inlineFileBody({ model, send, question, value, filename: picked?.name, effort, stream: true });
    const collector = send === "chat_file" ? chatCollector() : responsesCollector();
    await runner.run(path, {
      body,
      stream: true,
      onEvent: (e) => {
        collector.push(e);
        setLive(collector.snapshot());
      },
    });
  };

  const countTokens = async () => {
    if (busy || !ready || !countable) return;
    setTokens(null);
    const value = await valueOf();
    const countBody = (b: Json): Json => ({ model: b.model, input: b.input });
    // The same message without the file, so the file's share can be told apart from the question and formatting.
    const textOnly = { model, input: [{ type: "message", role: "user", content: [{ type: "input_text", text: question }] }] };
    const base = await docsCall<{ input_tokens?: number }>("responses/input_tokens", { body: textOnly });
    const { body } = inlineFileBody({ model, send, question, value, filename: picked?.name });
    const res = await counter.run("responses/input_tokens", { body: countBody(body) });
    const total = (res.json as { input_tokens?: unknown } | null)?.input_tokens;
    if (res.ok && typeof total === "number") setTokens({ total, textOnly: typeof base.json?.input_tokens === "number" ? base.json.input_tokens : null });
  };

  const facts = useMemo(() => {
    if (urlMode) return "file_url adds only the link to the body. The server fetches the file, up to the 50 MB inline limit, and parses PDFs as below.";
    if (!picked) return null;
    const inline = dataUrlLength(picked.bytes, picked.mime);
    const parts = [
      `${picked.name}: ${formatBytes(picked.bytes)}, which goes in the body as a ${formatBytes(inline)} data URL (base64 adds a third).`,
      picked.bytes > INLINE_MAX ? "That's over the 50 MB inline limit: upload it with the Files API instead (up to 1 GiB)." : "Inline files can be up to 50 MB; nothing is stored, so there's nothing to clean up.",
    ];
    return parts.join(" ");
  }, [urlMode, picked]);

  const shownValue = urlMode ? url.trim() || fileUrl : `data:${picked?.mime ?? "application/pdf"};base64,<BASE64>`;
  const code = inlineFileBody({ model, send, question, value: shownValue, filename: picked?.name, effort, stream: true });
  const isPdf = urlMode ? /\.pdf(\?|$)/i.test(url) : picked?.kind === "pdf";

  return (
    <div className={`pg ${styles.lab}`}>
      <PresetPills presets={presets} active={preset} onPick={applyPreset} disabled={busy} />
      <div className="pg-bar">
        <ModelSelect kind="vision" value={model} onChange={setModel} allow={models} disabled={busy} />
      </div>
      <div className={`${styles.controls} pg-advanced`}>
        <span className={styles.inline}>
          <span className={styles.label}>API</span>
          <Segmented<Api>
            size="sm"
            label="API"
            value={apiOf(send)}
            onChange={(a) => changeSend(a === "chat" ? "chat_file" : lastResponsesSend)}
            disabled={busy}
            options={[
              { value: "responses", label: "Responses" },
              { value: "chat", label: "Chat Completions" },
            ]}
          />
        </span>
        <EffortSelect id={`${id}-effort`} model={model} value={effort} onChange={setEffort} disabled={busy} />
        <span className={`${styles.inline} ${styles.segWrap}`}>
          <span className={styles.label}>Send as</span>
          <Segmented<InlineSend>
            size="sm"
            label="How the file is sent"
            value={send}
            onChange={changeSend}
            disabled={busy}
            options={SENDS[apiOf(send)].map((s) => ({ value: s, label: SEND_LABEL[s] }))}
          />
        </span>
      </div>
      <p className={`${styles.note} pg-advanced`}>{SEND_NOTE[send]}</p>

      {urlMode ? (
        <Field id={`${id}-url`} label="file_url" hint="A public http or https link. The server fetches it and detects the type.">
          <TextInput
            id={`${id}-url`}
            className={styles.urlInput}
            value={url}
            spellCheck={false}
            onChange={(e) => setUrl(e.target.value)}
            disabled={busy}
            aria-describedby={`${id}-url-hint`}
          />
        </Field>
      ) : (
        <FilePicker
          key={`${send === "responses_video_url" ? "video" : "doc"}-${sample}`}
          label={videoMode ? "Video (MP4)" : "File (PDF or image)"}
          accept={accept}
          value={picked}
          onChange={setPicked}
          samples={videoMode ? ["video"] : ["pdf", "image"]}
          defaultSampleId={sample}
          preview="compact"
          disabled={busy}
        />
      )}
      {facts ? <p className={`${styles.note} pg-advanced`}>{facts}</p> : null}
      {isPdf ? (
        <p className={`${styles.note} pg-advanced`}>
          PDFs become text from the first 100 pages plus page images of the first 50, and those images count toward the 50 images a request can carry.
        </p>
      ) : null}

      <Field id={`${id}-q`} label="Question">
        <TextArea id={`${id}-q`} value={question} rows={2} onChange={(e) => setQuestion(e.target.value)} onKeyDown={runOnModEnter(() => void run())} disabled={busy} />
      </Field>

      <div className={styles.spread}>
        <div className={`${styles.row} pg-advanced`}>
          {countable ? (
            <>
              <button type="button" className="btn btn-outline btn-sm" onClick={() => void countTokens()} disabled={busy || !ready}>
                {counter.state === "running" ? "Counting..." : "Count input tokens"}
              </button>
              <span className={styles.note}>Free, with POST /v1/responses/input_tokens.</span>
            </>
          ) : (
            <span className={styles.note}>
              {send === "chat_file" ? "No free count here: input_tokens takes the Responses shape." : "No free count for video: input_tokens counts a clip as 1 token."}
            </span>
          )}
        </div>
        <RunButton running={running} onRun={() => void run()} onStop={runner.abort} disabled={!ready || !question.trim() || counter.state === "running"} />
      </div>
      {tokens ? (
        <p className={styles.note} role="status">
          <strong className={styles.num}>{tokens.total.toLocaleString("en-US")}</strong> input tokens
          {tokens.textOnly !== null
            ? `: ${tokens.textOnly.toLocaleString("en-US")} for the question and formatting, ${(tokens.total - tokens.textOnly).toLocaleString("en-US")} for the file.`
            : "."}
        </p>
      ) : null}
      <ErrorBox error={counter.error} />

      <ErrorBox error={runner.error} />
      {running || runner.result ? (
        <ResponseView result={runner.result} running={running} elapsedMs={runner.elapsedMs} json={live?.final ?? undefined} usage={live?.usage ?? undefined}>
          <StreamView text={live?.text ?? ""} reasoning={live?.reasoning} refusal={live?.refusal} running={running} placeholder="Reading the file..." />
        </ResponseView>
      ) : null}

      <div className="pg-actions">
        <Toggle id={`${id}-code`} label="Show code" checked={showCode} onChange={setShowCode} />
      </div>
      {showCode ? <CodeView method="POST" path={code.path} body={code.body} stream caption="The request Run sends" /> : null}
    </div>
  );
}
