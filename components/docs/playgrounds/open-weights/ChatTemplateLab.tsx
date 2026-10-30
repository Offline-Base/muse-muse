"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { PresetPills, TextArea, TextInput, Toggle } from "@/components/docs/kit/Field";
import { TabPanel, Tabs } from "@/components/docs/kit/Tabs";
import { copyText } from "@/components/docs/page/clipboard";
import { OPEN_EFFORTS, sparkStrength, type OpenEffort, type OpenModel } from "@/components/docs/playgrounds/open-weights/facts";
import {
  GET_WEATHER,
  GLIMMER_PRESETS,
  SPARK_PRESETS,
  STANDIN_SAMPLE,
  mediaKinds,
  openaiTools,
  pageWeather,
  plainText,
  renderTemplate,
  serverRequest,
  snippetFor,
  tallyTokens,
  type ConvMessage,
  type MediaKind,
  type Segment,
  type TemplatePreset,
  type ToolCallIn,
  appendReply,
  hostedMessages,
} from "@/components/docs/playgrounds/open-weights/template";
import { StandIn } from "@/components/docs/playgrounds/open-weights/StandIn";
import { CodeTabs, Issues, SegmentField } from "@/components/docs/playgrounds/open-weights/ui";
import type { Collected } from "@/lib/docs/client/stream";
import { fetchSample, readFileAs } from "@/lib/docs/client/files";
import { sampleById } from "@/lib/docs/media/samples";
import styles from "@/components/docs/playgrounds/open-weights/ow.module.css";

/**
 * The prompting guides' chat template, live (muse-spark-open/prompting, muse-glimmer/prompting): edit a conversation
 * (system prompt, user turns with media, assistant turns with tool calls or replayed reasoning, tool results), set the
 * reasoning level and tools, and see the exact framing the page documents, special tokens highlighted, with a token
 * count, the issues the page warns about, the server request and the apply_chat_template call. A second tab sends the
 * same conversation to hosted Muse Spark as a stand-in and can feed its tool calls back into the conversation.
 */

export interface ChatTemplateLabProps {
  slug: string;
  model: OpenModel;
  /** Which preset to open on (its id). */
  start?: string;
}

type Tab = "template" | "live";

const MEDIA: Record<OpenModel, MediaKind[]> = { spark: ["image", "video", "audio"], glimmer: ["image"] };

/** "a, b and c". */
function listOf(items: string[]): string {
  return items.length > 1 ? `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}` : (items[0] ?? "");
}

function SegmentView({ seg }: { seg: Segment }) {
  if (seg.kind === "special") return <span className={styles.tokSpecial}>{seg.text}</span>;
  if (seg.kind === "media") return <span className={styles.tokMedia}>{seg.text}</span>;
  if (seg.kind === "elided")
    return (
      <span className={styles.tokElided} title={seg.note}>
        {seg.text}
      </span>
    );
  if (seg.kind === "inferred")
    return (
      <span className={styles.tokInferred} title={seg.note}>
        {seg.text}
      </span>
    );
  return <>{seg.text}</>;
}

export function ChatTemplateLab({ model, start }: ChatTemplateLabProps) {
  const id = useId();
  const presets = model === "spark" ? SPARK_PRESETS : GLIMMER_PRESETS;
  const first = presets.find((p) => p.id === start) ?? presets[0];
  const [preset, setPreset] = useState<number | null>(presets.indexOf(first));
  const [conv, setConv] = useState<ConvMessage[]>(first.messages);
  const [effort, setEffort] = useState<OpenEffort>(first.effort);
  const [tools, setTools] = useState(first.tools);
  const [date, setDate] = useState(first.currentDate ?? "2026-10-30");
  const [genPrompt, setGenPrompt] = useState(true);
  const [tab, setTab] = useState<Tab>("template");
  const [showRequest, setShowRequest] = useState(false);
  const [copied, setCopied] = useState(false);

  const toolDefs = tools ? [GET_WEATHER] : [];
  const opts = { model, effort, currentDate: date, tools: toolDefs, addGenerationPrompt: genPrompt };
  const rendered = useMemo(() => renderTemplate(conv, { model, effort, currentDate: date, tools: tools ? [GET_WEATHER] : [], addGenerationPrompt: genPrompt }), [conv, model, effort, date, tools, genPrompt]);
  const tally = tallyTokens(rendered.segments);
  const kinds = mediaKinds(conv);
  const kindsKey = kinds.join(",");
  // The page's example media URLs aren't real files, so the stand-in sends a docs sample for each kind, loaded the
  // first time the live tab opens with that kind in the conversation.
  const [samples, setSamples] = useState<Partial<Record<MediaKind, string>>>({});
  const [sampleError, setSampleError] = useState<string | null>(null);
  const loading = useRef(new Set<MediaKind>());
  useEffect(() => {
    if (tab !== "live" || !kindsKey) return;
    for (const kind of kindsKey.split(",") as MediaKind[]) {
      const sample = sampleById(STANDIN_SAMPLE[kind].id);
      if (!sample || loading.current.has(kind)) continue;
      loading.current.add(kind);
      fetchSample(sample)
        .then((file) => readFileAs(file, "dataUrl"))
        .then((url) => setSamples((cur) => ({ ...cur, [kind]: url })))
        .catch(() => {
          loading.current.delete(kind);
          setSampleError(`The ${kind} sample didn't load, so that part is left out.`);
        });
    }
  }, [tab, kindsKey]);
  const waiting = !sampleError && kinds.some((k) => !samples[k]);
  const hosted = useMemo(() => hostedMessages(conv, model, samples), [conv, model, samples]);
  const hostedTools = useMemo(() => (tools ? openaiTools([GET_WEATHER]) : undefined), [tools]);

  const pick = (i: number) => {
    const p: TemplatePreset = presets[i];
    setPreset(i);
    setConv(p.messages);
    setEffort(p.effort);
    setTools(p.tools);
    if (p.currentDate) setDate(p.currentDate);
    setGenPrompt(true);
  };

  const edit = (i: number, next: ConvMessage | null) => {
    setPreset(null);
    setConv((c) => (next ? c.map((m, j) => (j === i ? next : m)) : c.filter((_, j) => j !== i)));
  };

  const add = (m: ConvMessage) => {
    setPreset(null);
    setConv((c) => [...c, m]);
  };

  const calls = conv.flatMap((m) => (m.role === "assistant" ? (m.toolCalls ?? []) : []));
  const answered = new Set(conv.filter((m): m is Extract<ConvMessage, { role: "tool" }> => m.role === "tool").map((m) => m.toolCallId));
  const open = calls.filter((c) => !answered.has(c.id));

  /** A reply from the stand-in, appended the way the page's loop does: the calls, then one result per call. */
  const addReply = (reply: Collected) => {
    setPreset(null);
    setConv((c) => appendReply(c, reply));
    setTab("template");
  };

  const copyRendered = async () => {
    const ok = await copyText(plainText(rendered.segments));
    setCopied(ok);
    setTimeout(() => setCopied(false), 2000);
  };

  const effortLabel = model === "spark" ? "reasoning_effort" : "reasoning_strength";
  const tabs = [
    { id: "template" as const, label: "Chat template" },
    { id: "live" as const, label: "Try it on hosted Muse Spark" },
  ];

  return (
    <div className="pg">
      <PresetPills presets={presets} active={preset} onPick={pick} label="Examples" />
      <Tabs label="Template or live" tabs={tabs} value={tab} onChange={setTab} idBase={id} />

      <TabPanel idBase={id} id="template" active={tab === "template"}>
        <div className={styles.stack}>
          <div className={styles.rowTop}>
            <SegmentField<OpenEffort>
              label={effortLabel}
              value={effort}
              options={OPEN_EFFORTS.map((e) => ({ value: e, label: model === "spark" ? `${e} · ${sparkStrength(e)}` : e }))}
              onChange={(e) => {
                setPreset(null);
                setEffort(e);
              }}
              hint={model === "spark" ? "The template writes the number. The default is xhigh (512); none and max are rejected." : "A template argument, written by name. The default is high."}
            />
            {model === "spark" ? (
              <div className="pg-field" style={{ maxWidth: 190 }}>
                <label className="pg-label" htmlFor={`${id}-date`}>
                  current_date
                </label>
                <TextInput id={`${id}-date`} value={date} onChange={(e) => setDate(e.target.value)} spellCheck={false} aria-describedby={`${id}-date-hint`} />
                <p className="pg-hint" id={`${id}-date-hint`}>
                  A chat_template_kwargs field. Defaults to today.
                </p>
              </div>
            ) : null}
            <div className="pg-field">
              <Toggle id={`${id}-tools`} label="Pass get_weather in tools" checked={tools} onChange={(v) => { setPreset(null); setTools(v); }} />
              <Toggle id={`${id}-gen`} label="add_generation_prompt" checked={genPrompt} onChange={setGenPrompt} />
            </div>
          </div>

          <ConversationEditor model={model} conv={conv} onEdit={edit} onAdd={add} openCalls={open} idBase={id} />

          <div className={styles.stack} style={{ gap: 8 }}>
            <div className="pg-bar" style={{ justifyContent: "space-between" }}>
              <p className="pg-section-label" style={{ margin: 0 }}>
                What the model sees
              </p>
              <button type="button" className="btn btn-sm btn-outline" onClick={() => void copyRendered()}>
                {copied ? "Copied" : "Copy the text"}
              </button>
            </div>
            <pre className={styles.render} aria-label="The rendered prompt" tabIndex={0}>
              {rendered.segments.map((s, i) => (
                <SegmentView key={i} seg={s} />
              ))}
            </pre>
            <p className={styles.tally} aria-live="polite">
              <span>
                About <strong>{tally.total.toLocaleString("en-US")}</strong> tokens
              </span>
              <span>{tally.special} special tokens (exact)</span>
              {tally.media ? <span>{tally.media} media placeholder{tally.media === 1 ? "" : "s"}, each expanded by the processor</span> : null}
              <span>about {tally.text.toLocaleString("en-US")} text tokens (estimate)</span>
              {tally.elided ? <span>{tally.elided} elided part{tally.elided === 1 ? "" : "s"} not counted</span> : null}
            </p>
            <ul className={styles.legend} aria-label="Legend">
              <li>
                <span className={styles.tokSpecial}>{"<|eot|>"}</span> special token
              </li>
              <li>
                <span className={styles.tokMedia}>{model === "spark" ? "<|patch|>" : "<|image|>"}</span> media placeholder
              </li>
              <li>
                <span className={styles.tokElided}>[...]</span> not printed on the page
              </li>
              <li>
                <span className={styles.tokInferred}>dotted</span> described, not printed
              </li>
            </ul>
            <p className="pg-hint">
              The documented framing, built from this page. The exact text, including the parts marked as not printed, comes from the tokenizer&apos;s apply_chat_template (below).
            </p>
          </div>

          <Issues
            errors={rendered.issues.filter((i) => i.level === "error").map((i) => i.text)}
            warnings={rendered.issues.filter((i) => i.level === "warn").map((i) => i.text)}
            notes={rendered.issues.filter((i) => i.level === "note").map((i) => i.text)}
          />

          <div className="pg-actions">
            <Toggle id={`${id}-req`} label="Show the request and the Python" checked={showRequest} onChange={setShowRequest} />
          </div>
          {showRequest ? (
            <CodeTabs
              label="Request"
              tabs={[
                { id: "server", label: "Server request", lang: "json", code: JSON.stringify(serverRequest(conv, opts), null, 2) },
                { id: "python", label: "apply_chat_template", lang: "python", code: snippetFor(conv, opts) },
              ]}
            />
          ) : null}
        </div>
      </TabPanel>

      <TabPanel idBase={id} id="live" active={tab === "live"}>
        <StandIn
          standsFor={model === "spark" ? "Muse Spark Open" : "Muse Glimmer"}
          messages={hosted.messages}
          effort={effort}
          // Media requests reason longer: the image, video and audio preset spent 2,198 and 3,347 reasoning tokens at medium.
          maxTokens={kinds.length ? 6000 : undefined}
          disabled={waiting}
          note={
            kinds.length ? (
              <>
                The page&apos;s example URLs aren&apos;t real files, so this sends {listOf(kinds.map((k) => STANDIN_SAMPLE[k].what))} in their place, in the same order among the text
                {waiting ? " (loading)" : ""}.{kinds.includes("audio") ? " Audio on Muse Spark 1.3 isn't fully supported yet, so Meta's audio examples use Muse Spark 1.2 (Video and audio understanding)." : ""}
                {sampleError ? ` ${sampleError}` : ""}
              </>
            ) : null
          }
          tools={hostedTools}
          parallelToolCalls={model === "glimmer" ? false : undefined}
          dropped={[...hosted.dropped, ...(model === "spark" ? ["chat_template_kwargs.current_date"] : ["chat_template_kwargs.reasoning_strength, sent as reasoning_effort instead"])]}
          reasoningField={model === "spark" ? "reasoning_content" : "reasoning_content (SGLang, llama.cpp) or reasoning (vLLM)"}
        >
          {(reply) =>
            reply && (reply.toolCalls.length || reply.text) ? (
              <div className="pg-actions">
                <button type="button" className="btn btn-sm btn-outline" onClick={() => addReply(reply)}>
                  {reply.toolCalls.length
                    ? `Add the ${reply.toolCalls.length === 1 ? "call" : `${reply.toolCalls.length} calls`} and the page's results to the conversation`
                    : "Add the answer to the conversation"}
                </button>
                <span className="pg-hint">Then the Chat template tab shows how they render{reply.toolCalls.length ? ", and Run again sends the results back" : ""}.</span>
              </div>
            ) : null
          }
        </StandIn>
      </TabPanel>
    </div>
  );
}

function ConversationEditor({
  model,
  conv,
  onEdit,
  onAdd,
  openCalls,
  idBase,
}: {
  model: OpenModel;
  conv: ConvMessage[];
  onEdit(i: number, next: ConvMessage | null): void;
  onAdd(m: ConvMessage): void;
  openCalls: ToolCallIn[];
  idBase: string;
}) {
  const hasSystem = conv.some((m) => m.role === "system");
  return (
    <div className={styles.stack} style={{ gap: 8 }}>
      <p className="pg-section-label" style={{ margin: 0 }}>
        Conversation
      </p>
      <ol className={styles.msgs} aria-label="Messages">
        {conv.map((m, i) => (
          <li key={i} className={styles.msg}>
            <div className={styles.msgHead}>
              <span className={`${styles.role} ${m.role === "user" ? styles.roleUser : m.role === "tool" ? styles.roleTool : ""}`}>{m.role}</span>
              {m.role === "tool" ? <span className="pg-hint">answers {m.toolCallId}</span> : null}
              <span className={styles.msgActions}>
                {m.role === "user"
                  ? MEDIA[model].map((kind) => (
                      <button key={kind} type="button" className="btn btn-sm btn-outline" onClick={() => onEdit(i, { ...m, parts: [...m.parts.filter((p) => p.type !== "text"), { type: kind }, ...m.parts.filter((p) => p.type === "text")] })}>
                        + {kind}
                      </button>
                    ))
                  : null}
                {m.role === "assistant" && model === "glimmer" && !m.toolCalls?.length && m.reasoning === undefined ? (
                  <button type="button" className="btn btn-sm btn-outline" onClick={() => onEdit(i, { ...m, reasoning: "" })}>
                    + reasoning_content
                  </button>
                ) : null}
                <button type="button" className="btn btn-sm btn-outline" onClick={() => onEdit(i, null)} aria-label={`Remove the ${m.role} message`}>
                  Remove
                </button>
              </span>
            </div>
            <MessageBody model={model} m={m} onChange={(next) => onEdit(i, next)} id={`${idBase}-m${i}`} />
          </li>
        ))}
      </ol>
      <div className="pg-actions" role="group" aria-label="Add a message">
        {!hasSystem ? (
          <button type="button" className="btn btn-sm btn-outline" onClick={() => onAdd({ role: "system", content: "" })}>
            + System
          </button>
        ) : null}
        <button type="button" className="btn btn-sm btn-outline" onClick={() => onAdd({ role: "user", parts: [{ type: "text", text: "" }] })}>
          + User
        </button>
        <button type="button" className="btn btn-sm btn-outline" onClick={() => onAdd({ role: "assistant", content: "" })}>
          + Assistant
        </button>
        {openCalls.length ? (
          <button type="button" className="btn btn-sm btn-outline" onClick={() => onAdd({ role: "tool", toolCallId: openCalls[0].id, content: openCalls[0].name === "get_weather" ? pageWeather(openCalls[0].arguments.city) : "" })}>
            + Result for {openCalls[0].id}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function MessageBody({ model, m, onChange, id }: { model: OpenModel; m: ConvMessage; onChange(next: ConvMessage): void; id: string }) {
  if (m.role === "system") {
    return (
      <>
        <label className="sr-only" htmlFor={id}>
          System prompt
        </label>
        <TextArea id={id} rows={Math.min(8, Math.max(2, m.content.split("\n").length))} value={m.content} onChange={(e) => onChange({ ...m, content: e.target.value })} placeholder="Your system prompt" />
      </>
    );
  }
  if (m.role === "user") {
    const media = m.parts.filter((p) => p.type !== "text");
    const text = m.parts.filter((p): p is { type: "text"; text: string } => p.type === "text").map((p) => p.text).join("");
    return (
      <>
        {media.length ? (
          <ul className={styles.chipList} aria-label="Media parts">
            {media.map((p, j) => (
              <li key={j} className={styles.chip}>
                {p.type === "image" ? (model === "spark" ? "image_url" : "image") : `${p.type}_url`}
                <button
                  type="button"
                  className={styles.chipX}
                  aria-label={`Remove the ${p.type} part`}
                  onClick={() => {
                    const left = media.filter((_, k) => k !== j);
                    onChange({ ...m, parts: [...left, { type: "text", text }] });
                  }}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <label className="sr-only" htmlFor={id}>
          User message
        </label>
        <TextArea id={id} rows={Math.min(8, Math.max(2, text.split("\n").length))} value={text} onChange={(e) => onChange({ ...m, parts: [...media, { type: "text", text: e.target.value }] })} placeholder="The user's message" />
      </>
    );
  }
  if (m.role === "assistant") {
    if (m.toolCalls?.length) {
      return (
        <pre className={styles.callBox} aria-label="Tool calls">
          {m.toolCalls.map((c) => `${c.id}: ${c.name}(${JSON.stringify(c.arguments)})`).join("\n")}
        </pre>
      );
    }
    return (
      <>
        {m.reasoning !== undefined ? (
          <>
            <label className="pg-label" htmlFor={`${id}-r`}>
              reasoning_content (replayed as the to=self turn)
            </label>
            <TextArea id={`${id}-r`} rows={2} value={m.reasoning} onChange={(e) => onChange({ ...m, reasoning: e.target.value })} />
          </>
        ) : null}
        <label className="sr-only" htmlFor={id}>
          Assistant reply
        </label>
        <TextArea id={id} rows={2} value={m.content ?? ""} onChange={(e) => onChange({ ...m, content: e.target.value })} placeholder="An earlier assistant reply" />
      </>
    );
  }
  return (
    <>
      <label className="sr-only" htmlFor={id}>
        Tool result
      </label>
      <TextArea id={id} rows={1} value={m.content} onChange={(e) => onChange({ ...m, content: e.target.value })} />
    </>
  );
}
