/**
 * SFT conversations in the TorchTitan recipe's format (cookbook/muse-spark-open-torchtitan-sft): one JSON object per
 * line, {"messages": [...]}, with image and audio parts that point at a file by "path". Code only: no model call, no
 * network, no tokenizer. Token counts are estimates, and the rendering is the page's simplified view.
 */

export type Part = { type: "text"; text: string } | { type: "image"; path: string } | { type: "audio"; path: string };
export interface Message {
  role: "system" | "user" | "assistant";
  content: string | Part[];
}
export interface Conversation {
  messages: Message[];
}

export interface ParsedLine {
  line: number;
  row: unknown;
  error?: string;
}

export interface RowCheck {
  line: number;
  errors: string[];
  warnings: string[];
  images: number;
  audio: number;
}

const ROLES = new Set(["system", "user", "assistant"]);

export function parseJsonl(text: string): ParsedLine[] {
  const out: ParsedLine[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    if (!raw.trim()) return;
    try {
      out.push({ line: i + 1, row: JSON.parse(raw) });
    } catch {
      out.push({ line: i + 1, row: null, error: "This line isn't valid JSON." });
    }
  });
  return out;
}

/** A CSV with question and answer columns (and an optional system column) becomes one single-turn chat a row. */
export function csvToConversations(text: string): Conversation[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') (cell += '"'), i++;
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") row.push(cell), (cell = "");
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell), rows.push(row), (row = []), (cell = "");
    } else cell += c;
  }
  if (cell || row.length) row.push(cell), rows.push(row);
  const [head, ...body] = rows.filter((r) => r.some((x) => x.trim()));
  if (!head) return [];
  const col = (name: string) => head.findIndex((h) => h.trim().toLowerCase() === name);
  const q = col("question");
  const a = col("answer");
  const s = col("system");
  if (q < 0 || a < 0) throw new Error("The CSV needs a question column and an answer column.");
  return body.map((r) => ({
    messages: [
      ...(s >= 0 && r[s]?.trim() ? [{ role: "system" as const, content: r[s].trim() }] : []),
      { role: "user" as const, content: (r[q] ?? "").trim() },
      { role: "assistant" as const, content: (r[a] ?? "").trim() },
    ],
  }));
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((p) => (p && typeof p === "object" && (p as { type?: unknown }).type === "text" ? String((p as { text?: unknown }).text ?? "") : "")).join(" ");
}

export function checkConversation(row: unknown, line: number): RowCheck {
  const out: RowCheck = { line, errors: [], warnings: [], images: 0, audio: 0 };
  const messages = row && typeof row === "object" ? (row as { messages?: unknown }).messages : undefined;
  if (!Array.isArray(messages) || !messages.length) {
    out.errors.push('Needs "messages", a list of chat messages.');
    return out;
  }
  let assistant = 0;
  messages.forEach((m, i) => {
    const at = `Message ${i + 1}`;
    const role = m && typeof m === "object" ? (m as { role?: unknown }).role : undefined;
    if (typeof role !== "string" || !ROLES.has(role)) return void out.errors.push(`${at}: role must be system, user or assistant.`);
    if (role === "system" && i > 0) out.warnings.push(`${at}: a system message goes first.`);
    const content = (m as { content?: unknown }).content;
    if (typeof content !== "string" && !Array.isArray(content)) return void out.errors.push(`${at}: content must be text or a list of parts.`);
    if (Array.isArray(content)) {
      for (const p of content) {
        const type = p && typeof p === "object" ? (p as { type?: unknown }).type : undefined;
        const path = p && typeof p === "object" ? (p as { path?: unknown }).path : undefined;
        if (type === "image" || type === "audio") {
          if (role !== "user") out.warnings.push(`${at}: media goes in user messages.`);
          if (typeof path !== "string" || !path.trim()) out.errors.push(`${at}: each ${type} part needs a path to its file.`);
          else if (type === "audio" && !/\.wav$/i.test(path)) out.errors.push(`${at}: audio must be a 16-bit PCM mono WAV file.`);
          if (type === "image") out.images++;
          else out.audio++;
        } else if (type !== "text") out.errors.push(`${at}: parts are text, image or audio.`);
      }
    }
    if (role === "assistant") {
      assistant++;
      if (!textOf(content).trim()) out.errors.push(`${at}: the assistant reply is empty, so there is nothing to learn.`);
    }
  });
  if (!assistant) out.errors.push("No assistant reply. Only assistant replies are trained, so this row teaches nothing.");
  const last = messages[messages.length - 1] as { role?: unknown } | undefined;
  if (assistant && last?.role !== "assistant") out.warnings.push("Ends on a user message. That last turn is context only.");
  return out;
}

const fold = (s: string) => s.toLowerCase().replace(/\s+/g, " ").replace(/[^\p{L}\p{N} ]/gu, "").trim();

/** Line numbers of rows whose text repeats an earlier row's. */
export function duplicateLines(rows: Array<{ line: number; row: unknown }>): number[] {
  const seen = new Set<string>();
  const dupes: number[] = [];
  for (const { line, row } of rows) {
    const messages = (row as { messages?: unknown[] } | null)?.messages;
    if (!Array.isArray(messages)) continue;
    const key = messages.map((m) => fold(textOf((m as { content?: unknown })?.content))).join("|");
    if (seen.has(key)) dupes.push(line);
    else seen.add(key);
  }
  return dupes;
}

export interface Segment {
  text: string;
  trained: boolean;
}

/**
 * The page's simplified rendering: system and user turns are masked; for an assistant turn `<|start|>assistant` is
 * masked and " to=user<|message|>reply<|eot|>" trains. Media parts show as one placeholder and are never trained. The
 * real renderer also writes its own system lines, with the pinned date and reasoning effort.
 */
export function trainedSegments(convo: Conversation): Segment[] {
  const out: Segment[] = [];
  for (const m of convo.messages) {
    const body = typeof m.content === "string" ? m.content : m.content.map((p) => (p.type === "text" ? p.text : p.type === "image" ? "<|patch|>" : "<|audio|>")).join("");
    if (m.role === "assistant") out.push({ text: "<|start|>assistant", trained: false }, { text: ` to=user<|message|>${body}<|eot|>`, trained: true });
    else out.push({ text: `<|start|>${m.role}<|message|>${body}<|eot|>`, trained: false });
  }
  return out;
}

/** About 4 characters a token. An estimate, not the model's tokenizer: label it so. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A seeded held-out split, 10% by default, at least 1 row once there are 5. The same seed gives the same split. */
export function splitHeldOut<T>(rows: readonly T[], seed = 1, fraction = 0.1): { train: T[]; heldOut: T[] } {
  const order = rows.map((_, i) => i);
  const rand = seeded(seed);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const n = rows.length < 5 ? 0 : Math.max(1, Math.round(rows.length * fraction));
  const held = new Set(order.slice(0, n));
  return { train: rows.filter((_, i) => !held.has(i)), heldOut: rows.filter((_, i) => held.has(i)) };
}

export function sizeWarnings(count: number, heldOut: number): string[] {
  const out: string[] = [];
  if (count < 200) out.push("Small datasets overfit fast. Watch held-out loss and stop when it flattens, even if training loss is still falling.");
  if (!heldOut) out.push("No held-out rows yet: add at least 5 conversations so one can be set aside.");
  return out;
}

export function toJsonl(rows: readonly Conversation[]): string {
  return rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");
}

/** The page's recipe function and run commands, with the date pinned so the tokens and the loss don't change daily. */
export function recipeFiles(o: { dataPaths: string[]; date: string; lr?: number; media: boolean }): { recipePy: string; run: string } {
  const lr = o.lr ?? 1e-5;
  const data = `(${o.dataPaths.map((p) => JSON.stringify(p)).join(", ")},)`;
  const recipePy = o.media
    ? [
        "# Put this beside sft.py on PYTHONPATH, with the imports sft.py uses.",
        "def my_media_sft() -> Trainer.Config:",
        "    config = _muse_spark_816b_a42b()",
        '    config.model = build_model_config("816B-A42B_mm", parallelism=config.parallelism)',
        '    config.model.dataset_modalities = ("vision", "audio")',
        "    return sft_recipe(",
        "        config,",
        `        data=${data},`,
        "        processor=MediaChatSFTProcessor.Config(...),  # geometry from config.model",
        "        packing=MMSamplePackingConfig,",
        `        lr=${lr},`,
        "    )",
      ].join("\n")
    : [
        "# Put this beside sft.py on PYTHONPATH, with the imports sft.py uses.",
        "def my_text_sft() -> Trainer.Config:",
        "    return sft_recipe(",
        "        _muse_spark_816b_a42b(),",
        `        data=${data},`,
        "        processor=ChatProcessor.Config(",
        "            messages_fn=chat_messages,",
        `            renderer=MuseSparkRendererConfig(current_date=${JSON.stringify(o.date)}, reasoning_effort="xhigh"),`,
        "        ),",
        `        lr=${lr},`,
        "    )",
      ].join("\n");
  const smoke = o.media ? "muse_spark_debugmodel_media_sft" : "muse_spark_debugmodel_sft";
  const full = o.media ? "muse_spark_816b_a42b_media_sft" : "muse_spark_816b_a42b_sft";
  const run = [
    "# From the TorchTitan checkout. One GPU first, on the random-weight debug model.",
    `export MUSE_SPARK_SFT_DATA="${o.dataPaths.join(",")}"`,
    `NGPU=1 MODULE=sft CONFIG=${smoke} ./run_train.sh`,
    "# The full model, from the released weights: 128 GPUs in the recipe's layout.",
    `MODULE=sft CONFIG=${full} ./run_train.sh`,
    "",
  ].join("\n");
  return { recipePy: `${recipePy}\n`, run };
}
