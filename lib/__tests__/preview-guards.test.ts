/**
 * What a Vercel preview never does, now that it has a database of its own (README.md, Preview database): publish a
 * product, since a publish goes into production's Vercel project for that name and gives it a token production's
 * gateway doesn't know. Production and local runs are as before. Every value here is made up.
 *
 *   npx tsx --test lib/__tests__/preview-guards.test.ts
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { env, PUBLISH_OFF_ON_PREVIEW } from "@/lib/env";

const NAMES = ["VERCEL_ENV", "VERCEL_TOKEN", "PLATFORM_URL", "VERCEL_PROJECT_PRODUCTION_URL", "VERCEL_URL"] as const;
type Name = (typeof NAMES)[number];
const saved = Object.fromEntries(NAMES.map((n) => [n, process.env[n]]));

function set(values: Partial<Record<Name, string>>) {
  for (const n of NAMES) delete process.env[n];
  Object.assign(process.env, values);
}

afterEach(() => {
  for (const n of NAMES) {
    if (saved[n] === undefined) delete process.env[n];
    else process.env[n] = saved[n];
  }
});

describe("publishing on a preview", () => {
  const publishable = { VERCEL_TOKEN: "vercel-token-for-tests", VERCEL_PROJECT_PRODUCTION_URL: "muse-muse.example" };

  it("is off on a preview, with or without PLATFORM_URL, and says why", () => {
    for (const extra of [{}, { PLATFORM_URL: "https://muse-muse-git-tuned.vercel.app" }, { VERCEL_TOKEN: "" }]) {
      set({ ...publishable, VERCEL_ENV: "preview", VERCEL_URL: "muse-muse-abc.vercel.app", ...extra });
      assert.equal(env.publishOffReason, PUBLISH_OFF_ON_PREVIEW);
    }
    set({ ...publishable, VERCEL_ENV: " Preview " });
    assert.equal(env.publishOffReason, PUBLISH_OFF_ON_PREVIEW);
  });

  it("stays on in production, and off for the old reasons elsewhere", () => {
    set({ ...publishable, VERCEL_ENV: "production" });
    assert.equal(env.publishOffReason, null);
    set({ VERCEL_ENV: "production", VERCEL_PROJECT_PRODUCTION_URL: "muse-muse.example" });
    assert.equal(env.publishOffReason, "VERCEL_TOKEN isn't set");
    set({ VERCEL_TOKEN: "vercel-token-for-tests", PLATFORM_URL: "http://localhost:3000" });
    assert.match(env.publishOffReason ?? "", /local run/);
  });

  it("reads as a clause and carries no em dash", () => {
    assert.match(PUBLISH_OFF_ON_PREVIEW, /^it's a Vercel preview, /);
    assert.ok(!PUBLISH_OFF_ON_PREVIEW.includes(String.fromCharCode(0x2014)));
  });
});
