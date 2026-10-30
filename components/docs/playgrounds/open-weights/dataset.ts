/**
 * Row checks for the training data formats the post-training pages specify, one JSON object per line:
 *
 * - torchtitan-sft (cookbook/muse-spark-open-torchtitan-sft): messages; image and audio parts point at a file with
 *   "path"; audio is 16-bit PCM WAV.
 * - chat (TRL on both models, Fireworks SFT): OpenAI-style messages; Fireworks leaves a message with "weight": 0 out of
 *   the loss; Muse Glimmer can keep reasoning in reasoning_content.
 * - axolotl (muse-glimmer/post-training): messages with images inline in the user content, each before its question;
 *   a top-level images column keeps only the first image in Axolotl 0.19.0.
 * - dpo (TRL): prompt, chosen and rejected.
 * - grpo (TRL): prompts only; completions are sampled online.
 * - miles-math and miles-vlm (muse-spark-open/post-training, Miles): prompt and label, or messages with one <image>
 *   per image, images and label.
 * - fireworks-rl: messages and ground_truth, a JSON string.
 */

export type DatasetFormat = "torchtitan-sft" | "chat" | "axolotl" | "dpo" | "grpo" | "miles-math" | "miles-vlm" | "fireworks-rl";

export const FORMAT_LABEL: Record<DatasetFormat, string> = {
  "torchtitan-sft": "TorchTitan SFT conversations",
  chat: "Chat JSONL (TRL, Fireworks SFT)",
  axolotl: "Axolotl messages (inline images)",
  dpo: "DPO preference pairs",
  grpo: "GRPO prompts",
  "miles-math": "Miles math rows",
  "miles-vlm": "Miles image-grounded rows",
  "fireworks-rl": "Fireworks RL rows",
};

export interface RowResult {
  line: number;
  ok: boolean;
  errors: string[];
  warnings: string[];
  summary: string;
}

export interface DatasetReport {
  rows: RowResult[];
  valid: number;
  invalid: number;
  /** Counts across the file, such as turns, images and audio clips. */
  totals: Record<string, number>;
}

type Json = Record<string, unknown>;

const ROLES = new Set(["system", "developer", "user", "assistant", "tool"]);

function isObj(v: unknown): v is Json {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

interface MessageCheck {
  errors: string[];
  warnings: string[];
  images: number;
  audio: number;
  turns: number;
  assistant: number;
}

function checkMessages(messages: unknown, format: DatasetFormat, where = "messages"): MessageCheck {
  const out: MessageCheck = { errors: [], warnings: [], images: 0, audio: 0, turns: 0, assistant: 0 };
  if (!Array.isArray(messages)) {
    out.errors.push(`${where} must be a list of chat messages.`);
    return out;
  }
  if (!messages.length) out.errors.push(`${where} is empty.`);
  messages.forEach((m, i) => {
    const at = `${where}[${i}]`;
    if (!isObj(m)) {
      out.errors.push(`${at} isn't an object.`);
      return;
    }
    const role = m.role;
    if (typeof role !== "string" || !ROLES.has(role)) {
      out.errors.push(`${at}.role is ${JSON.stringify(role)}; use system, user, assistant or tool.`);
      return;
    }
    out.turns++;
    if (role === "assistant") out.assistant++;
    if (role === "system" && i > 0) out.warnings.push(`${at}: a system message usually comes first.`);
    if ("weight" in m) {
      if (format !== "chat") out.warnings.push(`${at}.weight is a Fireworks SFT field; other trainers ignore it.`);
      else if (m.weight !== 0 && m.weight !== 1) out.errors.push(`${at}.weight must be 0 (left out of the loss) or 1.`);
    }
    if ("reasoning_content" in m && role !== "assistant") out.warnings.push(`${at}: reasoning_content belongs on assistant messages.`);
    const content = m.content;
    if (typeof content === "string") {
      if (!content.trim() && !(role === "assistant" && Array.isArray(m.tool_calls))) out.warnings.push(`${at}.content is empty.`);
      if (format === "miles-vlm") out.images += (content.match(/<image>/g) ?? []).length;
      return;
    }
    if (content === null && role === "assistant" && Array.isArray(m.tool_calls)) return;
    if (!Array.isArray(content)) {
      out.errors.push(`${at}.content must be a string or a list of parts.`);
      return;
    }
    if (format === "chat" || format === "dpo" || format === "grpo" || format === "miles-math" || format === "fireworks-rl") {
      // Typed parts are fine for multimodal SFT in TRL, but these formats are text in the pages' examples.
      if (content.some((p) => isObj(p) && p.type !== "text")) out.warnings.push(`${at}: media parts aren't in this format's examples on the page.`);
    }
    let seenText = false;
    content.forEach((p, j) => {
      const pat = `${at}.content[${j}]`;
      if (!isObj(p) || typeof p.type !== "string") {
        out.errors.push(`${pat} needs a type.`);
        return;
      }
      if (p.type === "text") {
        if (typeof p.text !== "string") out.errors.push(`${pat}.text must be a string.`);
        seenText = true;
        return;
      }
      if (p.type === "image") {
        out.images++;
        if (format === "torchtitan-sft" || format === "axolotl") {
          if (typeof p.path !== "string" || !p.path) out.errors.push(`${pat} needs a path to the image file.`);
        }
        if (format === "axolotl" && seenText) out.warnings.push(`${pat}: put each image before the question it belongs to.`);
        if (role !== "user") out.warnings.push(`${pat}: images go in user messages.`);
        return;
      }
      if (p.type === "audio") {
        out.audio++;
        if (format === "axolotl") out.errors.push(`${pat}: the Axolotl recipe trains on text and images, not audio.`);
        else if (typeof p.path !== "string" || !p.path) out.errors.push(`${pat} needs a path to the audio file.`);
        else if (format === "torchtitan-sft" && !/\.wav$/i.test(p.path)) out.errors.push(`${pat}: audio must be 16-bit PCM WAV (mono, any sample rate); ${p.path} isn't a .wav.`);
        return;
      }
      if (p.type === "image_url" || p.type === "input_image") {
        out.images++;
        if (format === "torchtitan-sft" || format === "axolotl") out.errors.push(`${pat}: this recipe reads {"type": "image", "path": ...}, not ${p.type}.`);
        return;
      }
      out.warnings.push(`${pat}: part type ${p.type} isn't in this format.`);
    });
  });
  return out;
}

function lastRole(messages: unknown): string | null {
  if (!Array.isArray(messages) || !messages.length) return null;
  const m = messages[messages.length - 1];
  return isObj(m) && typeof m.role === "string" ? m.role : null;
}

function checkRow(row: unknown, format: DatasetFormat): Omit<RowResult, "line"> & { counts: Record<string, number> } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const counts: Record<string, number> = {};
  if (!isObj(row)) return { ok: false, errors: ["Each line must be one JSON object."], warnings, summary: "not an object", counts };

  const sft = (key = "messages") => {
    const c = checkMessages(row[key], format, key);
    errors.push(...c.errors);
    warnings.push(...c.warnings);
    counts.turns = c.turns;
    counts.images = c.images;
    counts.audio = c.audio;
    if (Array.isArray(row[key]) && (row[key] as unknown[]).length) {
      if (!c.assistant) errors.push("No assistant message: SFT learns only the assistant's replies, so this row trains nothing.");
      else if (lastRole(row[key]) !== "assistant") warnings.push("The last message isn't the assistant's: whatever follows the last reply is context only.");
    }
    return c;
  };

  switch (format) {
    case "torchtitan-sft":
    case "chat":
    case "axolotl": {
      if (format === "axolotl" && "images" in row) warnings.push("Top-level images column: Axolotl 0.19.0 keeps only the first image from it. Put every image inline in messages[*].content.");
      if (!("messages" in row)) {
        errors.push('Missing "messages".');
        break;
      }
      const c = sft();
      const media = c.images + c.audio;
      return { ok: !errors.length, errors, warnings, summary: `${c.turns} message${c.turns === 1 ? "" : "s"}${media ? `, ${c.images} image${c.images === 1 ? "" : "s"}${format === "torchtitan-sft" ? `, ${c.audio} audio` : ""}` : ""}`, counts };
    }
    case "dpo": {
      for (const key of ["prompt", "chosen", "rejected"]) if (!(key in row)) errors.push(`Missing "${key}".`);
      if (errors.length) break;
      if (typeof row.prompt !== "string") {
        const c = checkMessages(row.prompt, format, "prompt");
        errors.push(...c.errors);
        warnings.push(...c.warnings);
      }
      for (const key of ["chosen", "rejected"] as const) {
        const v = row[key];
        if (typeof v === "string") continue;
        const c = checkMessages(v, format, key);
        errors.push(...c.errors);
        if (!c.errors.length && Array.isArray(v) && v.some((m) => isObj(m) && m.role !== "assistant")) warnings.push(`${key} usually holds only the assistant's completion.`);
      }
      if (JSON.stringify(row.chosen) === JSON.stringify(row.rejected)) errors.push("chosen and rejected are the same, so the pair carries no preference.");
      return { ok: !errors.length, errors, warnings, summary: "a preference pair", counts };
    }
    case "grpo": {
      if (!("prompt" in row)) {
        errors.push('Missing "prompt".');
        break;
      }
      if (typeof row.prompt !== "string") {
        const c = checkMessages(row.prompt, format, "prompt");
        errors.push(...c.errors);
        if (!c.errors.length && lastRole(row.prompt) === "assistant") warnings.push("The prompt ends with an assistant turn; GRPO samples the completion itself.");
      }
      if ("completion" in row || "chosen" in row) warnings.push("GRPO trains on prompts only: completions are sampled online during training.");
      return { ok: !errors.length, errors, warnings, summary: "a prompt", counts };
    }
    case "miles-math": {
      if (!("prompt" in row)) errors.push('Missing "prompt" (a string or a list of chat messages).');
      if (!("label" in row)) errors.push('Missing "label", the reference answer.');
      if (errors.length) break;
      if (typeof row.prompt !== "string") {
        const c = checkMessages(row.prompt, format, "prompt");
        errors.push(...c.errors);
      }
      if (typeof row.label !== "string" && typeof row.label !== "number") errors.push("label should be the reference answer as a string.");
      if (!JSON.stringify(row.prompt).includes("boxed")) warnings.push("Ask for the final answer in \\boxed{} in the prompt: the reward matches the last \\boxed{} answer against label.");
      return { ok: !errors.length, errors, warnings, summary: `label ${JSON.stringify(row.label)}`, counts };
    }
    case "miles-vlm": {
      for (const key of ["messages", "images", "label"]) if (!(key in row)) errors.push(`Missing "${key}".`);
      if (errors.length) break;
      const c = checkMessages(row.messages, format, "messages");
      errors.push(...c.errors);
      if (!Array.isArray(row.images) || row.images.some((p) => typeof p !== "string")) errors.push("images must be a list of image paths.");
      else if (c.images !== row.images.length) errors.push(`The user turn has ${c.images} <image> placeholder${c.images === 1 ? "" : "s"} for ${row.images.length} image${row.images.length === 1 ? "" : "s"}: use one per image.`);
      counts.images = Array.isArray(row.images) ? row.images.length : 0;
      if (!JSON.stringify(row.messages).includes("boxed")) warnings.push("Ask for the final answer in \\boxed{}: the reward matches it against label.");
      return { ok: !errors.length, errors, warnings, summary: `${counts.images} image${counts.images === 1 ? "" : "s"}, label ${JSON.stringify(row.label)}`, counts };
    }
    case "fireworks-rl": {
      if (!("messages" in row)) errors.push('Missing "messages".');
      if (!("ground_truth" in row)) errors.push('Missing "ground_truth".');
      if (errors.length) break;
      const c = checkMessages(row.messages, format, "messages");
      errors.push(...c.errors);
      if (typeof row.ground_truth !== "string") errors.push("ground_truth must be a JSON string, such as \"{\\\"numbers\\\": [3, 5], \\\"target\\\": 8}\", not an object.");
      else {
        try {
          JSON.parse(row.ground_truth);
        } catch {
          errors.push("ground_truth is a string but not valid JSON.");
        }
      }
      if (c.assistant) warnings.push("RL rows don't need labeled assistant answers; the reward function scores sampled ones.");
      return { ok: !errors.length, errors, warnings, summary: "a prompt with ground_truth", counts };
    }
  }
  return { ok: false, errors, warnings, summary: "invalid", counts };
}

/** Checks a JSONL text, line by line. Blank lines are skipped, as trainers skip them. */
export function checkDataset(text: string, format: DatasetFormat): DatasetReport {
  const rows: RowResult[] = [];
  const totals: Record<string, number> = {};
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (e) {
      const why = e instanceof Error ? e.message.replace(/^JSON\.parse: /, "") : "invalid JSON";
      rows.push({ line: i + 1, ok: false, errors: [`Not valid JSON: ${why}. Each line must be one complete JSON object.`], warnings: [], summary: "invalid JSON" });
      return;
    }
    const r = checkRow(parsed, format);
    for (const [k, v] of Object.entries(r.counts)) totals[k] = (totals[k] ?? 0) + v;
    rows.push({ line: i + 1, ok: r.ok, errors: r.errors, warnings: r.warnings, summary: r.summary });
  });
  const valid = rows.filter((r) => r.ok).length;
  return { rows, valid, invalid: rows.length - valid, totals };
}

/** Each format's sample rows, from the pages, plus one broken line so the checker has something to catch. */
export const SAMPLE_ROWS: Record<DatasetFormat, string> = {
  "torchtitan-sft": [
    '{"messages": [{"role": "user", "content": "What is 2+2?"}, {"role": "assistant", "content": "4"}]}',
    '{"messages": [{"role": "user", "content": [{"type": "image", "path": "/data/img/1.jpg"}, {"type": "text", "text": "What color is the horse?"}]}, {"role": "assistant", "content": "Brown."}]}',
    '{"messages": [{"role": "user", "content": [{"type": "audio", "path": "/data/wav/1.wav"}, {"type": "text", "text": "Transcribe this audio."}]}, {"role": "assistant", "content": "He was in a fevered state of mind."}]}',
    '{"messages": [{"role": "user", "content": [{"type": "audio", "path": "/data/mp3/2.mp3"}, {"type": "text", "text": "Transcribe this audio."}]}]}',
  ].join("\n"),
  chat: [
    '{"messages": [{"role": "system", "content": "You are a medical assistant."}, {"role": "user", "content": "What are the symptoms of type 2 diabetes?"}, {"role": "assistant", "content": "Common symptoms include increased thirst, frequent urination, fatigue, and blurred vision."}]}',
    '{"messages": [{"role": "system", "content": "You are a medical assistant."}, {"role": "user", "content": "How is hypertension diagnosed?"}, {"role": "assistant", "content": "Hypertension is diagnosed by measuring blood pressure. A reading consistently at or above 130/80 mmHg indicates hypertension."}]}',
    '{"messages": [{"role": "system", "content": "You are a helpful assistant."}, {"role": "user", "content": "What is the capital of France?"}, {"role": "assistant", "content": "Paris.", "weight": 1}]}',
    '{"messages": [{"role": "user", "content": "Explain a mutex."}, {"role": "asistant", "content": "A lock for one thread at a time."}]}',
  ].join("\n"),
  axolotl: [
    '{"messages": [{"role": "user", "content": [{"type": "image", "path": "images/page-01.png"}, {"type": "image", "path": "images/page-02.png"}, {"type": "text", "text": "Compare the totals on both pages."}]}, {"role": "assistant", "content": "The second total is 18 percent higher."}]}',
    '{"messages": [{"role": "user", "content": "Summarize the circuit in one line."}, {"role": "assistant", "content": "A 9 V battery drives two LEDs in parallel through a 330 ohm resistor."}]}',
    '{"images": ["images/page-03.png", "images/page-04.png"], "messages": [{"role": "user", "content": [{"type": "text", "text": "What changed between the pages?"}, {"type": "image", "path": "images/page-03.png"}]}, {"role": "assistant", "content": "The date."}]}',
  ].join("\n"),
  dpo: [
    '{"prompt": [{"role": "user", "content": "Explain a mutex to a new engineer."}], "chosen": [{"role": "assistant", "content": "A mutex is a lock that lets only one thread into a critical section at a time..."}], "rejected": [{"role": "assistant", "content": "A mutex is when the CPU mutexes the threads."}]}',
    '{"prompt": [{"role": "user", "content": "Is 91 prime?"}], "chosen": [{"role": "assistant", "content": "No: 91 = 7 × 13."}], "rejected": [{"role": "assistant", "content": "No: 91 = 7 × 13."}]}',
  ].join("\n"),
  grpo: [
    '{"prompt": [{"role": "user", "content": "Compute the median of 3, 9, 4, 11, 7. Put the result in <answer></answer>."}]}',
    '{"prompt": "How many vowels are in the word reinforcement? Put the count in <answer></answer>."}',
    '{"prompt": [{"role": "user", "content": "Sort b, a, c."}, {"role": "assistant", "content": "a, b, c"}]}',
  ].join("\n"),
  "miles-math": [
    '{"prompt": "Find the number of positive divisors of 360. Put the final answer in \\\\boxed{}.", "label": "24"}',
    '{"prompt": [{"role": "user", "content": "What is 2^10? Put the final answer in \\\\boxed{}."}], "label": "1024"}',
    '{"prompt": "What is the sum of the first 10 odd numbers?"}',
  ].join("\n"),
  "miles-vlm": [
    '{"messages": [{"role": "user", "content": "<image>In the diagram, angle ABC is 40 degrees. Find angle ACB. Put the final answer in \\\\boxed{}."}], "images": ["/root/datasets/geo/1.png"], "label": "70"}',
    '{"messages": [{"role": "user", "content": "<image> Compare the two triangles. Put the final answer in \\\\boxed{}."}], "images": ["/root/datasets/geo/2.png", "/root/datasets/geo/3.png"], "label": "similar"}',
  ].join("\n"),
  "fireworks-rl": [
    '{"messages": [{"role": "user", "content": "Use 3, 5 and 7 once each with + - * / to make 22."}], "ground_truth": "{\\"numbers\\": [3, 5, 7], \\"target\\": 22}"}',
    '{"messages": [{"role": "user", "content": "Use 2, 4 and 6 to make 14."}], "ground_truth": {"numbers": [2, 4, 6], "target": 14}}',
  ].join("\n"),
};
