/**
 * One real Muse Spark Open call through the gateway's handler (lib/gateway/spark-open.ts), on the provider SPARK_OPEN_PROVIDER
 * names (baseten when unset) with its key. The token, budget, slots and meter are in memory, so nothing touches the database,
 * and the call is metered exactly as production meters it. It streams, so it also shows that the provider takes
 * stream_options.include_usage and sends its usage last. About 500 output tokens at most: under $0.01 at either provider's price.
 *
 *   node --env-file=<a file with BASETEN_API_KEY> --import tsx scripts/spark-open-smoke.ts --yes
 *
 * Prints the status, timings, the metered tokens and cost, and what the reply held. Never prints a key.
 */
import { handleGateway, type GatewayDeps, type GatewayToken } from "@/lib/gateway/handler";
import { sparkOpenUpstream } from "@/lib/gateway/spark-open";
import { SPARK_OPEN_HOST_HEADER, SPARK_OPEN_MODEL } from "@/lib/meta/spark-open";
import type { ModelUsage } from "@/lib/types";

const TOKEN = "mm_build_spark_open_smoke_made_up_token";

async function main() {
  if (!process.argv.includes("--yes")) {
    console.log("This spends one real call (under $0.01). Run it again with --yes.");
    return;
  }
  const upstream = sparkOpenUpstream();
  if (!upstream) {
    console.log("No provider: SPARK_OPEN_PROVIDER is unknown, or its key isn't set in this environment.");
    process.exitCode = 1;
    return;
  }
  const scrub = (text: string) => text.split(upstream.key).join("[key]");
  const token: GatewayToken = { id: "smoke-token", productId: "smoke-product", scope: "build", allowedModels: [SPARK_OPEN_MODEL], dailyBudgetUsd: 0.05 };
  const metered: ModelUsage[] = [];
  const pending: Promise<unknown>[] = [];
  const deps: GatewayDeps = {
    findToken: async (raw) => (raw === TOKEN ? token : null),
    productStatus: async () => "building",
    tokenSpendToday: async () => 0,
    platformSpendToday: async () => 0,
    dailySpendCapUsd: 1,
    hitRateLimits: async (keys) => Object.fromEntries(keys.map((k) => [k, 1])),
    acquireInFlight: async (_key, _limit, now) => now,
    releaseInFlight: async () => {},
    reserveSpend: async () => "smoke-reservation",
    settleSpend: async (_id, item) => void (item && metered.push(item)),
    recordUsage: async (_ctx, items) => void metered.push(...items),
    reserveCounter: async (_key, _window, amount) => amount,
    adjustCounter: async () => {},
    counterValue: async () => 0,
    fetch: (input, init) => fetch(input, init),
    upstreamKey: () => {
      throw new Error("a Muse Spark Open call must never use the Meta key");
    },
    sparkOpen: () => upstream,
    gatewayUrl: "https://platform.example/api/gateway",
    defer: (task) => void pending.push(task()),
  };
  const body = {
    model: SPARK_OPEN_MODEL,
    messages: [{ role: "user", content: "Reply with one word: ready." }],
    max_tokens: 512,
    reasoning_effort: "low",
    stream: true,
  };
  const req = new Request("https://platform.example/api/gateway/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const started = performance.now();
  const res = await handleGateway(req, ["chat", "completions"], deps);
  const headersMs = performance.now() - started;
  const reader = res.body?.getReader();
  let firstByteMs: number | null = null;
  let text = "";
  const decoder = new TextDecoder();
  for (;;) {
    const chunk = reader ? await reader.read() : { done: true, value: undefined };
    if (chunk.done) break;
    firstByteMs ??= performance.now() - started;
    text += decoder.decode(chunk.value, { stream: true });
  }
  const totalMs = performance.now() - started;
  await Promise.all(pending);

  console.log(`provider: ${upstream.name} (${upstream.model})`);
  console.log(`status: ${res.status}, content-type: ${res.headers.get("content-type")}, ${SPARK_OPEN_HOST_HEADER}: ${res.headers.get(SPARK_OPEN_HOST_HEADER)}`);
  console.log(`note: ${res.headers.get("x-musemuse-note") ?? "(none)"}`);
  console.log(`latency: headers ${headersMs.toFixed(0)} ms, first byte ${firstByteMs?.toFixed(0) ?? "-"} ms, whole reply ${totalMs.toFixed(0)} ms`);
  if (!res.ok) {
    console.log(`error body: ${scrub(text).slice(0, 300)}`);
    process.exitCode = 1;
    return;
  }
  let answer = "";
  let reasoningChars = 0;
  let usageChunk: unknown = null;
  let chunks = 0;
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:") || line.includes("[DONE]")) continue;
    chunks++;
    try {
      const data = JSON.parse(line.slice(5)) as { usage?: unknown; choices?: Array<{ delta?: { content?: string | null; reasoning_content?: string | null } }> };
      if (data.usage) usageChunk = data.usage;
      for (const c of data.choices ?? []) {
        answer += c.delta?.content ?? "";
        reasoningChars += c.delta?.reasoning_content?.length ?? 0;
      }
    } catch {
      // Not JSON.
    }
  }
  console.log(`chunks: ${chunks}, answer: ${JSON.stringify(scrub(answer).slice(0, 120))}, reasoning characters: ${reasoningChars}`);
  console.log(`usage chunk from the provider: ${usageChunk ? JSON.stringify(usageChunk) : "none"}`);
  for (const m of metered) console.log(`metered: ${m.model}, input ${m.inputTokens} (cached ${m.cachedInputTokens}), output ${m.outputTokens}, $${m.costUsd.toFixed(6)} at the platform's price`);
}

main().catch((err) => {
  console.error("smoke failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
