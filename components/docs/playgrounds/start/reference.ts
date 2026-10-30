import type { FileSlot, FormSpec } from "@/lib/docs/client/form";
import { DEFAULT_TEXT_MODEL } from "@/lib/docs/client/models";
import { answeredByMeta, errorParts } from "@/components/docs/playgrounds/start/error-cases";
import { modelCard, type ModelCard } from "@/components/docs/playgrounds/start/facts";

/**
 * What the API reference pages in the "start" group document, as data: the Models objects (api-reference/models/*),
 * the status reply (api-reference/status), and every endpoint the reference covers with a request that works through
 * the docs proxy (api-reference). Readers for the live replies sit next to them, so the demos and their tests share
 * one idea of each shape.
 */

type Json = Record<string, unknown>;

function obj(v: unknown): Json | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null;
}

// ---------------------------------------------------------------------------------------------------------------
// Models

export interface ModelObject {
  id: string;
  object: string;
  created: number | null;
  owned_by: string;
  metadata?: unknown;
}

/** The Model objects in a list reply, in the order the API sent them. */
export function modelsOf(reply: unknown): ModelObject[] {
  const data = obj(reply)?.data;
  if (!Array.isArray(data)) return [];
  return data.map(modelOf).filter((m): m is ModelObject => !!m);
}

export function modelOf(value: unknown): ModelObject | null {
  const m = obj(value);
  if (!m || typeof m.id !== "string") return null;
  return {
    id: m.id,
    object: typeof m.object === "string" ? m.object : "",
    created: typeof m.created === "number" ? m.created : null,
    owned_by: typeof m.owned_by === "string" ? m.owned_by : "",
    ...(m.metadata !== undefined ? { metadata: m.metadata } : {}),
  };
}

/** `created` as a reader would want it: a UTC date, or what the API sent when it isn't a real timestamp. */
export function createdLabel(created: number | null): string {
  if (created === null) return "not sent";
  if (created <= 0) return `${created} (no date)`;
  return new Date(created * 1000).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
}

/** True when the list is in the order the models page gives: newest first by created, the id breaking ties. */
export function inDocumentedOrder(models: readonly ModelObject[]): boolean {
  // The page doesn't say which way the id breaks ties, so either direction counts, as long as it's the same throughout.
  const sorted = (dir: 1 | -1) =>
    models.every((m, i) => {
      if (i === 0) return true;
      const prev = models[i - 1];
      const a = prev.created ?? 0;
      const b = m.created ?? 0;
      return a > b || (a === b && dir * prev.id.localeCompare(m.id) <= 0);
    });
  return sorted(1) || sorted(-1);
}

/** True when no model has a real creation date: created is 0, negative or missing on every one. */
export function allUndated(models: readonly ModelObject[]): boolean {
  return models.length > 0 && models.every((m) => m.created === null || m.created <= 0);
}

/**
 * What a list's order tells a reader, set against the models page's claim (newest first by created, the id breaking
 * ties). Live replies have reported created 0 on every model, in an order that is neither by date nor by id, so code
 * shouldn't read data[0] as the newest model. Null for a list too short to have an order.
 */
export function listOrderNote(models: readonly ModelObject[]): string | null {
  if (models.length < 2) return null;
  const claim = "The models page says the list comes newest first by created, the id breaking ties.";
  const ordered = inDocumentedOrder(models);
  if (allUndated(models)) {
    return ordered
      ? `${claim} No model in this reply has a real created date (they all say 0), so only the id orders them: don't rely on created.`
      : `${claim} No model in this reply has a real created date (they all say 0), and the order isn't by id either, so it carries no meaning: don't rely on created or on the order, and don't read data[0] as the newest model.`;
  }
  return ordered
    ? "Newest first by created, the id breaking ties, as the models page says."
    : `${claim} This reply isn't in that order: sort by created yourself when you need the newest.`;
}

/**
 * True for Meta's own 404 for a model id that doesn't exist (a request id, code model_not_found): the reply the
 * retrieve demo's made-up id is there to show, rather than a docs limit to explain away.
 */
export function isMetaModelNotFound(status: number, headers: Record<string, string>, json: unknown): boolean {
  return status === 404 && answeredByMeta(headers) && errorParts(status, json, "").code === "model_not_found";
}

export interface CatalogRow {
  model: ModelObject;
  card: ModelCard | null;
}

/** The live list with each model's card from the models page; ids the page doesn't describe get no card. */
export function catalogRows(reply: unknown): CatalogRow[] {
  return modelsOf(reply).map((model) => ({ model, card: modelCard(model.id) }));
}

// ---------------------------------------------------------------------------------------------------------------
// Schemas (api-reference/models/schemas)

export interface SchemaField {
  name: string;
  /** The type as the page writes it: "string", "enum ('list')", "array of Model". */
  type: string;
  required: boolean;
  description: string;
  /** The JSON type a value must have. */
  kind: "string" | "integer" | "object" | "array";
  /** For enums: the allowed values. */
  values?: string[];
  /** For "array of Model": the schema of the items. */
  items?: string;
}

export interface SchemaDef {
  /** The anchor on the schemas page. */
  id: string;
  name: string;
  description: string;
  fields: SchemaField[];
}

export const MODELS_SCHEMAS: readonly SchemaDef[] = [
  {
    id: "list-models-response",
    name: "List Models Response",
    description: "Response containing the list of available models.",
    fields: [
      { name: "object", type: "enum ('list')", required: true, kind: "string", values: ["list"], description: "Object type; always `list`. (default: list)" },
      { name: "data", type: "array of Model", required: true, kind: "array", items: "model", description: "List of model objects." },
    ],
  },
  {
    id: "model",
    name: "Model",
    description: "Describes a model available for use with the API.",
    fields: [
      { name: "id", type: "string", required: true, kind: "string", description: "Identifier for the model." },
      { name: "object", type: "enum ('model')", required: true, kind: "string", values: ["model"], description: "Object type; always `model`. (default: model)" },
      { name: "created", type: "integer", required: true, kind: "integer", description: "Unix timestamp (seconds) at which the model was created." },
      { name: "owned_by", type: "string", required: true, kind: "string", description: "Owner of the model." },
      {
        name: "metadata",
        type: "object",
        required: false,
        kind: "object",
        description: "Client-specific metadata, present only when the request supplies a recognized `client` query parameter. Keyed by client type.",
      },
    ],
  },
];

export function schemaDef(id: string): SchemaDef | null {
  return MODELS_SCHEMAS.find((s) => s.id === id) ?? null;
}

export interface FieldResult {
  /** "data[2].created" */
  path: string;
  field: SchemaField;
  ok: boolean;
  /** "present, integer", "optional, not sent", "missing", "expected integer, got string". */
  note: string;
}

function kindOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
}

/**
 * Checks a live object against one of the page's schemas, field by field: present when required, the right JSON
 * type, an allowed enum value. Arrays of Model check every item. Pure, for the explorer's pass and fail list.
 */
export function checkSchema(schemaId: string, value: unknown, prefix = ""): FieldResult[] {
  const schema = schemaDef(schemaId);
  const v = obj(value);
  if (!schema) return [];
  const out: FieldResult[] = [];
  for (const field of schema.fields) {
    const path = prefix ? `${prefix}.${field.name}` : field.name;
    const has = !!v && Object.prototype.hasOwnProperty.call(v, field.name);
    if (!has) {
      out.push({ path, field, ok: !field.required, note: field.required ? "missing" : "optional, not sent" });
      continue;
    }
    const x = (v as Json)[field.name];
    const kind = kindOf(x);
    if (kind !== field.kind) {
      out.push({ path, field, ok: false, note: `expected ${field.kind}, got ${kind}` });
      continue;
    }
    if (field.values && !field.values.includes(String(x))) {
      out.push({ path, field, ok: false, note: `expected ${field.values.map((s) => `"${s}"`).join(" or ")}, got "${String(x)}"` });
      continue;
    }
    out.push({ path, field, ok: true, note: field.values ? `"${String(x)}"` : kind === "array" ? `${(x as unknown[]).length} items` : kind });
    if (field.items && Array.isArray(x)) {
      x.forEach((item, i) => out.push(...checkSchema(field.items!, item, `${path}[${i}]`)));
    }
  }
  return out;
}

/** The fields of every schema that match a search, by name, type or description. */
export function searchSchemas(query: string): Array<{ schema: SchemaDef; fields: SchemaField[] }> {
  const q = query.trim().toLowerCase();
  return MODELS_SCHEMAS.map((schema) => ({
    schema,
    fields: q
      ? schema.fields.filter((f) => `${f.name} ${f.type} ${f.description}`.toLowerCase().includes(q) || schema.name.toLowerCase().includes(q))
      : schema.fields,
  })).filter((s) => s.fields.length);
}

// ---------------------------------------------------------------------------------------------------------------
// Status (api-reference/status)

export type StatusTone = "ok" | "warn" | "bad" | "unknown";

export interface StatusReport {
  alive: boolean | null;
  status: string;
  message: string;
  updatedAt: string;
  tone: StatusTone;
  /** One line per model the reply reports on. */
  models: Array<{ model: string; status: string; tone: StatusTone }>;
}

/** Bad words first: "unavailable" holds "available", and "partial outage" is a warning, not an outage. */
function toneOf(status: string, alive: boolean | null = true): StatusTone {
  const s = status.toLowerCase();
  if (alive === false) return "bad";
  if (!s) return "unknown";
  if (/degraded|partial|maintenance|limited|slow|elevated/.test(s)) return "warn";
  if (/down|outage|unavailable|major|offline|unhealthy|fail/.test(s)) return "bad";
  if (/operational|healthy|available|^ok$|^up$|normal/.test(s)) return "ok";
  return "unknown";
}

/** The status reply ({ is_alive, service_status, service_message, updated_at, model_statuses }) as a report. */
export function statusReport(reply: unknown): StatusReport | null {
  const r = obj(reply);
  if (!r) return null;
  const alive = typeof r.is_alive === "boolean" ? r.is_alive : null;
  const status = typeof r.service_status === "string" ? r.service_status : "";
  const models = (Array.isArray(r.model_statuses) ? r.model_statuses : [])
    .map((m) => {
      const o = obj(m);
      if (!o) return null;
      const model = [o.model, o.id, o.name].find((x) => typeof x === "string") as string | undefined;
      const st = [o.status, o.service_status, o.state].find((x) => typeof x === "string") as string | undefined;
      return model ? { model, status: st ?? "", tone: toneOf(st ?? "") } : null;
    })
    .filter((m): m is { model: string; status: string; tone: StatusTone } => !!m);
  return {
    alive,
    status,
    message: typeof r.service_message === "string" ? r.service_message : "",
    updatedAt: typeof r.updated_at === "string" ? r.updated_at : "",
    tone: toneOf(status, alive),
    models,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The endpoint explorer (api-reference)

export interface EndpointExample {
  id: string;
  resource: string;
  method: "GET" | "POST" | "DELETE";
  /** The path as the reference writes it: "/v1/responses/{response_id}". */
  route: string;
  /** What ApiConsole opens with (Meta's path after /v1/, with an example id where the route has one). */
  path: string;
  summary: string;
  /** The reference page. */
  slug: string;
  body?: unknown;
  form?: FormSpec[];
  fileSlots?: FileSlot[];
  /** "Free", "Under a cent", "$0.01 an image". */
  cost: string;
  /** Said under the console: what to do first, or why it can't run here. */
  note?: string;
  /** False for the realtime WebSocket, which ApiConsole can't open. */
  runnable: boolean;
}

const M = DEFAULT_TEXT_MODEL;

/** Every endpoint the API reference covers, in its order: the six resources on the index page, then Images and Voice. */
export const ENDPOINTS: readonly EndpointExample[] = [
  {
    id: "responses.create",
    resource: "Responses",
    method: "POST",
    route: "/v1/responses",
    path: "responses",
    summary: "Create a response",
    slug: "api-reference/responses/create-response",
    body: { model: M, input: "What is the capital of France?" },
    cost: "Under a cent",
    runnable: true,
  },
  {
    id: "responses.retrieve",
    resource: "Responses",
    method: "GET",
    route: "/v1/responses/{response_id}",
    path: "responses/resp_abc123",
    summary: "Retrieve a response",
    slug: "api-reference/responses/retrieve-response",
    cost: "Free",
    note: "Create a response first: its id shows up above the body to use.",
    runnable: true,
  },
  {
    id: "responses.delete",
    resource: "Responses",
    method: "DELETE",
    route: "/v1/responses/{response_id}",
    path: "responses/resp_abc123",
    summary: "Delete a response",
    slug: "api-reference/responses/delete-response",
    cost: "Free",
    note: "Create a response first, then delete it by id.",
    runnable: true,
  },
  {
    id: "responses.cancel",
    resource: "Responses",
    method: "POST",
    route: "/v1/responses/{response_id}/cancel",
    path: "responses/resp_abc123/cancel",
    summary: "Cancel a background response",
    slug: "api-reference/responses/cancel-response",
    cost: "Free",
    note: "Only a response created with background: true and still running can be cancelled.",
    runnable: true,
  },
  {
    id: "responses.input_tokens",
    resource: "Responses",
    method: "POST",
    route: "/v1/responses/input_tokens",
    path: "responses/input_tokens",
    summary: "Count input tokens",
    slug: "api-reference/responses/count-input-tokens",
    body: { model: M, input: "What is the capital of France?" },
    cost: "Free",
    runnable: true,
  },
  {
    id: "chat.create",
    resource: "Chat completions",
    method: "POST",
    route: "/v1/chat/completions",
    path: "chat/completions",
    summary: "Create a chat completion",
    slug: "api-reference/chat-completions/create-chat-completion",
    body: { model: M, messages: [{ role: "user", content: "What is the capital of France?" }] },
    cost: "Under a cent",
    runnable: true,
  },
  {
    id: "messages.create",
    resource: "Messages",
    method: "POST",
    route: "/v1/messages",
    path: "messages",
    summary: "Create a message",
    slug: "api-reference/messages/create-message",
    body: { model: M, max_tokens: 1024, messages: [{ role: "user", content: "What is the capital of France?" }] },
    cost: "Under a cent",
    runnable: true,
  },
  {
    id: "messages.count_tokens",
    resource: "Messages",
    method: "POST",
    route: "/v1/messages/count_tokens",
    path: "messages/count_tokens",
    summary: "Count tokens",
    slug: "api-reference/messages/count-tokens",
    body: { model: M, messages: [{ role: "user", content: "What is the capital of France?" }] },
    cost: "Free",
    runnable: true,
  },
  {
    id: "files.create",
    resource: "Files",
    method: "POST",
    route: "/v1/files",
    path: "files",
    summary: "Upload a file",
    slug: "api-reference/files/upload-file",
    form: [
      { name: "purpose", value: "user_data" },
      { name: "file", file: { label: "File", accept: "image/*,application/pdf,text/plain" } },
    ],
    cost: "Free",
    note: "Pick a sample or your own file (under 3 MB). Uploads from the docs expire after an hour.",
    runnable: true,
  },
  {
    id: "files.list",
    resource: "Files",
    method: "GET",
    route: "/v1/files",
    path: "files",
    summary: "List files",
    slug: "api-reference/files/list-files",
    cost: "Free",
    note: "The live docs list only the files uploaded from this browser.",
    runnable: true,
  },
  {
    id: "files.retrieve",
    resource: "Files",
    method: "GET",
    route: "/v1/files/{file_id}",
    path: "files/file-abc123",
    summary: "Retrieve a file",
    slug: "api-reference/files/retrieve-file",
    cost: "Free",
    note: "Upload a file first: its id shows up above to use.",
    runnable: true,
  },
  {
    id: "files.content",
    resource: "Files",
    method: "GET",
    route: "/v1/files/{file_id}/content",
    path: "files/file-abc123/content",
    summary: "Retrieve file content",
    slug: "api-reference/files/retrieve-file-content",
    cost: "Free",
    note: "Upload a file first, then download its bytes.",
    runnable: true,
  },
  {
    id: "files.delete",
    resource: "Files",
    method: "DELETE",
    route: "/v1/files/{file_id}",
    path: "files/file-abc123",
    summary: "Delete a file",
    slug: "api-reference/files/delete-file",
    cost: "Free",
    note: "Upload a file first, then delete it by id.",
    runnable: true,
  },
  {
    id: "models.list",
    resource: "Models",
    method: "GET",
    route: "/v1/models",
    path: "models",
    summary: "List models",
    slug: "api-reference/models/list-models",
    cost: "Free",
    runnable: true,
  },
  {
    id: "models.retrieve",
    resource: "Models",
    method: "GET",
    route: "/v1/models/{model}",
    path: `models/${M}`,
    summary: "Retrieve a model",
    slug: "api-reference/models/retrieve-model",
    cost: "Free",
    runnable: true,
  },
  {
    id: "status",
    resource: "Status",
    method: "GET",
    route: "/v1/status",
    path: "status",
    summary: "Get API status (no key needed)",
    slug: "api-reference/status",
    cost: "Free",
    runnable: true,
  },
  {
    id: "images.generations",
    resource: "Images",
    method: "POST",
    route: "/v1/images/generations",
    path: "images/generations",
    summary: "Create an image",
    slug: "api-reference/images/create-image",
    body: {
      model: "muse-image-1.0",
      prompt: "a watercolor painting of a red fox sitting in a snowy pine forest, soft golden morning light",
      n: 1,
    },
    cost: "$0.01 an image",
    runnable: true,
  },
  {
    id: "images.edits",
    resource: "Images",
    method: "POST",
    route: "/v1/images/edits",
    path: "images/edits",
    summary: "Edit an image",
    slug: "api-reference/images/edit-image",
    body: {
      model: "muse-image-1.0",
      prompt: "Make the sneaker bright orange with white laces. Keep the white background.",
      images: [{ image_url: "data:image/jpeg;base64,<BASE64>" }],
      n: 1,
    },
    fileSlots: [{ pointer: "/images/0/image_url", label: "Image to edit", accept: "image/*", as: "dataUrl" }],
    cost: "$0.01 an image",
    runnable: true,
  },
  {
    id: "asr.transcribe",
    resource: "Voice",
    method: "POST",
    route: "/v1/asr/transcribe",
    path: "asr/transcribe",
    summary: "Transcribe an audio file",
    slug: "api-reference/voice/transcribe",
    form: [
      { name: "request", value: JSON.stringify({ model: "muse-voice-transcribe-1.0", audioEncoding: "WAV", mode: "PUSH_TO_TALK" }) },
      { name: "audio", file: { label: "Audio (WAV)", accept: "audio/wav", as: "file" } },
    ],
    cost: "Under a cent a minute",
    note: "WAV only: pick one of the spoken samples.",
    runnable: true,
  },
  {
    id: "asr.realtime",
    resource: "Voice",
    method: "GET",
    route: "wss://api.meta.ai/v1/asr/realtime",
    path: "asr/realtime",
    summary: "Realtime transcription (WebSocket)",
    slug: "api-reference/voice/realtime",
    cost: "$0.18 an audio hour",
    note: "A WebSocket session, not an HTTP request, so this console can't open it. The realtime reference page's demo streams a sample to it.",
    runnable: false,
  },
];

export function endpointExample(id: string): EndpointExample | null {
  return ENDPOINTS.find((e) => e.id === id) ?? null;
}

/** The endpoints grouped by resource, in reference order. */
export function endpointsByResource(): Array<{ resource: string; endpoints: EndpointExample[] }> {
  const groups: Array<{ resource: string; endpoints: EndpointExample[] }> = [];
  for (const e of ENDPOINTS) {
    const g = groups.find((x) => x.resource === e.resource);
    if (g) g.endpoints.push(e);
    else groups.push({ resource: e.resource, endpoints: [e] });
  }
  return groups;
}
