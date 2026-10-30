import { estimateCost, formatUsd } from "@/lib/docs/client/cost";
import { docsModelLabel } from "@/lib/docs/client/models";
import { groupThousands, plural } from "@/lib/format";

/**
 * Tokens and an estimated cost for one call, from any protocol's usage object ("1,204 in, 900 cached · 312 out,
 * 250 reasoning · $0.0002 est."). Muse Image, SAM and transcription are counted in images, frames and audio time.
 * Renders nothing when there is nothing to count.
 */
export function UsageLine({
  model,
  usage,
  images,
  webSearches,
  audioMs,
}: {
  model: string | null;
  usage: unknown;
  /** Images returned, for Muse Image. */
  images?: number;
  /** web_search calls, billed per query on top of tokens. */
  webSearches?: number;
  /** Audio transcribed, for Voice Transcribe. */
  audioMs?: number;
}) {
  const est = estimateCost(model, usage, { images, webSearches, audioMs });
  if (!est) return null;
  const parts: string[] = [];
  const t = est.tokens;
  if (t && (t.input || t.output) && model !== "muse-image-1.0") {
    parts.push(`${groupThousands(t.input)} in${t.cached ? `, ${groupThousands(t.cached)} cached` : ""}`);
    parts.push(`${groupThousands(t.output)} out${t.reasoning ? `, ${groupThousands(t.reasoning)} reasoning` : ""}`);
  }
  if (est.images) parts.push(plural(est.images, "image"));
  if (est.videoFrames) parts.push(plural(est.videoFrames, "frame"));
  if (est.audioSeconds !== undefined) parts.push(`${est.audioSeconds} s of audio`);
  if (est.webSearches) parts.push(plural(est.webSearches, "web search", "web searches"));
  const cost = est.priced
    ? `${formatUsd(est.usd)} est.`
    : `no price on record for ${model ? docsModelLabel(model) : "this model"}${est.usd ? `, searches ${formatUsd(est.usd)} est.` : ""}`;
  return (
    <span className="pg-usage" title="Estimated from the published prices. Meta's bill is what counts.">
      {[...parts, cost].join(" · ")}
    </span>
  );
}
