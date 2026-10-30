"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { CodeView } from "@/components/docs/kit/CodeView";
import { ErrorBox } from "@/components/docs/kit/ErrorBox";
import { Segmented, Toggle } from "@/components/docs/kit/Field";
import { JsonEditor } from "@/components/docs/kit/JsonEditor";
import { JsonTree } from "@/components/docs/kit/JsonTree";
import { ModelSelect } from "@/components/docs/kit/ModelSelect";
import { PresetRow } from "@/components/docs/playgrounds/common/PresetRow";
import { latencyLabel } from "@/components/docs/kit/ResponseView";
import { RunButton } from "@/components/docs/kit/RunButton";
import { UsageLine } from "@/components/docs/kit/UsageLine";
import { useDocsRun } from "@/components/docs/kit/useDocsRun";
import { FilePicker } from "@/components/docs/media/FilePicker";
import { costExtrasOf, tokenUsage } from "@/lib/docs/client/cost";
import { formatJson, parseJsonText } from "@/lib/docs/client/json";
import { DEFAULT_TEXT_MODEL, docsModelLabel, modelsFor, runsAs } from "@/lib/docs/client/models";
import { fileToDataUrl } from "@/lib/docs/media/base64";
import { downscaleImage } from "@/lib/docs/media/downscale";
import type { PickedMedia } from "@/lib/docs/media/prepare";
import { cx, LazyDetails, Meter, n } from "@/components/docs/playgrounds/text/parts";
import {
  CONTEXT_WINDOW,
  COUNT_CASES,
  countBody,
  countKey,
  countOf,
  displayCountBody,
  sendBodyFor,
  shareLabel,
  windowShare,
  type CountCase,
  type CountEndpoint,
} from "@/components/docs/playgrounds/text/token-cases";
import styles from "@/components/docs/playgrounds/text/text.module.css";

/**
 * Token counting before you send (token-counting page): pick what to count (a question, instructions, a tool
 * conversation, the web_search tool's scaffolding, an image at several sizes, a long document, or any body you
 * write), count it with POST /v1/responses/input_tokens or the Anthropic-shaped POST /v1/messages/count_tokens, see it
 * against the 1,048,576-token context window, compare models (counts are model-specific), and send the real request
 * to compare the preflight count with the reply's usage. That comparison only uses a count of the very body it sends
 * (same case, endpoint, model, image size and text); otherwise Send counts that body first. Counting is free; sending
 * costs a few tokens.
 */

export interface TokenCounterProps {
  slug: string;
  /** Default "responses/input_tokens". */
  endpoint?: CountEndpoint;
  model?: string;
  models?: string[];
  /** The image the picker starts with. */
  sampleId?: string;
  /** The long document's sample. */
  documentUrl?: string;
}

type CaseId = CountCase | "custom";
type ImageSize = "original" | "800" | "400" | "200";

interface CountRecord {
  id: number;
  label: string;
  endpoint: CountEndpoint;
  model: string;
  tokens: number;
}

const DOC = "/docs-samples/alice-chapters-1-3.txt";

function withModel(body: Record<string, unknown>, model: string): Record<string, unknown> {
  return { ...body, model: runsAs(model) };
}

export function TokenCounter(props: TokenCounterProps) {
  const id = useId();
  const counter = useDocsRun();
  const sender = useDocsRun();
  const [endpoint, setEndpoint] = useState<CountEndpoint>(props.endpoint ?? "responses/input_tokens");
  const [model, setModel] = useState(props.model ?? DEFAULT_TEXT_MODEL);
  const [kind, setKind] = useState<CaseId>("text");
  const [compare, setCompare] = useState(false);
  const [picked, setPicked] = useState<PickedMedia | null>(null);
  const [size, setSize] = useState<ImageSize>("original");
  const [image, setImage] = useState<{ url: string; width: number; height: number; bytes: number } | null>(null);
  const [imageError, setImageError] = useState<string | null>(null);
  const [doc, setDoc] = useState<string | null>(null);
  const [customText, setCustomText] = useState(() => formatJson(countBody("responses/input_tokens", "text", props.model ?? DEFAULT_TEXT_MODEL)));
  const [last, setLast] = useState<{ key: string; tokens: number; model: string; label: string; elapsedMs: number } | null>(null);
  const [byModel, setByModel] = useState<Array<{ model: string; tokens: number | null }>>([]);
  const [history, setHistory] = useState<CountRecord[]>([]);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<{ preflight: number | null; usage: unknown; model: string | null; json: unknown; elapsedMs: number } | null>(null);
  const [showCode, setShowCode] = useState(false);
  const seq = useRef(0);

  // The image as the request carries it: the picked file, shrunk to the chosen longest side.
  useEffect(() => {
    let cancelled = false;
    setImage(null);
    setImageError(null);
    if (!picked || picked.problems.length) return;
    (async () => {
      try {
        const out = size === "original" ? { blob: picked.blob, width: picked.width ?? 0, height: picked.height ?? 0 } : await downscaleImage(picked.blob, { maxSide: Number(size), type: "image/jpeg" });
        const url = await fileToDataUrl(out.blob);
        if (!cancelled) setImage({ url, width: out.width, height: out.height, bytes: out.blob.size });
      } catch (err) {
        if (!cancelled) setImageError(err instanceof Error ? err.message : "Couldn't read that image.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [picked, size]);

  // The document loads from this site the first time its case is picked.
  useEffect(() => {
    if (kind !== "document" || doc !== null) return;
    let cancelled = false;
    fetch(props.documentUrl ?? DOC, { credentials: "same-origin" })
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((t) => !cancelled && setDoc(t))
      .catch(() => !cancelled && setDoc(""));
    return () => {
      cancelled = true;
    };
  }, [kind, doc, props.documentUrl]);

  const custom = useMemo(() => parseJsonText(customText), [customText]);
  const customBody = custom.ok && custom.value && typeof custom.value === "object" && !Array.isArray(custom.value) ? (custom.value as Record<string, unknown>) : null;
  const caseLabel = kind === "custom" ? "Your own body" : (COUNT_CASES.find((c) => c.id === kind)?.label ?? kind);
  const notReady = (kind === "image" && !image) || (kind === "document" && !doc) || (kind === "custom" && !customBody);

  const body = useMemo((): Record<string, unknown> | null => {
    if (kind === "custom") return customBody ? withModel(customBody, model) : null;
    if (kind === "image" && !image) return null;
    if (kind === "document" && !doc) return null;
    return countBody(endpoint, kind, runsAs(model), { imageDataUrl: image?.url, document: doc ?? undefined });
  }, [kind, customBody, model, endpoint, image, doc]);

  const pickCase = (c: CaseId) => {
    setKind(c);
    setSent(null);
    // The image and document cases carry megabytes the editor would only show shortened, so those start from the question.
    if (c === "custom" && kind !== "custom") {
      const seed = kind === "image" || kind === "document" || !body ? countBody(endpoint, "text", runsAs(model)) : body;
      setCustomText(formatJson(seed));
    }
  };

  /** Counts `sent` (the body for the current model) and keeps it as the latest count, keyed by what was counted. */
  const countOne = async (sent: Record<string, unknown>, m: string, record: boolean): Promise<number | null> => {
    const res = await counter.run(endpoint, { method: "POST", body: sent, record: record ? undefined : false });
    const tokens = res.ok ? countOf(res.json) : null;
    if (tokens !== null && m === model) {
      setLast({ key: countKey(endpoint, sent), tokens, model: m, label: caseLabel, elapsedMs: res.elapsedMs });
      setHistory((h) => [{ id: ++seq.current, label: caseLabel + (kind === "image" && image ? ` (${image.width} x ${image.height})` : ""), endpoint, model: m, tokens }, ...h].slice(0, 8));
    }
    return res.ok ? tokens : null;
  };

  const count = async () => {
    if (!body || busy) return;
    setBusy(true);
    setSent(null);
    const targets = compare ? modelsFor("text").map((m) => m.id) : [model];
    const rows: Array<{ model: string; tokens: number | null }> = [];
    for (const m of targets) {
      const tokens = await countOne(withModel(body, m), m, m === model);
      rows.push({ model: m, tokens });
      if (compare) setByModel([...rows]);
      if (tokens === null) break;
    }
    setByModel(compare ? rows : []);
    setBusy(false);
  };

  const send = async () => {
    if (!body || busy) return;
    setBusy(true);
    setSent(null);
    const counted = withModel(body, model);
    // The comparison is only fair against a count of this exact body, so a stale count (another case, endpoint,
    // model, image size or text) is replaced by counting this one first. Counting is free.
    const preflight = last?.key === countKey(endpoint, counted) ? last.tokens : await countOne(counted, model, false);
    if (preflight === null) {
      setBusy(false);
      return;
    }
    const target = sendBodyFor(endpoint, counted);
    const res = await sender.run(target.path, { method: "POST", body: target.body });
    setSent({ preflight, usage: (res.json as { usage?: unknown } | null)?.usage ?? null, model: res.model, json: res.json, elapsedMs: res.elapsedMs });
    setBusy(false);
  };

  const share = last ? windowShare(last.tokens) : 0;
  const currentKey = useMemo(() => (body ? countKey(endpoint, withModel(body, model)) : null), [endpoint, body, model]);
  const stale = !!last && last.key !== currentKey;
  const billed = sent ? tokenUsage(sent.usage) : null;

  return (
    <div className={`pg ${styles.stack}`}>
      <div className="pg-bar">
        <span className="pg-advanced">
          <Segmented<CountEndpoint>
            label="Endpoint"
            options={[
              { value: "responses/input_tokens", label: "responses/input_tokens" },
              { value: "messages/count_tokens", label: "messages/count_tokens" },
            ]}
            value={endpoint}
            onChange={(e) => {
              setEndpoint(e);
              setSent(null);
            }}
            disabled={busy}
          />
        </span>
        <ModelSelect kind="text" value={model} onChange={setModel} allow={props.models} disabled={busy} />
        <span className="pg-advanced">
          <Toggle id={`${id}-compare`} label="Count on every model" checked={compare} onChange={setCompare} disabled={busy} />
        </span>
      </div>

      <div className={styles.tight}>
        <PresetRow
          label="Count"
          presets={[...COUNT_CASES.map((c) => ({ label: c.label })), { label: "Your own body" }]}
          active={kind === "custom" ? COUNT_CASES.length : COUNT_CASES.findIndex((c) => c.id === kind)}
          onPick={(i) => pickCase(i < COUNT_CASES.length ? COUNT_CASES[i].id : "custom")}
          disabled={busy}
        />
        <p className={cx(styles.about, "pg-advanced")} aria-live="polite">
          {kind === "custom"
            ? `Any body ${endpoint === "messages/count_tokens" ? "POST /v1/messages takes (Anthropic-shaped)" : "POST /v1/responses takes"}; the model menu sets "model". A body that fails validation gets the same HTTP 400 a generation would.`
            : COUNT_CASES.find((c) => c.id === kind)?.about}
        </p>
      </div>

      {kind === "image" ? (
        <div className={cx(styles.card, styles.cardSoft)}>
          <FilePicker accept="image/*" value={picked} onChange={setPicked} label="Image" samples={["image"]} defaultSampleId={props.sampleId ?? "bar-chart"} preview="compact" disabled={busy} />
          <div className={styles.row}>
            <span className="pg-inline-field pg-advanced">
              <span className="pg-label">Longest side</span>
              <Segmented<ImageSize>
                label="Image size"
                size="sm"
                options={[
                  { value: "original", label: "As picked" },
                  { value: "800", label: "800 px" },
                  { value: "400", label: "400 px" },
                  { value: "200", label: "200 px" },
                ]}
                value={size}
                onChange={setSize}
                disabled={busy}
              />
            </span>
            {image ? (
              <span className="pg-muted pg-small">
                Sending {image.width} x {image.height}, {n(image.bytes / 1024)} KB
              </span>
            ) : imageError ? (
              <span className="pg-hint pg-bad">{imageError}</span>
            ) : (
              <span className="pg-muted pg-small">Preparing the image...</span>
            )}
          </div>
          <p className={cx(styles.about, styles.small, "pg-advanced")}>Count the same image at each size: resolution changes the count, so measure a representative payload instead of estimating.</p>
        </div>
      ) : null}

      {kind === "custom" ? (
        <JsonEditor id={`${id}-body`} label="Body to count" value={customText} onChange={setCustomText} rows={12} disabled={busy} />
      ) : body ? (
        <LazyDetails className={cx(styles.details, "pg-advanced")} summary="The body this counts">
          <JsonTree value={displayCountBody(body)} openDepth={3} label="Count request body" />
        </LazyDetails>
      ) : kind === "document" && doc === "" ? (
        <div className="pg-hint pg-bad">Couldn&apos;t load the document sample from this site.</div>
      ) : null}

      <div className="pg-composer-bar">
        <span className="pg-muted pg-kbd-hint">Counting is free: it tokenizes only, with no output and nothing stored.</span>
        <button type="button" className="btn btn-sm btn-outline pg-advanced" onClick={() => void send()} disabled={busy || notReady || !body}>
          Send it and compare
        </button>
        <RunButton running={busy} onRun={() => void count()} label={compare ? "Count on every model" : "Count tokens"} disabled={notReady || !body} />
      </div>

      {last ? (
        <section className={styles.card} aria-labelledby={`${id}-count`}>
          <p className={styles.hero} id={`${id}-count`} role="status">
            {n(last.tokens)}
            <span className={styles.heroUnit}>
              input tokens on {docsModelLabel(last.model)} ({last.label}, {latencyLabel(last.elapsedMs)})
              {stale ? ". You've changed the request since: count again for this one." : ""}
            </span>
          </p>
          <Meter
            share={share}
            label="Share of the context window"
            left={`${shareLabel(share)} of the ${n(CONTEXT_WINDOW)}-token context window`}
            right={`${n(Math.max(0, CONTEXT_WINDOW - last.tokens))} left for more input and the output`}
          />
          <p className={cx(styles.about, styles.small, "pg-advanced")}>
            The count is the fully rendered input: Meta&apos;s hidden system prompt and default developer message are in it, and built-in tools add their scaffolding.
            Use it for context fit, not for the bill.
          </p>
        </section>
      ) : null}

      {byModel.length ? (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <caption className="sr-only">The same body counted on each model</caption>
            <thead>
              <tr>
                <th scope="col">Model</th>
                <th scope="col" className={styles.num}>
                  Input tokens
                </th>
              </tr>
            </thead>
            <tbody>
              {byModel.map((r) => (
                <tr key={r.model}>
                  <td>{docsModelLabel(r.model)}</td>
                  <td className={styles.num}>{r.tokens === null ? "failed" : n(r.tokens)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className={cx(styles.about, styles.small, "pg-advanced")}>A count applies only to the model that produced it: tokenizers and prompt templates differ, so recount when you switch.</p>
        </div>
      ) : null}

      {sent ? (
        <section className={styles.card} aria-label="Preflight count against the reply's usage">
          <p className={styles.cardTitle}>Preflight count against the reply&apos;s usage</p>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <tbody>
                <tr>
                  <th scope="row">Counted before sending</th>
                  <td className={styles.num}>{sent.preflight === null ? "not counted" : n(sent.preflight)}</td>
                </tr>
                <tr>
                  <th scope="row">usage.input_tokens on the reply</th>
                  <td className={styles.num}>{billed ? n(billed.input) : "none"}</td>
                </tr>
              </tbody>
            </table>
          </div>
          {billed ? <UsageLine model={sent.model} usage={sent.usage} {...costExtrasOf(sent.json)} /> : null}
          <p className={cx(styles.about, styles.small, "pg-advanced")}>
            Usage is accounting, not context size: it applies adjustments such as discounts on Meta&apos;s injected tokens, so it can be lower than the count, and with
            hosted tools it adds up every model iteration, so it can be higher. Use the count endpoint when you need the size.
          </p>
        </section>
      ) : null}

      <ErrorBox error={counter.error ?? sender.error} />

      {history.length > 1 ? (
        <details className={cx(styles.details, "pg-advanced")} open>
          <summary>What you counted here</summary>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">What</th>
                  <th scope="col">Endpoint</th>
                  <th scope="col">Model</th>
                  <th scope="col" className={styles.num}>
                    Tokens
                  </th>
                </tr>
              </thead>
              <tbody>
                {history.map((h) => (
                  <tr key={h.id}>
                    <td>{h.label}</td>
                    <td>
                      <code>{h.endpoint}</code>
                    </td>
                    <td>{docsModelLabel(h.model)}</td>
                    <td className={styles.num}>{n(h.tokens)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      ) : null}

      <div className="pg-actions">
        <Toggle id={`${id}-code`} label="Show code" checked={showCode} onChange={setShowCode} />
      </div>
      {showCode && body ? <CodeView method="POST" path={endpoint} body={displayCountBody(body)} caption="The count request (long text and base64 shortened)" /> : null}
    </div>
  );
}
