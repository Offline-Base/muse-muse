import { env } from "@/lib/env";

/**
 * The one setting a media product gets (docs/CAPABILITIES.md, 2.5): where its page loads the vetted large files from,
 * the gateway's public, hash-addressed /assets route (lib/caps/media/assets.ts). Public by design: no token, and the
 * route serves only files listed in lib/caps/assets.json.
 */
export function mediaAssetsEnv(): Record<string, string> {
  return { NEXT_PUBLIC_MUSEMUSE_ASSETS_URL: `${env.gatewayUrl}/assets` };
}

/**
 * A build's .env.local also says the page runs under the platform's tests, so findAll holds itself to the smoke test's
 * SAM tiles (lib/platform/sam-tiles.ts). The live product's env never has it.
 */
export function mediaBuildEnv(): Record<string, string> {
  return { ...mediaAssetsEnv(), NEXT_PUBLIC_MUSEMUSE_MEDIA_SMOKE: "1" };
}
