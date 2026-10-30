/**
 * SAM 3.1's output format and object prompts, written from Meta's docs (sam/reading-segmentation, sam/segmenting and
 * the protocol notes they link), without Meta's parser packages.
 *
 * The output text holds one line per frame:
 *   <Nf>id<|box;x1=..;y1=..;x2=..;y2=..;w=..;h=..[;c=..]|><|mask;x=0;y=0[;c=..];data=H,W,<enc>payload|>,id<|box..
 * Frames can skip and arrive out of order, object ids are stable per object and sparse, x2 and y2 are inclusive, and a
 * mask is an H x W raster that sits on its record's box. The mask payload's first character is the encoding (`~`
 * lossless, `!` one_bit); the rest is base85 text: a five-digit length prefix, then the packed bytes of an
 * arithmetic-coded body. The docs don't specify that coder, so turning a payload into pixels is left to
 * lib/docs/media/sam-mask.ts; this file checks and unpacks the envelope.
 */

export type SamMaskEncoding = "lossless" | "one_bit";

export interface SamBox {
  /** Corners in source pixels; x2 and y2 are inclusive, as on the wire. */
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** The source frame's size, repeated on every record. */
  w: number;
  h: number;
  confidence?: number;
}

export interface SamMask {
  /** Raster rows and columns ("data=H,W,..." is height first). */
  height: number;
  width: number;
  encoding: SamMaskEncoding;
  /** Everything after "H,W," including the encoding character, unchanged. */
  payload: string;
  confidence?: number;
}

export interface SamRecord {
  /** Source frame index (0 for an image). */
  frame: number;
  /** The wire's integer id, kept as a string, as Meta's docs do. */
  objectId: string;
  box: SamBox;
  mask: SamMask;
}

export interface SamFrame {
  frame: number;
  records: SamRecord[];
  /** One-based line number in the output text. */
  line: number;
}

export interface SamDiagnostic {
  line: number;
  code: "malformed_record" | "ignored_token" | "ignored_field" | "ignored_confidence";
  message: string;
  raw: string;
}

export interface SamOutput {
  /** Frames in arrival order. */
  frames: SamFrame[];
  /** Every record in arrival order. */
  records: SamRecord[];
  /** Lines that aren't segmentation (plain text the model wrote). */
  text: string[];
  diagnostics: SamDiagnostic[];
}

// ---- One line --------------------------------------------------------------------------------------------------

interface Token {
  name: string;
  fields: Map<string, string>;
  repeated: Set<string>;
}

const INT = /^-?\d+$/;
const UINT = /^\d+$/;
const DECIMAL = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/;
const TOKEN_NAME = /^[A-Za-z][A-Za-z0-9_.-]*$/;

function readToken(body: string): Token | null {
  const parts = body.split(";");
  const name = parts[0].trim();
  if (!TOKEN_NAME.test(name)) return null;
  const fields = new Map<string, string>();
  const repeated = new Set<string>();
  for (const raw of parts.slice(1)) {
    if (!raw.trim()) continue;
    const eq = raw.indexOf("=");
    const key = (eq < 0 ? raw : raw.slice(0, eq)).trim();
    const value = eq < 0 ? "" : raw.slice(eq + 1).trim();
    if (fields.has(key)) repeated.add(key);
    else fields.set(key, value);
  }
  return { name, fields, repeated };
}

function confidenceOf(token: Token, warn: (code: SamDiagnostic["code"], message: string) => void): number | undefined {
  if (!token.fields.has("c")) return undefined;
  const raw = token.fields.get("c") ?? "";
  const n = DECIMAL.test(raw) ? Number(raw) : NaN;
  if (token.repeated.has("c") || !Number.isFinite(n) || n < 0 || n > 1) {
    warn("ignored_confidence", `Ignored a confidence value that isn't a number from 0 to 1: "c=${raw}".`);
    return undefined;
  }
  return n === 0 ? 0 : n; // -0 becomes 0
}

class LineError extends Error {}

function boxOf(token: Token, warn: (code: SamDiagnostic["code"], message: string) => void): SamBox {
  for (const key of token.repeated) if (key !== "c") throw new LineError(`The box repeats "${key}".`);
  const get = (key: string, pattern: RegExp) => {
    const v = token.fields.get(key);
    if (v === undefined || !pattern.test(v)) throw new LineError(`The box has no valid "${key}".`);
    return Number(v) || 0; // "-0" reads as 0
  };
  const box: SamBox = {
    x1: get("x1", INT),
    y1: get("y1", INT),
    x2: get("x2", INT),
    y2: get("y2", INT),
    w: get("w", UINT),
    h: get("h", UINT),
  };
  const c = confidenceOf(token, warn);
  if (c !== undefined) box.confidence = c;
  for (const key of token.fields.keys()) {
    if (!["x1", "y1", "x2", "y2", "w", "h", "c"].includes(key)) warn("ignored_field", `Ignored the box field "${key}".`);
  }
  return box;
}

function maskOf(token: Token, warn: (code: SamDiagnostic["code"], message: string) => void): SamMask {
  for (const key of token.repeated) if (key !== "c") throw new LineError(`The mask repeats "${key}".`);
  if (token.fields.get("x") !== "0" || token.fields.get("y") !== "0") throw new LineError("The mask needs x=0 and y=0.");
  const data = token.fields.get("data");
  const m = data === undefined ? null : /^(\d+),(\d+),([\s\S]+)$/.exec(data);
  if (!m) throw new LineError('The mask has no valid "data=H,W,payload".');
  const marker = m[3][0];
  if (marker !== "~" && marker !== "!") throw new LineError(`Unknown mask encoding "${marker}".`);
  const mask: SamMask = {
    height: Number(m[1]),
    width: Number(m[2]),
    encoding: marker === "~" ? "lossless" : "one_bit",
    payload: m[3],
  };
  if (!mask.height || !mask.width) throw new LineError("The mask raster is empty.");
  const c = confidenceOf(token, warn);
  if (c !== undefined) mask.confidence = c;
  for (const key of token.fields.keys()) {
    if (!["x", "y", "data", "c"].includes(key)) warn("ignored_field", `Ignored the mask field "${key}".`);
  }
  return mask;
}

/**
 * Parses one output line. A line that doesn't start with "<" is text; one that does but breaks the grammar gives a
 * malformed_record diagnostic and no records (the lines around it are unaffected).
 */
export function parseSamLine(
  raw: string,
  lineNo = 1,
): { frame: SamFrame | null; text: string | null; diagnostics: SamDiagnostic[] } {
  const line = raw.replace(/\r$/, "");
  const diagnostics: SamDiagnostic[] = [];
  if (!line.trim()) return { frame: null, text: null, diagnostics };
  if (!line.startsWith("<")) return { frame: null, text: line, diagnostics };
  const warnings: SamDiagnostic[] = [];
  const warn = (code: SamDiagnostic["code"], message: string) => warnings.push({ line: lineNo, code, message, raw: line });
  try {
    const head = /^<(\d+)f(;[^>]*)?>/.exec(line);
    if (!head) throw new LineError("The line doesn't start with a frame marker such as <0f>.");
    if (head[2]) warn("ignored_field", "Ignored fields on the frame marker.");
    const frameIndex = Number(head[1]);
    const records: SamRecord[] = [];
    let at = head[0].length;
    while (at < line.length) {
      if (line[at] === ",") at++;
      const id = /^\d+/.exec(line.slice(at));
      if (!id) throw new LineError(`Expected an object id at column ${at + 1}.`);
      at += id[0].length;
      let box: SamBox | null = null;
      let mask: SamMask | null = null;
      let boxes = 0;
      let masks = 0;
      while (line.startsWith("<|", at)) {
        const close = line.indexOf("|>", at + 2);
        if (close < 0) throw new LineError("A token is missing its closing |>.");
        const token = readToken(line.slice(at + 2, close));
        if (!token) throw new LineError(`A token has no valid name at column ${at + 1}.`);
        if (token.name === "box") {
          boxes++;
          box = boxOf(token, warn);
        } else if (token.name === "mask") {
          masks++;
          mask = maskOf(token, warn);
        } else {
          warn("ignored_token", `Ignored the token "${token.name}".`);
        }
        at = close + 2;
      }
      // The comma between records is optional, so the next record may start right away with its id.
      if (at < line.length && line[at] !== "," && !/\d/.test(line[at])) {
        throw new LineError(`Unexpected text at column ${at + 1}.`);
      }
      if (boxes !== 1 || masks !== 1 || !box || !mask) {
        throw new LineError(`Object ${id[0]} needs exactly one box and one mask.`);
      }
      if (box.x1 < 0 || box.y1 < 0 || box.x2 < box.x1 || box.y2 < box.y1 || box.x2 >= box.w || box.y2 >= box.h) {
        throw new LineError(`Object ${id[0]}'s box lies outside its ${box.w}x${box.h} frame.`);
      }
      records.push({ frame: frameIndex, objectId: id[0], box, mask });
    }
    if (!records.length) throw new LineError("The frame has no records.");
    return { frame: { frame: frameIndex, records, line: lineNo }, text: null, diagnostics: warnings };
  } catch (err) {
    if (!(err instanceof LineError)) throw err;
    diagnostics.push({ line: lineNo, code: "malformed_record", message: err.message, raw: line });
    return { frame: null, text: null, diagnostics };
  }
}

/** Parses a complete output text (all frames). An empty text means zero matches, which is a normal result. */
export function parseSamOutput(text: string): SamOutput {
  const parser = new SamStreamParser();
  parser.push(text);
  parser.end();
  return parser.output();
}

/**
 * Parses output as it streams. Deltas can split anywhere (even inside a mask payload); a line is parsed once its
 * newline arrives, or at end(). Each push returns the frames it completed, so an overlay can draw them right away.
 */
export class SamStreamParser {
  private buffer = "";
  private lineNo = 0;
  private readonly frames: SamFrame[] = [];
  private readonly texts: string[] = [];
  private readonly diagnostics: SamDiagnostic[] = [];
  private readonly warned = new Set<string>();
  /** Everything received, exactly. */
  raw = "";

  push(delta: string): SamFrame[] {
    this.raw += delta;
    this.buffer += delta;
    const done: SamFrame[] = [];
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      const frame = this.take(line);
      if (frame) done.push(frame);
    }
    return done;
  }

  end(): SamFrame[] {
    const rest = this.buffer;
    this.buffer = "";
    const frame = rest ? this.take(rest) : null;
    return frame ? [frame] : [];
  }

  output(): SamOutput {
    return {
      frames: [...this.frames],
      records: this.frames.flatMap((f) => f.records),
      text: [...this.texts],
      diagnostics: [...this.diagnostics],
    };
  }

  private take(line: string): SamFrame | null {
    this.lineNo++;
    const parsed = parseSamLine(line, this.lineNo);
    for (const d of parsed.diagnostics) {
      // Warnings are reported once per kind and key, the first time they apply; errors every time.
      const key = `${d.code}:${d.message}`;
      if (d.code !== "malformed_record" && this.warned.has(key)) continue;
      this.warned.add(key);
      this.diagnostics.push(d);
    }
    if (parsed.text !== null) this.texts.push(parsed.text);
    if (parsed.frame) this.frames.push(parsed.frame);
    return parsed.frame;
  }
}

// ---- Reading the stream ------------------------------------------------------------------------------------------

/** The text of a `response.output_text.delta` event, or null for any other event. */
export function samDelta(event: Record<string, unknown> | null): string | null {
  if (!event || event.type !== "response.output_text.delta") return null;
  return typeof event.delta === "string" ? event.delta : null;
}

/** The output text of a non-streamed Responses reply (or a response.completed event's response). */
export function samTextOfResponse(response: unknown): string {
  const r = response as { output_text?: unknown; output?: unknown } | null;
  if (!r) return "";
  if (typeof r.output_text === "string") return r.output_text;
  let text = "";
  for (const item of Array.isArray(r.output) ? r.output : []) {
    const content = (item as { content?: unknown }).content;
    for (const part of Array.isArray(content) ? content : []) {
      const p = part as { type?: unknown; text?: unknown };
      if (p.type === "output_text" && typeof p.text === "string") text += p.text;
    }
  }
  return text;
}

/** Records grouped by frame index, for drawing the current video frame. Later lines for a frame replace earlier ones. */
export function recordsByFrame(records: readonly SamRecord[]): Map<number, SamRecord[]> {
  const byFrame = new Map<number, Map<string, SamRecord>>();
  for (const r of records) {
    let frame = byFrame.get(r.frame);
    if (!frame) byFrame.set(r.frame, (frame = new Map()));
    frame.set(r.objectId, r);
  }
  return new Map([...byFrame].map(([f, m]) => [f, [...m.values()]]));
}

/** Distinct object ids in first-seen order. In a video that's the number of tracked objects. */
export function objectIds(records: readonly SamRecord[]): string[] {
  return [...new Set(records.map((r) => r.objectId))];
}

// ---- Mask payload envelope ---------------------------------------------------------------------------------------

/** The 85 base85 digits in value order: "!" through "{" minus the wire's delimiters " \ , ; < > |. */
export const SAM_BASE85 = "!#$%&'()*+-./0123456789:=?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[]^_`abcdefghijklmnopqrstuvwxyz{";

const DIGIT = (() => {
  const map = new Int16Array(128).fill(-1);
  for (let i = 0; i < SAM_BASE85.length; i++) map[SAM_BASE85.charCodeAt(i)] = i;
  return map;
})();

export class SamMaskError extends Error {
  readonly code = "invalid_mask_payload";
}

/** Characters needed to pack `n` bytes: five per four bytes, and n + 1 for a final partial group. */
export function base85Length(n: number): number {
  return 5 * Math.floor(n / 4) + (n % 4 ? (n % 4) + 1 : 0);
}

/**
 * Unpacks base85 digits into bytes: each group of five digits is a big-endian 32-bit number (four bytes), and a final
 * group of k digits (2 to 4) holds k - 1 bytes, read by padding it with the top digit.
 */
export function decodeSamBase85(digits: string): Uint8Array {
  const tail = digits.length % 5;
  if (tail === 1) throw new SamMaskError("A base85 group can't be a single digit.");
  const out = new Uint8Array(Math.floor(digits.length / 5) * 4 + (tail ? tail - 1 : 0));
  let o = 0;
  for (let at = 0; at < digits.length; at += 5) {
    const group = digits.slice(at, at + 5);
    let value = 0;
    for (let i = 0; i < 5; i++) {
      const code = i < group.length ? group.charCodeAt(i) : SAM_BASE85.charCodeAt(84);
      const d = code < 128 ? DIGIT[code] : -1;
      if (d < 0) throw new SamMaskError(`"${group[i]}" isn't a base85 digit.`);
      value = value * 85 + d;
    }
    if (value > 0xffffffff) throw new SamMaskError("A base85 group is out of range.");
    const n = group.length === 5 ? 4 : group.length - 1;
    for (let b = 0; b < n; b++) out[o++] = Math.floor(value / 2 ** (24 - 8 * b)) & 0xff;
  }
  return out;
}

export interface SamMaskEnvelope {
  encoding: SamMaskEncoding;
  /** Body length from the five-digit prefix. */
  declaredBytes: number;
  /** The packed body bytes (the arithmetic-coded mask). */
  body: Uint8Array;
}

/**
 * Checks a mask payload's envelope as the docs describe it (marker, alphabet, length prefix, packed groups) and returns
 * the body bytes. Throws SamMaskError when the payload is cut short, padded, or not base85.
 */
export function readMaskEnvelope(mask: Pick<SamMask, "payload">): SamMaskEnvelope {
  const { payload } = mask;
  const marker = payload[0];
  if (marker !== "~" && marker !== "!") throw new SamMaskError("A mask payload starts with ~ (lossless) or ! (one_bit).");
  const digits = payload.slice(1);
  if (digits.length < 5) throw new SamMaskError("The mask payload is shorter than its length prefix.");
  const prefix = decodeSamBase85(digits.slice(0, 5));
  const declaredBytes = ((prefix[0] << 24) | (prefix[1] << 16) | (prefix[2] << 8) | prefix[3]) >>> 0;
  const packed = digits.slice(5);
  if (packed.length !== base85Length(declaredBytes)) {
    throw new SamMaskError(
      `The mask declares ${declaredBytes} bytes, which pack into ${base85Length(declaredBytes)} digits, but ${packed.length} arrived.`,
    );
  }
  const body = decodeSamBase85(packed);
  return { encoding: marker === "~" ? "lossless" : "one_bit", declaredBytes, body };
}

// ---- Object prompts (box and point prompts) ----------------------------------------------------------------------

export interface SamPromptPoint {
  x: number;
  y: number;
  /** A negative point marks a region that isn't part of the object. */
  negative?: boolean;
}

export interface SamPromptObject {
  /** The id SAM reports this object under: a non-negative integer. */
  id: number;
  /** Source frame (0 for an image). */
  frame?: number;
  /** The whole object, in media pixels, x2 and y2 inclusive. */
  box?: { x1: number; y1: number; x2: number; y2: number };
  points?: SamPromptPoint[];
}

export class SamPromptError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** The model's limit on prompted objects (sam/segmenting, Limits). */
export const SAM_MAX_PROMPT_OBJECTS = 16;

/**
 * Builds the input_text for box and point prompts: one block per frame in ascending order, objects in the order given,
 * each object's box before its points, every token carrying the media's own size. Throws SamPromptError for input the
 * API would reject.
 */
export function buildSamPrompt(size: { width: number; height: number }, objects: readonly SamPromptObject[]): string {
  const { width: w, height: h } = size;
  if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0) {
    throw new SamPromptError("invalid_size", "The media size must be whole pixels.");
  }
  if (!objects.length) throw new SamPromptError("no_objects", "Add a box or a point first.");
  const ids = new Set<number>();
  const frames = new Map<number, SamPromptObject[]>();
  for (const o of objects) {
    if (!Number.isInteger(o.id) || o.id < 0) throw new SamPromptError("invalid_object_id", "Object ids are whole numbers from 0.");
    const frame = o.frame ?? 0;
    if (!Number.isInteger(frame) || frame < 0) throw new SamPromptError("invalid_frame", "Frames are whole numbers from 0.");
    const list = frames.get(frame) ?? [];
    if (list.some((x) => x.id === o.id)) {
      throw new SamPromptError("duplicate_object_id", `Object ${o.id} appears twice on frame ${frame}.`);
    }
    if (!o.box && !o.points?.length) throw new SamPromptError("empty_object", `Object ${o.id} has no box or point.`);
    if (o.box) {
      const { x1, y1, x2, y2 } = o.box;
      if (![x1, y1, x2, y2].every(Number.isInteger) || x1 < 0 || y1 < 0 || x2 < x1 || y2 < y1 || x2 >= w || y2 >= h) {
        throw new SamPromptError("invalid_box", `Object ${o.id}'s box must lie inside the ${w}x${h} media.`);
      }
    }
    for (const p of o.points ?? []) {
      if (!Number.isInteger(p.x) || !Number.isInteger(p.y) || p.x < 0 || p.y < 0 || p.x >= w || p.y >= h) {
        throw new SamPromptError("invalid_point", `A point on object ${o.id} lies outside the ${w}x${h} media.`);
      }
    }
    ids.add(o.id);
    list.push(o);
    frames.set(frame, list);
  }
  if (ids.size > SAM_MAX_PROMPT_OBJECTS) {
    throw new SamPromptError("too_many_objects", `SAM 3.1 takes up to ${SAM_MAX_PROMPT_OBJECTS} prompted objects.`);
  }
  const size_ = `w=${w};h=${h}`;
  let text = "";
  for (const frame of [...frames.keys()].sort((a, b) => a - b)) {
    text += `<${frame}f>`;
    text += frames
      .get(frame)!
      .map((o) => {
        let s = String(o.id);
        if (o.box) s += `<|box;x1=${o.box.x1};y1=${o.box.y1};x2=${o.box.x2};y2=${o.box.y2};${size_}|>`;
        for (const p of o.points ?? []) s += `${p.negative ? "-" : ""}<|point;x=${p.x};y=${p.y};${size_}|>`;
        return s;
      })
      .join(",");
  }
  return text;
}

/**
 * Converts a spot on a preview to media pixels, as sam/segmenting says: subtract where the media starts in the view,
 * scale by media size over displayed size, round down and keep it inside the media.
 */
export function toMediaPixels(
  point: { x: number; y: number },
  view: { left: number; top: number; width: number; height: number },
  media: { width: number; height: number },
): { x: number; y: number } {
  const clamp = (v: number, max: number) => Math.min(max - 1, Math.max(0, Math.floor(v)));
  return {
    x: clamp(((point.x - view.left) * media.width) / view.width, media.width),
    y: clamp(((point.y - view.top) * media.height) / view.height, media.height),
  };
}

/** A box from two dragged corners in media pixels, in either drag direction. */
export function boxFromCorners(a: { x: number; y: number }, b: { x: number; y: number }) {
  return { x1: Math.min(a.x, b.x), y1: Math.min(a.y, b.y), x2: Math.max(a.x, b.x), y2: Math.max(a.y, b.y) };
}
