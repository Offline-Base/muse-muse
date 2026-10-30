import { PRICES, tokenCost } from "@/lib/meta/pricing";

/**
 * The subscriptions page as data and rules (content/meta-docs/pages/muse-code/subscriptions.md): the four plans and
 * their multiples of the Everyday plan's 10-50 prompts every 5 hours, which plan a reader's usage and needs call for,
 * a rough pay-as-you-go comparison from the API's token prices (lib/meta/pricing; plan prices aren't on the page),
 * whether a given run is in Contributor mode, and the renewal dates the billing-cycle rule gives.
 */

export type PlanId = "everyday" | "high" | "power" | "maximum";

export interface Plan {
  id: PlanId;
  name: string;
  /** Usage as a multiple of the Everyday Usage plan. */
  multiplier: number;
  bullets: string[];
  wonderFull: boolean;
  earlyAccess: boolean;
  higherUploads: boolean;
}

export const PLANS: readonly Plan[] = [
  {
    id: "everyday",
    name: "Everyday Usage",
    multiplier: 1,
    bullets: [
      "Access to Muse Spark, Muse Wonder and Muse Image",
      "Send 10-50 prompts every 5 hours, including image and video uploads",
      "Use voice mode",
      "Get access to web search",
    ],
    wonderFull: false,
    earlyAccess: false,
    higherUploads: false,
  },
  {
    id: "high",
    name: "High Usage",
    multiplier: 5,
    bullets: ["Everything from the Everyday Usage plan", "5x more usage than the Everyday Usage plan", "More multimodal inputs"],
    wonderFull: false,
    earlyAccess: false,
    higherUploads: false,
  },
  {
    id: "power",
    name: "Power Usage",
    multiplier: 20,
    bullets: [
      "Everything from the High Usage plan",
      "Access to Muse Wonder Full, the higher-capability variant of Muse Wonder",
      "20x more usage than the Everyday Usage plan",
      "Early access to new features",
      "Higher file uploads",
    ],
    wonderFull: true,
    earlyAccess: true,
    higherUploads: true,
  },
  {
    id: "maximum",
    name: "Maximum Usage",
    multiplier: 80,
    bullets: ["Everything from the Power Usage plan", "80x more usage than the Everyday Usage plan"],
    wonderFull: true,
    earlyAccess: true,
    higherUploads: true,
  },
];

/** The Everyday plan's range: "Send 10-50 prompts every 5 hours". */
export const EVERYDAY_PROMPTS = { low: 10, high: 50 } as const;

/** Where a reader's prompts fall in that range: light prompts get the top of it, heavy ones the bottom. */
export type Weight = "light" | "mixed" | "heavy";

export function promptsPerWindow(plan: Plan, weight: Weight): number {
  const base = weight === "light" ? EVERYDAY_PROMPTS.high : weight === "heavy" ? EVERYDAY_PROMPTS.low : (EVERYDAY_PROMPTS.low + EVERYDAY_PROMPTS.high) / 2;
  return base * plan.multiplier;
}

export function promptRange(plan: Plan): { low: number; high: number } {
  return { low: EVERYDAY_PROMPTS.low * plan.multiplier, high: EVERYDAY_PROMPTS.high * plan.multiplier };
}

export interface Needs {
  /** Prompts in a busy 5-hour window. */
  prompts: number;
  weight: Weight;
  wonderFull: boolean;
  earlyAccess: boolean;
  higherUploads: boolean;
}

export type Fit = "fits" | "short" | "missing";

export interface Recommendation {
  plan: Plan;
  /** Every plan's fit for these needs. */
  fits: Record<PlanId, Fit>;
  reasons: string[];
  /** True when even Maximum Usage falls short. */
  overMax: boolean;
}

export function recommendPlan(needs: Needs): Recommendation {
  const prompts = Math.max(0, needs.prompts || 0);
  const fits = {} as Record<PlanId, Fit>;
  for (const p of PLANS) {
    const missing = (needs.wonderFull && !p.wonderFull) || (needs.earlyAccess && !p.earlyAccess) || (needs.higherUploads && !p.higherUploads);
    fits[p.id] = missing ? "missing" : promptsPerWindow(p, needs.weight) >= prompts ? "fits" : "short";
  }
  const pick = PLANS.find((p) => fits[p.id] === "fits");
  const plan = pick ?? PLANS[PLANS.length - 1];
  const reasons: string[] = [];
  const featureNeeds = [
    needs.wonderFull ? "Muse Wonder Full" : null,
    needs.earlyAccess ? "early access to new features" : null,
    needs.higherUploads ? "higher file uploads" : null,
  ].filter(Boolean);
  if (featureNeeds.length) reasons.push(`You need ${featureNeeds.join(" and ")}, which start at Power Usage.`);
  const allowance = promptsPerWindow(plan, needs.weight);
  if (pick) {
    reasons.push(`${plan.name} covers about ${Math.round(allowance).toLocaleString("en-US")} prompts every 5 hours at your prompt size (${plan.multiplier}x the Everyday plan).`);
    const cheaper = PLANS.slice(0, PLANS.indexOf(plan)).find((p) => fits[p.id] !== "missing" && promptsPerWindow(p, "light") >= prompts);
    if (cheaper && needs.weight !== "light") reasons.push(`${cheaper.name} could also cover it if your prompts are light (up to ${promptRange(cheaper).high.toLocaleString("en-US")}).`);
  } else {
    reasons.push(`Even Maximum Usage covers about ${Math.round(allowance).toLocaleString("en-US")} prompts every 5 hours at your prompt size. On Maximum Usage you wait for your limit to refresh; usage through extra API keys is billed pay-as-you-go.`);
  }
  return { plan, fits, reasons, overMax: !pick };
}

/** What a reader could price pay-as-you-go usage at. Plans run on Muse Code's own models; these are the API's rates. */
export const PAYG_MODELS: ReadonlyArray<{ value: keyof typeof PRICES; label: string }> = [
  { value: "muse-spark-1.2", label: "Muse Spark 1.2 (Muse Code's default model)" },
  { value: "muse-wonder-1.0", label: "Muse Wonder 1.0" },
  { value: "muse-spark-1.3-contributor", label: "Muse Spark 1.3 Contributor" },
];

export interface PaygInput {
  model: string;
  promptsPerDay: number;
  daysPerMonth: number;
  /** All input tokens one prompt sends across its model steps, cached included. */
  inputTokens: number;
  /** Share of those tokens served from the prompt cache, 0 to 1. */
  cachedShare: number;
  outputTokens: number;
}

export function paygEstimate(input: PaygInput): { perPrompt: number; perMonth: number; promptsPerMonth: number } {
  const inputTokens = Math.max(0, input.inputTokens || 0);
  const cached = Math.round(inputTokens * Math.min(1, Math.max(0, input.cachedShare || 0)));
  const perPrompt = tokenCost(input.model, { inputTokens, cachedInputTokens: cached, outputTokens: Math.max(0, input.outputTokens || 0) });
  const promptsPerMonth = Math.max(0, input.promptsPerDay || 0) * Math.max(0, input.daysPerMonth || 0);
  return { perPrompt, perMonth: perPrompt * promptsPerMonth, promptsPerMonth };
}

// ---------------------------------------------------------------------------------------------------------------
// Contributor mode for one run ("Turn Contributor mode on or off")

export type Billing = "subscription" | "payg" | "zdr" | "managed";
export type Surface = "interactive" | "headless";
export type FlagValue = "none" | "on" | "off";
export type EnvValue = "unset" | "1" | "0";
/** The saved setting on this computer: on, off, a settings file where it was never saved, or no settings file at all. */
export type Saved = "on" | "off" | "never" | "nofile";

export interface ContributorInput {
  billing: Billing;
  surface: Surface;
  flag: FlagValue;
  env: EnvValue;
  saved: Saved;
}

export interface ContributorResult {
  /** "maybe" is the page's "can have Contributor mode on"; "hidden" means the setting isn't offered at all. */
  state: "on" | "off" | "maybe" | "hidden";
  headline: string;
  reasons: string[];
  /** What the Contributor mode row in /settings shows, or null when there's no row (or no /settings, headless). */
  row: string | null;
  /** How to pin the mode for runs like this one. */
  pin: string | null;
}

export function contributorMode(input: ContributorInput): ContributorResult {
  const runCmd = input.surface === "headless" ? 'muse exec --contributor-mode off "<prompt>"' : "muse --contributor-mode off";
  if (input.billing === "managed") {
    return {
      state: "off",
      headline: "Off: your organization manages the setting",
      reasons: ["With a managed configuration Contributor mode stays off, and the flag and environment variable have no effect.", "The Contributor mode row doesn't appear in /settings."],
      row: null,
      pin: null,
    };
  }
  if (input.billing === "payg" || input.billing === "zdr") {
    return {
      state: "hidden",
      headline: input.billing === "payg" ? "Not offered: pay-as-you-go billing" : "Not offered: Zero Data Retention account",
      reasons: [
        "The Contributor mode row appears only while you're signed in with an active Muse Code subscription.",
        input.billing === "payg" ? "It doesn't appear with pay-as-you-go billing." : "It doesn't appear when your account has Zero Data Retention (ZDR).",
      ],
      row: null,
      pin: null,
    };
  }

  const reasons: string[] = [];
  const interactive = input.surface === "interactive";
  if (input.flag !== "none") {
    reasons.push(`--contributor-mode ${input.flag} sets it for this run only, without changing your saved setting.`);
    if (input.env !== "unset") reasons.push(`MUSE_CONTRIBUTOR_MODE=${input.env} is set too, but when both are set the flag wins.`);
    if (interactive) reasons.push("Switching the row in /settings saves your setting for later runs; this run keeps the override.");
    return { state: input.flag, headline: `${input.flag === "on" ? "On" : "Off"}: the flag decides this run`, reasons, row: interactive ? "(run override)" : null, pin: null };
  }
  if (input.env !== "unset") {
    const on = input.env === "1";
    reasons.push(`MUSE_CONTRIBUTOR_MODE=${input.env} turns it ${on ? "on" : "off"} for this run.`);
    if (interactive) reasons.push("Switching the row in /settings saves your setting for later runs; this run keeps the override.");
    return { state: on ? "on" : "off", headline: `${on ? "On" : "Off"}: the environment variable decides this run`, reasons, row: interactive ? "(run override)" : null, pin: null };
  }
  if (input.saved === "on" || input.saved === "off") {
    reasons.push(`Your saved setting on this computer is ${input.saved}. ${interactive ? "" : "Headless runs use the same saved setting."}`.trim());
    reasons.push("Muse Code saves it per computer, so change it on each computer you use.");
    return { state: input.saved, headline: `${input.saved === "on" ? "On" : "Off"}: your saved setting`, reasons, row: interactive ? (input.saved === "on" ? "On" : "Off") : null, pin: input.surface === "headless" ? runCmd : null };
  }
  if (input.saved === "never") {
    if (interactive) {
      reasons.push("Muse Code subscriptions default to Contributor mode, and the setting was never saved here.");
      return { state: "on", headline: "On: the subscription default", reasons, row: "On", pin: null };
    }
    reasons.push("The settings file exists but the setting was never saved, so a headless run can have Contributor mode on.");
    reasons.push("To control headless runs in scripts and CI, set it on every run with the flag or the environment variable.");
    return { state: "maybe", headline: "Can be on: set it explicitly", reasons, row: null, pin: runCmd };
  }
  // No settings file at all.
  if (interactive) {
    reasons.push("On a new computer, your first interactive session turns Contributor mode on and shows a notice that says so.");
    return { state: "on", headline: "On: first session on this computer", reasons, row: "On", pin: null };
  }
  reasons.push("On a computer with no settings file, a headless run has Contributor mode off.");
  reasons.push("Pin it anyway in scripts and CI, so a settings file appearing later can't change it.");
  return { state: "off", headline: "Off: no settings file on this computer", reasons, row: null, pin: runCmd };
}

// ---------------------------------------------------------------------------------------------------------------
// Billing cycle

export interface Ymd {
  y: number;
  /** 1 to 12. */
  m: number;
  d: number;
}

export function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** The charge date in a given month: the subscription's day, or the month's last day when that day doesn't exist. */
export function chargeDayIn(y: number, m: number, subscribedDay: number): Ymd {
  return { y, m, d: Math.min(subscribedDay, daysInMonth(y, m)) };
}

function addMonths(y: number, m: number, n: number): { y: number; m: number } {
  const index = y * 12 + (m - 1) + n;
  return { y: Math.floor(index / 12), m: (index % 12) + 1 };
}

export function compareYmd(a: Ymd, b: Ymd): number {
  return a.y - b.y || a.m - b.m || a.d - b.d;
}

/** The next `count` renewals strictly after `today`, for a subscription first taken on `start`. */
export function renewals(start: Ymd, today: Ymd, count = 6): Ymd[] {
  const out: Ymd[] = [];
  for (let k = 1; out.length < count && k < 1200; k++) {
    const { y, m } = addMonths(start.y, start.m, k);
    const date = chargeDayIn(y, m, start.d);
    if (compareYmd(date, today) > 0) out.push(date);
  }
  return out;
}

/** The day before a date: cancelling at least 24 hours before the billing date means by this day at the latest. */
export function dayBefore(date: Ymd): Ymd {
  const t = new Date(Date.UTC(date.y, date.m - 1, date.d) - 86_400_000);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

export function formatYmd(date: Ymd): string {
  return new Date(Date.UTC(date.y, date.m - 1, date.d)).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

export function parseYmd(text: string): Ymd | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) return null;
  return { y, m: mo, d };
}

export function toIsoYmd(date: Ymd): string {
  return `${date.y}-${String(date.m).padStart(2, "0")}-${String(date.d).padStart(2, "0")}`;
}
