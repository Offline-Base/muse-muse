import { z } from "zod";
import { imagePart, type ContentPart, type MediaSource, textPart } from "@/lib/brief/media";
import { cleanStrings } from "@/lib/brief/normalize";
import { briefToMarkdown } from "@/lib/brief/render";
import type { Brief } from "@/lib/brief/schema";
import { respondStructured } from "@/lib/brief/structured";
import { env } from "@/lib/env";
import { JUDGE_INSTRUCTIONS } from "@/lib/prompts/judge";
import type { JudgeVerdict, ModelUsage, Reference, Screenshot } from "@/lib/types";

/**
 * CONTRACT (owned by the brief agent).
 *
 * Prompt 4 in docs/PROMPTS.md: the judge model (env.judgeModel, Muse Wonder by default) sees the brief, the image inspo and the screenshots, and returns
 * { pass, reasons, mismatches, blocking } as structured output. Only image references are shown to the judge; other
 * kinds are described from the brief. With no screenshots it fails, blocking, with a reason instead of calling the
 * model.
 */

/** The verdict plus whether a failure is blocking: such a product never ships, not even as partial. */
export type JudgeResult = JudgeVerdict & { blocking: boolean };

/** Field order puts the reasoning before the decision. A missing `blocking` counts as blocking. */
const VerdictSchema = z.object({
  reasons: z.array(z.string().min(1)).min(1).max(6),
  mismatches: z.array(z.string().min(1)).max(10),
  pass: z.boolean(),
  blocking: z.boolean().optional(),
});

export function toJudgeResult(data: z.infer<typeof VerdictSchema>): JudgeResult {
  const { pass, reasons, mismatches } = data;
  return { pass, reasons, mismatches, blocking: pass ? false : (data.blocking ?? true) };
}

const MAX_INSPO = 4;
const MAX_SCREENSHOTS = 4;

function remote(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

/**
 * At most four screenshots: the first, then the last ones, so the final screen is always seen. Fix rounds attach the
 * same ones, so Muse Code sees what the judge saw.
 */
export function pickScreenshots(screens: Screenshot[]): Screenshot[] {
  if (screens.length <= MAX_SCREENSHOTS) return screens;
  return [screens[0], ...screens.slice(-(MAX_SCREENSHOTS - 1))];
}

export async function judgeBuild(input: {
  brief: Brief;
  references: Reference[];
  screenshots: Screenshot[];
}): Promise<{ verdict: JudgeResult; usage: ModelUsage[]; costUsd: number }> {
  if (!input.screenshots.length) {
    // Nothing cleared the product's look, so this can't ship as partial.
    return {
      verdict: {
        pass: false,
        reasons: ["The smoke test saved no screenshots, so the judge had nothing to look at."],
        mismatches: ["Save 2 to 4 numbered full-page screenshots in test-results/judge/, ending on the final result."],
        blocking: true,
      },
      usage: [],
      costUsd: 0,
    };
  }

  const content: ContentPart[] = [];
  const sources = new Map<number, MediaSource>();
  const add = (url: string, fileName: string, contentType = guessImageType(url)) => {
    if (remote(url)) sources.set(content.length, { url, kind: "image", contentType, fileName });
    content.push(imagePart(url));
  };

  content.push(textPart(`Brief:\n\n${briefToMarkdown(input.brief)}`));

  const inspo = input.references
    .map((ref, index) => ({ ref, index }))
    .filter(({ ref }) => ref.kind === "image")
    .slice(0, MAX_INSPO);
  const others = input.references.filter((r) => r.kind !== "image");
  content.push(
    textPart(
      inspo.length
        ? `Inspiration, in order (${inspo.length} image${inspo.length === 1 ? "" : "s"}${others.length ? `; ${others.length} other reference${others.length === 1 ? " is" : "s are"} described in the brief only` : ""}):`
        : "Inspiration: no images. Any references are described in the brief.",
    ),
  );
  for (const { ref, index } of inspo) {
    const describes = input.brief.inspiration.references.find((r) => r.index === index)?.describes;
    content.push(textPart(`Inspiration ${index + 1}: ${ref.fileName}${describes ? `. ${describes.slice(0, 300)}` : ""}`));
    add(ref.url, ref.fileName, ref.contentType);
  }

  const shots = pickScreenshots(input.screenshots);
  content.push(textPart(`Screenshots, in order (${shots.length}${shots.length < input.screenshots.length ? ` of ${input.screenshots.length}` : ""}):`));
  shots.forEach((shot, i) => {
    const last = i === shots.length - 1 ? " (final screen)" : "";
    content.push(textPart(`Screenshot ${i + 1}${last}: ${shot.caption || "no caption"}`));
    add(shot.url, `screenshot-${i + 1}.png`);
  });
  content.push(textPart("Judge the product now."));

  const result = await respondStructured({
    model: env.judgeModel,
    instructions: JUDGE_INSTRUCTIONS,
    content,
    sources,
    schema: VerdictSchema,
    schemaName: "judge_verdict",
    effort: "medium",
    normalize: (raw) => cleanStrings(raw),
  });
  const costUsd = Math.round(result.usage.reduce((s, u) => s + u.costUsd, 0) * 1e6) / 1e6;
  return { verdict: toJudgeResult(result.data), usage: result.usage, costUsd };
}

function guessImageType(url: string): string {
  const path = url.split("?")[0].toLowerCase();
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".webp")) return "image/webp";
  if (path.endsWith(".gif")) return "image/gif";
  return "image/jpeg";
}
