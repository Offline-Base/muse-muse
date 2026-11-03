/**
 * An append-only session journal for a product's own agent loop (recipe-code-sessions, Part 2: 04/01 audit log and
 * resume, 04/02 replay check). Copy it to lib/sim/journal.ts. It imports nothing and runs in the browser and on the
 * server (Web Crypto's SHA-256).
 *
 * Every record is chained to the one before it by SHA-256, so an edited or dropped record breaks the chain. The intent
 * to act is written before the act: `append` refuses an effect that starts with no intent, and an effect that starts
 * again after its terminal record committed. The export is canonical JSON, so the same log always gives the same bytes.
 */

export type RecordKind =
  | "proposed"
  | "accepted"
  | "model.call"
  | "approval.requested"
  | "decision_applied"
  | "side_effect_intent"
  | "effect.started"
  | "effect.terminal"
  | "session.crashed"
  | "session.resumed"
  | "completed";

export interface JournalInput {
  kind: RecordKind;
  /** ISO time. Pass it in, so a test or a replay gives the same bytes. */
  at: string;
  /** Ties an intent, its start and its terminal record together. */
  effectId?: string;
  /** The tool or the model the record is about. */
  tool?: string;
  summary: string;
  payload?: unknown;
  /** On decision_applied: who allowed or denied it. */
  decisionSource?: "policy" | "person";
  /** On side_effect_intent: allow:policy, allow:person or deny:person. */
  policyDecision?: string;
  /** On effect.terminal: what happened. */
  outcome?: "ok" | "failed" | "denied";
}

export interface JournalRecord extends JournalInput {
  seq: number;
  prev: string;
  hash: string;
}

const GENESIS = "0".repeat(64);

/** JSON with sorted keys and no spaces. Undefined values are dropped, as JSON.stringify does. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? "null" : canonicalJson(v))).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function recordBody(r: Omit<JournalRecord, "hash">): string {
  return canonicalJson(r);
}

/** True once the effect's terminal record is in the log. */
export function committed(log: readonly JournalRecord[], effectId: string): boolean {
  return log.some((r) => r.kind === "effect.terminal" && r.effectId === effectId);
}

/** Intents with no terminal record: the effects a crash left unknown, which a resume must check before retrying. */
export function inFlight(log: readonly JournalRecord[]): JournalRecord[] {
  return log.filter((r) => r.kind === "side_effect_intent" && r.effectId && !committed(log, r.effectId));
}

/** A new log with the record added. Throws a plain error when the record would break the audit rules. */
export async function append(log: readonly JournalRecord[], input: JournalInput): Promise<JournalRecord[]> {
  if (input.kind === "effect.started" || input.kind === "effect.terminal") {
    if (!input.effectId) throw new Error(`${input.kind} needs an effectId.`);
    if (!log.some((r) => r.kind === "side_effect_intent" && r.effectId === input.effectId)) {
      throw new Error(`Effect ${input.effectId} has no intent record, so it can't run.`);
    }
    if (committed(log, input.effectId)) throw new Error(`Effect ${input.effectId} already finished, so it won't run again.`);
  }
  if (input.kind === "side_effect_intent" && !input.policyDecision) throw new Error("An intent carries its policy decision.");
  const prev = log.length ? log[log.length - 1].hash : GENESIS;
  const body = { ...input, seq: log.length + 1, prev };
  const hash = await sha256Hex(recordBody(body));
  return [...log, { ...body, hash }];
}

/** Checks every link. The first bad record is named, so the page can say which one was changed. */
export async function verifyChain(log: readonly JournalRecord[]): Promise<{ ok: true } | { ok: false; seq: number; reason: string }> {
  let prev = GENESIS;
  for (let i = 0; i < log.length; i++) {
    const { hash, ...body } = log[i];
    if (body.seq !== i + 1) return { ok: false, seq: i + 1, reason: "A record is missing or out of order." };
    if (body.prev !== prev) return { ok: false, seq: body.seq, reason: "This record doesn't follow the one before it." };
    if ((await sha256Hex(recordBody(body))) !== hash) return { ok: false, seq: body.seq, reason: "This record was changed after it was written." };
    prev = hash;
  }
  return { ok: true };
}

const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(authorization\s*[:=]\s*)(bearer\s+)?\S+/gi,
  /\bbearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /\b(sk|pk|rk|ghp|gho|xox[abp])[-_][A-Za-z0-9_-]{10,}\b/g,
  /\b([A-Za-z_]*(?:secret|token|password|passwd|api_?key)[A-Za-z_]*\s*[:=]\s*)("[^"]*"|'[^']*'|\S+)/gi,
];

/** Removes keys, tokens and secret assignments. It only removes, never restores. */
export function redact(text: string): string {
  return SECRET_PATTERNS.reduce(
    (t, re) => t.replace(re, (match: string, prefix?: string) => (typeof prefix === "string" && match.startsWith(prefix) && /[:=]\s*$/.test(prefix) ? `${prefix}[redacted]` : "[redacted]")),
    text,
  );
}

function redactDeep(value: unknown): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v)]));
  return value;
}

/** The whole session as one canonical JSON document. Same log, same bytes. No export time inside, on purpose. */
export function exportSession(log: readonly JournalRecord[], opts: { sessionId: string; redacted?: boolean }): string {
  const termination = log.some((r) => r.kind === "completed") ? "clean" : inFlight(log).length ? "interrupted" : "open";
  // Redaction changes payload text, so a redacted export keeps each record's original hash as written.
  const records = opts.redacted ? log.map((r) => ({ ...r, summary: redact(r.summary), payload: redactDeep(r.payload) })) : log;
  return canonicalJson({ format: "session-export/1", sessionId: opts.sessionId, redacted: Boolean(opts.redacted), termination, records });
}

export type Lane = "model" | "tool" | "edit" | "approval" | "session";

export interface LedgerRow {
  seq: number;
  lane: Lane;
  label: string;
  /** How it was authorized: allow:policy, allow:person, deny:person, or not_applicable for model calls. */
  auth: string;
}

/** One row per journaled action, stamped with how it was authorized: the color-coded ledger. */
export function ledgerRows(log: readonly JournalRecord[], editTools: readonly string[] = ["edit_file", "write_file"]): LedgerRow[] {
  const rows: LedgerRow[] = [];
  for (const r of log) {
    if (r.kind === "model.call") rows.push({ seq: r.seq, lane: "model", label: r.summary, auth: "not_applicable" });
    else if (r.kind === "approval.requested") rows.push({ seq: r.seq, lane: "approval", label: `Requested: ${r.summary}`, auth: "pending" });
    else if (r.kind === "decision_applied") rows.push({ seq: r.seq, lane: "approval", label: r.summary, auth: `by ${r.decisionSource ?? "policy"}` });
    else if (r.kind === "side_effect_intent") rows.push({ seq: r.seq, lane: r.tool && editTools.includes(r.tool) ? "edit" : "tool", label: `${r.tool ?? "tool"}: ${r.summary}`, auth: r.policyDecision ?? "unknown" });
    else if (r.kind === "session.crashed" || r.kind === "session.resumed" || r.kind === "completed") rows.push({ seq: r.seq, lane: "session", label: r.summary, auth: "not_applicable" });
  }
  return rows;
}

/** Paths where two JSON values differ, like `messages[3].content`. Empty when they match. For the replay check. */
export function diffJson(expected: unknown, actual: unknown, path = ""): string[] {
  if (canonicalJson(expected) === canonicalJson(actual)) return [];
  const bothArrays = Array.isArray(expected) && Array.isArray(actual);
  const bothObjects = !bothArrays && expected && actual && typeof expected === "object" && typeof actual === "object" && !Array.isArray(expected) && !Array.isArray(actual);
  if (bothArrays) {
    const a = expected as unknown[];
    const b = actual as unknown[];
    const out: string[] = [];
    for (let i = 0; i < Math.max(a.length, b.length); i++) out.push(...diffJson(a[i], b[i], `${path}[${i}]`));
    return out;
  }
  if (bothObjects) {
    const a = expected as Record<string, unknown>;
    const b = actual as Record<string, unknown>;
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    return keys.flatMap((k) => diffJson(a[k], b[k], path ? `${path}.${k}` : k));
  }
  return [path || "(root)"];
}
