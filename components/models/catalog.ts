import catalog from "@/catalog/meta-models.json";
import type { ResultView } from "@/components/train/results";
import { hubRepoUrl, isRepoId } from "@/components/vibe/apps";
import { PRICES } from "@/lib/meta/pricing";
import { SPARK_STANDIN } from "@/lib/meta/spark";
import type { LocalFiles } from "@/lib/train/local-files";
import { ADAPTER_RECIPE } from "@/lib/train/logic";

/**
 * What /models shows, as pure functions over the platform's own data: the hosted models Muse Muse calls (from the
 * brief writer's catalog, catalog/meta-models.json, priced from lib/meta/pricing.ts) and the lab's tuned Glimmer models
 * (from the Lab results). Nothing here reads the database.
 */

/** The call counts cover this many days of usage records. */
export const CALL_DAYS = 30;

/** A hosted model as /models shows it. */
export interface HostedModelView {
  id: string;
  name: string;
  /** What Muse Muse uses it for. */
  use: string;
  /** Its price, as Muse Muse estimates it. */
  price: string;
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

function tokenPrice(p: { input: number; cachedInput: number; output: number }): string {
  return `${dollars(p.input)} in, ${dollars(p.cachedInput)} cached, ${dollars(p.output)} out per million tokens`;
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
    price: tokenPrice(PRICES["muse-wonder-1.0"]),
    testOnly: false,
    note: "Reasoning is billed as output, so even short answers cost a few hundred tokens.",
  },
  {
    id: "muse-image-1.0",
    name: "Muse Image",
    use: "Inside products, to make and edit images.",
    price: `${dollars(PRICES["muse-image-1.0"].perImage)} per image`,
    testOnly: false,
    note: null,
  },
  {
    id: "sam-3.1",
    name: "SAM 3.1",
    use: "Inside products, to find, outline and track objects in photos and video.",
    price: `${dollars(sam.perImage)} per image, ${dollars(sam.perVideoFrame)} per video frame (${sam.minVideoFrames} frames at least)`,
    testOnly: false,
    note: null,
  },
  {
    id: "muse-voice-transcribe-1.0",
    name: "Muse Voice Transcribe",
    use: "Turns a voice memo into text before the brief, and transcribes recordings inside products.",
    price: `${dollars(PRICES["muse-voice-transcribe-1.0"].perAudioHour)} per audio hour`,
    testOnly: false,
    note: null,
  },
  {
    id: SPARK_STANDIN,
    name: "Muse Spark 1.3 Contributor",
    use: "Muse Muse's model for tests and examples, which use made-up data. Meta may train on what it's sent, so new products can't pick it.",
    price: tokenPrice(PRICES[SPARK_STANDIN]),
    testOnly: true,
    note: "Older products built on Muse Spark 1.3 run on it instead, since Muse Muse doesn't call Spark 1.3 itself.",
  },
];

interface CatalogModel {
  id: string | null;
  hosted?: boolean;
  status?: string;
}

/** Spark 1.3 Contributor's row while BUILDS_ON_CONTRIBUTOR is on, when "tests and examples" would no longer be true. */
const CONTRIBUTOR_ON_BUILDS = {
  use: "The model Muse Muse builds on right now: the brief, the build, the checks and a build's own test calls. Meta may train on what it's sent, so don't put personal, sensitive or confidential information in a build. Live products don't run on it.",
  testOnly: false,
};

/** The hosted models with their calls, each one only while the catalog still lists it as hosted. */
export function hostedModelViews(calls: Record<string, number> | null, opts: { buildsOnContributor?: boolean } = {}): HostedModelView[] {
  const listed = new Map((catalog.models as CatalogModel[]).filter((m) => m.hosted && m.id).map((m) => [m.id, m] as const));
  return HOSTED.flatMap((m) => {
    const entry = listed.get(m.id);
    if (!entry) return [];
    const view = { ...m, preview: entry.status === "preview", calls: calls ? (calls[m.id] ?? 0) : null };
    return [opts.buildsOnContributor && m.id === SPARK_STANDIN ? { ...view, ...CONTRIBUTOR_ON_BUILDS } : view];
  });
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
