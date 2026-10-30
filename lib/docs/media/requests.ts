/**
 * Request bodies for the media demos, built in one place so the request a demo sends, the code CodeView shows and the
 * request recorded for "Copy prompt" are the same object. Shapes follow the mirrored docs: image-understanding,
 * video-understanding, image-generation, file-handling, speech-to-text and sam/segmenting.
 */

export type JsonObject = Record<string, unknown>;

/** Where a picked file goes in a request: inline as a data URL, or as an id from POST /v1/files. */
export type MediaRef = { dataUrl: string } | { fileId: string } | { url: string };

function isObject(v: unknown): v is JsonObject {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Deep merge for extraBody: objects merge, everything else (arrays included) replaces. */
export function mergeBody(base: JsonObject, extra?: JsonObject | null): JsonObject {
  if (!extra) return base;
  const out: JsonObject = { ...base };
  for (const [k, v] of Object.entries(extra)) out[k] = isObject(v) && isObject(out[k]) ? mergeBody(out[k] as JsonObject, v) : v;
  return out;
}

export function imagePart(ref: MediaRef, detail?: "auto" | "low" | "high"): JsonObject {
  const part: JsonObject =
    "fileId" in ref ? { type: "input_image", file_id: ref.fileId } : { type: "input_image", image_url: "dataUrl" in ref ? ref.dataUrl : ref.url };
  if (detail) part.detail = detail;
  return part;
}

/**
 * A video part. An uploaded clip can be referenced as input_video or input_file by file_id; inline and hosted clips go
 * in input_video.video_url (video-understanding, Reference a video by URL).
 */
export function videoPart(ref: MediaRef, as: "input_video" | "input_file" = "input_video"): JsonObject {
  if ("fileId" in ref) return { type: as, file_id: ref.fileId };
  return { type: "input_video", video_url: "dataUrl" in ref ? ref.dataUrl : ref.url };
}

const userMessage = (content: JsonObject[]): JsonObject => ({ type: "message", role: "user", content });

export interface VisionRequest {
  model: string;
  question: string;
  images: MediaRef[];
  detail?: "auto" | "low" | "high";
  api?: "responses" | "chat";
  stream?: boolean;
  reasoningEffort?: "low" | "medium" | "high";
  maxOutputTokens?: number;
  extraBody?: JsonObject | null;
}

/** An image question on the Responses API (input_image parts) or Chat Completions (image_url parts). */
export function visionRequest(r: VisionRequest): { path: string; body: JsonObject } {
  if (r.api === "chat") {
    const content: JsonObject[] = [
      { type: "text", text: r.question },
      ...r.images.map((ref) => {
        const url = "fileId" in ref ? ref.fileId : "dataUrl" in ref ? ref.dataUrl : ref.url;
        return { type: "image_url", image_url: r.detail ? { url, detail: r.detail } : { url } };
      }),
    ];
    const body: JsonObject = { model: r.model, messages: [{ role: "user", content }] };
    if (r.stream) body.stream = true;
    if (r.maxOutputTokens) body.max_completion_tokens = r.maxOutputTokens;
    if (r.reasoningEffort) body.reasoning_effort = r.reasoningEffort;
    return { path: "chat/completions", body: mergeBody(body, r.extraBody) };
  }
  const body: JsonObject = {
    model: r.model,
    input: [userMessage([{ type: "input_text", text: r.question }, ...r.images.map((ref) => imagePart(ref, r.detail))])],
  };
  if (r.stream) body.stream = true;
  if (r.reasoningEffort) body.reasoning = { effort: r.reasoningEffort };
  if (r.maxOutputTokens) body.max_output_tokens = r.maxOutputTokens;
  return { path: "responses", body: mergeBody(body, r.extraBody) };
}

export interface VideoRequest {
  model: string;
  question: string;
  video: MediaRef;
  as?: "input_video" | "input_file";
  stream?: boolean;
  maxOutputTokens?: number;
  extraBody?: JsonObject | null;
}

export function videoRequest(r: VideoRequest): { path: string; body: JsonObject } {
  const body: JsonObject = {
    model: r.model,
    input: [userMessage([{ type: "input_text", text: r.question }, videoPart(r.video, r.as)])],
  };
  if (r.stream) body.stream = true;
  if (r.maxOutputTokens) body.max_output_tokens = r.maxOutputTokens;
  return { path: "responses", body: mergeBody(body, r.extraBody) };
}

/** Spoken audio as an input_audio part (video-understanding, Audio): bare base64 plus its format. */
export function audioQuestionRequest(r: {
  model: string;
  question: string;
  base64: string;
  format: "wav" | "mp3";
  maxOutputTokens?: number;
}): { path: string; body: JsonObject } {
  return {
    path: "responses",
    body: {
      model: r.model,
      max_output_tokens: r.maxOutputTokens ?? 4000,
      input: [
        userMessage([
          { type: "input_text", text: r.question },
          { type: "input_audio", input_audio: { data: r.base64, format: r.format } },
        ]),
      ],
    },
  };
}

export interface ImageToolSettings {
  size?: string;
  outputFormat?: "webp" | "png" | "jpeg";
  reasoningStrength?: "low" | "high";
  enableImageSearch?: boolean;
  enableWebSearch?: boolean;
  enableShell?: boolean;
}

function toolFields(s: ImageToolSettings): JsonObject {
  const t: JsonObject = {};
  if (s.enableImageSearch === false) t.enable_image_search = false;
  if (s.enableWebSearch === false) t.enable_web_search = false;
  if (s.enableShell === false) t.enable_shell = false;
  if (s.reasoningStrength) t.reasoning_strength = s.reasoningStrength;
  if (s.size && s.size !== "auto") t.size = s.size;
  if (s.outputFormat) t.output_format = s.outputFormat;
  return t;
}

/**
 * A Muse Image turn on the Responses API. With previousResponseId it edits the last image (the server keeps the
 * conversation, image-generation "Iterate across turns"). Reference images go in as input_image parts in order.
 */
export function imageTurnRequest(r: {
  prompt: string;
  previousResponseId?: string | null;
  references?: MediaRef[];
  settings?: ImageToolSettings;
}): { path: string; body: JsonObject } {
  const refs = r.references ?? [];
  const body: JsonObject = {
    model: "muse-image-1.0",
    input: refs.length
      ? [{ role: "user", content: [{ type: "input_text", text: r.prompt }, ...refs.map((ref) => imagePart(ref))] }]
      : r.prompt,
  };
  if (r.previousResponseId) body.previous_response_id = r.previousResponseId;
  const tool = toolFields(r.settings ?? {});
  if (Object.keys(tool).length) body.tools = [{ type: "image_generation", ...tool }];
  return { path: "responses", body };
}

function imagesEndpointFields(s: ImageToolSettings): JsonObject {
  const body: JsonObject = {};
  if (s.size && s.size !== "auto") body.size = s.size;
  if (s.outputFormat) body.output_format = s.outputFormat;
  if (s.reasoningStrength) body.reasoning_strength = s.reasoningStrength;
  const tools: JsonObject = {};
  if (s.enableImageSearch === false) tools.enable_image_search = false;
  if (s.enableWebSearch === false) tools.enable_web_search = false;
  if (s.enableShell === false) tools.enable_shell = false;
  if (Object.keys(tools).length) body.tool_enablement = tools;
  return body;
}

/** POST /v1/images/generations. The docs proxy allows n up to 2. */
export function imagesGenerationRequest(r: { prompt: string; n?: number; settings?: ImageToolSettings }) {
  return {
    path: "images/generations",
    body: { model: "muse-image-1.0", prompt: r.prompt, n: clampN(r.n), ...imagesEndpointFields(r.settings ?? {}) } as JsonObject,
  };
}

/** POST /v1/images/edits with Meta's JSON body: an images array of image_url (data URL or https) or file_id items. */
export function imagesEditJsonRequest(r: { prompt: string; images: MediaRef[]; n?: number; settings?: ImageToolSettings }) {
  return {
    path: "images/edits",
    body: {
      model: "muse-image-1.0",
      prompt: r.prompt,
      images: r.images.map((ref) => ("fileId" in ref ? { file_id: ref.fileId } : { image_url: "dataUrl" in ref ? ref.dataUrl : ref.url })),
      n: clampN(r.n),
      ...imagesEndpointFields(r.settings ?? {}),
    } as JsonObject,
  };
}

/**
 * The multipart fields for images/edits as the OpenAI SDK sends them: "image" for one file, "image[0]", "image[1]"
 * for several (image-generation, Errors: never mix the two), then the scalar fields once each.
 */
export function imagesEditFormFields(r: { prompt: string; imageCount: number; n?: number; settings?: ImageToolSettings }) {
  const s = r.settings ?? {};
  const scalars: Array<[string, string]> = [
    ["model", "muse-image-1.0"],
    ["prompt", r.prompt],
    ["n", String(clampN(r.n))],
  ];
  if (s.size && s.size !== "auto") scalars.push(["size", s.size]);
  if (s.outputFormat) scalars.push(["output_format", s.outputFormat]);
  if (s.reasoningStrength) scalars.push(["reasoning_strength", s.reasoningStrength]);
  const files = r.imageCount <= 1 ? ["image"] : Array.from({ length: r.imageCount }, (_, i) => `image[${i}]`);
  return { scalars, files };
}

function clampN(n?: number): number {
  return Math.max(1, Math.min(2, Math.round(n ?? 1)));
}

export interface SamRequest {
  /** A short noun phrase, or box and point prompt text from buildSamPrompt. */
  prompt: string;
  media: MediaRef;
  kind: "image" | "video";
  stream?: boolean;
  maskEncoding?: "lossless" | "one_bit";
  includeConfidence?: boolean;
  propagation?: "both" | "forward" | "backward";
}

/** SAM 3.1 on the Responses API. Metadata values are strings, as sam/segmenting says ("true", not true). */
export function samRequest(r: SamRequest): { path: string; body: JsonObject } {
  const media =
    r.kind === "video"
      ? videoPart(r.media, "input_video")
      : "fileId" in r.media
        ? { type: "input_image", file_id: r.media.fileId }
        : { type: "input_image", image_url: "dataUrl" in r.media ? r.media.dataUrl : r.media.url };
  const body: JsonObject = { model: "sam-3.1", input: [userMessage([{ type: "input_text", text: r.prompt }, media])] };
  if (r.stream !== false) body.stream = true;
  const metadata: Record<string, string> = {};
  if (r.maskEncoding && r.maskEncoding !== "lossless") metadata.mask_encoding = r.maskEncoding;
  if (r.includeConfidence) metadata.include_confidence = "true";
  if (r.kind === "video" && r.propagation && r.propagation !== "both") metadata.propagation_direction = r.propagation;
  if (Object.keys(metadata).length) body.metadata = metadata;
  return { path: "responses", body };
}

export type TranscribeMode = "PUSH_TO_TALK" | "ENDPOINTING" | "DIARIZATION";

/** The `request` part of POST /v1/asr/transcribe (api-reference/voice/schemas, Transcribe Request). */
export function transcribeRequestPart(r: {
  mode?: TranscribeMode;
  keywords?: string[];
  languageBias?: string[];
}): JsonObject {
  const req: JsonObject = { model: "muse-voice-transcribe-1.0", audioEncoding: "WAV" };
  if (r.mode && r.mode !== "PUSH_TO_TALK") req.mode = r.mode;
  const keywords = (r.keywords ?? []).map((k) => k.trim()).filter(Boolean);
  if (keywords.length) req.keywords = keywords;
  const languages = (r.languageBias ?? []).map((k) => k.trim()).filter(Boolean);
  if (languages.length) req.languageBias = languages;
  return req;
}

/**
 * Query string for POST /api/docs/asr-realtime, the relay to wss://api.meta.ai/v1/asr/realtime. The relay puts these
 * into the handshake frame (lib/docs/proxy/realtime.ts): lists go comma-separated.
 */
export function realtimeQuery(r: {
  mode?: TranscribeMode;
  partialMode?: "CUMULATIVE" | "DELTA";
  keywords?: string[];
  languageBias?: string[];
}): string {
  const mode = r.mode ?? "PUSH_TO_TALK";
  const q = new URLSearchParams({ model: "muse-voice-transcribe-1.0", mode });
  if (mode === "DIARIZATION") q.set("diarization", "true");
  if (r.partialMode && r.partialMode !== "CUMULATIVE") q.set("partialMode", r.partialMode);
  const keywords = (r.keywords ?? []).map((k) => k.trim()).filter(Boolean);
  if (keywords.length) q.set("keywords", keywords.join(","));
  const languages = (r.languageBias ?? []).map((k) => k.trim()).filter(Boolean);
  if (languages.length) q.set("languageBias", languages.join(","));
  return q.toString();
}

/** The handshake the relay sends for these settings, without the credential, for code and the copy-prompt. */
export function realtimeHandshake(r: {
  mode?: TranscribeMode;
  partialMode?: "CUMULATIVE" | "DELTA";
  keywords?: string[];
  languageBias?: string[];
  sampleRate?: number;
}): JsonObject {
  const h: JsonObject = {
    authorization: { accessToken: "Bearer $MODEL_API_KEY" },
    audioEncoding: r.sampleRate === 24_000 ? "PCM_24KHZ" : "PCM_16KHZ",
    model: "muse-voice-transcribe-1.0",
    mode: r.mode ?? "PUSH_TO_TALK",
  };
  if (r.partialMode && r.partialMode !== "CUMULATIVE") h.partialMode = r.partialMode;
  const keywords = (r.keywords ?? []).map((k) => k.trim()).filter(Boolean);
  if (keywords.length) h.keywords = keywords;
  const languages = (r.languageBias ?? []).map((k) => k.trim()).filter(Boolean);
  if (languages.length) h.languageBias = languages;
  return h;
}

/** Splits a comma list typed by the reader ("Acme Mobile, eSIM, 5G"). */
export function commaList(text: string): string[] {
  return text
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The fields of POST /v1/files, in the order the docs recommend: purpose and expiry first, the file last. */
export function fileUploadFields(r: { expiresAfterSeconds?: number | null }): Array<[string, string]> {
  const fields: Array<[string, string]> = [["purpose", "user_data"]];
  if (r.expiresAfterSeconds) {
    const seconds = Math.min(2_592_000, Math.max(3600, Math.round(r.expiresAfterSeconds)));
    fields.push(["expires_after[anchor]", "created_at"], ["expires_after[seconds]", String(seconds)]);
  }
  return fields;
}

export type FilePart = "input_file" | "input_image" | "input_video" | "input_audio";

/**
 * Which content part references an uploaded file (file-handling, Reference an uploaded file; the Responses schemas'
 * Input Audio Content takes a file_id too). input_file works for every kind; the typed parts say what it is.
 */
export function partForFile(mime: string): FilePart {
  if (mime.startsWith("image/")) return "input_image";
  if (mime.startsWith("video/")) return "input_video";
  if (mime.startsWith("audio/")) return "input_audio";
  return "input_file";
}

/** The typed part for a file kind (image, video, audio), or input_file for everything else. */
export function partForKind(kind: string | null): FilePart {
  return kind === "image" ? "input_image" : kind === "video" ? "input_video" : kind === "audio" ? "input_audio" : "input_file";
}

export function fileQuestionRequest(r: {
  model: string;
  question: string;
  fileId: string;
  part: FilePart;
  maxOutputTokens?: number;
}): { path: string; body: JsonObject } {
  const body: JsonObject = {
    model: r.model,
    input: [userMessage([{ type: "input_text", text: r.question }, { type: r.part, file_id: r.fileId }])],
  };
  if (r.maxOutputTokens) body.max_output_tokens = r.maxOutputTokens;
  return { path: "responses", body };
}

// ---- Display ---------------------------------------------------------------------------------------------------

const LONG = 120;

/**
 * A copy of a request body for showing and recording: inline media becomes `data:<type>;base64,<BASE64>` (and bare
 * base64 audio `<BASE64>`), the placeholders the docs' own examples use, so code stays readable and pasteable.
 */
export function redactMedia<T>(body: T): T {
  const walk = (v: unknown, key?: string): unknown => {
    if (typeof v === "string") {
      const m = /^data:([^;,]+)(?:;[^,]*)?;base64,/.exec(v);
      if (m && v.length > LONG) return `data:${m[1]};base64,<BASE64>`;
      if ((key === "data" || key === "b64_json" || key === "result") && v.length > LONG && /^[A-Za-z0-9+/=\s]+$/.test(v)) {
        return "<BASE64>";
      }
      return v;
    }
    if (Array.isArray(v)) return v.map((x) => walk(x));
    if (isObject(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]));
    return v;
  };
  return walk(body) as T;
}

/** Bytes of inline media in a body, for the "sent inline" caption under the code. */
export function inlineMediaBytes(body: unknown): number {
  let total = 0;
  const walk = (v: unknown) => {
    if (typeof v === "string") {
      const i = v.indexOf(";base64,");
      if (v.startsWith("data:") && i > 0) total += Math.floor(((v.length - i - 8) * 3) / 4);
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (isObject(v)) Object.values(v).forEach(walk);
  };
  walk(body);
  return total;
}
