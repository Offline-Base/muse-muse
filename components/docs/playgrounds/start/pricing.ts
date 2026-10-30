import { tokenUsage, type TokenUsage } from "@/lib/docs/client/cost";
import { runsAs } from "@/lib/docs/client/models";
import {
  IMAGE_PRICE,
  RATE_LIMITS,
  SAM_MIN_FRAMES,
  SAM_PER_1000_FRAMES,
  SAM_PER_1000_IMAGES,
  TOKEN_MODELS,
  tokenRates,
  VOICE_PER_HOUR,
  WEB_SEARCH_PER_1000,
  type RateLimit,
  type TokenModelRow,
  type TokenRates,
} from "@/components/docs/playgrounds/start/facts";

/**
 * The pricing page as arithmetic: what a workload costs on each model and mode, line by line, so the calculator can
 * show its working ("40,000 cached input tokens x $0.002 per 1M"). Rules from the page: cached input is billed at the
 * cached rate and counts inside input_tokens; reasoning tokens are output tokens; web searches add $2.50 per 1,000;
 * Muse Image bills each image returned; Voice Transcribe bills whole seconds, rounded down; SAM bills each image and
 * each video frame, at least 50 frames per video request. Pure, so it is tested directly.
 */

export interface CostLine {
  label: string;
  quantity: number;
  unit: string;
  /** "$0.10 per 1M tokens" */
  rate: string;
  usd: number;
}

export interface TokenWork {
  /** All input tokens, cached ones included (as in the API's usage). */
  input: number;
  cached: number;
  /** All output tokens, reasoning included. */
  output: number;
  searches?: number;
}

function count(n: number): number {
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** "$0.10", "$4.00", "$0.002": a per-unit rate as the pricing page writes it. */
export function rateText(usd: number): string {
  if (usd >= 0.01) return `$${usd.toFixed(2)}`;
  return `$${trimZeros(usd.toFixed(6), 3)}`;
}

function trimZeros(text: string, keep = 2): string {
  const [whole, frac = ""] = text.split(".");
  let f = frac.replace(/0+$/, "");
  if (f.length < keep) f = f.padEnd(keep, "0");
  return f ? `${whole}.${f}` : whole;
}

/**
 * A cost with the precision it needs: "$1,234.50", "$0.0125", "$0.000072". The calculator shows exact figures
 * rather than the kit's rounded estimate, since small workloads are what Contributor mode is for.
 */
export function exactUsd(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return "$0";
  if (usd >= 1) return `$${usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (usd >= 0.01) return `$${trimZeros(usd.toFixed(4))}`;
  const digits = Math.min(12, 2 - Math.floor(Math.log10(usd)));
  return `$${trimZeros(usd.toFixed(digits))}`;
}

export function tokenCostLines(rates: TokenRates, work: TokenWork): CostLine[] {
  const input = count(work.input);
  const cached = Math.min(count(work.cached), input);
  const output = count(work.output);
  const searches = count(work.searches ?? 0);
  const lines: CostLine[] = [
    { label: "Input, not cached", quantity: input - cached, unit: "tokens", rate: `${rateText(rates.input)} per 1M tokens`, usd: ((input - cached) * rates.input) / 1e6 },
    { label: "Cached input", quantity: cached, unit: "tokens", rate: `${rateText(rates.cachedInput)} per 1M tokens`, usd: (cached * rates.cachedInput) / 1e6 },
    { label: "Output, reasoning included", quantity: output, unit: "tokens", rate: `${rateText(rates.output)} per 1M tokens`, usd: (output * rates.output) / 1e6 },
  ];
  if (searches) {
    lines.push({ label: "Web searches", quantity: searches, unit: "searches", rate: "$2.50 per 1,000 searches", usd: (searches * WEB_SEARCH_PER_1000) / 1000 });
  }
  return lines;
}

export function imageCostLines(images: number): CostLine[] {
  const n = count(images);
  return [{ label: "Generated images", quantity: n, unit: "images", rate: "$0.01 per image", usd: n * IMAGE_PRICE }];
}

/** Audio is billed in whole seconds, rounded down. */
export function audioCostLines(seconds: number): CostLine[] {
  const billed = count(seconds);
  return [{ label: "Audio processed", quantity: billed, unit: "seconds", rate: "$0.18 per hour", usd: (billed / 3600) * VOICE_PER_HOUR }];
}

/** Frames billed for one video request: what it processed, but never under 50. */
export function samBilledFrames(frames: number): number {
  const n = count(frames);
  return n > 0 ? Math.max(n, SAM_MIN_FRAMES) : 0;
}

export function samCostLines(images: number, videoFramesPerRequest: number, videoRequests: number): CostLine[] {
  const lines: CostLine[] = [];
  const n = count(images);
  if (n) lines.push({ label: "Images segmented", quantity: n, unit: "images", rate: "$2.50 per 1,000 images", usd: (n * SAM_PER_1000_IMAGES) / 1000 });
  const requests = count(videoRequests);
  const frames = samBilledFrames(videoFramesPerRequest) * requests;
  if (frames) {
    const per = samBilledFrames(videoFramesPerRequest);
    const note = per > count(videoFramesPerRequest) ? ` (${requests === 1 ? "this request is" : "each request is"} billed at the 50-frame minimum)` : "";
    lines.push({ label: `Video frames${note}`, quantity: frames, unit: "frames", rate: "$0.20 per 1,000 frames", usd: (frames * SAM_PER_1000_FRAMES) / 1000 });
  }
  return lines;
}

export function sumUsd(lines: readonly CostLine[]): number {
  return lines.reduce((n, l) => n + l.usd, 0);
}

export interface WorkloadRow {
  row: TokenModelRow;
  /** Null where the page says "Not available". */
  usd: number | null;
}

/** One token workload priced on every token model and mode the page lists, in its order. */
export function compareTokenWorkload(work: TokenWork, requests = 1): WorkloadRow[] {
  const times = Math.max(1, count(requests));
  return TOKEN_MODELS.map((row) => ({ row, usd: row.rates ? sumUsd(tokenCostLines(row.rates, work)) * times : null }));
}

export interface UsageCost {
  /** The model the price came from: what ran, with muse-spark-1.3 counted as its Contributor stand-in. */
  model: string;
  tokens: TokenUsage | null;
  lines: CostLine[];
  usd: number;
  /** False when the model isn't token-priced or the usage has no token counts. */
  priced: boolean;
}

/** A real reply's usage turned into the page's line items, for the model that ran. */
export function costOfUsage(model: string, usage: unknown, searches = 0): UsageCost {
  const id = runsAs(model);
  const tokens = tokenUsage(usage);
  const rates = tokenRates(id);
  if (!tokens || !rates) return { model: id, tokens, lines: [], usd: 0, priced: false };
  const lines = tokenCostLines(rates, { input: tokens.input, cached: tokens.cached, output: tokens.output, searches });
  return { model: id, tokens, lines, usd: sumUsd(lines), priced: true };
}

export interface LimitFit {
  limit: RateLimit;
  /** Share of the RPM budget the workload uses (1 = all of it), or null when the model has no RPM limit. */
  requestShare: number | null;
  tokenShare: number | null;
  /** The most requests a minute that fit both limits at this request size, or null when neither limit applies. */
  maxRequestsPerMinute: number | null;
  /** Which limit runs out first. */
  binding: "requests" | "tokens" | null;
  fits: boolean;
}

/**
 * Whether a steady workload fits a model's team limits: requests a minute against RPM, and requests a minute times
 * tokens per request (input plus output) against TPM. The tighter one is the binding limit.
 */
export function rateLimitFit(model: string, requestsPerMinute: number, tokensPerRequest: number): LimitFit | null {
  const limit = RATE_LIMITS.find((l) => l.model === model);
  if (!limit) return null;
  const rpm = Math.max(0, requestsPerMinute);
  const tokens = Math.max(0, tokensPerRequest);
  const requestShare = limit.rpm ? rpm / limit.rpm : null;
  const tokenShare = limit.tpm ? (rpm * tokens) / limit.tpm : null;
  const byRequests = limit.rpm ?? Infinity;
  const byTokens = limit.tpm && tokens > 0 ? Math.floor(limit.tpm / tokens) : Infinity;
  const max = Math.min(byRequests, byTokens);
  return {
    limit,
    requestShare,
    tokenShare,
    maxRequestsPerMinute: Number.isFinite(max) ? max : null,
    binding: !Number.isFinite(max) ? null : byTokens < byRequests ? "tokens" : "requests",
    fits: (requestShare ?? 0) <= 1 && (tokenShare ?? 0) <= 1,
  };
}

export interface TokenPreset {
  label: string;
  work: TokenWork;
  requests: number;
}

/** Workloads to start the calculator from, each a shape the pricing page talks about. */
export const TOKEN_PRESETS: readonly TokenPreset[] = [
  { label: "Short chat turn", work: { input: 500, cached: 0, output: 300 }, requests: 1 },
  { label: "Agent step on a cached prefix", work: { input: 60_000, cached: 50_000, output: 1_500 }, requests: 1 },
  { label: "Long document, 800K tokens", work: { input: 800_000, cached: 0, output: 4_000 }, requests: 1 },
  { label: "Search-grounded answer", work: { input: 3_000, cached: 0, output: 800, searches: 2 }, requests: 1 },
  { label: "A day of support chats", work: { input: 2_000, cached: 1_500, output: 400 }, requests: 10_000 },
];
