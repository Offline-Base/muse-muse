import resources from "@/catalog/meta-resources.json";
import type { RebuildTarget } from "@/lib/types";

/** A model Meta has no demo video for yet (the catalog's `missing` list). */
export interface MissingDemo {
  id: string;
  model: string;
  why: string;
  note: string;
}

export type CatalogItem = { kind: "video"; video: RebuildTarget } | { kind: "missing"; missing: MissingDemo };

const videos = resources.videos as RebuildTarget[];
const missing = resources.missing as MissingDemo[];

export function catalogItems(): CatalogItem[] {
  return [
    ...videos.map((video): CatalogItem => ({ kind: "video", video })),
    ...missing.map((m): CatalogItem => ({ kind: "missing", missing: m })),
  ];
}

/**
 * Whether the no-ids batch (POST /api/rebuilds with no ids, npm run rebuild-all with no ids) may pick this item. Lessons
 * marked autoBuild false are planned and wait on the owner's spend decision, so they are built only when named by id.
 */
export function inDefaultBatch(item: CatalogItem): boolean {
  return item.kind === "missing" || item.video.autoBuild !== false;
}

export function catalogItem(id: string): CatalogItem | null {
  return catalogItems().find((item) => itemId(item) === id) ?? null;
}

export function itemId(item: CatalogItem): string {
  return item.kind === "video" ? item.video.id : item.missing.id;
}

export function itemTitle(item: CatalogItem): string {
  return item.kind === "video" ? item.video.title : `First ${item.missing.model} demo`;
}

/**
 * The RebuildTarget the brief writer and build prompt get. Missing demos have no video, so they get a synthetic target
 * with an empty url that names the model and the job.
 */
export function rebuildTargetFor(id: string | null | undefined): RebuildTarget | null {
  if (!id) return null;
  const item = catalogItem(id);
  if (!item) return null;
  if (item.kind === "video") return item.video;
  const m = item.missing;
  return {
    id: m.id,
    title: itemTitle(item),
    url: "",
    era: "none",
    demonstrates: m.why,
    rebuild: { fit: "clean", models: [m.model], plan: m.note, note: m.note },
  };
}

function sentence(text: string): string {
  const t = text.trim();
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

/** The note a batch rebuild starts from: the item's rebuild note plus its title and link. */
export function rebuildNote(item: CatalogItem): string {
  if (item.kind === "video") {
    const v = item.video;
    return [
      sentence(v.rebuild.note),
      `This is Muse Muse's version of Meta's lesson "${v.title}" (${v.url}) on current Muse models, for the Learn section.`,
      `It demonstrates: ${sentence(v.demonstrates)} Plan: ${sentence(v.rebuild.plan)}`,
    ].join("\n\n");
  }
  const m = item.missing;
  return [sentence(m.note), `This is the first demo for ${m.model}. ${sentence(m.why)}`].join("\n\n");
}
