import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // A short wait for response frames, so the 504 test is quick.
      miniflare: { bindings: { REQUEST_TIMEOUT_MS: "400" } },
    }),
  ],
});
