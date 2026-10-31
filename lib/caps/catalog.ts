import type { CapId } from "@/lib/caps/ids";

/**
 * What the brief writer's catalog says about each cap (docs/CAPABILITIES.md, 2.6). One line per cap, in plan order; the
 * text lives in lib/caps/<id>/catalog.ts. `name` is how the catalog's "How products run" bullets refer to it ("saved
 * rows", "scheduled jobs"), and `block` is its own section after the models, as plain bullets.
 */
export interface CapCatalogEntry {
  name: string;
  block: string;
}

export const CAP_CATALOG: Partial<Record<CapId, CapCatalogEntry>> = {};

/** The enabled caps with a catalog entry, in plan order. */
function entries(enabled: readonly CapId[]): Array<[CapId, CapCatalogEntry]> {
  return enabled.flatMap((id) => (CAP_CATALOG[id] ? [[id, CAP_CATALOG[id]] as [CapId, CapCatalogEntry]] : []));
}

function list(names: string[]): string {
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/**
 * The first and third "How products run" bullets when caps are on. lib/prompts/catalog.ts uses today's bullets when
 * this returns null, which it does whenever no enabled cap has an entry.
 */
export function howProductsRun(
  enabled: readonly CapId[],
  opts: { gadgets: boolean; agents?: boolean },
): { first: string; third: string } | null {
  const on = entries(enabled);
  if (!on.length) return null;
  const names = list(on.map(([, e]) => e.name));
  return {
    first: `- One Next.js app on Vercel with its own link. Without a platform service it has no database and no user accounts, and anything saved stays in the user's browser (localStorage). The platform services below add ${names}, only when the brief picks them.`,
    third: `- Products reach only Meta's models${opts.gadgets ? ", a connected gadget when the brief picks muse-gadget" : ""}${opts.agents ? ", the agent tools below when the brief picks the agent target" : ""} and the platform services below. No other services or API keys: no WhatsApp, SMS, email, payments, maps, social networks or scraping other sites, unless a platform service below says otherwise. When a muse needs one, build the web version and make that a limit.`,
  };
}

/** Each enabled cap's catalog section, in plan order. Empty when none has an entry. */
export function capsCatalogBlocks(enabled: readonly CapId[]): string[] {
  const on = entries(enabled);
  if (!on.length) return [];
  return ["", "Platform services a product may use, when the brief picks them:", ...on.map(([, e]) => e.block)];
}
