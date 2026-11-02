import catalog from "@/catalog/meta-models.json";
import { GLIMMER, SPARK } from "@/components/docs/playgrounds/open-weights/facts";
import { GLIMMER_NAME, type ResultView } from "@/components/train/results";
import { hubRepoUrl, isRepoId } from "@/components/vibe/apps";
import { groupThousands } from "@/lib/format";
import { PRICES } from "@/lib/meta/pricing";
import { RETIRED_SPARK, SPARK_STANDIN } from "@/lib/meta/spark";
import type { LocalFiles } from "@/lib/train/local-files";
import { ADAPTER_RECIPE } from "@/lib/train/logic";

/**
 * What /models shows, as pure functions over the platform's own data: the hosted models Muse Muse calls (from the
 * brief writer's catalog, catalog/meta-models.json, priced from lib/meta/pricing.ts) and the lab's tuned Glimmer models
 * (from the Lab results). Nothing here reads the database.
 */

/** The call counts cover this many days of usage records. */
export const CALL_DAYS = 30;

/** What a model takes in or gives back, as the "All modalities" filter on /models names it. */
export type Modality = "text" | "image" | "video" | "audio";

/** One key and value row at the bottom of a card. */
export interface ModelRow {
  label: string;
  value: string;
}

/** A pill button on a card. Only links to a real place. */
export interface ModelLink {
  label: string;
  href: string;
  external?: boolean;
}

/** A hosted model as /models shows it. */
export interface HostedModelView {
  id: string;
  name: string;
  /** What Muse Muse uses it for. */
  use: string;
  /** Its prices as key and value rows, as Muse Muse estimates them. */
  rows: ModelRow[];
  /** In preview on Meta's side. */
  preview: boolean;
  /** For tests and examples only. */
  testOnly: boolean;
  /** A short second line, or null. */
  note: string | null;
  /** Calls in the usage records over the last CALL_DAYS days, or null when they couldn't be read. */
  calls: number | null;
}

/** "$4", "$0.20", "$0.002". */
export function dollars(n: number): string {
  if (Number.isInteger(n)) return `$${n}`;
  return Math.abs(Math.round(n * 100) - n * 100) < 1e-9 ? `$${n.toFixed(2)}` : `$${n}`;
}

function tokenRows(p: { input: number; cachedInput: number; output: number }): ModelRow[] {
  return [
    { label: "Input", value: `${dollars(p.input)} / 1M tokens` },
    { label: "Cached input", value: `${dollars(p.cachedInput)} / 1M tokens` },
    { label: "Output", value: `${dollars(p.output)} / 1M tokens` },
  ];
}

const sam = PRICES["sam-3.1"];

/**
 * The hosted models Muse Muse calls, in the order /models lists them: Muse Wonder first, the default everywhere, and
 * Spark 1.3 Contributor last, since only tests and examples use it. Muse Spark 1.3 itself isn't here: Muse Muse never
 * calls it (lib/meta/spark.ts). Uses follow docs/META_CATALOG.md, "How Muse Muse uses them".
 */
const HOSTED: ReadonlyArray<Omit<HostedModelView, "preview" | "calls">> = [
  {
    id: "muse-wonder-1.0",
    name: "Muse Wonder",
    use: "Every platform role: writing briefs and checking them, Muse Code's builds and fixes, and judging screenshots. The default for a product's own text and vision calls, and the fine-tuning lab's writer and judge.",
    rows: tokenRows(PRICES["muse-wonder-1.0"]),
    testOnly: false,
    note: "Reasoning is billed as output, so even short answers cost a few hundred tokens.",
  },
  {
    id: "muse-image-1.0",
    name: "Muse Image",
    use: "Inside products, to make and edit images.",
    rows: [{ label: "Image", value: `${dollars(PRICES["muse-image-1.0"].perImage)} per image` }],
    testOnly: false,
    note: null,
  },
  {
    id: "sam-3.1",
    name: "SAM 3.1",
    use: "Inside products, to find, outline and track objects in photos and video.",
    rows: [
      { label: "Image", value: `${dollars(sam.perImage)} per image` },
      { label: "Video", value: `${dollars(sam.perVideoFrame)} per frame, ${sam.minVideoFrames} frames at least` },
    ],
    testOnly: false,
    note: null,
  },
  {
    id: "muse-voice-transcribe-1.0",
    name: "Muse Voice Transcribe",
    use: "Turns a voice memo into text before the brief, and transcribes recordings inside products.",
    rows: [{ label: "Audio", value: `${dollars(PRICES["muse-voice-transcribe-1.0"].perAudioHour)} per audio hour` }],
    testOnly: false,
    note: null,
  },
  {
    id: SPARK_STANDIN,
    name: "Muse Spark 1.3 Contributor",
    use: "Muse Muse's model for tests and examples, which use made-up data. Meta may train on what it's sent, so new products can't pick it.",
    rows: tokenRows(PRICES[SPARK_STANDIN]),
    testOnly: true,
    note: "Older products built on Muse Spark 1.3 run on it instead, since Muse Muse doesn't call Spark 1.3 itself.",
  },
];

interface CatalogModel {
  id: string | null;
  name?: string;
  role?: string;
  hosted?: boolean;
  status?: string;
  input?: string[];
  output?: string[];
  contextTokens?: number;
  facts?: string[];
  license?: string;
}

/**
 * Spark 1.3 Contributor's row while BUILDS_ON_CONTRIBUTOR is on, when "tests and examples" would no longer be true. A
 * product published under the switch keeps running on it (lib/gateway/handler.ts), as the Privacy text says.
 */
const CONTRIBUTOR_ON_BUILDS = {
  use: "The model Muse Muse builds on right now: the brief, the build, the checks and a build's own test calls. Meta may train on what it's sent, so don't put personal, sensitive or confidential information in a build. A product published this way keeps running on it and says so.",
  testOnly: false,
};

/** Muse Wonder's row while BUILDS_ON_CONTRIBUTOR is on, when it no longer does every platform role (lib/meta/spark.ts). */
const WONDER_ON_BUILDS = "Builds run on Spark 1.3 Contributor right now. Muse Wonder still serves live products that use a gadget's or board's camera or microphone, and three demo products.";

/** The hosted models with their calls, each one only while the catalog still lists it as hosted. */
export function hostedModelViews(calls: Record<string, number> | null, opts: { buildsOnContributor?: boolean } = {}): HostedModelView[] {
  const listed = new Map((catalog.models as CatalogModel[]).filter((m) => m.hosted && m.id).map((m) => [m.id, m] as const));
  return HOSTED.flatMap((m) => {
    const entry = listed.get(m.id);
    if (!entry) return [];
    const view = { ...m, preview: entry.status === "preview", calls: calls ? (calls[m.id] ?? 0) : null };
    if (!opts.buildsOnContributor) return [view];
    return [m.id === SPARK_STANDIN ? { ...view, ...CONTRIBUTOR_ON_BUILDS } : m.id === "muse-wonder-1.0" ? { ...view, use: WONDER_ON_BUILDS } : view];
  });
}

/** A card in the main grid of /models. */
export interface ModelCardView {
  id: string;
  name: string;
  /** Meta's API id, shown under the subline. Open-weight models have none. */
  apiId: string | null;
  /** The peach pill. See cardFromHosted. */
  isNew: boolean;
  subline: string;
  description: string[];
  tags: string[];
  modalities: Modality[];
  links: ModelLink[];
  rows: ModelRow[];
}

/** "1M", "128K", as the docs' models page and Glimmer's own page write them. */
export function contextLabel(tokens: number): string {
  return tokens >= 2 ** 20 ? `${Math.round(tokens / 2 ** 20)}M` : `${Math.round(tokens / 2 ** 10)}K`;
}

/** The modalities named in a catalog entry's input and output. PDFs and SAM's masks aren't filter options. */
export function modalitiesOf(m: Pick<CatalogModel, "input" | "output">): Modality[] {
  const words = [...(m.input ?? []), ...(m.output ?? [])].map((w) => w.split(" ")[0]);
  return (["text", "image", "video", "audio"] as const).filter((k) => words.includes(k));
}

/** How many cards each filter option shows, for the words a screen reader hears when the filter changes. */
export function modalityCounts(cards: ReadonlyArray<ReadonlyArray<Modality>>): Record<Modality, number> {
  const count = (k: Modality) => cards.filter((c) => c.includes(k)).length;
  return { text: count("text"), image: count("image"), video: count("video"), audio: count("audio") };
}

/** The modalities the catalog writes out in Muse Spark Open's and Glimmer's facts, since those entries have no input list. */
const SPARK_OPEN_MODALITIES: Modality[] = ["text", "image", "video", "audio"];
export const GLIMMER_MODALITIES: Modality[] = ["text", "image"];

const specs = (anchor: string): ModelLink => ({ label: "Model specs", href: `/docs/models#${anchor}` });
const docs = (href: string): ModelLink => ({ label: "Documentation", href });
const tryIt = (slug: string): ModelLink => ({ label: "Try in playground", href: `/docs/${slug}#try-it-live` });

/**
 * What each hosted card says and links to. The playground is the live demo panel on a docs page (lib/docs/demos). Spark
 * 1.3 has no playground link: the docs' demos run it as Spark 1.3 Contributor (lib/docs/proxy/policy.ts).
 */
const CARD_FACTS: Record<string, { kind: string; links: ModelLink[] }> = {
  "muse-wonder-1.0": { kind: "Chat", links: [tryIt("overview"), specs("muse-wonder"), docs("/docs/quickstart")] },
  [RETIRED_SPARK]: { kind: "Chat", links: [specs("muse-spark"), docs("/docs/quickstart")] },
  [SPARK_STANDIN]: { kind: "Chat", links: [tryIt("overview"), specs("muse-spark"), docs("/docs/pricing-rate-limits#contributor-mode")] },
  "muse-image-1.0": { kind: "Image generation", links: [tryIt("image-generation"), specs("muse-image"), docs("/docs/image-generation")] },
  "sam-3.1": { kind: "Image and video segmentation", links: [tryIt("media-segmentation"), specs("sam-3"), docs("/docs/sam/overview")] },
  "muse-voice-transcribe-1.0": { kind: "Speech to text", links: [tryIt("speech-to-text"), specs("muse-voice-transcribe"), docs("/docs/speech-to-text")] },
};

/** The grid's order, from the owner's screenshot of Meta's page. Models it didn't show come after. */
const CARD_ORDER = ["muse-wonder-1.0", "muse-spark-open", "sam-3.1", RETIRED_SPARK, SPARK_STANDIN, "muse-voice-transcribe-1.0", "muse-image-1.0", "muse-glimmer"];

function hostedSubline(entry: CatalogModel | undefined, kind: string, contextTokens: number | undefined): string {
  const context = entry?.contextTokens ?? contextTokens;
  return context ? `Context ${contextLabel(context)} · ${kind}` : kind;
}

function openEntry(name: string): CatalogModel | undefined {
  return (catalog.models as CatalogModel[]).find((m) => !m.hosted && m.name === name);
}

/**
 * Every card in the main grid: the hosted models with their calls, Spark 1.3, which Muse Muse doesn't call but Meta
 * offers, and the two open-weight models. A model the catalog drops loses its card. The repo has no release dates, so
 * "New" follows the one thing it does record: the catalog's status "preview".
 */
export function modelCards(hosted: HostedModelView[]): ModelCardView[] {
  const models = catalog.models as CatalogModel[];
  const entryOf = (id: string) => models.find((m) => m.id === id);
  const spark = entryOf(RETIRED_SPARK);
  const cards: ModelCardView[] = hosted.map((m) => {
    const entry = entryOf(m.id);
    const facts = CARD_FACTS[m.id];
    return {
      id: m.id,
      name: m.name,
      apiId: m.id,
      isNew: m.preview,
      // The docs give every Muse Spark version the same context; the catalog writes it on Spark 1.3 alone.
      subline: hostedSubline(entry, facts.kind, m.id === SPARK_STANDIN ? spark?.contextTokens : undefined),
      description: m.note ? [m.use, m.note] : [m.use],
      tags: [...(m.testOnly ? ["Tests and examples only"] : []), ...(m.preview ? ["Preview"] : [])],
      modalities: modalitiesOf(entry ?? {}),
      links: facts.links,
      rows: m.calls === null ? m.rows : [...m.rows, { label: `Calls, ${CALL_DAYS} days`, value: groupThousands(m.calls) }],
    };
  });
  if (spark?.hosted) {
    cards.push({
      id: RETIRED_SPARK,
      name: "Muse Spark 1.3",
      apiId: RETIRED_SPARK,
      isNew: spark.status === "preview",
      subline: hostedSubline(spark, CARD_FACTS[RETIRED_SPARK].kind, undefined),
      description: ["Meta's model for agentic and coding work. Muse Muse doesn't call it: anything that would run on it runs on Muse Spark 1.3 Contributor."],
      tags: [],
      modalities: modalitiesOf(spark),
      links: CARD_FACTS[RETIRED_SPARK].links,
      rows: tokenRows(PRICES[RETIRED_SPARK]),
    });
  }
  const sparkOpen = openEntry("Muse Spark Open");
  if (sparkOpen) {
    cards.push({
      id: "muse-spark-open",
      name: "Muse Spark Open",
      apiId: null,
      isNew: false,
      subline: `Context ${contextLabel(SPARK.contextTokens)} · Open weights`,
      description: [`${sparkOpen.role}: ${(sparkOpen.facts ?? []).join("; ")}.`],
      tags: [],
      modalities: SPARK_OPEN_MODALITIES,
      links: [
        { label: "Download", href: "/docs/muse-spark-open/get-the-model" },
        specs("muse-spark-open"),
        docs("/docs/muse-spark-open"),
      ],
      rows: [
        { label: "Access", value: "Download and self-host" },
        { label: "License", value: "Muse Model License" },
      ],
    });
  }
  const glimmer = openEntry("Muse Glimmer");
  if (glimmer) {
    cards.push({
      id: "muse-glimmer",
      name: GLIMMER_NAME,
      apiId: null,
      isNew: false,
      subline: `Context ${contextLabel(GLIMMER.contextTokens)} · Open weights`,
      description: [],
      tags: [],
      modalities: GLIMMER_MODALITIES,
      links: [
        { label: "Download", href: "/docs/muse-glimmer/get-the-model" },
        specs("muse-glimmer"),
        { label: "Glimmer docs", href: "/docs/muse-glimmer" },
        { label: "Lab results", href: "/fine-tuning" },
      ],
      rows: [
        { label: "Access", value: "Download and self-host" },
        { label: "License", value: glimmer.license ?? "" },
      ].filter((r) => r.value),
    });
  }
  const rank = (id: string) => CARD_ORDER.indexOf(id);
  return cards.sort((a, b) => rank(a.id) - rank(b.id));
}

/** A tuned Glimmer model as /models lists it. Links are there only when the Lab data says they're public. */
export interface TunedModelView {
  id: string;
  title: string;
  tunedWins: number;
  items: number;
  /** The adapter's model repo on the Hugging Face Hub, once published and public. */
  hubUrl: string | null;
  /** Its GGUF files, once their repo and the adapter are both public. */
  gguf: { repoUrl: string; runHref: string } | null;
  /** True for a model trained from r30b, a Derivative of Muse Spark Open (ResultView.sparkOpen, lib/train/base.ts). */
  sparkOpen: boolean;
  /**
   * For decide-kind results: show accuracy instead of wins (lib/decide/types.ts: kind tells pages to show these
   * numbers instead). Mirrors JobPanel and LabResults "(Tuned|Base) right on X of Y". Null for judged chat jobs.
   */
  decision: { tuned: boolean; right: number } | null;
}

/** The judged glimmer-lora jobs, in the order given. Other recipes' results aren't models. */
export function tunedModelViews(results: ResultView[], localFiles: Map<string, LocalFiles | null>): TunedModelView[] {
  return results
    .filter((r) => r.recipe === ADAPTER_RECIPE)
    .map((r) => {
      const files = r.hub ? (localFiles.get(r.id) ?? null) : null;
      const linkable = files && files.public && files.adapterJobId === r.id && isRepoId(files.repo) && files.files.length > 0;
      return {
        id: r.id,
        title: r.title,
        tunedWins: r.summary.tunedWins,
        items: r.summary.items,
        hubUrl: r.hub?.modelUrl ?? null,
        gguf: linkable ? { repoUrl: hubRepoUrl(files.repo as string), runHref: `/fine-tuning/${r.id}/run` } : null,
        sparkOpen: r.sparkOpen === true,
        decision: r.decision ? { tuned: Boolean(r.decision.tuned), right: (r.decision.tuned ?? r.decision.base).accuracy.right } : null,
      };
    });
}
