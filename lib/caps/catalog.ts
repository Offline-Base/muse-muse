import { CONNECT_CATALOG } from "@/lib/caps/connect/catalog";
import { CODE_CATALOG } from "@/lib/caps/code/catalog";
import { DATA_CATALOG } from "@/lib/caps/data/catalog";
import type { CapId } from "@/lib/caps/ids";
import { EXTENSION_CATALOG } from "@/lib/caps/extension/catalog";
import { FILES_CATALOG } from "@/lib/caps/files/catalog";
import { GAMES_CATALOG } from "@/lib/caps/games/catalog";
import { HARDWARE_CATALOG } from "@/lib/caps/hardware/catalog";
import { JOBS_CATALOG } from "@/lib/caps/jobs/catalog";
import { LIVE_CATALOG } from "@/lib/caps/live/catalog";
import { MEDIA_CATALOG, mediaPartsOn, mediaWorkarounds } from "@/lib/caps/media/catalog";
import { PLATFORM_CATALOG } from "@/lib/caps/platform/brief";
import { RUNTIME_CATALOG } from "@/lib/caps/runtime/catalog";

/**
 * What the brief writer's catalog says about each cap (docs/CAPABILITIES.md, 2.6). One line per cap, in plan order; the
 * text lives in lib/caps/<id>/catalog.ts. `name` is how the catalog's "How products run" bullets refer to it ("saved
 * rows", "scheduled jobs"), and `block` is its own section after the models, as plain bullets.
 */
export interface CapCatalogEntry {
  name: string;
  block: string;
}

export const CAP_CATALOG: Partial<Record<CapId, CapCatalogEntry>> = {
  data: DATA_CATALOG,
  files: FILES_CATALOG,
  connect: CONNECT_CATALOG,
  jobs: JOBS_CATALOG,
  live: LIVE_CATALOG,
  media: MEDIA_CATALOG,
  code: CODE_CATALOG,
  runtime: RUNTIME_CATALOG,
  hardware: HARDWARE_CATALOG,
  extension: EXTENSION_CATALOG,
  games: GAMES_CATALOG,
  platform: PLATFORM_CATALOG,
};

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

/**
 * The catalog's "Not available on the Model API yet" lines a cap replaces while it is enabled, by key: "speech" and
 * "video" (lib/prompts/catalog.ts). One line per cap, in plan order. A key no enabled cap replaces keeps today's line.
 */
export const CAP_WORKAROUNDS: Partial<Record<CapId, () => Partial<Record<"speech" | "video", string>>>> = {
  media: () => mediaWorkarounds(mediaPartsOn()),
};

/** The line an enabled cap gives for a workaround key, or null for today's line. */
export function capsWorkaround(enabled: readonly CapId[], key: "speech" | "video"): string | null {
  for (const id of enabled) {
    const line = CAP_WORKAROUNDS[id]?.()[key];
    if (line) return line;
  }
  return null;
}
