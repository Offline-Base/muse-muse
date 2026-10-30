import type { Effort } from "@/lib/docs/client/models";

/**
 * Request bodies for the media page demos, built in one place so what a demo sends, what "Show code" prints and what
 * the copy prompt records are the same object. Shapes follow the mirrored pages: image-understanding (input_image,
 * input_file with file_id or file_url, Chat Completions image_url, perception grounding prompts), video-understanding
 * (input_file, input_video, Chat Completions video_url, input_audio three ways), file-handling (file_data inline on
 * both APIs, file_url) and image-generation (store: false turns that replay the last image_generation_call).
 */

export type Json = Record<string, unknown>;
export type Api = "responses" | "chat";

const userMessage = (content: Json[]): Json => ({ type: "message", role: "user", content });

/** Reasoning effort in each protocol's own field, left out when it's the model's default. */
function withEffort(body: Json, api: Api, effort: Effort | null | undefined): Json {
  if (!effort) return body;
  return api === "chat" ? { ...body, reasoning_effort: effort } : { ...body, reasoning: { effort } };
}

/** Streaming on: Chat Completions also asks for usage in the last chunk, as the docs proxy would. */
function withStream(body: Json, api: Api, stream: boolean): Json {
  if (!stream) return body;
  return api === "chat" ? { ...body, stream: true, stream_options: { include_usage: true } } : { ...body, stream: true };
}

// ---- Images (image-understanding) -------------------------------------------------------------------------------

/**
 * How an image goes into a request (image-understanding, "How it works"): inline as a base64 data URL, as a public
 * URL the server fetches, or as an uploaded file's id in an input_image or input_file part, or (Responses only) a
 * public URL in an input_file part's file_url.
 */
export type ImageSend = "data_url" | "public_url" | "file_id_image" | "file_id_file" | "file_url";

export const IMAGE_SENDS: readonly ImageSend[] = ["data_url", "public_url", "file_id_image", "file_id_file", "file_url"];

/** Chat Completions takes an image_url object whose url is a public URL or a data URL, nothing else. */
export function imageSendOnChat(send: ImageSend): boolean {
  return send === "data_url" || send === "public_url";
}

/** True for the ways that upload the picked file with POST /v1/files first. */
export function imageSendUploads(send: ImageSend): boolean {
  return send === "file_id_image" || send === "file_id_file";
}

/** True for the ways that send a URL typed by the reader rather than a picked file. */
export function imageSendIsUrl(send: ImageSend): boolean {
  return send === "public_url" || send === "file_url";
}

/** One image as a content part. `value` is the data URL, the https URL or the file id the send mode calls for. */
export function imagePartFor(send: ImageSend, value: string, api: Api): Json {
  if (api === "chat") return { type: "image_url", image_url: { url: value } };
  switch (send) {
    case "data_url":
    case "public_url":
      return { type: "input_image", image_url: value };
    case "file_id_image":
      return { type: "input_image", file_id: value };
    case "file_id_file":
      return { type: "input_file", file_id: value };
    case "file_url":
      return { type: "input_file", file_url: value };
  }
}

export interface VisionBodyInput {
  model: string;
  api: Api;
  question: string;
  send: ImageSend;
  /** One value per image, in order. */
  images: string[];
  effort?: Effort | null;
  stream?: boolean;
}

/** An image question on the Responses API or Chat Completions, text first and then each image. */
export function visionBody(r: VisionBodyInput): { path: string; body: Json } {
  const parts = r.images.map((v) => imagePartFor(r.send, v, r.api));
  if (r.api === "chat") {
    const body: Json = { model: r.model, messages: [{ role: "user", content: [{ type: "text", text: r.question }, ...parts] }] };
    return { path: "chat/completions", body: withStream(withEffort(body, "chat", r.effort), "chat", !!r.stream) };
  }
  const body: Json = { model: r.model, input: [userMessage([{ type: "input_text", text: r.question }, ...parts])] };
  return { path: "responses", body: withStream(withEffort(body, "responses", r.effort), "responses", !!r.stream) };
}

/**
 * The body for POST /v1/responses/input_tokens with the same input (image-understanding, "Estimating token usage"):
 * the model and input only, since it counts and generates nothing. A Chat Completions question is counted in its
 * Responses form, which carries the same text and images.
 */
export function tokenCountBody(model: string, question: string, send: ImageSend, images: string[]): Json {
  return { model, input: [userMessage([{ type: "input_text", text: question }, ...images.map((v) => imagePartFor(send, v, "responses"))])] };
}

export type GroundingMode = "point" | "box" | "count";

/** Splits the reader's object list, "the milk, the eggs" or one per line. */
export function objectList(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((s) => s.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
}

/**
 * The page's own grounding prompts (image-understanding, "Some grounding modes: point, box, and count"), with the
 * reader's objects in the quoted list. Each asks for one output shape on the 0 to 1000 grid as a JSON array.
 */
export function groundingPrompt(mode: GroundingMode, objects: string[]): string {
  const list = objects.map((o) => `"${o}"`).join(", ");
  switch (mode) {
    case "point":
      return `Point to each of the following objects in the image: ${list}. For each object, answer in the format {"object_name": "<name>", "x": <int>, "y": <int>}. The coordinates should be in the 0-1000 range. Return a JSON array of results. If you cannot find an object, omit it from the results.`;
    case "box":
      return `You are an object grounding expert. Provide the bounding box coordinates of the objects in the image: ${list}. Ensure the objects accurately match the request and do not miss any objects. For each object, answer in the format {"object_name": "<name>", "bbox": [{"x_min": <int>, "y_min": <int>, "x_max": <int>, "y_max": <int>}]}. The coordinates should be in the 0-1000 range. Return a JSON array of results. If you cannot find an object, omit it from the results.`;
    case "count":
      return `Point to every instance of each of the following objects in the image and count them: ${list}. For each object, answer in the format {"object_name": "<name>", "points": [{"x": <int>, "y": <int>}, ...], "count": <int>}. The coordinates should be in the 0-1000 range. Return a JSON array of results. If you cannot find any instances of an object, omit it from the results.`;
  }
}

/** The page's to_pixels helper: a 0 to 1000 grid value to pixels of the image that was sent, clamped to its edges. */
export function toPixels(xNorm: number, yNorm: number, width: number, height: number): { x: number; y: number } {
  const clamp = (v: number) => Math.min(1000, Math.max(0, v));
  return { x: Math.round((clamp(xNorm) * width) / 1000), y: Math.round((clamp(yNorm) * height) / 1000) };
}

/** "count" values a count-mode reply gives per object: [{ object_name, count, points }]. */
export function countsOf(value: unknown): Array<{ name: string; count: number; points: number }> {
  const items = Array.isArray(value) ? value : value && typeof value === "object" && Array.isArray((value as Json).results) ? ((value as Json).results as unknown[]) : [];
  return items
    .filter((v): v is Json => !!v && typeof v === "object" && !Array.isArray(v))
    .filter((v) => typeof v.count === "number")
    .map((v) => ({
      name: String(v.object_name ?? v.label ?? v.name ?? "object"),
      count: v.count as number,
      points: Array.isArray(v.points) ? v.points.length : 0,
    }));
}

// ---- Video and audio (video-understanding) ----------------------------------------------------------------------

/**
 * How a clip goes in (video-understanding): uploaded and referenced as input_file (the page's main flow) or
 * input_video by file_id, inline as input_video's video_url data URL, or a public URL. Chat Completions takes a
 * video_url part with a data URL or a public URL.
 */
export type VideoSend = "upload_input_file" | "upload_input_video" | "inline" | "public_url";

/** Spoken audio (video-understanding, "Audio"): input_audio with base64 and its format, an audio_url data URI, or a file_id. */
export type AudioSend = "input_audio" | "audio_url" | "upload";

export type MediaKind = "video" | "audio";

/**
 * The clip the Public URL mode starts with: MDN's sample of a flower opening (5 s, 1.1 MB, from MDN's CC0 shared
 * assets), which Meta's servers fetch from anywhere. Our own sample can't be the default: Meta can't reach localhost
 * or a protected preview deployment.
 */
export const PUBLIC_SAMPLE_VIDEO = "https://developer.mozilla.org/shared-assets/videos/flower.mp4";

export function videoSendsFor(api: Api): VideoSend[] {
  return api === "chat" ? ["inline", "public_url"] : ["upload_input_file", "upload_input_video", "inline", "public_url"];
}

export function audioSendsFor(api: Api): AudioSend[] {
  return api === "chat" ? ["input_audio"] : ["input_audio", "audio_url", "upload"];
}

export function mediaSendUploads(media: MediaKind, send: VideoSend | AudioSend): boolean {
  return media === "video" ? send === "upload_input_file" || send === "upload_input_video" : send === "upload";
}

export interface MediaBodyInput {
  model: string;
  api: Api;
  media: MediaKind;
  send: VideoSend | AudioSend;
  question: string;
  /** A data URL (inline video, audio_url), bare base64 (input_audio), an https URL or a file id. */
  value: string;
  /** input_audio's format. */
  format?: "wav" | "mp3";
  effort?: Effort | null;
  stream?: boolean;
  /** Output room; the page asks for at least 4,000 when transcribing, since reasoning shares the budget. */
  maxOutputTokens?: number;
}

function mediaPart(r: MediaBodyInput): Json {
  if (r.media === "video") {
    if (r.api === "chat") return { type: "video_url", video_url: { url: r.value } };
    if (r.send === "upload_input_file") return { type: "input_file", file_id: r.value };
    if (r.send === "upload_input_video") return { type: "input_video", file_id: r.value };
    return { type: "input_video", video_url: r.value };
  }
  if (r.api === "responses" && r.send === "audio_url") return { type: "input_audio", audio_url: r.value };
  if (r.api === "responses" && r.send === "upload") return { type: "input_audio", file_id: r.value };
  return { type: "input_audio", input_audio: { data: r.value, format: r.format ?? "wav" } };
}

/**
 * Whether a reply stopped at its output limit: Chat Completions says finish_reason "length", the Responses API
 * incomplete_details.reason "max_output_tokens" (both land in the stream collector's finishReason).
 */
export function ranOutOfOutput(finishReason: string | null | undefined): boolean {
  return finishReason === "length" || finishReason === "max_output_tokens";
}

/** A question about a clip or a recording, on the Responses API or Chat Completions. */
export function mediaBody(r: MediaBodyInput): { path: string; body: Json } {
  const part = mediaPart(r);
  if (r.api === "chat") {
    let body: Json = { model: r.model };
    if (r.maxOutputTokens) body.max_tokens = r.maxOutputTokens;
    body.messages = [{ role: "user", content: [{ type: "text", text: r.question }, part] }];
    body = withStream(withEffort(body, "chat", r.effort), "chat", !!r.stream);
    return { path: "chat/completions", body };
  }
  let body: Json = { model: r.model };
  if (r.maxOutputTokens) body.max_output_tokens = r.maxOutputTokens;
  body.input = [userMessage([{ type: "input_text", text: r.question }, part])];
  body = withStream(withEffort(body, "responses", r.effort), "responses", !!r.stream);
  return { path: "responses", body };
}

// ---- Files inline (file-handling) -------------------------------------------------------------------------------

/**
 * Inline files (file-handling, "Send a file inline"): a Responses input_file with file_data and a filename, a Chat
 * Completions file block whose nested file carries file_data and filename, a Responses input_file with file_url the
 * server fetches, or inline video as input_video's video_url.
 */
export type InlineSend = "responses_file_data" | "chat_file" | "responses_file_url" | "responses_video_url";

export interface InlineBodyInput {
  model: string;
  send: InlineSend;
  question: string;
  /** The data URL for file_data and video_url, or the https URL for file_url. */
  value: string;
  filename?: string;
  effort?: Effort | null;
  stream?: boolean;
}

export function inlineFileBody(r: InlineBodyInput): { path: string; body: Json } {
  if (r.send === "chat_file") {
    const body: Json = {
      model: r.model,
      messages: [{ role: "user", content: [{ type: "text", text: r.question }, { type: "file", file: { filename: r.filename || "document.pdf", file_data: r.value } }] }],
    };
    return { path: "chat/completions", body: withStream(withEffort(body, "chat", r.effort), "chat", !!r.stream) };
  }
  const part: Json =
    r.send === "responses_file_url"
      ? { type: "input_file", file_url: r.value }
      : r.send === "responses_video_url"
        ? { type: "input_video", video_url: r.value }
        : { type: "input_file", filename: r.filename || "document.pdf", file_data: r.value };
  const body: Json = { model: r.model, input: [userMessage([{ type: "input_text", text: r.question }, part])] };
  return { path: "responses", body: withStream(withEffort(body, "responses", r.effort), "responses", !!r.stream) };
}

/**
 * Whether POST /v1/responses/input_tokens gives a true count for this file, for free: it counts a PDF or an image sent
 * as file_data or file_url, but not video (checked live: a 2 MB clip adds 1 token, inline as input_video or as
 * input_file file_data, while a real run bills it at over a thousand), and the Chat Completions block isn't the
 * Responses shape it takes.
 */
export function inlineSendCountable(send: InlineSend, isVideo = false): boolean {
  return (send === "responses_file_data" || send === "responses_file_url") && !isVideo;
}

/** A file_url that names a clip by its extension, which input_tokens wouldn't count. */
export function urlLooksLikeVideo(url: string): boolean {
  return /\.(mp4|m4v|mov|webm)(?:[?#]|$)/i.test(url.trim());
}

// ---- Muse Image without stored state (image-generation, "Manage state yourself") ---------------------------------

/** The image_generation tool's fields that make a turn quick: one pass, no lookups. */
export const FAST_IMAGE_TOOL: Json = {
  type: "image_generation",
  reasoning_strength: "low",
  enable_image_search: false,
  enable_web_search: false,
  enable_shell: false,
};

export interface StatelessTurnInput {
  prompt: string;
  /** The image_generation_call id from the turn before, or null for the first turn. */
  previousImageId?: string | null;
  /** Reference images as data URLs, sent as input_image parts after the instruction. */
  references?: string[];
  fast?: boolean;
}

/**
 * A Muse Image turn with store: false. Nothing is kept at Meta, so a follow-up replays the last image_generation_call
 * item (its id with result null, since the id carries what's needed) before the new instruction.
 */
export function statelessTurnBody(r: StatelessTurnInput): { path: string; body: Json } {
  const refs = r.references ?? [];
  const instruction: Json = {
    role: "user",
    content: [{ type: "input_text", text: r.prompt }, ...refs.map((url) => ({ type: "input_image", image_url: url }))],
  };
  const input: unknown = r.previousImageId
    ? [{ type: "image_generation_call", id: r.previousImageId, status: "completed", result: null }, instruction]
    : refs.length
      ? [instruction]
      : r.prompt;
  const body: Json = { model: "muse-image-1.0", store: false, input };
  if (r.fast) body.tools = [FAST_IMAGE_TOOL];
  return { path: "responses", body };
}

/** The image_generation_call items in a Responses reply: their ids (the handles for the next turn) and images. */
export function imageCallsOf(reply: unknown): Array<{ id: string; b64: string }> {
  const output = reply && typeof reply === "object" ? (reply as Json).output : null;
  if (!Array.isArray(output)) return [];
  return output
    .filter((o): o is Json => !!o && typeof o === "object" && (o as Json).type === "image_generation_call")
    .filter((o) => typeof o.id === "string" && typeof o.result === "string" && (o.result as string).length > 0)
    .map((o) => ({ id: o.id as string, b64: o.result as string }));
}

/** A long id shortened for display: "ig_eyJwZXJt...Q8WLFw" (the full id is still what's sent). */
export function shortId(id: string, keep = 12): string {
  return id.length <= keep * 2 + 3 ? id : `${id.slice(0, keep)}...${id.slice(-6)}`;
}
