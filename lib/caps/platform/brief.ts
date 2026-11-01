import { z } from "zod";
import type { Brief } from "@/lib/brief/schema";
import type { CapCatalogEntry } from "@/lib/caps/catalog";
import type { CapRenderEntry } from "@/lib/caps/render";

/**
 * The platform powers' brief block (docs/PLATFORM_POWERS.md): a product that itself builds products, for its owner.
 *
 *   sandboxes  run build tasks in sandboxes of its own ({GATEWAY_URL}/platform/sandboxes)
 *   gateway    hand out metered model keys for what it makes ({GATEWAY_URL}/platform/keys)
 *   publish    build and publish products of its own ({GATEWAY_URL}/platform/products)
 */
export const PlatformBriefBlock = z.object({
  sandboxes: z.boolean(),
  gateway: z.boolean(),
  publish: z.boolean(),
});

export type PlatformBrief = z.infer<typeof PlatformBriefBlock>;
export type Power = keyof PlatformBrief;

export function platformBlock(brief: object | null | undefined): PlatformBrief | null {
  const block = (brief as { platform?: PlatformBrief | null } | null | undefined)?.platform;
  return block && typeof block === "object" ? block : null;
}

export const PLATFORM_WRITER_RULES = [
  "- platform: fill this only when the person asks for a product that itself builds, runs or publishes other products or apps for its owner, such as their own app builder. sandboxes runs its build tasks in sandboxes, gateway gives what it makes metered model keys, and publish builds and publishes new products. Turn on only the ones it needs. Otherwise null.",
];

export const PLATFORM_CATALOG: CapCatalogEntry = {
  name: "platform powers",
  block:
    "- platform (platform powers): for the product's owner only, a product may run build tasks in its own sandboxes, hand out metered model keys, and build and publish new products. Each product has a hard daily spending limit, and the products it starts can't have these powers themselves. Visitors can't use them.",
};

export const PLATFORM_RENDER: CapRenderEntry = {
  title: "Platform powers",
  build(brief: Brief) {
    const block = platformBlock(brief);
    if (!block) return [];
    const on = [...(block.sandboxes ? ["`sandboxes`"] : []), ...(block.gateway ? ["`keys`"] : []), ...(block.publish ? ["`products`"] : [])];
    return [
      `The brief asks for these powers: ${on.join(", ") || "none"}.`,
      "",
      "- Read `.agents/skills/muse-platform/SKILL.md` first. It has every helper in `lib/platform/powers.ts`, what each returns, and the smoke test's rules.",
      "- Call them only from server routes, with the owner's pass. Visitors can't use them, so show them only to the owner.",
      "- Show `spentTodayUsd` and `dailyLimitUsd` from `powers()` next to what spends them, and say so plainly when a call answers `quota_exceeded`.",
      "- During this build every call answers `simulated: true` and spends nothing. Don't treat a simulated answer as a real product, and test the screens with it.",
      "- A key is shown once. Show it to the owner, never store it in the browser or in a log, and never put it in code you generate into the product's own source.",
    ];
  },
};
