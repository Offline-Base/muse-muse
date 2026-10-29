/**
 * The bot check the public request route asks before anything else (docs/VIBE_TUNING.md, Decision 1: Vercel BotID or
 * Cloudflare Turnstile). Neither is set up on the platform yet, so every request passes here, and what stands between a
 * bot and a shipped drive is the route's quotas, the 18+ box and the owner's own invoice. When the vibe front door adds
 * the shared check, this calls it. The tests fake it to show the route refuses a request that fails.
 */
export async function passesBotCheck(req: Request): Promise<boolean> {
  void req;
  return true;
}
