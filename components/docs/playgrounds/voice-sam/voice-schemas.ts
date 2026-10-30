/**
 * The Voice API's schemas as data (api-reference/voice/schemas), for the schema explorer: every field with its type,
 * whether it's required, its default and the page's own description, plus a validator that says which schema a
 * message is and checks it field by field. Server events are told apart by `type`; the handshake acknowledgement is
 * the one frame without one. Unknown event types are reported as ignorable, as the Server Message schema asks.
 */

export type FieldKind = "string" | "integer" | "boolean" | "string[]" | "enum" | "ref" | "ref[]";

export interface SchemaField {
  name: string;
  /** The type as the page writes it, such as "enum ('PCM_24KHZ', 'PCM_16KHZ')" or "array of Turn". */
  type: string;
  kind: FieldKind;
  required: boolean;
  description: string;
  values?: readonly string[];
  default?: string;
  /** The schema id a ref field holds. */
  ref?: string;
}

export type SchemaGroup = "request" | "response" | "event";

export interface VoiceSchema {
  id: string;
  title: string;
  /** The heading's anchor on api-reference/voice/schemas. */
  anchor: string;
  group: SchemaGroup;
  description: string;
  fields: readonly SchemaField[];
  /** Event schemas: the `type` value that names them. */
  eventType?: string;
  /** Where the schema is used. */
  usedIn: string;
  /** A real or documented example. */
  example?: unknown;
  /** ServerMessage only: the schemas it is one of. */
  oneOf?: readonly string[];
}

const MODES = ["PUSH_TO_TALK", "ENDPOINTING", "DIARIZATION"] as const;
const PARTIALS = ["CUMULATIVE", "DELTA"] as const;

const audioProcessed = (what: string): SchemaField => ({
  name: "audioProcessedMs",
  type: "integer (int64)",
  kind: "integer",
  required: true,
  description: `Audio processed when the model emitted this ${what}, in milliseconds from the start of the stream. Not a precise acoustic boundary.`,
});

const typeField = (value: string): SchemaField => ({
  name: "type",
  type: `enum ('${value}')`,
  kind: "enum",
  values: [value],
  required: true,
  description: `Event discriminator; always ${value} for this event.`,
});

export const VOICE_SCHEMAS: readonly VoiceSchema[] = [
  {
    id: "TranscribeRequest",
    title: "Transcribe Request",
    anchor: "transcribe-request",
    group: "request",
    description: "The request part of the multipart body, sent as JSON.",
    usedIn: "POST /v1/asr/transcribe, the request part",
    example: { model: "muse-voice-transcribe-1.0", audioEncoding: "WAV", mode: "DIARIZATION" },
    fields: [
      { name: "model", type: "string", kind: "string", required: true, description: "Public model id. The model must support the requested mode." },
      {
        name: "audioEncoding",
        type: "enum ('WAV')",
        kind: "enum",
        values: ["WAV"],
        required: true,
        description:
          "Container of the uploaded audio part, sent as the enum name. WAV is a RIFF/WAVE container holding mono integer PCM at 16 kHz or 24 kHz. There is no default; an unset or unrecognized value is rejected.",
      },
      {
        name: "mode",
        type: "enum ('PUSH_TO_TALK', 'ENDPOINTING', 'DIARIZATION')",
        kind: "enum",
        values: MODES,
        required: false,
        default: "PUSH_TO_TALK",
        description:
          "Transcription behavior. PUSH_TO_TALK is single-turn and the uploaded clip is the turn. ENDPOINTING detects speech onset and endpoint, one turn per detected segment. DIARIZATION additionally attributes turns to speakers.",
      },
      {
        name: "keywords",
        type: "array of string",
        kind: "string[]",
        required: false,
        description: "Terms to bias recognition toward, such as names, jargon, and product words. Biasing does not guarantee an exact spelling.",
      },
      {
        name: "languageBias",
        type: "array of string",
        kind: "string[]",
        required: false,
        description: 'Languages to bias transcription toward, each as a language name, e.g. ["English", "French"]. Omit it to let the model detect the language.',
      },
      {
        name: "partialMode",
        type: "enum ('CUMULATIVE', 'DELTA')",
        kind: "enum",
        values: PARTIALS,
        required: false,
        default: "CUMULATIVE",
        description: "Representation of partial transcript text. Applies to text/event-stream responses only. CUMULATIVE replaces the previous partial; DELTA sends only newly emitted text.",
      },
      {
        name: "emitAudioProgress",
        type: "boolean",
        kind: "boolean",
        required: false,
        default: "true",
        description: "Whether to emit audioProgress events. Applies to text/event-stream responses only; the buffered responses never surface them.",
      },
    ],
  },
  {
    id: "RealtimeHandshakeRequest",
    title: "Realtime Handshake Request",
    anchor: "realtime-handshake-request",
    group: "request",
    description:
      "The first JSON text frame the client sends to open a realtime session, within 10 seconds of the socket opening. Configuration is fixed once the handshake is accepted.",
    usedIn: "wss://api.meta.ai/v1/asr/realtime, the first text frame",
    example: {
      authorization: { accessToken: "Bearer $MODEL_API_KEY" },
      audioEncoding: "PCM_24KHZ",
      model: "muse-voice-transcribe-1.0",
      mode: "PUSH_TO_TALK",
      partialMode: "CUMULATIVE",
      emitAudioProgress: false,
    },
    fields: [
      { name: "authorization", type: "Authorization", kind: "ref", ref: "Authorization", required: true, description: "The credential: Bearer and your Model API key." },
      {
        name: "audioEncoding",
        type: "enum ('PCM_24KHZ', 'PCM_16KHZ')",
        kind: "enum",
        values: ["PCM_24KHZ", "PCM_16KHZ"],
        required: true,
        description:
          "Encoding of the streamed binary frames. Both are signed 16-bit little-endian mono. PCM_24KHZ is 48,000 bytes per second and the model's native rate; PCM_16KHZ is 32,000 bytes per second, resampled server-side. There is no default.",
      },
      { name: "model", type: "string", kind: "string", required: true, description: "Public model id. The model must support the requested mode." },
      {
        name: "mode",
        type: "enum ('PUSH_TO_TALK', 'ENDPOINTING', 'DIARIZATION')",
        kind: "enum",
        values: MODES,
        required: false,
        default: "PUSH_TO_TALK",
        description: "Transcription behavior. PUSH_TO_TALK is single-turn and the client delimits the turn by ending the stream.",
      },
      {
        name: "partialMode",
        type: "enum ('CUMULATIVE', 'DELTA')",
        kind: "enum",
        values: PARTIALS,
        required: false,
        default: "CUMULATIVE",
        description: "CUMULATIVE sends the complete current hypothesis each time; DELTA sends only newly emitted text, and is not compatible with every model or mode.",
      },
      { name: "emitAudioProgress", type: "boolean", kind: "boolean", required: false, default: "true", description: "Whether the server emits audioProgress events." },
      { name: "keywords", type: "array of string", kind: "string[]", required: false, description: "Terms to bias recognition toward. Biasing does not guarantee an exact spelling." },
      { name: "languageBias", type: "array of string", kind: "string[]", required: false, description: "Languages to bias transcription toward, each as a language name." },
    ],
  },
  {
    id: "Authorization",
    title: "Authorization",
    anchor: "authorization",
    group: "request",
    description: "Credential authorizing the session. Consumed only by the server's authentication step and never forwarded to the model.",
    usedIn: "RealtimeHandshakeRequest.authorization",
    example: { accessToken: "Bearer $MODEL_API_KEY" },
    fields: [
      { name: "accessToken", type: "string", kind: "string", required: true, description: "Bearer followed by your Model API key. The prefix is part of the value." },
    ],
  },
  {
    id: "TranscribeResponse",
    title: "Transcribe Response",
    anchor: "transcribe-response",
    group: "response",
    description: "The buffered application/json response.",
    usedIn: "POST /v1/asr/transcribe with Accept: application/json (or none)",
    fields: [
      { name: "sessionId", type: "string", kind: "string", required: true, description: "The sessionId query parameter, or the id the server generated when it was absent." },
      { name: "transcript", type: "string", kind: "string", required: true, description: "Final transcript for the whole clip. Populated in every mode; in the multi-turn modes it is the turn transcripts joined in turn order." },
      { name: "audioDurationMs", type: "integer (int64)", kind: "integer", required: true, description: "Total audio duration processed, in milliseconds." },
      {
        name: "turns",
        type: "array of Turn",
        kind: "ref[]",
        ref: "Turn",
        required: true,
        description: "Every turn the model reported, in ascending turnId order. Empty in PUSH_TO_TALK. A turn the clip ended part-way through carries an empty transcript.",
      },
    ],
  },
  {
    id: "Turn",
    title: "Turn",
    anchor: "turn",
    group: "response",
    description: "One speech turn the model detected, reported in the buffered transcribe response. Populated in ENDPOINTING and DIARIZATION only.",
    usedIn: "TranscribeResponse.turns",
    example: { turnId: 1, startMs: 1520, endMs: 4640, transcript: "How is the weather?", speaker: "A" },
    fields: [
      { name: "turnId", type: "integer (int32)", kind: "integer", required: true, description: "Id for this turn. Turns are reported in ascending id order; numbering is not otherwise meaningful." },
      { name: "startMs", type: "integer (int64)", kind: "integer", required: true, description: "Audio processed when the model detected the turn's speech onset. Not a precise acoustic boundary." },
      { name: "endMs", type: "integer (int64)", kind: "integer", required: true, description: "Audio processed when the model detected the turn's speech end. Not a precise acoustic boundary." },
      { name: "transcript", type: "string", kind: "string", required: true, description: "Finalized transcript for this turn, including any post processing." },
      { name: "speaker", type: "string", kind: "string", required: false, description: "Model-generated speaker label, such as A. Present in DIARIZATION only." },
    ],
  },
  {
    id: "RealtimeHandshakeResponse",
    title: "Realtime Handshake Response",
    anchor: "realtime-handshake-response",
    group: "response",
    description: "Server reply to a successful handshake, sent before any transcript frames. This is the only server frame with no type field.",
    usedIn: "wss://api.meta.ai/v1/asr/realtime, the first server frame",
    example: { sessionId: "550e8400-e29b-41d4-a716-446655440000" },
    fields: [{ name: "sessionId", type: "string", kind: "string", required: true, description: "Session id for end-to-end log correlation." }],
  },
  {
    id: "ServerMessage",
    title: "Server Message",
    anchor: "server-message",
    group: "event",
    description:
      "Envelope for every server event after the handshake. The type field names the event and its payload is merged alongside it. Dispatch on type and ignore unknown values.",
    usedIn: "Every realtime frame after the acknowledgement, and every text/event-stream event",
    oneOf: ["TranscriptEvent", "SpeechStartEvent", "SpeechEndEvent", "SpeechCompleteEvent", "SpeakerEvent", "AudioProgressEvent", "ErrorEvent"],
    fields: [],
  },
  {
    id: "TranscriptEvent",
    title: "Transcript Event",
    anchor: "transcript-event",
    group: "event",
    eventType: "transcript",
    description: "One streamed transcript update.",
    usedIn: "ServerMessage",
    example: { type: "transcript", transcript: "how is the weather", final: false, audioProcessedMs: 3200 },
    fields: [
      typeField("transcript"),
      { name: "transcript", type: "string", kind: "string", required: true, description: "Transcript text for this segment. Under CUMULATIVE it replaces the previous partial; under DELTA it is appended." },
      {
        name: "final",
        type: "boolean",
        kind: "boolean",
        required: true,
        description: "Transcript stability as reported by the model. In PUSH_TO_TALK, true marks stream completion. In ENDPOINTING and DIARIZATION, use speechComplete for turn completion instead.",
      },
      { name: "audioProcessedMs", type: "integer (int64)", kind: "integer", required: true, description: "Total audio processed so far, in milliseconds." },
    ],
  },
  {
    id: "SpeechStartEvent",
    title: "Speech Start Event",
    anchor: "speech-start-event",
    group: "event",
    eventType: "speechStart",
    description: "The model detected the beginning of speech.",
    usedIn: "ServerMessage",
    example: { type: "speechStart", turnId: 1, audioProcessedMs: 1200 },
    fields: [
      typeField("speechStart"),
      audioProcessed("event"),
      {
        name: "turnId",
        type: "integer (int32)",
        kind: "integer",
        required: true,
        description: "Id for this speech turn. A later turn can open before an earlier turn's speechComplete arrives, so keep state keyed by turnId.",
      },
    ],
  },
  {
    id: "SpeechEndEvent",
    title: "Speech End Event",
    anchor: "speech-end-event",
    group: "event",
    eventType: "speechEnd",
    description: "The model detected the end of speech. A boundary event, not the final transcript: use speechComplete for the turn's text.",
    usedIn: "ServerMessage",
    example: { type: "speechEnd", turnId: 1, audioProcessedMs: 3600 },
    fields: [typeField("speechEnd"), audioProcessed("event"), { name: "turnId", type: "integer (int32)", kind: "integer", required: true, description: "Id for this speech turn." }],
  },
  {
    id: "SpeechCompleteEvent",
    title: "Speech Complete Event",
    anchor: "speech-complete-event",
    group: "event",
    eventType: "speechComplete",
    description: "The completed transcript for one speech turn, including any post processing.",
    usedIn: "ServerMessage",
    example: { type: "speechComplete", turnId: 1, transcript: "How is the weather?", audioProcessedMs: 3600 },
    fields: [
      typeField("speechComplete"),
      audioProcessed("event"),
      { name: "turnId", type: "integer (int32)", kind: "integer", required: true, description: "Id for this speech turn. Correlate lifecycle events by equality within the session." },
      { name: "transcript", type: "string", kind: "string", required: true, description: "Transcript for the entire turn. It can differ from the last partial, because the model may post-process the turn." },
    ],
  },
  {
    id: "SpeakerEvent",
    title: "Speaker Event",
    anchor: "speaker-event",
    group: "event",
    eventType: "speaker",
    description:
      "Labels the transcript span immediately before it, from the previous speechStart or speaker event, whichever came later. Emitted in DIARIZATION. Not a speech boundary, a speaker change, or a final transcript, and the same label can repeat.",
    usedIn: "ServerMessage",
    example: { type: "speaker", label: "A", audioProcessedMs: 2480 },
    fields: [
      typeField("speaker"),
      { name: "label", type: "string", kind: "string", required: true, description: "Model-generated speaker label, such as A. Meaningful only within one session, and not a verified identity." },
      audioProcessed("label"),
    ],
  },
  {
    id: "AudioProgressEvent",
    title: "Audio Progress Event",
    anchor: "audio-progress-event",
    group: "event",
    eventType: "audioProgress",
    description: "One update on the independent audio-progress channel, multiplexed onto the same ordered stream. Not part of any speech turn.",
    usedIn: "ServerMessage",
    example: { type: "audioProgress", audioProcessedMs: 80 },
    fields: [
      typeField("audioProgress"),
      { name: "audioProcessedMs", type: "integer (int64)", kind: "integer", required: true, description: "Total audio processed so far, in milliseconds from the start of the stream." },
    ],
  },
  {
    id: "ErrorEvent",
    title: "Error Event",
    anchor: "error-event",
    group: "event",
    eventType: "error",
    description: "Fatal error the server sends just before it closes the session. The message is client-safe; internal detail is logged server-side only.",
    usedIn: "ServerMessage",
    example: { type: "error", message: "human-readable message", sessionId: "<id>" },
    fields: [
      typeField("error"),
      { name: "message", type: "string", kind: "string", required: true, description: "Human-readable, client-safe error message." },
      { name: "sessionId", type: "string", kind: "string", required: true, description: "Session id for log correlation. Empty if one has not been assigned yet." },
      { name: "errorType", type: "string", kind: "string", required: false, description: "Model API error taxonomy for this failure." },
      { name: "errorCode", type: "string", kind: "string", required: false, description: "Machine-readable error code, when the failure has one." },
      { name: "errorParam", type: "string", kind: "string", required: false, description: "Request field the error relates to, when applicable." },
    ],
  },
];

const BY_ID = new Map(VOICE_SCHEMAS.map((s) => [s.id, s]));
const BY_EVENT = new Map(VOICE_SCHEMAS.filter((s) => s.eventType).map((s) => [s.eventType as string, s]));

export function voiceSchema(id: string): VoiceSchema | null {
  return BY_ID.get(id) ?? null;
}

/** Schemas whose name, title, description or a field matches the query. Empty query: all. */
export function searchSchemas(query: string): VoiceSchema[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...VOICE_SCHEMAS];
  return VOICE_SCHEMAS.filter(
    (s) =>
      s.id.toLowerCase().includes(q) ||
      s.title.toLowerCase().includes(q) ||
      s.description.toLowerCase().includes(q) ||
      s.fields.some((f) => f.name.toLowerCase().includes(q) || f.description.toLowerCase().includes(q)) ||
      (s.eventType ?? "").toLowerCase().includes(q),
  );
}

type Json = Record<string, unknown>;

const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * Which schema a message is. Events by `type`; the handshake acknowledgement is an object with sessionId alone;
 * requests and responses by the fields only they have. Null when nothing fits.
 */
export function identifyVoiceMessage(value: unknown): { schema: VoiceSchema | null; reason: string } {
  if (!isObj(value)) return { schema: null, reason: "Not a JSON object." };
  if (typeof value.type === "string") {
    const s = BY_EVENT.get(value.type);
    return s
      ? { schema: s, reason: `type is "${value.type}".` }
      : { schema: null, reason: `type "${value.type}" isn't one the page lists. Clients should ignore unknown event types.` };
  }
  const keys = Object.keys(value);
  if ("authorization" in value || ("audioEncoding" in value && String(value.audioEncoding).startsWith("PCM"))) {
    return { schema: BY_ID.get("RealtimeHandshakeRequest")!, reason: "It has authorization or a PCM audioEncoding." };
  }
  if ("accessToken" in value) return { schema: BY_ID.get("Authorization")!, reason: "It has accessToken." };
  if ("audioDurationMs" in value || "turns" in value) return { schema: BY_ID.get("TranscribeResponse")!, reason: "It has audioDurationMs or turns." };
  if ("audioEncoding" in value || ("model" in value && !("type" in value))) {
    return { schema: BY_ID.get("TranscribeRequest")!, reason: "It has audioEncoding or model." };
  }
  if ("turnId" in value && ("startMs" in value || "endMs" in value)) return { schema: BY_ID.get("Turn")!, reason: "It has turnId with startMs or endMs." };
  if (keys.length === 1 && keys[0] === "sessionId") {
    return { schema: BY_ID.get("RealtimeHandshakeResponse")!, reason: "Only sessionId and no type: the handshake acknowledgement." };
  }
  return { schema: null, reason: "No type field, and its fields don't match a request or response schema." };
}

export interface FieldCheck {
  field: string;
  ok: boolean;
  message: string;
}

export interface VoiceCheck {
  schema: VoiceSchema | null;
  reason: string;
  ok: boolean;
  checks: FieldCheck[];
  /** Fields the schema doesn't list. */
  extra: string[];
}

function checkField(f: SchemaField, v: unknown, path: string, out: FieldCheck[]): void {
  const fail = (message: string): void => void out.push({ field: path, ok: false, message });
  const pass = (message: string): void => void out.push({ field: path, ok: true, message });
  switch (f.kind) {
    case "string":
      return typeof v === "string" ? pass("string") : fail(`should be a string, got ${describe(v)}`);
    case "integer":
      return Number.isInteger(v) ? pass("integer") : fail(`should be an integer, got ${describe(v)}`);
    case "boolean":
      return typeof v === "boolean" ? pass("boolean") : fail(`should be true or false, got ${describe(v)}`);
    case "string[]":
      return Array.isArray(v) && v.every((x) => typeof x === "string") ? pass(`${(v as unknown[]).length} strings`) : fail(`should be an array of strings, got ${describe(v)}`);
    case "enum":
      return typeof v === "string" && f.values?.includes(v) ? pass(`"${v}"`) : fail(`should be one of ${(f.values ?? []).join(", ")}, got ${describe(v)}`);
    case "ref": {
      const s = f.ref ? BY_ID.get(f.ref) : null;
      if (!s || !isObj(v)) return fail(`should be ${f.ref ?? "an object"}, got ${describe(v)}`);
      const inner = validateAgainst(s, v, `${path}.`);
      out.push(...inner.checks);
      return;
    }
    case "ref[]": {
      const s = f.ref ? BY_ID.get(f.ref) : null;
      if (!s || !Array.isArray(v)) return fail(`should be an array of ${f.ref ?? "objects"}, got ${describe(v)}`);
      pass(`${v.length} item${v.length === 1 ? "" : "s"}`);
      v.forEach((item, i) => {
        if (!isObj(item)) return fail(`${path}[${i}] should be an object`);
        out.push(...validateAgainst(s, item, `${path}[${i}].`).checks);
      });
      return;
    }
  }
}

function describe(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "an array";
  if (typeof v === "string") return `"${v.length > 40 ? `${v.slice(0, 40)}...` : v}"`;
  return typeof v === "object" ? "an object" : `${typeof v} ${String(v)}`;
}

/** Checks a value against one schema: required fields, types, enum values; fields it doesn't list are noted. */
export function validateAgainst(schema: VoiceSchema, value: Json, prefix = ""): VoiceCheck {
  const checks: FieldCheck[] = [];
  for (const f of schema.fields) {
    const path = `${prefix}${f.name}`;
    if (!(f.name in value) || value[f.name] === undefined) {
      checks.push(f.required ? { field: path, ok: false, message: "is required and missing" } : { field: path, ok: true, message: `absent (optional${f.default ? `, defaults to ${f.default}` : ""})` });
      continue;
    }
    checkField(f, value[f.name], path, checks);
  }
  const known = new Set(schema.fields.map((f) => f.name));
  const extra = Object.keys(value).filter((k) => !known.has(k)).map((k) => `${prefix}${k}`);
  return { schema, reason: "", ok: checks.every((c) => c.ok), checks, extra };
}

/** Identifies a message and checks it. */
export function checkVoiceMessage(value: unknown): VoiceCheck {
  const { schema, reason } = identifyVoiceMessage(value);
  if (!schema || !isObj(value)) return { schema, reason, ok: false, checks: [], extra: [] };
  return { ...validateAgainst(schema, value), reason };
}

/**
 * Reads what a reader pastes: one JSON value, a JSON array, one JSON object per line, or server-sent events (the
 * data lines). Returns each value with its line, or the line's parse error.
 */
export function readMessages(text: string): Array<{ line: number; value?: unknown; error?: string; raw: string }> {
  const trimmed = text.trim();
  if (!trimmed) return [];
  try {
    const whole = JSON.parse(trimmed) as unknown;
    if (Array.isArray(whole)) return whole.map((value, i) => ({ line: i + 1, value, raw: JSON.stringify(value) }));
    return [{ line: 1, value: whole, raw: trimmed }];
  } catch {
    // One per line, below.
  }
  const out: Array<{ line: number; value?: unknown; error?: string; raw: string }> = [];
  text.split(/\r?\n/).forEach((rawLine, i) => {
    let line = rawLine.trim();
    if (!line || line.startsWith("event:") || line.startsWith(":")) return;
    if (line.startsWith("data:")) line = line.slice(5).trim();
    try {
      out.push({ line: i + 1, value: JSON.parse(line) as unknown, raw: line });
    } catch (err) {
      out.push({ line: i + 1, error: err instanceof Error ? err.message : "Not JSON.", raw: line });
    }
  });
  return out;
}
