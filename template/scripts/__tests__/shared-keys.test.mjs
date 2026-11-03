// Unit tests for the shared-keys caption guard in scripts/demo-plan.mjs (the platform's docs/BUILD_KEYS.md). Run from
// the repo root:
//   npx tsx --test template/scripts/__tests__/shared-keys.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { redactValues, sharedKeyValues } from "../demo-plan.mjs";

const HF = "hf_fakeCaptionToken0123456789ab";
const AWS = "fakeAwsCaption/secret+0123456789";

test("reads only the values .env.local lists in MUSEMUSE_SHARED_KEYS, longest first", () => {
  const env = `GATEWAY_URL=https://gw.example\nPRODUCT_TOKEN=mm_build_fakefakefakefake\nMUSEMUSE_SHARED_KEYS=HF_TOKEN,AWS_SECRET_ACCESS_KEY\nHF_TOKEN=${HF}\nAWS_SECRET_ACCESS_KEY=${AWS}\nAWS_REGION=us-east-1\n`;
  assert.deepEqual(sharedKeyValues(env), [AWS, HF]);
  assert.deepEqual(sharedKeyValues("GATEWAY_URL=https://gw.example\n"), []);
  assert.deepEqual(sharedKeyValues(null), []);
});

test("a caption with a value comes out without it, and one without is unchanged", () => {
  assert.equal(redactValues(`Paste ${HF} here`, [HF]), "Paste [redacted] here");
  assert.equal(redactValues("Pick a photo", [HF]), "Pick a photo");
  assert.equal(redactValues("Pick a photo", []), "Pick a photo");
});
