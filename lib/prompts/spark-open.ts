import { SPARK_OPEN_BRIEF_MODEL, type Brief } from "@/lib/brief/schema";
import { env } from "@/lib/env";
import { SPARK_OPEN_CREDIT, SPARK_OPEN_PROVIDERS, sparkOpenLabel, sparkOpenProviderFrom } from "@/lib/meta/spark-open";

/**
 * What SPARK_OPEN_PRODUCTS adds to the brief writer's catalog and Muse Code's prompts (lib/gateway/spark-open.ts serves the
 * calls). Each part is empty unless env.sparkOpenProductsForBuilds is on and the brief picks muse-spark-open, so with the flag
 * off every prompt is today's.
 */

export function picksSparkOpen(brief: { capabilities?: ReadonlyArray<{ model: string }> } | null | undefined): boolean {
  return Boolean(brief?.capabilities?.some((c) => c.model === SPARK_OPEN_BRIEF_MODEL));
}

/** True when this new build's product calls Muse Spark Open: the flag, a snapshot with the helper, and a brief that picks it. */
export function usesSparkOpen(brief: { capabilities?: ReadonlyArray<{ model: string }> } | null | undefined): boolean {
  return env.sparkOpenProductsForBuilds && picksSparkOpen(brief);
}

const dollars = (n: number) => `$${n.toFixed(2)}`;

/** The catalog's line, with the configured provider's name and price. Null for an unknown SPARK_OPEN_PROVIDER, which serves nothing. */
export function sparkOpenCatalogLine(source: Record<string, string | undefined> = process.env): string | null {
  const id = sparkOpenProviderFrom(source);
  if (!id) return null;
  const { name, price } = SPARK_OPEN_PROVIDERS[id];
  return [
    `- ${SPARK_OPEN_BRIEF_MODEL}: Muse Spark Open, Meta's open-weight model, run for Muse Muse on ${name} and reached through the gateway like the others.`,
    `  in: text, image; out: text. Price: about ${dollars(price.input)} per million input tokens and ${dollars(price.output)} per million output tokens, and its reasoning counts as output.`,
    "  Pick it when the muse asks for Meta's open-weight or open-source model, or for a text step that needs no web search, audio, video or PDFs, such as sorting, extracting, rewriting or short answers. It has no web search.",
    `  Its license means the product shows "${SPARK_OPEN_CREDIT}" Never pick it for a product made for children or for students under 18.`,
  ].join("\n");
}

/** The build prompt's section for a brief that picks muse-spark-open while the flag and the snapshot allow it. In capsBuildLines. */
export function sparkOpenBuildLines(brief: Brief): string[] {
  if (!usesSparkOpen(brief)) return [];
  return [
    "",
    "### Muse Spark Open",
    "",
    "- The brief picks muse-spark-open. Read `.agents/skills/meta-spark-open/SKILL.md` first.",
    "- Every call goes through `askSparkOpen` or `sparkOpenStream` in `lib/meta/spark-open.ts`, on the server, with the incoming request. They call the Muse Muse gateway's `/v1/chat/completions` with this product's token, and the platform runs the model on its provider. Never call a provider or any other host, and never add a key.",
    `- Show the \`label\` the helper returns with every answer it writes (for example "${sparkOpenLabel(SPARK_OPEN_PROVIDERS.baseten.name)}"), and put "${SPARK_OPEN_CREDIT}" in the footer, word for word.`,
    "- Text and images in, text out. It has no web search and takes no audio, video or PDFs: use the brief's other models for those.",
    "- It reasons before it answers, and the reasoning counts toward `maxTokens`. Keep `reasoning: \"low\"` and the helper's default `maxTokens` unless a step needs more.",
    "- An answer can take half a minute or more to start. Show that it's working, and set the route's `maxDuration` to 120.",
    "- During this build its calls are real, on this build's token and budget. Assert that an answer and its label show, never what the answer says.",
  ];
}

/** What a change request adds for a product on Muse Spark Open. */
export function sparkOpenRefineLines(brief: Brief): string[] {
  if (!usesSparkOpen(brief)) return [];
  return ["", `Keep every Muse Spark Open call going through \`lib/meta/spark-open.ts\`, its \`label\` beside each answer, and "${SPARK_OPEN_CREDIT}" in the footer.`];
}

/** The judge's note for a product on Muse Spark Open, so its attribution isn't read as Meta's marks. Empty otherwise. */
export function sparkOpenJudgeNote(brief: Partial<Brief>): string {
  if (!usesSparkOpen(brief as Brief)) return "";
  return `Muse Spark Open answers in this product. "${SPARK_OPEN_CREDIT}" and a label like "${sparkOpenLabel(SPARK_OPEN_PROVIDERS.baseten.name)}" are its license's attribution and its provider's name. They are expected and fine, and don't imply Meta made the product.`;
}

/** musemuse.privacy.json's line for a product on Muse Spark Open. Both providers are named, since the platform's setting can change. */
export const SPARK_OPEN_PRIVACY_LINE =
  "To answer with Muse Spark Open, what you send passes through this app's server and Muse Muse to Baseten or Fireworks, the company Muse Muse pays to run the model. That company's own terms apply.";
