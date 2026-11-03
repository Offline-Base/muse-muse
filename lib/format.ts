import type { TargetId } from "@/lib/brief/schema";
import type { BuildStatus, Manifest, ProductStatus } from "@/lib/types";
import { contributorSwitchOn, SPARK_STANDIN } from "@/lib/meta/spark";

/**
 * Display helpers shared by server pages and client components. Pure functions only: no server imports, no
 * locale-dependent output that could differ between the server and the browser during hydration.
 */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** 344.3k, 10.5k, 1.2M, 950. */
export function compact(n: number): string {
  const v = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (v < 1000) return `${sign}${Math.round(v)}`;
  if (v < 1e6) return `${sign}${trim1(v / 1e3)}k`;
  if (v < 1e9) return `${sign}${trim1(v / 1e6)}M`;
  return `${sign}${trim1(v / 1e9)}B`;
}

function trim1(v: number): string {
  const s = v.toFixed(1);
  return s.endsWith(".0") ? s.slice(0, -2) : s;
}

/** $0.00, $0.004, $1.12, $1,240. */
export function usd(n: number | null | undefined): string {
  const v = Number(n ?? 0);
  if (!Number.isFinite(v) || v === 0) return "$0.00";
  if (Math.abs(v) < 0.01) return `$${v.toFixed(3)}`;
  if (Math.abs(v) < 1000) return `$${v.toFixed(2)}`;
  return `$${groupThousands(Math.round(v))}`;
}

/** 1,234,567. */
export function groupThousands(n: number): string {
  return Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** 14.5 s, 4 m 12 s, 1 h 3 m. */
export function duration(ms: number | null | undefined): string {
  const v = Math.max(0, Number(ms ?? 0));
  if (v < 60_000) {
    return `${(v / 1000).toFixed(1).replace(/\.0$/, "")} s`;
  }
  const totalS = Math.round(v / 1000);
  const h = Math.floor(totalS / 3600);
  const m = Math.floor((totalS % 3600) / 60);
  const s = totalS % 60;
  if (h > 0) return `${h} h ${m} m`;
  return s ? `${m} m ${s} s` : `${m} m`;
}

/** Coarse duration for cards: 45 s, 6 m, 2.4 h. */
export function shortDuration(ms: number | null | undefined): string {
  const v = Math.max(0, Number(ms ?? 0));
  if (v < 60_000) return `${Math.round(v / 1000)} s`;
  if (v < 3_600_000) return `${Math.round(v / 60_000)} m`;
  return `${trim1(v / 3_600_000)} h`;
}

/** Elapsed ms between two ISO times, or until `now` when the end is missing. */
export function elapsedMs(startIso: string | null | undefined, endIso: string | null | undefined, now: number): number {
  if (!startIso) return 0;
  const start = Date.parse(startIso);
  const end = endIso ? Date.parse(endIso) : now;
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : 0;
}

/** "Oct 21" from an ISO time or a YYYY-MM-DD day, read in UTC. */
export function dayLabel(isoOrDay: string): string {
  const d = new Date(isoOrDay.length === 10 ? `${isoOrDay}T00:00:00Z` : isoOrDay);
  if (Number.isNaN(d.getTime())) return isoOrDay;
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/** "Oct 21, 14:05 UTC". */
export function dateTimeUtc(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${hh}:${mm} UTC`;
}

/** "just now", "5 m ago", "3 h ago", "2 d ago", then "Oct 21". */
export function relativeTime(iso: string | null | undefined, now: number): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const diff = now - t;
  if (diff < 45_000) return "just now";
  if (diff < 3_600_000) return `${Math.max(1, Math.round(diff / 60_000))} m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} h ago`;
  if (diff < 7 * 86_400_000) return `${Math.round(diff / 86_400_000)} d ago`;
  return dayLabel(iso);
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function truncate(s: string, max: number): string {
  const t = s.trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/** Two letters for the account chip. */
export function initials(email: string): string {
  const local = email.split("@")[0] ?? "";
  const parts = local.split(/[._-]+/).filter(Boolean);
  const letters = parts.length >= 2 ? `${parts[0][0]}${parts[1][0]}` : local.slice(0, 2);
  return (letters || "?").toUpperCase();
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1).replace(/\.0$/, "")} MB`;
}

const MODEL_LABELS: Record<string, string> = {
  "muse-spark-1.3": "Muse Spark 1.3",
  "muse-spark-1.3-contributor": "Spark 1.3 Contributor",
  "muse-spark-1.2": "Muse Spark 1.2",
  "muse-wonder-1.0": "Muse Wonder",
  "muse-image-1.0": "Muse Image",
  "sam-3.1": "SAM 3.1",
  "muse-voice-transcribe-1.0": "Voice Transcribe",
  "muse-glimmer": "Muse Glimmer",
  "muse-gadget": "Muse Gadget",
  "jetson-fleet": "Jetson fleet",
  "muse-spark-open": "Muse Spark Open",
};

export function modelLabel(id: string): string {
  return MODEL_LABELS[id] ?? id;
}

/**
 * What a plan or a build room calls a model the product asks for: the one that really runs. Under BUILDS_ON_CONTRIBUTOR
 * the gateway serves a product's muse-wonder-1.0 calls on Spark 1.3 Contributor, so the plan says so. `keepsWonder` is
 * a gadget or board product, whose live calls stay on Muse Wonder (keepsWonderUnderSwitch in lib/gateway/policy.ts).
 * Routing never reads this: it only names what the gateway does.
 */
export function servedModelLabel(id: string, opts: { keepsWonder?: boolean; switchOn?: boolean } = {}): string {
  const on = opts.switchOn ?? contributorSwitchOn();
  if (id === "muse-wonder-1.0" && on && !opts.keepsWonder) return `${modelLabel(SPARK_STANDIN)}, in place of Muse Wonder`;
  return modelLabel(id);
}

/** True for a brief whose live product keeps Muse Wonder under the switch: a gadget, or the board's tools. */
export function briefKeepsWonder(brief: { capabilities: ReadonlyArray<{ model: string }> } | null | undefined): boolean {
  if (!brief) return false;
  return brief.capabilities.some((c) => c.model === "muse-gadget") || (brief as { hardware?: { boardTools?: unknown } }).hardware?.boardTools === true;
}

const TARGET_LABELS: Record<TargetId, string> = {
  web: "Web",
  phone: "Phone",
  desktop: "Desktop",
  vr: "VR",
  glasses: "Glasses",
  agent: "Agent",
  edge: "Edge",
};

/** What a person calls a target. */
export function targetLabel(id: TargetId): string {
  return TARGET_LABELS[id];
}

export type Tone = "live" | "partial" | "failed" | "building" | "neutral";

const STATUS_LABELS: Record<BuildStatus | ProductStatus, string> = {
  queued: "Queued",
  briefing: "Writing the brief",
  refused: "Declined",
  provisioning: "Setting up",
  building: "Building",
  previewing: "Starting preview",
  verifying: "Checking",
  fixing: "Fixing",
  recording: "Recording",
  deploying: "Deploying",
  live: "Live",
  partial: "Partial",
  failed: "Failed",
  disabled: "Turned off",
};

export function statusLabel(status: string): string {
  return STATUS_LABELS[status as BuildStatus] ?? status;
}

export function statusTone(status: string): Tone {
  switch (status) {
    case "live":
      return "live";
    case "partial":
      return "partial";
    case "failed":
    case "refused":
      return "failed";
    case "disabled":
      return "neutral";
    default:
      return "building";
  }
}

export function isTerminalStatus(status: string): boolean {
  return status === "live" || status === "partial" || status === "failed" || status === "refused";
}

/** Fit labels for catalog/meta-resources.json. */
export const FIT_LABEL: Record<string, string> = {
  clean: "Clean",
  reframe: "Reframe",
  partial: "Partial",
};

/**
 * Only same-site absolute paths are followed after sign-in, so ?next can't send people elsewhere. Control characters
 * and backslashes are refused outright because URL parsers drop or rewrite them ("/\t/evil.example" is a different
 * host), and what's left must still resolve to this site.
 */
export function safeNext(next: string | null | undefined): string {
  // eslint-disable-next-line no-control-regex
  if (!next || !next.startsWith("/") || /[\u0000-\u001f\u007f\\]/.test(next)) return "/";
  const base = "https://same-site.invalid";
  let url: URL;
  try {
    url = new URL(next, base);
  } catch {
    return "/";
  }
  if (url.origin !== base || url.pathname.startsWith("/sign-in")) return "/";
  return `${url.pathname}${url.search}${url.hash}`;
}

const isObject = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === "string";
const listOf = (v: unknown, item: (x: unknown) => boolean): boolean => Array.isArray(v) && v.every(item);

/** The actions the Muse app connector exposes. An owner action stays off it, because its callers are anonymous. */
export function connectorActions(manifest: Pick<Manifest, "actions"> | null | undefined): Manifest["actions"] {
  return (manifest?.actions ?? []).filter((a) => a.who !== "owner");
}

/**
 * A stored musemuse.json when it has the Manifest shape, else null. A partial ship can store whatever Muse Code
 * wrote, so pages read it through this and fall back to the brief instead of crashing on a bad field.
 */
export function parseManifest(m: unknown): Manifest | null {
  if (!isObject(m)) return null;
  const ok =
    isString(m.name) &&
    isString(m.slug) &&
    isString(m.tagline) &&
    isString(m.inspiration) &&
    listOf(m.models, (x) => isObject(x) && isString(x.id) && isString(x.usedFor)) &&
    listOf(
      m.actions,
      (x) =>
        isObject(x) &&
        isString(x.name) &&
        isString(x.description) &&
        isObject(x.input) &&
        isObject(x.output) &&
        (x.example === undefined || isObject(x.example)) &&
        (x.who === undefined || x.who === "anyone" || x.who === "owner") &&
        (x.annotations === undefined ||
          (isObject(x.annotations) && isOptionalBoolean(x.annotations.readOnly) && isOptionalBoolean(x.annotations.openWorld))),
    ) &&
    listOf(m.fixtures, (x) => isObject(x) && isString(x.path) && isString(x.description)) &&
    listOf(m.limits, isString) &&
    typeof m.estimatedCostPerRunUsd === "number" &&
    Number.isFinite(m.estimatedCostPerRunUsd) &&
    m.estimatedCostPerRunUsd >= 0 &&
    (m.agent === undefined || isAgentBlock(m.agent));
  return ok ? (m as unknown as Manifest) : null;
}

function isOptionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === "boolean";
}

function isAgentBlock(agent: unknown): boolean {
  return (
    isObject(agent) &&
    isString(agent.task) &&
    listOf(agent.tools, (x) => isObject(x) && isString(x.id) && isString(x.usedFor)) &&
    (agent.connections === "none" || agent.connections === "owner") &&
    (agent.limits === undefined || isObject(agent.limits))
  );
}

/**
 * Cards newest first, keeping only the newest product of each catalog rebuild, so a rebuilt demo doesn't show twice.
 * Products that aren't rebuilds all stay. The older ones keep their own pages and links.
 */
export function newestPerRebuild<T extends { rebuildOf: string | null }>(cards: T[]): T[] {
  const seen = new Set<string>();
  return cards.filter((c) => {
    if (!c.rebuildOf) return true;
    if (seen.has(c.rebuildOf)) return false;
    seen.add(c.rebuildOf);
    return true;
  });
}
