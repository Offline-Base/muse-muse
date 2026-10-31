import catalog from "@/catalog/meta-models.json";
import { PRICES } from "@/lib/meta/pricing";
import { PRODUCT_MODELS } from "@/lib/brief/schema";
import { RETIRED_SPARK } from "@/lib/meta/spark";

/**
 * The model catalog as the brief writer sees it: hosted Model API models from catalog/meta-models.json, corrected and
 * extended with what docs/SPIKES.md measured on Oct 27, 2026. SPIKES wins where the two disagree.
 */

interface CatalogModel {
  id: string | null;
  role: string;
  hosted?: boolean;
  input?: string[];
  output?: string[];
  contextTokens?: number;
  maxOutputTokens?: number;
  status?: string;
}

/**
 * Roles that replace the catalog's where they changed: Muse Wonder is the default for a product's own text and vision
 * calls (catalog/meta-models.json still calls Spark the default). Muse Spark 1.3 isn't offered at all: the platform
 * never uses it, and the gateway serves a product that still asks for it with Spark 1.3 Contributor (lib/meta/spark.ts).
 */
const ROLES: Record<string, string> = {
  "muse-wonder-1.0": "Meta's strongest model, for reasoning, vision, video, audio input and web search",
};

/** Facts per model, from docs/SPIKES.md and docs/META_CATALOG.md. */
const FACTS: Record<string, string[]> = {
  "muse-wonder-1.0": [
    "The default for a product's own text and vision calls. Reads photos, screenshots, PDFs and short videos (MP4) directly, and returns JSON that matches a schema.",
    "Even short answers spend a few hundred reasoning tokens, billed as output, so count them in the cost.",
    "For speech, prefer muse-voice-transcribe-1.0 and then Wonder on the transcript. Wonder's audio input is untested.",
  ],
  "muse-image-1.0": [
    "Generates, edits and combines images (1 to 10 input images). Returns base64 JPEG, PNG or WebP.",
    "size sets only the aspect ratio, not exact pixels. No masks: to change one region, find it with sam-3.1, crop, edit the crop and paste it back.",
  ],
  "sam-3.1": [
    "Finds, outlines and tracks objects in a photo or a video from one short noun phrase per call (\"bird\", \"red car\"), or from box and point prompts. Returns boxes, masks and confidence.",
    "No lists, questions or negation in the prompt. At most 16 objects. Video must be MP4 or MOV (H.264, H.265 or MPEG-4), up to 15,000 frames.",
  ],
  "muse-voice-transcribe-1.0": [
    "Speech to text from a recorded file. Only mono 16-bit WAV at 16 or 24 kHz is accepted, so the product converts recordings in the browser first (the template has a helper).",
    "Returns one plain transcript: no speaker labels and no word timestamps. Products transcribe recorded files, not live streams.",
  ],
};

function priceLine(id: string): string {
  switch (id) {
    case "muse-wonder-1.0": {
      const p = PRICES[id];
      return `$${p.input} per million input tokens ($${p.cachedInput} cached), $${p.output} per million output tokens`;
    }
    case "muse-image-1.0":
      return `$${PRICES["muse-image-1.0"].perImage} per returned image`;
    case "sam-3.1": {
      const p = PRICES["sam-3.1"];
      return `about $${p.perImage} per image; video about $${p.perVideoFrame} per frame with a ${p.minVideoFrames}-frame minimum`;
    }
    case "muse-voice-transcribe-1.0":
      return `$${PRICES["muse-voice-transcribe-1.0"].perAudioHour} per audio hour`;
    default:
      return "self-hosted, no Model API cost";
  }
}

function modelBlock(m: CatalogModel): string {
  const id = m.id as string;
  const io = [m.input?.length ? `in: ${m.input.join(", ")}` : "", m.output?.length ? `out: ${m.output.join(", ")}` : ""]
    .filter(Boolean)
    .join("; ");
  const context = m.contextTokens ? `; ${Math.round(m.contextTokens / 1000)}k-token context` : "";
  const lines = [
    `- ${id}${m.status === "preview" ? " (preview)" : ""}: ${ROLES[id] ?? m.role}.`,
    `  ${io}${context}. Price: ${priceLine(id)}.`,
    ...(FACTS[id] ?? []).map((f) => `  ${f}`),
  ];
  return lines.join("\n");
}

let cached: string | null = null;

/** The catalog summary pasted into the brief writer's instructions. */
export function catalogSummary(): string {
  if (cached) return cached;
  const allowed = new Set<string>(PRODUCT_MODELS);
  // Muse Wonder first: it is the default for a product's own calls.
  const hosted = (catalog.models as CatalogModel[])
    .filter((m) => m.hosted && m.id && allowed.has(m.id) && m.id !== RETIRED_SPARK)
    .sort((a, b) => Number(b.id === "muse-wonder-1.0") - Number(a.id === "muse-wonder-1.0"));
  cached = [
    "Models a product may call, all through the Muse Muse gateway (prices are estimates):",
    ...hosted.map(modelBlock),
    "- muse-glimmer: open-weights model for local or offline use. Not on the Model API: it needs an endpoint someone hosts. Pick it only when the muse asks for local or offline use.",
    "- muse-gadget: a physical board connected to Muse Muse, with a camera and a microphone. The product can take a photo or record a few seconds of sound on the board, then pass it to a model, for example a counter that photographs a shelf. Pick it only when the muse asks for hardware: a device that watches, listens or reacts in the real world. It isn't a model, so pair it with the model that reads what it captures. A product must still work when no board is connected, with a clear message and a way to upload instead.",
    "",
    "Not available on the Model API yet, with the workaround a product uses instead:",
    "- Text-to-speech: the browser's built-in speech synthesis.",
    "- Video generation: a short image sequence from muse-image-1.0.",
    "- Embeddings: put the documents in Muse Wonder's 1M-token context (fine for small document sets).",
    "- Realtime voice conversation: record, transcribe, then reply in text.",
    "- Speaker labels in transcripts: none. Ask the user to label turns, or treat the transcript as one voice.",
    "",
    "How products run:",
    "- One Next.js app on Vercel with its own link. No database and no user accounts: anything saved stays in the user's browser (localStorage).",
    "- Requests to the product's server are capped at about 4.5 MB. Larger photos, videos and recordings upload to temporary storage first and are deleted after 24 hours.",
    "- Products reach only Meta's models, and a connected gadget when the brief picks muse-gadget. No other services or API keys: no WhatsApp, SMS, email, payments, maps, social networks or scraping other sites. When a muse needs one, build the web version and make that a limit.",
    "- Each product has a small daily model budget, so one run should cost cents, not dollars.",
  ].join("\n");
  return cached;
}
