import { env } from "@/lib/env";
import { errorJson, route } from "@/lib/http";
import { liveQuote, platformApi } from "@/lib/train/fireworks/api";
import type { FireworksQuote } from "@/lib/train/fireworks/quote";
import { runCaller } from "@/lib/train/tune/caller";

/** The plan card asks on every open, so the pages are read at most this often. Launch always reads them fresh. */
const CACHE_MS = 10 * 60_000;
let cached: { at: number; quote: FireworksQuote } | null = null;

/** GET -> what Fireworks' live pages confirm about a run's cost (lib/train/fireworks/quote.ts). Off with FIREWORKS_TUNE: 404. */
export const GET = route(async (req: Request) => {
  if (!env.tuneComposer || !env.fireworksTune) return errorJson(404, "not_found");
  await runCaller(req);
  if (!process.env.FIREWORKS_API_KEY?.trim()) return Response.json({ ok: false, reason: "Fireworks isn't set up here." } satisfies FireworksQuote);
  const now = Date.now();
  if (!cached || now - cached.at > CACHE_MS) cached = { at: now, quote: await liveQuote(platformApi()) };
  return Response.json(cached.quote);
});
