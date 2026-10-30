/**
 * cookbook/glimmer-api-agent: a local Muse Glimmer agent that escalates to Muse Spark only through an approval gate.
 * The local half is simulated here (it runs in the browser and sends nothing); the gate and the remote call are real.
 * The rules come from the recipe: the string shown is the string sent; approvals are scoped by a digest of the text
 * (rule_key "remote_model:<first 16 hex of SHA-256>"), so approving one text never approves another; a denial, a
 * timeout or a gate error sends nothing; the egress ledger records event, bytes, digest, model, ms and time, never
 * the question or the answer.
 */

export interface LocalStep {
  kind: "read" | "think" | "answer";
  text: string;
  /** For reads: the file and what the local model saw. */
  file?: string;
  content?: string;
}

export interface Scenario {
  id: string;
  label: string;
  /** What the user types into Hermes. */
  prompt: string;
  /** What the local agent does before it decides (or not) to escalate. */
  local: LocalStep[];
  /** consult_remote_model drafts: the first, then one per "deny and say what to change". Empty: stays local. */
  drafts: Array<{ question: string; reason: string }>;
  /** Suggested notes for a revision, from the recipe. */
  revisions?: string[];
  /** The local agent's reply when the escalation is denied for good. */
  deniedReply: string;
  /** How the local agent wraps the remote answer. */
  wrap: string;
}

export const SCENARIOS: readonly Scenario[] = [
  {
    id: "wash-sale",
    label: "Tax rule (the recipe's example)",
    prompt: "Use the remote model to find out how the US wash sale rule adjusts the cost basis of replacement shares.",
    local: [
      { kind: "read", text: "Reads the local trade log to see what you're asking about.", file: "notes/trades.csv", content: "date,action,symbol,shares,price\n2026-09-03,sell,ACME,100,41.20\n2026-09-20,buy,ACME,100,38.75" },
      { kind: "think", text: "The trades look like a loss sale and a repurchase within 30 days. The cost-basis rule needs current tax-rule specifics I don't hold reliably, so I'll ask the remote model a self-contained question." },
    ],
    drafts: [
      { question: "How does the US wash sale rule adjust the cost basis of replacement shares bought in my brokerage account?", reason: "needs current tax-rule specifics beyond local knowledge" },
      { question: "How does the US wash sale rule adjust the cost basis of replacement shares?", reason: "needs current tax-rule specifics beyond local knowledge" },
    ],
    revisions: ["Make it about the general rule, not my brokerage."],
    deniedReply: "Understood, nothing was sent. From what I know locally: when a wash sale applies, the disallowed loss generally isn't lost but is added to the cost basis of the replacement shares. Check current IRS guidance before relying on that.",
    wrap: "From Muse Spark (the only thing sent was the approved question):",
  },
  {
    id: "secret",
    label: "A token slips into the draft",
    prompt: "My deploy script fails with an x509 error. Ask the remote model what usually causes it.",
    local: [
      {
        kind: "read",
        text: "Reads the failing deploy log.",
        file: "logs/deploy.log",
        content:
          "POST https://build-07.corp.internal/api/release?token=DEMO-ONLY-0000-not-a-real-secret\nerror: x509: certificate signed by unknown authority\nhint: set SSL_CERT_FILE or install the corporate root CA",
      },
      { kind: "think", text: "This is a TLS trust problem. I'll quote the error to the remote model to get the common causes." },
    ],
    drafts: [
      {
        question:
          "My deploy fails calling POST https://build-07.corp.internal/api/release?token=DEMO-ONLY-0000-not-a-real-secret with: x509: certificate signed by unknown authority. What usually causes this and how do I fix it?",
        reason: "needs broader TLS troubleshooting knowledge",
      },
      {
        question: "A deploy script's HTTPS call to an internal server fails with: x509: certificate signed by unknown authority. What usually causes this and how do I fix it?",
        reason: "needs broader TLS troubleshooting knowledge",
      },
    ],
    revisions: ["Remove the token and the internal hostname."],
    deniedReply: "Nothing was sent. Locally: this error usually means the server's certificate chains to a CA your machine doesn't trust, often a corporate root CA. Installing that CA or pointing SSL_CERT_FILE at it is the usual fix.",
    wrap: "From Muse Spark (the token and hostname never left the machine):",
  },
  {
    id: "local",
    label: "Stays local",
    prompt: "Summarize notes/standup.md in two bullets.",
    local: [
      {
        kind: "read",
        text: "Reads the notes.",
        file: "notes/standup.md",
        content: "- Shipped the export fix; QA signed off.\n- Blocked on the vendor's API key rotation until Thursday.\n- Next: start the billing migration spike.",
      },
      { kind: "think", text: "This is a short summary of a local file. I can do it myself, no escalation needed." },
      { kind: "answer", text: "- The export fix shipped and passed QA.\n- Billing migration starts next, after the vendor key rotation unblocks on Thursday." },
    ],
    drafts: [],
    deniedReply: "",
    wrap: "",
  },
];

export function scenarioById(id: string): Scenario {
  return SCENARIOS.find((s) => s.id === id) ?? SCENARIOS[0];
}

/** Bytes of the outbound text, as UTF-8: what "N bytes leaves this device" counts. */
export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** SHA-256 of the text as hex (the plugin's _digest). */
export async function sha256Hex(text: string): Promise<string> {
  const buf = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The approval's scope: one exact text. */
export function ruleKey(digest: string): string {
  return `remote_model:${digest.slice(0, 16)}`;
}

/** The prompt Hermes' gate shows, word for word in the recipe's shape. */
export function approvalText(question: string, reason: string, model: string): string {
  return [
    `Send this text to ${model}?`,
    "",
    `    ${question}`,
    "",
    `    ${utf8Bytes(question)} bytes leaves this device`,
    `    reason: ${reason}`,
    "",
    "Nothing else is sent: no conversation history, no files.",
  ].join("\n");
}

export type Choice = "once" | "session" | "always" | "deny";

export interface Approvals {
  session: string[];
  always: string[];
}

/** Whether an earlier choice already covers this exact text (and which one). */
export function coveredBy(approvals: Approvals, key: string): "session" | "always" | null {
  if (approvals.always.includes(key)) return "always";
  if (approvals.session.includes(key)) return "session";
  return null;
}

/** Records a choice: session and always approvals remember the rule key; once and deny remember nothing. */
export function remember(approvals: Approvals, key: string, choice: Choice): Approvals {
  if (choice === "session" && !approvals.session.includes(key)) return { ...approvals, session: [...approvals.session, key] };
  if (choice === "always" && !approvals.always.includes(key)) return { ...approvals, always: [...approvals.always, key] };
  return approvals;
}

export interface LedgerRow {
  event: "sent" | "not sent" | "gate error" | "send failed";
  bytes?: number;
  digest?: string;
  model: string;
  outcome?: string;
  ms?: number;
  ts: string;
}

/** One egress.jsonl line. Content never goes in: no question, no answer. */
export function ledgerLine(row: LedgerRow): string {
  const out: Record<string, unknown> = { event: row.event };
  if (row.bytes !== undefined) out.bytes = row.bytes;
  if (row.digest) out.digest = `${row.digest.slice(0, 8)}…`;
  out.model = row.model;
  if (row.outcome) out.outcome = row.outcome;
  if (row.ms !== undefined) out.ms = row.ms;
  out.ts = row.ts;
  return JSON.stringify(out);
}

/** The body the tool sends: the same string the gate showed, as the input, and nothing else. */
export function remoteBody(model: string, question: string): Record<string, unknown> {
  return { model, input: question };
}

/** What the tool hands back to the local model when nothing was sent. */
export function notSentMessage(outcome: "denied" | "timeout" | "error", feedback?: string): string {
  if (outcome === "timeout") return "Nothing was sent: the approval timed out. Do not retry.";
  if (outcome === "error") return "Nothing was sent: the approval gate failed.";
  return feedback ? `Nothing was sent: the user denied it and asked for a change: ${feedback}. Rewrite the question and call the tool again.` : "Nothing was sent: the user denied the request.";
}
