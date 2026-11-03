/**
 * An approval gate before text leaves the page for a cloud model (recipe-agent-patterns, 03/15). Pure and
 * import-free apart from Web Crypto, which browsers and Node both have: copy it to lib/gate/egress.ts and use it on
 * the page and in the route.
 *
 * The rules: the string shown is the string sent (the route recomputes the digest and refuses a mismatch), an
 * approval covers one text (its digest), never the tool; deny, timeout and a gate that fails all send nothing; and the
 * ledger records size, digest, outcome and timing, never the question or the answer.
 */

/** SHA-256 of the text as lowercase hex. */
export async function digestOf(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const hash = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** How many bytes leave the page: UTF-8, as the request body carries it. */
export function byteCount(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** What the person reads before anything is sent. The text is shown whole and verbatim, never summarized. */
export function approvalPrompt(o: { text: string; reason: string; model: string }): { title: string; text: string; size: string; reason: string; nothingElse: string } {
  const n = byteCount(o.text);
  return {
    title: `Send this text to ${o.model}?`,
    text: o.text,
    size: `${n} byte${n === 1 ? "" : "s"} leave this page`,
    reason: o.reason,
    nothingElse: "Nothing else is sent: no notes, no files, no earlier messages.",
  };
}

export type Choice = "once" | "session" | "deny";

/**
 * Approvals scoped to one text. "session" remembers that text's digest for this page's life only; a different
 * question prompts again, because its digest differs. Never keyed on the tool name.
 */
export class ApprovalScope {
  private allowed = new Set<string>();

  isPreApproved(digest: string): boolean {
    return this.allowed.has(digest);
  }

  record(digest: string, choice: Choice): boolean {
    if (choice === "session") this.allowed.add(digest);
    return choice !== "deny";
  }
}

/**
 * Waits for the person's choice, and treats no answer within timeoutMs as a denial. `ask` resolves with the choice
 * the buttons give. A gate that throws also counts as a denial.
 */
export async function decide(ask: () => Promise<Choice>, timeoutMs: number): Promise<{ choice: Choice; outcome: "approved" | "denied" | "timeout" | "gate error" }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  try {
    const got = await Promise.race([ask(), timeout]);
    if (got === "timeout") return { choice: "deny", outcome: "timeout" };
    return { choice: got, outcome: got === "deny" ? "denied" : "approved" };
  } catch {
    return { choice: "deny", outcome: "gate error" };
  } finally {
    clearTimeout(timer);
  }
}

export interface LedgerRow {
  ts: string;
  event: "sent" | "not sent" | "send failed";
  /** denied, timeout or gate error, for "not sent". */
  outcome?: string;
  bytes: number;
  /** The first 16 hex characters of the text's digest. */
  digest: string;
  model: string;
  /** How long the model call took, for "sent". */
  ms?: number;
  /** Size of the answer that came back, for "sent". */
  replyBytes?: number;
}

/** One ledger row. Takes the text only to measure and hash it; the row never holds it. */
export async function ledgerRow(o: { text: string; event: LedgerRow["event"]; outcome?: string; model: string; ms?: number; reply?: string; now?: Date }): Promise<LedgerRow> {
  const row: LedgerRow = { ts: (o.now ?? new Date()).toISOString(), event: o.event, bytes: byteCount(o.text), digest: (await digestOf(o.text)).slice(0, 16), model: o.model };
  if (o.outcome) row.outcome = o.outcome;
  if (o.ms !== undefined) row.ms = Math.round(o.ms);
  if (o.reply !== undefined) row.replyBytes = byteCount(o.reply);
  return row;
}

/** The ledger as JSON lines, for its download. */
export function ledgerJsonl(rows: readonly LedgerRow[]): string {
  return rows.map((r) => JSON.stringify(r)).join("\n");
}

/** For tests: any ledger row that contains one of these texts (a question, an answer, a note). Must be empty. */
export function ledgerLeaks(rows: readonly LedgerRow[], texts: readonly string[]): string[] {
  const blob = ledgerJsonl(rows);
  return texts.filter((t) => t.trim().length >= 8 && blob.includes(t));
}

/**
 * The route's check before it calls the model: the text it got must hash to the digest the page approved. A
 * mismatch is refused with nothing sent, so a changed text never rides on an old approval.
 */
export async function outboundProblem(text: unknown, digest: unknown, maxBytes = 4000): Promise<string | null> {
  if (typeof text !== "string" || !text.trim()) return "There is no text to send.";
  if (typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest)) return "The approval is missing its digest.";
  if (byteCount(text) > maxBytes) return `The text is over ${maxBytes} bytes. Shorten it and approve it again.`;
  if ((await digestOf(text)) !== digest) return "The text isn't the one you approved, so nothing was sent.";
  return null;
}
