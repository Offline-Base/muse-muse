/**
 * A build can plan its own model (docs/TRAINING.md "Fine-tune like a build", B): the build room's "Its own model" row
 * (components/build/OwnModelRow.tsx) prefills the tune composer from the brief, and POST /api/train/plan {fromBuildId}
 * records the plan's source as {kind: "build", buildId, productId}. Pure, so the row (a client component), the routes
 * and the tests share it.
 */
import type { Brief } from "@/lib/brief/schema";
import { NOTE_MAX } from "@/lib/train/tune/settings";

/** The tune composer's draft id (writeComposerDraft), so the row's Plan it fills the box the composer opens with. */
export const TUNE_DRAFT_ID = "tune";

/** The query /fine-tuning/new reads the build from. */
export const FROM_BUILD_PARAM = "fromBuild";

/**
 * What the build page offers a build's own model with: null unless TUNE_FROM_BUILDS and TUNE_COMPOSER are on and the
 * viewer owns the product or is an admin. `canPlan`: the viewer may use the tune composer today (admins only through
 * Nov 4, as /fine-tuning/new is), so Plan it is a link; anyone else is told who can.
 */
export interface OwnModelOffer {
  examples: number;
  ceilings: { maxMinutes: number; maxUsd: number };
  canPlan: boolean;
}

/** The build page's offer (app/b/[buildId]/page.tsx), from the flags and who is viewing. */
export function ownModelOffer(i: {
  fromBuilds: boolean;
  composer: boolean;
  hasProduct: boolean;
  /** canActAsOwner(viewer, the product's owner): the owner, or an admin. */
  ownerOrAdmin: boolean;
  isAdmin: boolean;
  examples: number;
  ceilings: { maxMinutes: number; maxUsd: number };
}): OwnModelOffer | null {
  if (!i.fromBuilds || !i.composer || !i.hasProduct || !i.ownerOrAdmin) return null;
  return { examples: i.examples, ceilings: i.ceilings, canPlan: i.isAdmin };
}

/** The composer's address for planning a build's own model. */
export function planFromBuildHref(buildId: string): string {
  return `/fine-tuning/new?${FROM_BUILD_PARAM}=${encodeURIComponent(buildId)}`;
}

/** What the brief says its own Muse Glimmer should do (the muse-glimmer capability's need), or null when it picked none. */
export function glimmerNeed(brief: Pick<Brief, "capabilities"> | null | undefined): string | null {
  const pick = brief?.capabilities.find((c) => c.model === "muse-glimmer");
  if (!pick) return null;
  return pick.need.trim() || "the product's own answers";
}

/** True when the build room may offer its own model: the brief picked muse-glimmer and the build is live or partial. */
export function offersOwnModel(brief: Pick<Brief, "capabilities"> | null | undefined, status: string | null | undefined): boolean {
  return (status === "live" || status === "partial") && glimmerNeed(brief) !== null;
}

function sentence(text: string): string {
  const t = text.trim().replace(/\s+/g, " ");
  if (!t) return "";
  const up = t[0]!.toUpperCase() + t.slice(1);
  return /[.!?]$/.test(up) ? up : `${up}.`;
}

/**
 * The note the composer opens with: what the model should learn (the capability's need), the product it is for and
 * its tagline, who uses it, and the product's main steps. At most NOTE_MAX characters.
 */
export function ownModelNote(brief: Pick<Brief, "capabilities" | "name" | "tagline" | "user" | "primaryFlow">): string {
  const need = glimmerNeed(brief) ?? "the product's own answers";
  const flow = brief.primaryFlow.map((s) => s.trim().replace(/[.!?]+$/, "")).filter(Boolean);
  const parts = [
    sentence(need),
    sentence(`It answers inside ${brief.name.trim()}: ${brief.tagline.trim().replace(/[.!?]+$/, "")}`),
    brief.user.trim() ? sentence(`The people using it: ${brief.user.trim()}`) : "",
    flow.length ? sentence(`In the product they ${flow.length > 1 ? "go through" : "do"}: ${flow.join("; ")}`) : "",
  ].filter(Boolean);
  const note = parts.join(" ");
  return note.length <= NOTE_MAX ? note : `${note.slice(0, NOTE_MAX - 1).trimEnd()}.`;
}
