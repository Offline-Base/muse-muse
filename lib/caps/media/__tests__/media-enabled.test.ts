/**
 * The media cap counts as on only while MEDIA_ENABLED and at least one part flag are on (docs/CAPABILITIES.md, 14a).
 * CAP_READY.media is false until the cap merges, so this file stands in a lib/caps/ids.ts with media ready, then reads
 * env.enabledCaps and what the brief writer would get from it.
 *   npx tsx --test --experimental-test-module-mocks lib/caps/media/__tests__/media-enabled.test.ts
 */
import assert from "node:assert/strict";
import { afterEach, before, describe, it, mock } from "node:test";
import * as ids from "../../ids";

const at = (relative: string) => new URL(relative, import.meta.url).href;
const FLAGS = ["MEDIA_ENABLED", "MEDIA_SPEECH", "MEDIA_VIDEO", "MEDIA_MUSIC", "MEDIA_SAM_TILING", "VERCEL_ENV"];

let env: typeof import("@/lib/env").env;
let capsWriterRules: typeof import("@/lib/caps/brief-fields").capsWriterRules;
let capsCatalogBlocks: typeof import("@/lib/caps/catalog").capsCatalogBlocks;
let newBriefSchemaFor: typeof import("@/lib/brief/schema").newBriefSchemaFor;
let handleAsset: typeof import("@/lib/caps/media/assets").handleAsset;
let BRIEF: typeof import("@/lib/promote/__tests__/fixtures").BRIEF;

before(async () => {
  mock.module(at("../../ids.ts"), { namedExports: { ...ids, CAP_READY: { ...ids.CAP_READY, media: true } } });
  ({ env } = await import("@/lib/env"));
  ({ capsWriterRules } = await import("@/lib/caps/brief-fields"));
  ({ capsCatalogBlocks } = await import("@/lib/caps/catalog"));
  ({ newBriefSchemaFor } = await import("@/lib/brief/schema"));
  ({ handleAsset } = await import("@/lib/caps/media/assets"));
  ({ BRIEF } = await import("@/lib/promote/__tests__/fixtures"));
});

afterEach(() => {
  for (const f of FLAGS) delete process.env[f];
});

describe("MEDIA_ENABLED with no part flag", () => {
  it("leaves media out of enabledCaps, so the writer gets no media field, rules or catalog block, and /assets is off", async () => {
    process.env.MEDIA_ENABLED = "1";
    assert.deepEqual(env.enabledCaps, []);
    assert.equal(capsWriterRules(env.enabledCaps), "");
    assert.deepEqual(capsCatalogBlocks(env.enabledCaps), []);
    assert.equal(newBriefSchemaFor({ gadgets: false, targets: [], caps: env.enabledCaps }).safeParse(BRIEF).success, true, "no media field is required");
    const res = await handleAsset(new Request(`https://platform.example/api/gateway/assets/${"a".repeat(64)}`), "a".repeat(64), {
      enabledCaps: () => env.enabledCaps,
      hitRateLimits: async () => assert.fail("rate limits read"),
    });
    assert.equal(res.status, 404);
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, "unknown_endpoint");
  });

  it("turns media on once one part is on, and only then", () => {
    process.env.MEDIA_ENABLED = "1";
    process.env.MEDIA_VIDEO = "1";
    assert.deepEqual(env.enabledCaps, ["media"]);
    assert.match(capsWriterRules(env.enabledCaps), /media\.video: true when/);
    assert.match(capsCatalogBlocks(env.enabledCaps).join("\n"), /video: up to/);
    assert.equal(newBriefSchemaFor({ gadgets: false, targets: [], caps: env.enabledCaps }).safeParse(BRIEF).success, false, "the writer must give media");
    delete process.env.MEDIA_ENABLED;
    assert.deepEqual(env.enabledCaps, [], "a part flag alone turns nothing on");
  });
});
