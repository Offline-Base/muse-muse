import { GLIMMER_CATALOG_LINE } from "@/lib/caps/gpu/catalog";
import catalog from "@/catalog/meta-models.json";
import { PRICES } from "@/lib/meta/pricing";
import { PRODUCT_MODELS } from "@/lib/brief/schema";
import { capsCatalogBlocks, capsWorkaround, howProductsRun } from "@/lib/caps/catalog";
import { codePartsKey } from "@/lib/caps/code/parts";
import { connectOptions } from "@/lib/caps/connect/flags";
import type { CapId } from "@/lib/caps/ids";
import { env } from "@/lib/env";
import { RETIRED_SPARK } from "@/lib/meta/spark";
import { RUN_LIMITS } from "@/lib/gateway/runs";
import { WEB_SEARCH_USD_PER_QUERY } from "@/lib/meta/pricing";
import toolCatalog from "@/lib/tools/composio/catalog.json";
import { BUILTIN_TOOL_IDS, PERSONAL_TOOL_IDS, PUBLIC_TOOL_IDS, type ToolId } from "@/lib/tools/ids";

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

/** What each agent tool is for, as the brief writer reads it. Third-party tools say what Meta's search can't do. */
const TOOL_USES: Record<ToolId, string> = {
  web_search:
    "Meta's own web search, built into Muse Wonder and the only general web search. One search runs several queries, opens pages from its results and finds text in them, and its answers link their sources. Pick it first, and pick it for news too.",
  scholar: "structured records of scholarly papers, with authors, years and citation counts. Only when the product needs those fields, which web_search can't return.",
  places: "structured records of nearby places, with addresses, hours and ratings. Only when the product needs those fields, which web_search can't return.",
  events: "structured records of upcoming events, with dates and venues. Only when the product needs those fields, which web_search can't return.",
  read_page: "opens one link the person gave. Only for addresses found in the person's own input, because web_search opens only its own results.",
  gmail_read: "searches and reads the owner's Gmail.",
  gmail_draft: "saves a draft in the owner's Gmail. Nothing is sent.",
  gmail_send: "sends an email from the owner's Gmail, to at most 5 people and 10 times a day. It asks for a confirmation every time.",
  calendar_read: "reads the owner's Google Calendar.",
  calendar_add: "adds an event to the owner's Google Calendar. It asks for a confirmation every time.",
  slack_read: "finds channels and reads their recent messages in the owner's Slack.",
  slack_search: "searches messages in the owner's Slack.",
  slack_send: "posts a message in the owner's Slack, at most 10 times a day. It asks for a confirmation every time.",
};

/** The price a tool's own generated catalog entry lists. */
function toolPrice(id: ToolId): string {
  if ((BUILTIN_TOOL_IDS as readonly string[]).includes(id)) return `$${WEB_SEARCH_USD_PER_QUERY} per query`;
  const entry = toolCatalog.tools.find((t) => t.id === id);
  const usd = Math.max(0, ...(entry?.functions ?? []).map((f) => f.estimateUsd));
  return usd ? `$${usd} per call` : "no charge per call";
}

function toolLine(id: ToolId): string {
  return `- ${id}: ${TOOL_USES[id]} ${toolPrice(id)}.`;
}

/** The agent section of the catalog, for the writer once AGENTS_ENABLED is on. */
function agentToolsBlock(personal: boolean): string[] {
  const live = RUN_LIMITS.liveAgent;
  return [
    "",
    "Agent tools, only for a product with the agent target. Prices are estimates, on top of Muse Wonder's tokens. Pick the fewest tools that do the job, at most 6, and web_search before any other:",
    "Public tools work for everyone who opens the product:",
    ...PUBLIC_TOOL_IDS.map(toolLine),
    ...(personal
      ? [
          "Personal tools work only for the product's owner for now, on the owner's own account, after the owner connects it. A visitor can't use them:",
          ...PERSONAL_TOOL_IDS.map(toolLine),
        ]
      : []),
    "For a question that takes several steps, the product splits it into narrow searches on web_search and merges the answers. That is how the template works, not a tool to pick.",
    `One run costs turns times tokens, plus searches, plus tool prices, and is usually $0.10 to $0.30. A live run stops at ${live.turns} turns, ${live.toolCalls} built-in tool calls or $${live.usd.toFixed(2)}.`,
    "Agents can't do anything else: no other search or AI services, no payments, SMS or voice calls, no social posting, no browser automation or running code, and they never delete anything. No schedules or background runs: a person starts each run and it stops when it ends.",
  ];
}

const cached = new Map<string, string>();

/**
 * The catalog summary pasted into the brief writer's instructions. With caps on (docs/CAPABILITIES.md, 2.6), the first
 * and third "How products run" bullets come from howProductsRun and each cap's block follows the agent block. With none
 * on, the text is today's, byte for byte.
 */
export function catalogSummary(caps: readonly CapId[] = env.enabledCaps): string {
  const gadgets = env.gadgetsEnabled;
  const agents = env.agentsEnabled;
  const personal = agents && env.composioPersonalEnabled;
  // Wave 3, unit 3: the data cap's block follows DATA_SIGN_IN, so it is part of the key only while data is on.
  // Unit 8: the media cap names only its parts that are on, so they are part of the key only while media is on.
  // Wave 3, unit 5 (connect): its block names keys and sends only while they are on, so they are part of the key only
  // while connect is on.
  const connectKey = caps.includes("connect") ? `|${connectOptions().vault}|${connectOptions().sends}` : "";
  // End unit 5.
  // Wave 3, unit 9: the code cap's block names only its parts that are on, so they are part of the key while code is on.
  // Wave 3, unit 13: the hardware cap's block names board tools only while they are on.
  const gpuOn = env.gpuGlimmerForBuilds;
  const key = `${gadgets}|${agents}|${personal}|${caps.join(",")}${gpuOn ? "|gpu" : ""}${caps.includes("data") ? `|${env.dataSignIn}` : ""}${caps.includes("live") ? `|live:${env.liveUpdates}` : ""}${caps.includes("media") ? `|${env.mediaParts.join(",")}` : ""}${connectKey}${caps.includes("code") ? `|code:${codePartsKey()}` : ""}${caps.includes("hardware") ? `|board:${env.hardwareBoardToolsUsable}` : ""}${caps.includes("hardware") && env.driveToolsUsable ? "|drive" : ""}`;
  const hit = cached.get(key);
  if (hit) return hit;
  const run = howProductsRun(caps, { gadgets, agents });
  const allowed = new Set<string>(PRODUCT_MODELS);
  // Muse Wonder first: it is the default for a product's own calls.
  const hosted = (catalog.models as CatalogModel[])
    .filter((m) => m.hosted && m.id && allowed.has(m.id) && m.id !== RETIRED_SPARK)
    .sort((a, b) => Number(b.id === "muse-wonder-1.0") - Number(a.id === "muse-wonder-1.0"));
  const summary = [
    "Models a product may call, all through the Muse Muse gateway (prices are estimates):",
    ...hosted.map(modelBlock),
    // Wave 3, unit 11 (docs/CAPABILITIES.md, section 17): the shared endpoint's line while it's on.
    gpuOn ? GLIMMER_CATALOG_LINE : "- muse-glimmer: open-weights model for local or offline use. Not on the Model API: it needs an endpoint someone hosts. Pick it only when the muse asks for local or offline use.",
    ...(gadgets ? ["- muse-gadget: a physical board connected to Muse Muse, with a camera and a microphone. The product can take a photo or record a few seconds of sound on the board, then pass it to a model, for example a counter that photographs a shelf. Pick it only when the muse asks for hardware: a device that watches, listens or reacts in the real world. It isn't a model, so pair it with the model that reads what it captures. A product must still work when no board is connected, with a clear message and a way to upload instead."] : []),
    "",
    "Not available on the Model API yet, with the workaround a product uses instead:",
    // Wave 3, unit 8 (docs/CAPABILITIES.md, section 14): the media cap replaces these two while its part is on.
    capsWorkaround(caps, "speech") ?? "- Text-to-speech: the browser's built-in speech synthesis.",
    capsWorkaround(caps, "video") ?? "- Video generation: a short image sequence from muse-image-1.0.",
    "- Embeddings: put the documents in Muse Wonder's 1M-token context (fine for small document sets).",
    "- Realtime voice conversation: record, transcribe, then reply in text.",
    "- Speaker labels in transcripts: none. Ask the user to label turns, or treat the transcript as one voice.",
    "",
    "How products run:",
    run?.first ?? "- One Next.js app on Vercel with its own link. No database and no user accounts: anything saved stays in the user's browser (localStorage).",
    "- Requests to the product's server are capped at about 4.5 MB. Larger photos, videos and recordings upload to temporary storage first and are deleted after 24 hours.",
    run?.third ??
      `- Products reach only Meta's models${gadgets ? ", and a connected gadget when the brief picks muse-gadget" : ""}${agents ? ", and the agent tools below when the brief picks the agent target" : ""}. No other services or API keys: no WhatsApp, SMS, email, payments, maps, social networks or scraping other sites. When a muse needs one, build the web version and make that a limit.`,
    "- Each product has a small daily model budget, so one run should cost cents, not dollars.",
    ...(agents ? agentToolsBlock(personal) : []),
    // Wave 3 (docs/CAPABILITIES.md, 2.6): each enabled cap's block follows the agent block. None with no caps on.
    ...capsCatalogBlocks(caps),
  ].join("\n");
  cached.set(key, summary);
  return summary;
}
