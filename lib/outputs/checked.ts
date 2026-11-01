/**
 * The product page's "What was checked" panel (VERIFY_AGENTS), built only from a build's events. It says who checked what
 * and what nobody checked. A row exists only for a check that really ran, and a skipped one is listed as not checked. Judge
 * reasons and raw details can quote internals, so only an owner's view has them.
 */
import { settleProveView } from "@/lib/outputs/labels";
import { condenseProveEvents, type BuildEvent, type ProductStatus, type ProveEventBody, type ProveItemView } from "@/lib/types";

export type CheckedResult = "passed" | "failed" | "running" | "not_checked" | "reported";

export interface CheckedRow {
  id: string;
  label: string;
  result: CheckedResult;
  /** The day it ran, or null when the row isn't a run. */
  date: string | null;
  /** Owner only. */
  details?: string[];
}

export interface CheckedSection {
  id: "code" | "model" | "reported" | "not_checked";
  title: string;
  note: string;
  rows: CheckedRow[];
}

export interface CheckedPanelView {
  /** What the build's own status means for what's below, when it isn't plainly live. */
  statusNote: string | null;
  sections: CheckedSection[];
}

const VERIFY_LABEL: Record<string, string> = {
  typecheck: "Typecheck",
  build: "Build",
  start: "The built app starts",
  console: "No errors in the browser console",
  smoke: "Smoke test of the main flow",
  caps: "Platform service checks",
  manifest: "Its manifest is valid",
};

const dayOf = (at: string | null | undefined): string | null => {
  if (!at) return null;
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
};

const STATE_RESULT: Record<ProveEventBody["state"], CheckedResult> = { planned: "running", running: "running", done: "passed", failed: "failed", skipped: "not_checked" };

function last<T extends BuildEvent["type"]>(events: readonly BuildEvent[], type: T): Extract<BuildEvent, { type: T }> | null {
  for (let i = events.length - 1; i >= 0; i--) if (events[i]!.type === type) return events[i] as Extract<BuildEvent, { type: T }>;
  return null;
}

/** One origin's run: a nightly re-check keeps its own date and doesn't stand in for what shipping found. */
function runOf(events: readonly BuildEvent[], origin: ProveEventBody["origin"], now: number) {
  const own = events.filter((e) => e.type === "prove" && e.origin === origin);
  return settleProveView(condenseProveEvents(own), now);
}

function proveRows(items: readonly ProveItemView[], prefix: string, keyPrefix: string, isOwner: boolean) {
  const code: CheckedRow[] = [];
  const reported: CheckedRow[] = [];
  const notChecked: CheckedRow[] = [];
  const details = (i: ProveItemView) => (isOwner && i.detail ? { details: [i.detail] } : {});
  for (const item of items) {
    const date = dayOf(item.at);
    const id = `${keyPrefix}-${item.item}`;
    if (item.item === "stage") {
      if (item.state === "failed") code.push({ id, label: `${prefix}${item.title}`, result: "failed", date, ...details(item) });
      continue;
    }
    if (item.item === "agent_claims") {
      // Each of its checks really ran, even when the claims themselves couldn't be graded.
      item.checks?.forEach((c, n) => code.push({ id: `${id}-${n}`, label: `${prefix}${c.label}`, result: c.ok ? "passed" : "failed", date }));
      item.reported?.forEach((r, n) => reported.push({ id: `${id}-r${n}`, label: `${prefix}${r}`, result: "reported", date }));
      if (item.state === "skipped") notChecked.push({ id, label: `${prefix}${item.title}`, result: "not_checked", date, ...details(item) });
      else if (item.state === "failed" && !item.checks?.length) code.push({ id, label: `${prefix}${item.title}`, result: "failed", date, ...details(item) });
      else if (item.state === "failed" && isOwner && item.detail) code[code.length - 1] = { ...code[code.length - 1]!, ...details(item) };
      continue;
    }
    const result = STATE_RESULT[item.state];
    (result === "not_checked" ? notChecked : code).push({ id, label: `${prefix}${item.title}`, result, date, ...details(item) });
  }
  return { code, reported, notChecked };
}

export function buildCheckedPanel(input: { events: readonly BuildEvent[]; status: ProductStatus; hasActions: boolean; isAgent: boolean; isOwner: boolean; now: number }): CheckedPanelView {
  const { events, status, hasActions, isAgent, isOwner, now } = input;
  const code: CheckedRow[] = [];
  const model: CheckedRow[] = [];
  const reported: CheckedRow[] = [];
  const notChecked: CheckedRow[] = [];

  const verify = last(events, "verify");
  if (verify) {
    const date = dayOf(verify.at);
    const owner = (detail?: string) => (isOwner && detail ? { details: [detail] } : {});
    if (verify.summary.steps.length) {
      for (const s of verify.summary.steps) code.push({ id: `verify-${s.name}`, label: VERIFY_LABEL[s.name] ?? s.name, result: s.ok ? "passed" : "failed", date, ...owner(s.detail) });
    } else code.push({ id: "verify", label: "Automated build checks", result: verify.summary.passed ? "passed" : "failed", date, ...owner(verify.summary.failureOutput) });
  } else notChecked.push({ id: "no-verify", label: "No build checks are on record for this version", result: "not_checked", date: null });

  const judge = last(events, "judge");
  if (judge) {
    const details = isOwner ? [...judge.verdict.reasons, ...judge.verdict.mismatches] : [];
    model.push({ id: "judge", label: "A model's opinion of the screenshots, against the brief", result: judge.verdict.pass ? "passed" : "failed", date: dayOf(judge.at), ...(details.length ? { details } : {}) });
  } else notChecked.push({ id: "no-judge", label: "No model looked at the screenshots of this version", result: "not_checked", date: null });

  const ship = runOf(events, "ship", now);
  const shipParts = ship?.items.filter((i) => i.item !== "stage") ?? [];
  if (ship && (shipParts.length || ship.items.some((i) => i.state === "failed" || i.state === "running"))) {
    const rows = proveRows(ship.items, "", "ship", isOwner);
    code.push(...rows.code);
    reported.push(...rows.reported);
    notChecked.push(...rows.notChecked);
  } else notChecked.push({ id: "no-prove", label: "No Prove it run: nothing it comes with was run for real", result: "not_checked", date: null });

  const nightly = runOf(events, "nightly", now);
  if (nightly?.items.some((i) => i.item !== "stage")) {
    const rows = proveRows(nightly.items, "Nightly re-check: ", "nightly", isOwner);
    code.push(...rows.code);
    reported.push(...rows.reported);
    notChecked.push(...rows.notChecked);
  }

  const mentioned = new Set(notChecked.map((r) => r.id));
  const fixed: CheckedRow[] = [
    { id: "fixed-true", label: "Whether its answers are true", result: "not_checked", date: null },
    ...(isAgent ? [{ id: "fixed-sends", label: "Real sends on real accounts: builds use samples", result: "not_checked" as const, date: null }] : []),
    ...(hasActions && !mentioned.has("ship-chatgpt") ? [{ id: "fixed-chatgpt", label: "ChatGPT: only a person with an account can test it", result: "not_checked" as const, date: null }] : []),
    ...(hasActions ? [{ id: "fixed-install", label: "Installing the Claude plugin or the Muse gadget pack on a real device", result: "not_checked" as const, date: null }] : []),
  ];

  const sections: CheckedSection[] = [];
  if (code.length) sections.push({ id: "code", title: "Checked by code", note: "Each line is what the check ran on, and no more.", rows: code });
  if (model.length) sections.push({ id: "model", title: "Judged by a model", note: "This is a model's opinion, not proof.", rows: model });
  if (reported.length) sections.push({ id: "reported", title: "Reported by the product", note: "The product says so. We didn't re-check it.", rows: reported });
  sections.push({ id: "not_checked", title: "Not checked", note: "Nothing here should be taken as tested.", rows: [...fixed, ...notChecked] });

  const statusNote = status === "partial" ? "This version went live as partial: it didn't pass everything below." : status === "failed" ? "This version didn't ship, because of a check below." : null;
  return { statusNote, sections };
}
