import type { Brief } from "@/lib/brief/schema";
import { usesSharedGlimmer } from "@/lib/caps/gpu/marker";

/** The build prompt's section for a brief that picks muse-glimmer while the shared endpoint is on. In capsBuildLines. */
export function gpuBuildLines(brief: Brief): string[] {
  if (!usesSharedGlimmer(brief)) return [];
  return [
    "",
    "### Hosted Muse Glimmer",
    "",
    "- The brief picks muse-glimmer. On Muse Muse it runs only during demo windows, so most of the time this product answers with Muse Wonder and says so. Read `.agents/skills/meta-glimmer/SKILL.md` first.",
    '- Every Glimmer answer goes through `askGlimmer({ messages, own, request })` in `lib/meta/glimmer.ts`, on the server. It returns `{ text, by, note }`, and it falls back to Muse Wonder by itself. Set `own: true` when the brief says this product should use its own trained model.',
    "- Show `note` next to the answer whenever it isn't null. Never say a person wrote an answer. Muse Glimmer's license and usage policy pass down to this product.",
    "- A Glimmer answer can take over a minute. Show that it's working, and set the route's `maxDuration` to 300.",
    "- During this build the gateway answers with sample replies, not a model. Don't assert their words.",
    `- The smoke test proves two things: a reply shows, and with the header \`x-musemuse-glimmer-test: closed\` on the page's requests (\`page.setExtraHTTPHeaders\`) the product still answers and shows the note. Pass the incoming request to \`askGlimmer\` so the header reaches the gateway.`,
    "- The line in `template/AGENTS.md` about reaching only the Meta API still holds: this goes through the Muse Muse gateway.",
  ];
}

/** What a change request adds for a product on the shared endpoint. */
export function gpuRefineLines(brief: Brief): string[] {
  if (!usesSharedGlimmer(brief)) return [];
  return ["", "If `lib/meta/glimmer.ts` has `askGlimmer`, keep every Muse Glimmer answer going through it and keep showing its `note`. If it doesn't, this product was built before the hosted Muse Glimmer: leave its Glimmer code as it is, and it keeps answering with Muse Wonder."];
}
