import { asObject } from "@/components/docs/playgrounds/cookbook-use-cases/lib/strict-json";

/**
 * cookbook/alert-fatigue-copilot: a synthetic alert feed with the patterns the recipe bakes into its own
 * data/synthetic_alerts.json (42 alerts for the fictional BrewBean POS SRE team, .example domains only, no PII:
 * 28 recurring, 31 owned by alex, 28 in the 2 to 4am window, 3 silenced, about 1.4 alerts a day, and seven
 * components at 6 alerts each). The digest is what a Python Counter would print, the validators are the checks
 * validate_alert_output.py runs, and the number check is the recipe's "every number traces back to the digest".
 */

export interface Alert {
  id: string;
  ts: string;
  component: string;
  title: string;
  severity: "P1" | "P2" | "P3";
  owner: string;
  host: string;
  recurring: boolean;
  silenced: boolean;
  runbook: string;
}

const COMPONENTS = ["checkout", "payments", "inventory", "loyalty", "menu-sync", "receipts", "kds"] as const;

const TITLES: Record<(typeof COMPONENTS)[number], { recurring: string; oneOff: [string, string] }> = {
  checkout: { recurring: "Checkout p95 latency above 2 s", oneOff: ["Checkout 5xx burst after deploy", "Cart service OOMKilled on pos-api-3"] },
  payments: { recurring: "Payment gateway timeout rate above 3%", oneOff: ["Card reader firmware mismatch at store 114", "Refund queue backlog above 500"] },
  inventory: { recurring: "Inventory sync lag above 15 min", oneOff: ["Inventory DB replica disk at 90%", "Nightly SKU import job failed"] },
  loyalty: { recurring: "Loyalty points API error rate above 2%", oneOff: ["Loyalty campaign config failed validation", "Loyalty cache eviction storm"] },
  "menu-sync": { recurring: "Menu sync job retries exhausted", oneOff: ["Menu image CDN returning 404s", "Price mismatch between POS and menu board"] },
  receipts: { recurring: "Receipt printer queue stuck", oneOff: ["Email receipt bounce rate above 5%", "Receipt PDF render timeout"] },
  kds: { recurring: "KDS websocket disconnects above 50 an hour", oneOff: ["KDS tablet battery low at store 207", "KDS order bump latency above 3 s"] },
};

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * The 42 alerts, deterministic. Alert i belongs to component i mod 7 and is that component's occurrence j = i div 7:
 * occurrences 0 to 3 recur, 4 and 5 are one-offs. The owner, window and silenced picks below produce the counts.
 */
export function syntheticAlerts(): Alert[] {
  const out: Alert[] = [];
  const nonAlex: Record<string, string> = {
    "6:0": "priya",
    "4:4": "priya",
    "5:4": "priya",
    "6:4": "sam",
    "0:5": "priya",
    "1:5": "sam",
    "2:5": "jordan",
    "3:5": "priya",
    "4:5": "sam",
    "5:5": "jordan",
    "6:5": "jordan",
  };
  const silenced = new Set(["1:1", "4:2", "6:3"]);
  for (let i = 0; i < 42; i++) {
    const c = i % 7;
    const j = Math.floor(i / 7);
    const component = COMPONENTS[c];
    const recurring = j < 4;
    // 24 recurring alerts and 4 one-offs fire between 02:00 and 03:59; the rest in the daytime.
    const inWindow = recurring ? !(j === 3 && c <= 3) : j === 4 && c <= 3;
    const day = 1 + Math.floor((i * 30) / 42);
    const minutes = inWindow ? 120 + ((i * 37) % 120) : 9 * 60 + ((i * 53) % 600);
    const ts = `2026-09-${pad(day)}T${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}:00-07:00`;
    const title = recurring ? TITLES[component].recurring : TITLES[component].oneOff[j - 4];
    out.push({
      id: `ALR-${String(1000 + i)}`,
      ts,
      component,
      title,
      severity: recurring ? "P3" : c === 0 || c === 1 ? "P1" : "P2",
      owner: nonAlex[`${c}:${j}`] ?? "alex",
      host: `${component}.pos.brewbean.example`,
      recurring,
      silenced: silenced.has(`${c}:${j}`),
      runbook: `https://runbooks.brewbean.example/${component}`,
    });
  }
  return out;
}

export interface Digest {
  total: number;
  recurring: number;
  one_off: number;
  silenced: number;
  days: number;
  alerts_per_day: number;
  spike_2_4am: number;
  top_owners: Array<[string, number]>;
  top_components: Array<[string, number]>;
  recurring_pct: number;
  spike_pct: number;
  top_owner_pct: number;
}

function counter(values: string[]): Array<[string, number]> {
  const m = new Map<string, number>();
  for (const v of values) m.set(v, (m.get(v) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

const pct = (n: number, d: number) => Math.round((n / d) * 1000) / 10;

/** What `Counter` over the feed says: the numbers the model may state, and nothing else. */
export function digestOf(alerts: Alert[]): Digest {
  const total = alerts.length;
  const recurring = alerts.filter((a) => a.recurring).length;
  const hours = alerts.map((a) => Number(a.ts.slice(11, 13)));
  const spike = hours.filter((h) => h >= 2 && h < 4).length;
  const days = new Set(alerts.map((a) => a.ts.slice(0, 10)));
  const dates = [...days].sort();
  // Calendar days from the first alert's date to the last one's, both included.
  const span = dates.length ? Math.round((Date.parse(`${dates[dates.length - 1]}T00:00:00Z`) - Date.parse(`${dates[0]}T00:00:00Z`)) / 86_400_000) + 1 : 0;
  const owners = counter(alerts.map((a) => a.owner));
  return {
    total,
    recurring,
    one_off: total - recurring,
    silenced: alerts.filter((a) => a.silenced).length,
    days: Math.max(span, days.size),
    alerts_per_day: Math.round((total / Math.max(1, Math.max(span, days.size))) * 10) / 10,
    spike_2_4am: spike,
    top_owners: owners,
    top_components: counter(alerts.map((a) => a.component)),
    recurring_pct: pct(recurring, total),
    spike_pct: pct(spike, total),
    top_owner_pct: pct(owners[0]?.[1] ?? 0, total),
  };
}

/** The digest as the READ step hands it over: plain lines a model can quote. */
export function digestText(d: Digest): string {
  return [
    `total alerts: ${d.total}`,
    `recurring: ${d.recurring} (${d.recurring_pct}%), one-off: ${d.one_off}, silenced: ${d.silenced}`,
    `window: ${d.days} days, alerts per day: ${d.alerts_per_day}`,
    `2-4am spike: ${d.spike_2_4am} of ${d.total} (${d.spike_pct}%)`,
    `top owners: ${d.top_owners.map(([o, n]) => `${o} ${n}`).join(", ")} (top owner ${d.top_owner_pct}%)`,
    `components: ${d.top_components.map(([c, n]) => `${c} ${n}`).join(", ")}`,
  ].join("\n");
}

/** The feed as compact JSON lines for the prompt. */
export function feedText(alerts: Alert[]): string {
  return alerts.map((a) => JSON.stringify(a)).join("\n");
}

export const PROBE_SYSTEM = `You are the alert-fatigue copilot for the BrewBean POS SRE team. Each turn you read context, reason, and emit STRICT JSON.
Read the alert feed and its digest, then return ONE JSON object, no markdown fences, no prose:
{"patterns": [{"text": string, "salience": "high" | "medium" | "low"}],
 "refined_purpose": {"statement": string, "rationale": string},
 "signals": [{"name": string, "direction": "decrease" | "increase", "role": "north-star" | "leading", "proxy_strength": "strong" | "moderate" | "weak"}]}
Give five patterns with salience hints, a one-sentence refined triage purpose, and five signals labeled north-star or leading.
State a numeric value only if it appears in the digest; mark approximate values as approximate; say "not readable" rather than guess. Propose only: never act on real systems.`;

export const CHAT_SYSTEM = `You are the alert-fatigue copilot for the BrewBean POS SRE team. Answer from the state files you wrote (purpose.json, signals.json, memory.jsonl) and the digest only. Every number you state must appear in them; invent no new numbers. Answer concisely in plain text. Propose an operational fix (debounce, routing, ownership rotation), never financial or safety advice.`;

export const ASSESS_SYSTEM = `You are the alert-fatigue copilot. Self-assess against the purpose and signal basket in state/. Return ONE JSON object, no markdown fences, no prose:
{"narrative": string, "proposals": [{"kind": "purpose" | "signal" | "memory" | "scenario", "title": string, "change": string, "risk": "low" | "high"}]}
The narrative is a short first-person gap analysis. Propose up to eight improvements spanning the four kinds, each with a low or high risk. Propose only; change nothing yourself.`;

export const PROBE_TASK =
  "Read the alert feed below and build a digest with total alerts, recurring/one-off/silenced counts, alerts per day, the 2-4am spike, top owners, and top components. Then emit a STRICT JSON probe result with patterns, refined_purpose, and signals matching the schema. Do not act on real systems.";

export const CHAT_TASK = "Based on the alert patterns you just extracted and the state files you wrote, what is my biggest alert problem and one concrete fix? Answer concisely, grounded in the numbers.";

export const ASSESS_TASK = "Now self-assess against the purpose and signal basket in state/. Return STRICT JSON with a narrative and proposals per the self-assess system.";

/** Strict schemas for the json_schema mode (the recipe's recovery for shape errors). */
export function probeSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["patterns", "refined_purpose", "signals"],
    properties: {
      patterns: {
        type: "array",
        items: { type: "object", additionalProperties: false, required: ["text", "salience"], properties: { text: { type: "string" }, salience: { type: "string", enum: ["high", "medium", "low"] } } },
      },
      refined_purpose: {
        type: "object",
        additionalProperties: false,
        required: ["statement", "rationale"],
        properties: { statement: { type: "string" }, rationale: { type: "string" } },
      },
      signals: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["name", "direction", "role", "proxy_strength"],
          properties: {
            name: { type: "string" },
            direction: { type: "string", enum: ["decrease", "increase"] },
            role: { type: "string", enum: ["north-star", "leading"] },
            proxy_strength: { type: "string", enum: ["strong", "moderate", "weak"] },
          },
        },
      },
    },
  };
}

export const PROPOSAL_KINDS = ["purpose", "signal", "memory", "scenario"] as const;

export function assessSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["narrative", "proposals"],
    properties: {
      narrative: { type: "string" },
      proposals: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["kind", "title", "change", "risk"],
          properties: {
            kind: { type: "string", enum: [...PROPOSAL_KINDS] },
            title: { type: "string" },
            change: { type: "string" },
            risk: { type: "string", enum: ["low", "high"] },
          },
        },
      },
    },
  };
}

export interface CheckLine {
  ok: boolean;
  text: string;
}

/** validate_alert_output.py --probe: the shape checks, as [OK] and [ERR] lines. */
export function validateProbe(value: unknown): CheckLine[] {
  const o = asObject(value);
  const lines: CheckLine[] = [];
  const patterns = Array.isArray(o?.patterns) ? o.patterns : null;
  const badPattern = patterns?.findIndex((p) => !asObject(p) || typeof asObject(p)!.text !== "string" || !asObject(p)!.text || asObject(p)!.salience === undefined) ?? -1;
  lines.push(
    patterns && patterns.length && badPattern < 0
      ? { ok: true, text: `patterns: ${patterns.length} items with text and salience` }
      : { ok: false, text: patterns ? `patterns[${Math.max(0, badPattern)}] missing text or salience` : "patterns is not an array" },
  );
  const statement = asObject(o?.refined_purpose)?.statement;
  lines.push(typeof statement === "string" && statement.trim() ? { ok: true, text: "refined_purpose.statement non-empty" } : { ok: false, text: "refined_purpose.statement is empty" });
  const signals = Array.isArray(o?.signals) ? o.signals : null;
  let signalError: string | null = signals && signals.length ? null : "signals is not a non-empty array";
  signals?.forEach((s, i) => {
    const so = asObject(s);
    for (const field of ["direction", "role", "proxy_strength"]) {
      if (!signalError && (!so || so[field] === undefined || so[field] === "")) signalError = `signals[${i}] missing ${field}`;
    }
  });
  lines.push(signalError ? { ok: false, text: signalError } : { ok: true, text: `signals: ${signals!.length} items with direction, role and proxy_strength` });
  return lines;
}

/** validate_alert_output.py --assess. */
export function validateAssessment(value: unknown): CheckLine[] {
  const o = asObject(value);
  const lines: CheckLine[] = [];
  lines.push(typeof o?.narrative === "string" && o.narrative.trim() ? { ok: true, text: "self-assess narrative non-empty" } : { ok: false, text: "narrative is empty" });
  const proposals = Array.isArray(o?.proposals) ? o.proposals : null;
  let err: string | null = proposals && proposals.length ? null : "proposals is not a non-empty array";
  proposals?.forEach((p, i) => {
    const po = asObject(p);
    if (err) return;
    if (!po || !(PROPOSAL_KINDS as readonly string[]).includes(String(po.kind))) err = `proposals[${i}] kind ${JSON.stringify(po?.kind)} is not in the allowlist`;
    else if (po.risk !== "low" && po.risk !== "high") err = `proposals[${i}] risk must be low or high`;
  });
  lines.push(err ? { ok: false, text: err } : { ok: true, text: `proposals: ${proposals!.length} items, kinds in the allowlist, low/high risk` });
  return lines;
}

/** Every number the digest supports, as the strings a model might write them. */
export function groundedNumbers(d: Digest): Set<string> {
  const nums = [
    d.total,
    d.recurring,
    d.one_off,
    d.silenced,
    d.days,
    d.alerts_per_day,
    d.spike_2_4am,
    d.recurring_pct,
    d.spike_pct,
    d.top_owner_pct,
    ...d.top_owners.map(([, n]) => n),
    ...d.top_components.map(([, n]) => n),
    d.top_components.length,
    Math.round(d.recurring_pct),
    Math.round(d.spike_pct),
    Math.round(d.top_owner_pct),
    2,
    4,
  ];
  const out = new Set<string>();
  for (const n of nums) {
    out.add(String(n));
    out.add(String(Math.round(n * 10) / 10));
  }
  // Percentages of the total the model can compute from the counts (e.g. 6/42 = 14.3%).
  for (const [, n] of [...d.top_owners, ...d.top_components]) out.add(String(Math.round((n / d.total) * 1000) / 10));
  return out;
}

/** Clock times such as 02:00, 2:30 am or 04:00:00. */
const CLOCK_TIME = /\b\d{1,2}:\d{2}(?::\d{2})?(?:\s?[ap]\.?m\.?)?/gi;

/**
 * The numbers in an answer, each marked grounded or not. Times like 2-4am (2 and 4 are in the digest's window) and
 * clock times count as grounded: a clock time is listed whole and taken out before the numbers are read, so the "00"
 * in 02:00 isn't flagged as a count the digest doesn't have.
 */
export function numberCheck(answer: string, d: Digest): Array<{ text: string; grounded: boolean }> {
  const grounded = groundedNumbers(d);
  const seen = new Set<string>();
  const out: Array<{ text: string; grounded: boolean }> = [];
  for (const time of answer.match(CLOCK_TIME) ?? []) {
    if (seen.has(time)) continue;
    seen.add(time);
    out.push({ text: time, grounded: true });
  }
  const found = answer.replace(CLOCK_TIME, " ").match(/\d+(?:\.\d+)?/g) ?? [];
  for (const raw of found) {
    const n = String(Number(raw));
    if (seen.has(n)) continue;
    seen.add(n);
    out.push({ text: raw, grounded: grounded.has(n) || grounded.has(raw) });
  }
  return out;
}

type Json = Record<string, unknown>;

export interface TaskOptions {
  model: string;
  effort: string | null;
  /** Enforce the shape with a strict json_schema. */
  schema: boolean;
}

/** The state files a later task reads, as one block of text. */
export function stateBlock(files: Record<string, string>, names: string[]): string {
  return names
    .filter((n) => files[n])
    .map((n) => `state/${n}:\n${files[n]}`)
    .join("\n\n");
}

/** Task 1: the probe, with the feed and (in the READ step) the digest. */
export function probeRequest(o: TaskOptions & { sendDigest: boolean; alerts: Alert[]; digest: Digest }): Json {
  return {
    model: o.model,
    instructions: PROBE_SYSTEM,
    input: `${PROBE_TASK}${o.sendDigest ? `\n\nDigest (computed by the harness):\n${digestText(o.digest)}` : ""}\n\ndata/synthetic_alerts.json (${o.alerts.length} alerts, one JSON object per line):\n${feedText(o.alerts)}`,
    ...(o.effort ? { reasoning: { effort: o.effort } } : {}),
    max_output_tokens: 3000,
    ...(o.schema ? { text: { format: { type: "json_schema", name: "probe_result", strict: true, schema: probeSchema() } } } : {}),
  };
}

/** Task 2: answer from the state files, plain text. */
export function chatRequest(o: Omit<TaskOptions, "schema"> & { files: Record<string, string>; digest: Digest }): Json {
  return {
    model: o.model,
    instructions: CHAT_SYSTEM,
    input: `${CHAT_TASK}\n\n${stateBlock(o.files, ["purpose.json", "signals.json", "memory.jsonl"])}\n\nDigest:\n${digestText(o.digest)}`,
    ...(o.effort ? { reasoning: { effort: o.effort } } : {}),
    max_output_tokens: 2500,
  };
}

/** Task 3: the self-assessment over the state files. */
export function assessRequest(o: TaskOptions & { files: Record<string, string> }): Json {
  return {
    model: o.model,
    instructions: ASSESS_SYSTEM,
    input: `${ASSESS_TASK}\n\n${stateBlock(o.files, ["purpose.json", "signals.json", "memory.jsonl"])}`,
    ...(o.effort ? { reasoning: { effort: o.effort } } : {}),
    max_output_tokens: 3000,
    ...(o.schema ? { text: { format: { type: "json_schema", name: "self_assessment", strict: true, schema: assessSchema() } } } : {}),
  };
}

/** The state files the probe writes: purpose.json, signals.json and the first memory line. */
export function probeStateFiles(value: unknown, digest: Digest): Record<string, string> {
  const o = asObject(value) ?? {};
  const purpose = asObject(o.refined_purpose) ?? {};
  return {
    "purpose.json": JSON.stringify({ statement: purpose.statement ?? "", rationale: purpose.rationale ?? "", version: 1 }, null, 2),
    "signals.json": JSON.stringify(o.signals ?? [], null, 2),
    "memory.jsonl": JSON.stringify({ turn: 1, kind: "probe", digest, patterns: (Array.isArray(o.patterns) ? o.patterns : []).map((p) => asObject(p)?.text) }),
  };
}
