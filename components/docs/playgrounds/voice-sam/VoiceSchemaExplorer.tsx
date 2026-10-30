"use client";

import { useId, useMemo, useState } from "react";
import { ErrorBox, ModelSelect, PresetPills, ResponseView, RunButton } from "@/components/docs/kit";
import { Segmented, TextInput } from "@/components/docs/kit/Field";
import { TabPanel, Tabs } from "@/components/docs/kit/Tabs";
import media from "@/components/docs/media/media.module.css";
import { pickSample } from "@/components/docs/playgrounds/voice-sam/pick-sample";
import { useVoiceRun } from "@/components/docs/playgrounds/voice-sam/useVoiceRun";
import type { VoiceMode } from "@/components/docs/playgrounds/voice-sam/voice-events";
import { ACCEPT_HEADER, VOICE_MODEL, transcribeRequestJson, DEFAULT_VOICE_SETTINGS } from "@/components/docs/playgrounds/voice-sam/voice-request";
import styles from "@/components/docs/playgrounds/voice-sam/voice-sam.module.css";
import {
  VOICE_SCHEMAS,
  checkVoiceMessage,
  readMessages,
  searchSchemas,
  voiceSchema,
  type SchemaGroup,
  type VoiceCheck,
  type VoiceSchema,
} from "@/components/docs/playgrounds/voice-sam/voice-schemas";
import type { SseEvent } from "@/lib/docs/client/api";

/**
 * The Voice API's schemas (api-reference/voice/schemas) three ways: browse every schema and field with its type,
 * whether it's required and its default; paste messages (JSON, one per line, or server-sent events) and see which
 * schema each one is and how it checks field by field; or run a real transcription as an event stream and check
 * every event Meta sends against its schema as it arrives.
 */

export interface VoiceSchemaExplorerProps {
  slug?: string;
  /** The schema shown first. */
  schemaId?: string;
  /** The live check's audio sample. */
  sampleId?: string;
  mode?: VoiceMode;
}

type Tab = "browse" | "check" | "live";

const GROUPS: Array<{ id: SchemaGroup; label: string }> = [
  { id: "request", label: "Requests" },
  { id: "response", label: "Responses" },
  { id: "event", label: "Server events" },
];

/** Messages to check, from the page's examples and real replies (Oct 30, 2026). */
const CHECK_PRESETS: Array<{ label: string; text: string }> = [
  {
    label: "A real event stream",
    text: [
      'data: {"type":"speechStart","audioProcessedMs":620,"turnId":0}',
      'data: {"type":"transcript","transcript":"K23 for 4.","final":false,"audioProcessedMs":2720}',
      'data: {"type":"audioProgress","audioProcessedMs":2800}',
      'data: {"type":"speechEnd","audioProcessedMs":8700,"turnId":0}',
      'data: {"type":"speechComplete","audioProcessedMs":8700,"turnId":0,"transcript":"K23 for 4. Night to F3. Bishop to c4. Castle kingside."}',
      'data: {"type":"transcript","transcript":"","final":true,"audioProcessedMs":9200}',
    ].join("\n"),
  },
  {
    label: "A real TranscribeResponse",
    text: JSON.stringify(
      {
        sessionId: "voyager/transcribe/B0AEAD078458497590E69A010C320631",
        transcript: "Hi, thanks for calling Riverside bikes. How can I help? Hi, the back brake on my bike is squeaking.",
        audioDurationMs: 25360,
        turns: [
          { turnId: 0, startMs: 380, endMs: 4540, transcript: "Hi, thanks for calling Riverside bikes. How can I help?", speaker: "A" },
          { turnId: 1, startMs: 4860, endMs: 9660, transcript: "Hi, the back brake on my bike is squeaking.", speaker: "B" },
          { turnId: 5, startMs: 23020, endMs: 23100, transcript: "" },
        ],
      },
      null,
      2,
    ),
  },
  { label: "The handshake ack", text: '{ "sessionId": "550e8400-e29b-41d4-a716-446655440000" }' },
  {
    label: "A handshake",
    text: JSON.stringify(
      { authorization: { accessToken: "Bearer $MODEL_API_KEY" }, audioEncoding: "PCM_24KHZ", model: VOICE_MODEL, mode: "PUSH_TO_TALK", partialMode: "CUMULATIVE", emitAudioProgress: false },
      null,
      2,
    ),
  },
  {
    label: "Broken messages",
    text: [
      '{"model":"muse-voice-transcribe-1.0","mode":"DIARIZATION"}',
      '{"type":"speechComplete","turnId":"1","transcript":"How is the weather?","audioProcessedMs":3600}',
      '{"type":"speaker","audioProcessedMs":2480}',
      '{"authorization":{"accessToken":"Bearer $MODEL_API_KEY"},"audioEncoding":"PCM_44KHZ","model":"muse-voice-transcribe-1.0"}',
      '{"type":"emotion","label":"calm","audioProcessedMs":1200}',
    ].join("\n"),
  },
];

export function VoiceSchemaExplorer({ schemaId = "TranscribeRequest", sampleId = "chess-moves", mode: initialMode = "ENDPOINTING" }: VoiceSchemaExplorerProps) {
  const idBase = useId();
  const [tab, setTab] = useState<Tab>("browse");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(voiceSchema(schemaId) ? schemaId : VOICE_SCHEMAS[0].id);
  const [text, setText] = useState(CHECK_PRESETS[0].text);
  const [preset, setPreset] = useState<number | null>(0);
  const found = useMemo(() => new Set(searchSchemas(query).map((s) => s.id)), [query]);
  const schema = voiceSchema(selected) ?? VOICE_SCHEMAS[0];

  const openCheck = (value: unknown) => {
    setText(JSON.stringify(value, null, 2));
    setPreset(null);
    setTab("check");
  };

  return (
    <div className={styles.lab}>
      <Tabs<Tab>
        label="Schema explorer"
        idBase={idBase}
        value={tab}
        onChange={setTab}
        className={styles.wrapTabs}
        tabs={[
          { id: "browse", label: "Schemas", count: VOICE_SCHEMAS.length },
          { id: "check", label: "Check a message" },
          { id: "live", label: "Check a live stream" },
        ]}
      />
      <TabPanel idBase={idBase} id="browse" active={tab === "browse"}>
        <div className={styles.schemaLayout}>
          <nav className={styles.schemaNav} aria-label="Voice schemas">
            <TextInput value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter: turnId, speaker, PCM..." aria-label="Filter schemas and fields" />
            {GROUPS.map((g) => {
              const list = VOICE_SCHEMAS.filter((s) => s.group === g.id && found.has(s.id));
              if (!list.length) return null;
              return (
                <div key={g.id}>
                  <p className={styles.schemaGroupTitle}>{g.label}</p>
                  <ul className={styles.schemaGroup}>
                    {list.map((s) => (
                      <li key={s.id}>
                        <button type="button" className={styles.schemaItem} aria-current={s.id === selected} onClick={() => setSelected(s.id)}>
                          <span>{s.id}</span>
                          {s.eventType ? <span className={styles.badge}>{s.eventType}</span> : null}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
            {!found.size ? <p className={styles.note}>Nothing matches &quot;{query}&quot;.</p> : null}
          </nav>
          <SchemaDetail schema={schema} onPick={setSelected} onCheck={openCheck} />
        </div>
      </TabPanel>
      <TabPanel idBase={idBase} id="check" active={tab === "check"}>
        <CheckPanel text={text} setText={setText} preset={preset} setPreset={setPreset} onSchema={(id) => {
          setSelected(id);
          setTab("browse");
        }} />
      </TabPanel>
      <TabPanel idBase={idBase} id="live" active={tab === "live"}>
        <LivePanel sampleId={sampleId} initialMode={initialMode} />
      </TabPanel>
    </div>
  );
}

function SchemaDetail({ schema, onPick, onCheck }: { schema: VoiceSchema; onPick(id: string): void; onCheck(value: unknown): void }) {
  return (
    <section className={styles.stack} aria-label={schema.title}>
      <div className={styles.row}>
        <p className={styles.cardTitle}>
          {schema.id} <span className={styles.badge}>{schema.group}</span>
        </p>
        <a href={`#${schema.anchor}`} className="pg-small">
          On this page
        </a>
      </div>
      <p>{schema.description}</p>
      <p className={styles.note}>Used in: {schema.usedIn}</p>
      {schema.oneOf ? (
        <div className={media.chips} role="group" aria-label="One of">
          {schema.oneOf.map((id) => (
            <button key={id} type="button" className={media.chip} onClick={() => onPick(id)}>
              {id} <span className={styles.badge}>{voiceSchema(id)?.eventType}</span>
            </button>
          ))}
        </div>
      ) : null}
      {schema.fields.length ? (
        <div className={media.tableWrap}>
          <table className={`${media.table} ${styles.fieldTable}`}>
            <thead>
              <tr>
                <th scope="col">Field</th>
                <th scope="col">Type</th>
                <th scope="col">Required</th>
                <th scope="col">Description</th>
              </tr>
            </thead>
            <tbody>
              {schema.fields.map((f) => (
                <tr key={f.name}>
                  <td className={styles.fieldCell}>
                    <span className={styles.fieldName}>{f.name}</span>
                  </td>
                  <td data-label="Type">
                    {f.ref ? (
                      <button type="button" className="link-btn" onClick={() => onPick(f.ref!)}>
                        {f.type}
                      </button>
                    ) : f.values ? (
                      <span className={styles.enumList}>
                        {f.values.map((v) => (
                          <code key={v}>{v}</code>
                        ))}
                      </span>
                    ) : (
                      <code>{f.type}</code>
                    )}
                  </td>
                  <td data-label="Required">
                    {f.required ? <span className={`${styles.badge} ${styles.badgeAccent}`}>Yes</span> : <span className={styles.badge}>No</span>}
                    {f.default ? <div className={styles.note}>default {f.default}</div> : null}
                  </td>
                  <td>{f.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {schema.example !== undefined ? (
        <div className={styles.stack}>
          <span className={styles.label}>Example</span>
          <pre className={styles.pre}>{JSON.stringify(schema.example, null, 2)}</pre>
          <button type="button" className="btn btn-outline btn-sm" style={{ alignSelf: "flex-start" }} onClick={() => onCheck(schema.example)}>
            Edit and check it
          </button>
        </div>
      ) : null}
    </section>
  );
}

function CheckRow({ index, raw, check, error, onSchema }: { index: number; raw: string; check?: VoiceCheck; error?: string; onSchema(id: string): void }) {
  const ok = !!check?.ok;
  return (
    <li className={styles.card}>
      <div className={styles.row}>
        <span className={`${styles.badge} ${error || !check?.schema ? styles.badgeWarn : ok ? styles.badgeOk : styles.badgeBad}`}>
          {error ? "not JSON" : !check?.schema ? "unknown" : ok ? "valid" : "invalid"}
        </span>
        <span className={styles.label}>Message {index}</span>
        {check?.schema ? (
          <button type="button" className="link-btn" onClick={() => onSchema(check.schema!.id)}>
            {check.schema.id}
          </button>
        ) : null}
        <span className={styles.note}>{error ?? check?.reason}</span>
      </div>
      <code className={styles.mono} style={{ overflowWrap: "anywhere" }}>
        {raw.length > 220 ? `${raw.slice(0, 220)}...` : raw}
      </code>
      {check?.checks.length ? (
        <ul className={styles.checkList}>
          {check.checks.map((c, i) => (
            <li key={i} className={styles.check}>
              <span className={c.ok ? styles.checkOk : styles.checkBad} aria-label={c.ok ? "passes" : "fails"}>
                {c.ok ? "✓" : "✗"}
              </span>
              <span className={styles.fieldName}>{c.field}</span>
              <span>{c.message}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {check?.extra.length ? <p className={styles.note}>Not in the schema: {check.extra.join(", ")}.</p> : null}
    </li>
  );
}

function CheckPanel({
  text,
  setText,
  preset,
  setPreset,
  onSchema,
}: {
  text: string;
  setText(t: string): void;
  preset: number | null;
  setPreset(i: number | null): void;
  onSchema(id: string): void;
}) {
  const id = useId();
  const messages = useMemo(() => readMessages(text).slice(0, 60), [text]);
  const checked = useMemo(() => messages.map((m) => ({ ...m, check: m.error ? undefined : checkVoiceMessage(m.value) })), [messages]);
  const valid = checked.filter((m) => m.check?.ok).length;
  return (
    <div className={styles.stack}>
      <PresetPills
        presets={CHECK_PRESETS}
        active={preset}
        onPick={(i) => {
          setPreset(i);
          setText(CHECK_PRESETS[i].text);
        }}
      />
      <label className={styles.label} htmlFor={`${id}-msgs`}>
        Messages: one JSON value, a JSON array, one object per line, or event-stream lines
      </label>
      <textarea
        id={`${id}-msgs`}
        className={styles.textarea}
        value={text}
        rows={8}
        spellCheck={false}
        onChange={(e) => {
          setPreset(null);
          setText(e.target.value);
        }}
      />
      <p className={styles.note} aria-live="polite">
        {checked.length ? `${checked.length} message${checked.length === 1 ? "" : "s"}, ${valid} valid. ` : "Paste something to check. "}
        Server events are matched by type; the acknowledgement is the one frame without it. Unknown types are fine to ignore.
      </p>
      <ol className={styles.checkList}>
        {checked.map((m, i) => (
          <CheckRow key={`${m.line}-${i}`} index={i + 1} raw={m.raw} check={m.check} error={m.error} onSchema={onSchema} />
        ))}
      </ol>
    </div>
  );
}

interface LiveEntry {
  type: string;
  check: VoiceCheck;
  raw: string;
}

function LivePanel({ sampleId, initialMode }: { sampleId: string; initialMode: VoiceMode }) {
  const runner = useVoiceRun();
  const running = runner.state === "running";
  const [mode, setMode] = useState<VoiceMode>(initialMode);
  const [accept, setAccept] = useState<"sse" | "json">("sse");
  const [entries, setEntries] = useState<LiveEntry[]>([]);
  const [sample, setSample] = useState(sampleId);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** Audio the last stream processed (its latest audioProcessedMs), for the cost line: a stream has no summary. */
  const [processedMs, setProcessedMs] = useState(0);

  const run = async () => {
    setLoadError(null);
    setEntries([]);
    setProcessedMs(0);
    const picked = await pickSample(sample).catch(() => null);
    if (!picked) {
      setLoadError("Couldn't load the sample. Try again.");
      return;
    }
    const request = transcribeRequestJson({ ...DEFAULT_VOICE_SETTINGS, mode, accept });
    const form = new FormData();
    form.append("request", JSON.stringify(request));
    form.append("audio", picked.blob, picked.name);
    const seen: LiveEntry[] = [];
    let frame: number | null = null;
    let processed = 0;
    const res = await runner.run("asr/transcribe", {
      form,
      accept: ACCEPT_HEADER[accept],
      onEvent: (e: SseEvent) => {
        if (!e.json) return;
        const at = e.json.audioProcessedMs;
        if (typeof at === "number" && Number.isFinite(at)) processed = Math.max(processed, at);
        seen.push({ type: String(e.json.type ?? e.event ?? "message"), check: checkVoiceMessage(e.json), raw: e.data });
        // Checked as they arrive, drawn once a frame.
        frame ??= requestAnimationFrame(() => {
          frame = null;
          setEntries([...seen]);
        });
      },
      record: (r) => ({
        method: "POST",
        path: "asr/transcribe",
        body: `multipart: request=${JSON.stringify(request)}, audio=${picked.name}; Accept: ${ACCEPT_HEADER[accept]}`,
        status: r.status,
        outcome: r.ok ? `${seen.length || 1} messages checked against the Voice schemas` : `error ${r.status}: ${r.error?.message ?? ""}`,
      }),
    });
    if (frame !== null) cancelAnimationFrame(frame);
    if (res.ok && res.json) seen.push({ type: "TranscribeResponse", check: checkVoiceMessage(res.json), raw: res.text });
    setEntries([...seen]);
    setProcessedMs(processed);
  };

  const bySchema = useMemo(() => {
    const m = new Map<string, { schema: string; count: number; valid: number; firstBad: LiveEntry | null }>();
    for (const e of entries) {
      const key = e.check.schema?.id ?? `unknown (${e.type})`;
      const row = m.get(key) ?? { schema: key, count: 0, valid: 0, firstBad: null };
      row.count++;
      if (e.check.ok) row.valid++;
      else row.firstBad ??= e;
      m.set(key, row);
    }
    return [...m.values()];
  }, [entries]);

  // A JSON reply carries audioDurationMs itself; a stream has no summary, so this one takes it from the events and the
  // cost line counts the audio the call was billed for.
  const summary = runner.result?.json ?? {
    checked: entries.length,
    schemas: bySchema.map((r) => ({ schema: r.schema, messages: r.count, valid: r.valid })),
    ...(processedMs ? { audioDurationMs: processedMs } : {}),
  };

  return (
    <div className={styles.stack}>
      <p className={styles.note}>
        Sends a sample to POST /v1/asr/transcribe and checks every message Meta sends back against its schema. Under a cent ($0.18 an hour of audio).
      </p>
      <div className="pg-bar">
        <ModelSelect kind="voice" value={VOICE_MODEL} onChange={() => {}} />
        <Segmented<string>
          size="sm"
          label="Sample"
          value={sample}
          onChange={setSample}
          disabled={running}
          options={[
            { value: "chess-moves", label: "Chess moves (9 s)" },
            { value: "two-voices", label: "Two voices (25 s)" },
          ]}
        />
        <Segmented<VoiceMode>
          size="sm"
          label="Mode"
          value={mode}
          onChange={setMode}
          disabled={running}
          options={(["PUSH_TO_TALK", "ENDPOINTING", "DIARIZATION"] as const).map((m) => ({ value: m, label: m }))}
        />
        <Segmented<"sse" | "json">
          size="sm"
          label="Reply"
          value={accept}
          onChange={setAccept}
          disabled={running}
          options={[
            { value: "sse", label: "text/event-stream" },
            { value: "json", label: "application/json" },
          ]}
        />
      </div>
      <div className={media.spread}>
        <RunButton running={running} onRun={() => void run()} onStop={runner.abort} label="Run and check" />
      </div>
      {loadError ? <p className={media.problem}>{loadError}</p> : null}
      <ErrorBox error={runner.error} />
      {running || runner.result ? (
        <ResponseView result={runner.result} running={running} elapsedMs={runner.elapsedMs} model={VOICE_MODEL} usage={{}} json={summary}>
          <div className={styles.stack} aria-live="polite">
            {bySchema.length ? (
              <div className={media.tableWrap}>
                <table className={media.table}>
                  <thead>
                    <tr>
                      <th scope="col">Schema</th>
                      <th scope="col">Messages</th>
                      <th scope="col">Valid</th>
                      <th scope="col">First problem</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bySchema.map((r) => (
                      <tr key={r.schema}>
                        <td>
                          <span className={styles.fieldName}>{r.schema}</span>
                        </td>
                        <td>{r.count}</td>
                        <td>
                          <span className={`${styles.badge} ${r.valid === r.count ? styles.badgeOk : styles.badgeBad}`}>
                            {r.valid} of {r.count}
                          </span>
                        </td>
                        <td>
                          {r.firstBad
                            ? r.firstBad.check.schema
                              ? r.firstBad.check.checks.filter((c) => !c.ok).map((c) => `${c.field} ${c.message}`).join("; ")
                              : r.firstBad.check.reason
                            : ""}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className={styles.note}>{running ? "Checking messages as they arrive..." : "No messages came back."}</p>
            )}
            {entries.some((e) => e.check.extra.length) ? (
              <p className={styles.note}>
                Fields Meta sent that the schemas don&apos;t list: {[...new Set(entries.flatMap((e) => e.check.extra))].join(", ")}.
              </p>
            ) : null}
          </div>
        </ResponseView>
      ) : null}
    </div>
  );
}
