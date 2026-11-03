/**
 * Promoting a product built on a local run (npm run dev:local) to the live site: the bundle scripts/promote-local.ts
 * sends to POST /api/admin/import-product, its strict parser, and the check that nothing in it still points at the
 * laptop. Pure, so the route, the script and the tests share it.
 *
 * A bundle holds the product's rows as the local database had them, original ids included, so Blob paths with a build
 * id in them stay that build's. It never holds a user id: the live site gives every row to its guest account. Usage
 * rows aren't in it either, since they would count against the live site's spend caps for today; a build's cost stays
 * on its row and in its cost events.
 */
import { BriefSchema, TARGETS, type Brief, type TargetId } from "@/lib/brief/schema";
import { STORED_PREFIXES } from "@/lib/local-files";
import { validateTargets } from "@/lib/native/targets";
import { normalizeSlug, SLUG_MAX } from "@/lib/pipeline/logic";
import { MAX_NOTE_CHARS, validateNote, validateReferences } from "@/lib/pipeline/references";
import { publicHost } from "@/lib/sandbox/policy";
import type { ToolFixtures } from "@/lib/tools/ids";
import { MILESTONES_MAX, type MilestoneState, type RoundPlanRecord } from "@/lib/engine/milestones";
import { TERMINAL_STATUSES, type BuildEventBody, type BuildStatus, type ProductClip, type Reference } from "@/lib/types";

/** What the import route reads: under the 4.5 MB a Vercel Function takes in a request body. */
export const IMPORT_MAX_BYTES = 4 * 1024 * 1024;
export const IMPORT_MAX_BUILDS = 100;
export const IMPORT_MAX_EVENTS = 20_000;
const IMPORT_MAX_CLIPS = 50;
const MAX_LINK = 2048;
const MAX_ERROR = 20_000;

export interface ImportInspiration {
  id: string;
  note: string | null;
  references: Reference[];
  createdAt: string;
}

export interface ImportProduct {
  id: string;
  slug: string;
  name: string;
  tagline: string;
  inspirationId: string;
  rebuildOf: string | null;
  /** musemuse.json as the product stored it. Pages read it through parseManifest, so it is kept as it is. */
  manifest: Record<string, unknown> | null;
  latestBuildId: string;
  /** The sandbox the live site deploys from: every environment shares the Vercel project's sandboxes. */
  sandboxName: string;
  museSessionId: string | null;
  demoVideoUrl: string | null;
  demoPosterUrl: string | null;
  transcriptUrl: string | null;
  /** Left out when there are none, so a product without clips makes the same bundle it always did. */
  extraClips?: ProductClip[];
  status: "live";
  createdAt: string;
  updatedAt: string;
}

export interface ImportBuild {
  id: string;
  inspirationId: string;
  kind: "build" | "refine";
  message: string | null;
  rebuildOf: string | null;
  productId: string;
  /** Always a finished one: a build still running locally would block refinements on the live site. */
  status: BuildStatus;
  step: string | null;
  brief: Brief | null;
  buildModel: string | null;
  sandboxName: string | null;
  museSessionId: string | null;
  fixRounds: number;
  previewUrl: string | null;
  costUsd: number;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  /** Left out when empty, like toolFixtures, so a build with no targets makes the same bundle it always did. */
  requestedTargets?: TargetId[];
  /** The canned tool outputs a later refinement's tests start from. */
  toolFixtures?: ToolFixtures;
  /**
   * Wave 3, unit 2 (0019_engine): the engine's round plan, sent when set. builds.live_check and gateway_tokens.build_id
   * stay on the site that made them (docs/CAPABILITIES.md, section 4).
   */
  roundPlan?: RoundPlanRecord;
}

/** A build_events row without its local id: the live table numbers it, in the order the bundle lists them. */
export interface ImportEvent {
  buildId: string;
  type: BuildEventBody["type"];
  payload: BuildEventBody;
  at: string;
}

export interface ImportBundle {
  product: ImportProduct;
  builds: ImportBuild[];
  events: ImportEvent[];
  /** The muse the product was built from (products.inspiration_id). */
  inspiration: ImportInspiration;
  /** The muses of its refinements: each refine build points at its own, with the change's message and files. */
  refineInspirations: ImportInspiration[];
}

export type BundleParse = { ok: true; value: ImportBundle } | { ok: false; error: string; field: string };

// ---------------------------------------------------------------------------------------------------------------
// Links back to the laptop

/**
 * A file a local run stored (lib/local-files.ts): http://localhost:<port>/api/files/<key>, where the key starts with
 * one of lib/storage.ts's Blob prefixes. Keys end in a letter or digit (an extension or a random suffix), so trailing
 * punctuation in text stays out of the match.
 */
export const LOCAL_FILE_URL = new RegExp(
  String.raw`https?://(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d{1,5})?/api/files/(?:${STORED_PREFIXES.join("|")})/[A-Za-z0-9\-_.!~*'()%/]*[A-Za-z0-9]`,
  "g",
);

/** Every local file URL in a piece of text, in order. */
export function localFileUrlsIn(text: string): string[] {
  return [...text.matchAll(LOCAL_FILE_URL)].map((m) => m[0]);
}

/** An https link on a public host name, as the platform stores links: never localhost, an IP or credentials. */
export function isPublicLink(value: string): boolean {
  if (value.length > MAX_LINK) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === "https:" && !url.username && !url.password && publicHost(url.origin) !== null;
}

/** Keys that hold a link: url, posterUrl, demoVideoUrl, previewUrl and so on. */
const LINK_KEY = /^(?:url|[a-z][A-Za-z0-9]*Url)$/;

const WRITTEN_BY_MODELS = new Set(["manifest", "brief", "toolFixtures"]);

/**
 * Where a bundle (or any JSON) still points at the machine it came from: a local file URL anywhere, or a link field
 * that isn't a public https link. Text that only mentions localhost, such as Muse Code running curl against the
 * product's dev server in its sandbox, or a verify log, is left alone: that localhost is the sandbox, not the laptop.
 * Briefs, manifests and canned tool outputs are what the models wrote, so only the first rule applies inside them.
 */
export function linkProblems(value: unknown): Array<{ field: string; message: string }> {
  const out: Array<{ field: string; message: string }> = [];
  const walk = (v: unknown, field: string, key: string, written: boolean) => {
    if (typeof v === "string") {
      const local = localFileUrlsIn(v)[0];
      if (local) out.push({ field, message: `${field} still points at a file on the machine it came from (${local}).` });
      else if (!written && LINK_KEY.test(key) && !isPublicLink(v)) {
        out.push({ field, message: `${field} isn't a public https link (${v.slice(0, 120)}).` });
      }
    } else if (Array.isArray(v)) {
      v.forEach((item, i) => walk(item, `${field}[${i}]`, key, written));
    } else if (v && typeof v === "object") {
      for (const [k, item] of Object.entries(v)) walk(item, field ? `${field}.${k}` : k, k, written || WRITTEN_BY_MODELS.has(k));
    }
  };
  walk(value, "", "", false);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Parser

class BundleError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
  }
}

type Fields = Record<string, unknown>;

function fail(field: string, message: string): never {
  throw new BundleError(field, message);
}

/** `field.key`, or just the key at the top of the bundle. */
const at = (field: string, key: string) => (field ? `${field}.${key}` : key);

/** An object with exactly these keys (and maybe the optional ones). Anything else, a user id say, is refused. */
function fields(v: unknown, field: string, keys: readonly string[], optional: readonly string[] = []): Fields {
  if (!v || typeof v !== "object" || Array.isArray(v)) fail(field || "bundle", `${field || "The bundle"} must be an object.`);
  const obj = v as Fields;
  for (const k of Object.keys(obj)) {
    if (!keys.includes(k) && !optional.includes(k)) fail(at(field, k), `${at(field, k)} isn't something an import takes.`);
  }
  for (const k of keys) if (!(k in obj)) fail(at(field, k), `${at(field, k)} is missing.`);
  return obj;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function id(v: unknown, field: string): string {
  if (typeof v !== "string" || !UUID.test(v)) fail(field, `${field} must be a UUID.`);
  return v.toLowerCase();
}

function maybeId(v: unknown, field: string): string | null {
  return v === null ? null : id(v, field);
}

function text(v: unknown, field: string, max: number, min = 0): string {
  if (typeof v !== "string") fail(field, `${field} must be text.`);
  if (v.length < min) fail(field, `${field} is empty.`);
  if (v.length > max) fail(field, `${field} is over ${max} characters.`);
  return v;
}

function maybeText(v: unknown, field: string, max: number): string | null {
  return v === null ? null : text(v, field, max);
}

function when(v: unknown, field: string): string {
  if (typeof v !== "string" || v.length > 40 || !Number.isFinite(Date.parse(v))) fail(field, `${field} must be an ISO date.`);
  return new Date(v).toISOString();
}

function maybeWhen(v: unknown, field: string): string | null {
  return v === null ? null : when(v, field);
}

function wholeNumber(v: unknown, field: string, max: number): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > max) fail(field, `${field} must be a whole number from 0 to ${max}.`);
  return v;
}

function amount(v: unknown, field: string, max: number): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > max) fail(field, `${field} must be a number from 0 to ${max}.`);
  return v;
}

function link(v: unknown, field: string): string | null {
  if (v === null) return null;
  if (typeof v !== "string" || !isPublicLink(v)) fail(field, `${field} must be a public https link.`);
  return v;
}

function list(v: unknown, field: string, max: number): unknown[] {
  if (!Array.isArray(v)) fail(field, `${field} must be a list.`);
  if (v.length > max) fail(field, `${field} has more than ${max} items.`);
  return v;
}

function plainObject(v: unknown, field: string): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) fail(field, `${field} must be an object.`);
  return v as Record<string, unknown>;
}

/** Sandbox names: lowercase letters, digits and dashes (lib/sandbox/builder.ts sandboxNameFor). */
const SANDBOX = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

function sandboxName(v: unknown, field: string): string {
  if (typeof v !== "string" || !SANDBOX.test(v)) fail(field, `${field} must be a sandbox name.`);
  return v;
}

/**
 * True when `name` is this product's sandbox: product-<slug>-<first 8 hex digits of its id> (sandboxNameFor), or
 * product-<slug> for products from before Oct 28. Anything else would deploy another product's code.
 */
function ownSandbox(name: string, slug: string, productId: string): boolean {
  const id8 = productId.replace(/[^0-9a-f]/g, "").slice(0, 8);
  return name === `product-${slug}` || (name.startsWith("product-") && name.endsWith(`-${id8}`));
}

const INSPIRATION_KEYS = ["id", "note", "references", "createdAt"] as const;
/** Every column of `products` is here or in the test's list of what an import leaves out (bundle.test.ts). */
export const PRODUCT_KEYS = [
  "id",
  "slug",
  "name",
  "tagline",
  "inspirationId",
  "rebuildOf",
  "manifest",
  "latestBuildId",
  "sandboxName",
  "museSessionId",
  "demoVideoUrl",
  "demoPosterUrl",
  "transcriptUrl",
  "status",
  "createdAt",
  "updatedAt",
] as const;
/** Keys an older script's bundle doesn't have, and a bundle leaves out when they're empty. */
export const OPTIONAL_PRODUCT_KEYS = ["extraClips"] as const;
export const BUILD_KEYS = [
  "id",
  "inspirationId",
  "kind",
  "message",
  "rebuildOf",
  "productId",
  "status",
  "step",
  "brief",
  "buildModel",
  "sandboxName",
  "museSessionId",
  "fixRounds",
  "previewUrl",
  "costUsd",
  "error",
  "startedAt",
  "finishedAt",
] as const;
export const OPTIONAL_BUILD_KEYS = ["requestedTargets", "toolFixtures", "roundPlan"] as const;
const CLIP_KEYS = ["url", "posterUrl", "caption", "addedAt"] as const;
const EVENT_KEYS = ["buildId", "type", "payload", "at"] as const;

function inspiration(v: unknown, field: string): ImportInspiration {
  const o = fields(v, field, INSPIRATION_KEYS);
  const note = validateNote(o.note);
  if (!note.ok) fail(`${field}.note`, note.error);
  const references = validateReferences(o.references);
  if (!references.ok) fail(`${field}.references`, references.error);
  return { id: id(o.id, `${field}.id`), note: note.value, references: references.value, createdAt: when(o.createdAt, `${field}.createdAt`) };
}

function clip(v: unknown, field: string): ProductClip {
  const o = fields(v, field, CLIP_KEYS);
  const url = link(o.url, `${field}.url`);
  if (url === null) fail(`${field}.url`, `${field}.url must be a public https link.`);
  return {
    url,
    posterUrl: link(o.posterUrl, `${field}.posterUrl`),
    caption: text(o.caption, `${field}.caption`, 300, 1),
    addedAt: when(o.addedAt, `${field}.addedAt`),
  };
}

function requestedTargets(v: unknown, field: string): TargetId[] {
  const check = validateTargets(list(v, field, TARGETS.length), TARGETS);
  if (!check.ok) fail(field, `${field}: ${check.error}`);
  return check.value;
}

const MILESTONE_STATES: readonly MilestoneState[] = ["planned", "building", "passed", "failed", "skipped"];

function roundPlan(v: unknown, field: string): RoundPlanRecord {
  const o = fields(v, field, ["capMinutes", "milestones"] as const, ["wallMinutes"]);
  const milestones = list(o.milestones, `${field}.milestones`, MILESTONES_MAX).map((m, i) => {
    const item = fields(m, `${field}.milestones[${i}]`, ["title", "state"] as const);
    if (!MILESTONE_STATES.includes(item.state as MilestoneState)) fail(`${field}.milestones[${i}].state`, `${field}.milestones[${i}].state isn't a milestone state.`);
    return { title: text(item.title, `${field}.milestones[${i}].title`, 60, 1), state: item.state as MilestoneState };
  });
  return {
    capMinutes: wholeNumber(o.capMinutes, `${field}.capMinutes`, 90),
    ...(o.wallMinutes === undefined ? {} : { wallMinutes: wholeNumber(o.wallMinutes, `${field}.wallMinutes`, 180) }),
    milestones,
  };
}

function product(v: unknown): ImportProduct {
  const o = fields(v, "product", PRODUCT_KEYS, OPTIONAL_PRODUCT_KEYS);
  const productId = id(o.id, "product.id");
  const slug = text(o.slug, "product.slug", SLUG_MAX, 1);
  if (normalizeSlug(slug) !== slug) fail("product.slug", "product.slug must be lowercase letters, digits and single dashes.");
  if (o.status !== "live") fail("product.status", "Only a live product can be imported.");
  const sandbox = sandboxName(o.sandboxName, "product.sandboxName");
  if (!ownSandbox(sandbox, slug, productId)) fail("product.sandboxName", "product.sandboxName isn't this product's sandbox.");
  return {
    id: productId,
    slug,
    name: text(o.name, "product.name", 200, 1),
    tagline: text(o.tagline, "product.tagline", 500),
    inspirationId: id(o.inspirationId, "product.inspirationId"),
    rebuildOf: maybeText(o.rebuildOf, "product.rebuildOf", 200),
    manifest: o.manifest === null ? null : plainObject(o.manifest, "product.manifest"),
    latestBuildId: id(o.latestBuildId, "product.latestBuildId"),
    sandboxName: sandbox,
    museSessionId: maybeId(o.museSessionId, "product.museSessionId"),
    demoVideoUrl: link(o.demoVideoUrl, "product.demoVideoUrl"),
    demoPosterUrl: link(o.demoPosterUrl, "product.demoPosterUrl"),
    transcriptUrl: link(o.transcriptUrl, "product.transcriptUrl"),
    ...(o.extraClips === undefined
      ? {}
      : { extraClips: list(o.extraClips, "product.extraClips", IMPORT_MAX_CLIPS).map((c, i) => clip(c, `product.extraClips[${i}]`)) }),
    status: "live",
    createdAt: when(o.createdAt, "product.createdAt"),
    updatedAt: when(o.updatedAt, "product.updatedAt"),
  };
}

function brief(v: unknown, field: string): Brief | null {
  if (v === null) return null;
  const parsed = BriefSchema.safeParse(v);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? `${field}.${issue.path.map(String).join(".")}` : field;
    fail(where, `${where} doesn't fit the brief's schema: ${issue?.message ?? "invalid"}.`);
  }
  // Checked, and stored as it came, so a field this version doesn't know isn't lost.
  return v as Brief;
}

function build(v: unknown, field: string): ImportBuild {
  const o = fields(v, field, BUILD_KEYS, OPTIONAL_BUILD_KEYS);
  if (o.kind !== "build" && o.kind !== "refine") fail(`${field}.kind`, `${field}.kind must be build or refine.`);
  if (!TERMINAL_STATUSES.includes(o.status as BuildStatus)) {
    fail(`${field}.status`, `${field}.status must be one a build ends with (${TERMINAL_STATUSES.join(", ")}).`);
  }
  return {
    id: id(o.id, `${field}.id`),
    inspirationId: id(o.inspirationId, `${field}.inspirationId`),
    kind: o.kind,
    message: maybeText(o.message, `${field}.message`, MAX_NOTE_CHARS),
    rebuildOf: maybeText(o.rebuildOf, `${field}.rebuildOf`, 200),
    productId: id(o.productId, `${field}.productId`),
    status: o.status as BuildStatus,
    step: maybeText(o.step, `${field}.step`, 40),
    brief: brief(o.brief, `${field}.brief`),
    buildModel: maybeText(o.buildModel, `${field}.buildModel`, 100),
    sandboxName: o.sandboxName === null ? null : sandboxName(o.sandboxName, `${field}.sandboxName`),
    museSessionId: maybeId(o.museSessionId, `${field}.museSessionId`),
    fixRounds: wholeNumber(o.fixRounds, `${field}.fixRounds`, 100),
    previewUrl: link(o.previewUrl, `${field}.previewUrl`),
    costUsd: amount(o.costUsd, `${field}.costUsd`, 10_000),
    error: maybeText(o.error, `${field}.error`, MAX_ERROR),
    startedAt: when(o.startedAt, `${field}.startedAt`),
    finishedAt: maybeWhen(o.finishedAt, `${field}.finishedAt`),
    ...(o.requestedTargets === undefined ? {} : { requestedTargets: requestedTargets(o.requestedTargets, `${field}.requestedTargets`) }),
    ...(o.toolFixtures === undefined ? {} : { toolFixtures: plainObject(o.toolFixtures, `${field}.toolFixtures`) as ToolFixtures }),
    ...(o.roundPlan === undefined ? {} : { roundPlan: roundPlan(o.roundPlan, `${field}.roundPlan`) }),
  };
}

/**
 * Event types aren't checked against today's list: a local run on a newer branch may write one this site doesn't
 * render yet, and the build room skips what it doesn't know. The shape is: a payload that names its own type.
 */
function event(v: unknown, field: string): ImportEvent {
  const o = fields(v, field, EVENT_KEYS);
  const type = text(o.type, `${field}.type`, 40, 1);
  if (!/^[a-z][a-z_]*$/.test(type)) fail(`${field}.type`, `${field}.type must be lowercase letters and underscores.`);
  const payload = plainObject(o.payload, `${field}.payload`);
  if (payload.type !== type) fail(`${field}.payload.type`, `${field}.payload.type must be ${type}, as the event's type is.`);
  return {
    buildId: id(o.buildId, `${field}.buildId`),
    type: type as BuildEventBody["type"],
    payload: payload as BuildEventBody,
    at: when(o.at, `${field}.at`),
  };
}

function unique(ids: string[], field: string): void {
  const seen = new Set<string>();
  for (const [i, v] of ids.entries()) {
    if (seen.has(v)) fail(`${field}[${i}].id`, `${field}[${i}].id appears twice.`);
    seen.add(v);
  }
}

/** The rows' links and ids must agree: one product, its builds, their muses and events, and its latest build live. */
function crossCheck(b: ImportBundle): void {
  const { product: p } = b;
  if (p.inspirationId !== b.inspiration.id) fail("product.inspirationId", "product.inspirationId must be inspiration.id.");
  if (!b.builds.length) fail("builds", "builds is empty: a live product has at least the build that shipped it.");
  unique(b.builds.map((x) => x.id), "builds");
  unique(b.refineInspirations.map((x) => x.id), "refineInspirations");
  const muses = new Set([b.inspiration.id, ...b.refineInspirations.map((x) => x.id)]);
  if (muses.size !== b.refineInspirations.length + 1) fail("refineInspirations", "refineInspirations repeats the product's own muse.");
  const used = new Set<string>();
  for (const [i, x] of b.builds.entries()) {
    if (x.productId !== p.id) fail(`builds[${i}].productId`, `builds[${i}].productId must be product.id.`);
    if (!muses.has(x.inspirationId)) fail(`builds[${i}].inspirationId`, `builds[${i}].inspirationId isn't a muse in the bundle.`);
    used.add(x.inspirationId);
  }
  for (const [i, x] of b.refineInspirations.entries()) {
    if (!used.has(x.id)) fail(`refineInspirations[${i}].id`, `refineInspirations[${i}] isn't the muse of any build in the bundle.`);
  }
  const latest = b.builds.find((x) => x.id === p.latestBuildId);
  if (!latest) fail("product.latestBuildId", "product.latestBuildId isn't one of the builds.");
  if (latest.status !== "live") fail("product.latestBuildId", `The product's latest build is ${latest.status}, not live.`);
  const builds = new Set(b.builds.map((x) => x.id));
  for (const [i, e] of b.events.entries()) {
    if (!builds.has(e.buildId)) fail(`events[${i}].buildId`, `events[${i}].buildId isn't one of the builds.`);
  }
}

/**
 * Checks a bundle field by field: every key, type, size and id, the brief against its schema, the rows' links to each
 * other, and that nothing points back at the machine it came from (linkProblems). Unknown keys are refused, so a
 * bundle can't carry a user id or anything else the live site sets itself.
 */
export function parseImportBundle(raw: unknown): BundleParse {
  try {
    const o = fields(raw, "", ["product", "builds", "events", "inspiration"], ["refineInspirations"]);
    const bundle: ImportBundle = {
      product: product(o.product),
      builds: list(o.builds, "builds", IMPORT_MAX_BUILDS).map((x, i) => build(x, `builds[${i}]`)),
      events: list(o.events, "events", IMPORT_MAX_EVENTS).map((x, i) => event(x, `events[${i}]`)),
      inspiration: inspiration(o.inspiration, "inspiration"),
      refineInspirations:
        o.refineInspirations === undefined
          ? []
          : list(o.refineInspirations, "refineInspirations", IMPORT_MAX_BUILDS).map((x, i) => inspiration(x, `refineInspirations[${i}]`)),
    };
    crossCheck(bundle);
    const problem = linkProblems(bundle)[0];
    if (problem) fail(problem.field, problem.message);
    return { ok: true, value: bundle };
  } catch (err) {
    if (err instanceof BundleError) return { ok: false, error: err.message, field: err.field };
    throw err;
  }
}
