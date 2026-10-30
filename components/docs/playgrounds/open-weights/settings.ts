import { EOM_ID, EOS_TOKEN_IDS, SPARK, STOP_TOKENS, n } from "@/components/docs/playgrounds/open-weights/facts";

/**
 * Muse Spark Open's recommended settings (muse-spark-open/settings) as checks and numbers: the KV-cache growth that
 * follows from 16 full-attention layers out of 62 (the other 46 keep a fixed 2,048-token window), the context flag
 * each runtime takes, and a stop-token checker that catches the one mistake the page warns about, stopping on
 * <|eom|>.
 */

/**
 * KV entries the model keeps at a context length, in layer-tokens: the 16 full-attention layers hold every token, the
 * 46 sliding-window layers at most 2,048. Bytes per entry aren't on the page, so the calculators compare contexts
 * with this rather than print gigabytes.
 */
export function kvLayerTokens(ctx: number): number {
  const { full, sliding, window } = SPARK.layers;
  return full * ctx + sliding * Math.min(ctx, window);
}

/** The KV cache as a share of what 62 full-attention layers would keep at the same context. */
export function kvShareOfDense(ctx: number): number {
  return kvLayerTokens(ctx) / (SPARK.layers.total * ctx);
}

/** How much more KV a bigger context needs than a smaller one. */
export function kvGrowth(fromCtx: number, toCtx: number): number {
  return kvLayerTokens(toCtx) / kvLayerTokens(fromCtx);
}

export type SettingsRuntime = "sglang" | "vllm" | "trtllm";

export function contextFlag(runtime: SettingsRuntime, ctx: number): string {
  if (runtime === "sglang") return `--context-length ${ctx}`;
  if (runtime === "vllm") return `--max-model-len ${ctx}`;
  return `max_seq_len: ${ctx}`;
}

export interface StopCheck {
  level: "error" | "warn" | "ok";
  text: string;
}

const BY_TOKEN = new Map<string, number>(STOP_TOKENS.map((t) => [t.token, t.id]));
const BY_ID = new Map<number, string>(STOP_TOKENS.map((t) => [t.id, t.token]));

/**
 * Reads a stop list as a reader would paste it (a JSON array, eos_token_id from generation_config.json, or tokens and
 * ids separated by commas or spaces) and checks it against the page: stop on <|eot|> (200008) and <|end_of_text|>
 * (200001), never on <|eom|> (200007).
 */
export function checkStops(input: string): { ids: number[]; unknown: string[]; checks: StopCheck[] } {
  const text = input.trim();
  const items: string[] = [];
  if (text) {
    try {
      const parsed = JSON.parse(text) as unknown;
      const pick = (v: unknown): unknown => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>).eos_token_id ?? (v as Record<string, unknown>).stop ?? (v as Record<string, unknown>).stop_token_ids : v);
      const value = pick(parsed);
      for (const v of Array.isArray(value) ? value : [value]) if (v !== undefined && v !== null) items.push(String(v));
    } catch {
      for (const m of text.matchAll(/<\|[a-z_]+\|>|\d+/g)) items.push(m[0]);
    }
  }
  const ids: number[] = [];
  const unknown: string[] = [];
  for (const item of items) {
    const t = item.trim();
    const id = /^\d+$/.test(t) ? Number(t) : BY_TOKEN.get(t);
    if (id === undefined) unknown.push(t);
    else if (!ids.includes(id)) ids.push(id);
  }
  const checks: StopCheck[] = [];
  if (!items.length) return { ids, unknown, checks: [{ level: "warn", text: "Paste a stop list, or an eos_token_id from generation_config.json." }] };
  if (ids.includes(EOM_ID)) {
    checks.push({ level: "error", text: "Remove <|eom|> (200007). It ends a message while the turn continues, so stopping there cuts the model off before a tool call or its final answer." });
  }
  for (const want of EOS_TOKEN_IDS) {
    checks.push(
      ids.includes(want)
        ? { level: "ok", text: `Stops on ${BY_ID.get(want)} (${want}).` }
        : { level: "warn", text: `Add ${BY_ID.get(want)} (${want}): eos_token_id is [200001, 200008].` },
    );
  }
  for (const id of ids) {
    if (id !== EOM_ID && !EOS_TOKEN_IDS.includes(id as 200001 | 200008)) {
      const token = BY_ID.get(id);
      checks.push({ level: "warn", text: `${token ?? id} ${token ? `(${id}) ` : ""}isn't a stop token on this page: ${token ? STOP_TOKENS.find((t) => t.id === id)?.role : "check it against tokenizer_config.json"}.` });
    }
  }
  if (unknown.length) checks.push({ level: "warn", text: `Not a token this page lists: ${unknown.join(", ")}.` });
  return { ids, unknown, checks };
}

/** "8.6x the KV cache of 32,768 tokens" style label. */
export function growthLabel(fromCtx: number, toCtx: number): string {
  const g = kvGrowth(fromCtx, toCtx);
  return `${g >= 10 ? Math.round(g) : g.toFixed(1)}x the KV cache of ${n(fromCtx)} tokens`;
}

/** The comparison prompts for the live strength check, one per row of the page's table. */
export const STRENGTH_TASKS = [
  { effort: "low", label: "Classification (low)", prompt: "Classify this support ticket as billing, bug, or feature request. Reply with one word.\n\nTicket: I was charged twice for my October invoice." },
  { effort: "medium", label: "Agentic step (medium)", prompt: "You can call search_docs(query) and read_file(path). List, in order, the calls you would make to find why our CI job fails with 'module not found', then stop." },
  { effort: "high", label: "Multi-step reasoning (high)", prompt: "A worker pool has 3 workers and a queue. Each job takes 2 s; jobs arrive every 0.5 s for 6 s, then stop. When does the last job finish? Show the key steps briefly." },
] as const;
