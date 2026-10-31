/**
 * The lab's tokens (lib/native/lab-token.ts): what the agent's own rules accept, and a selftest token that names its job,
 * can't be forged or moved to another job, and stops working at its expiry.
 */
import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { bearerToken, hashLabToken, newJobToken, newLabToken, selftestToken, verifySelftestToken } from "@/lib/native/lab-token";

const JOB = "6f1c2d3e-0000-4000-8000-000000000001";
/** native/lab/lib/validate.mjs's rule for a job's token and a selftest token. */
const AGENT_TOKEN_RULE = /^[A-Za-z0-9._~-]{16,512}$/;

describe("lab tokens", () => {
  before(() => {
    process.env.GATEWAY_TOKEN_PEPPER = "test-pepper-for-lab-tokens";
  });

  it("makes tokens the agent accepts, each one new, and hashes them to the same sha256 every time", () => {
    assert.match(newJobToken(), AGENT_TOKEN_RULE);
    assert.match(selftestToken(JOB, new Date(Date.now() + 1000)), AGENT_TOKEN_RULE);
    assert.notEqual(newLabToken(), newLabToken());
    const token = newJobToken();
    assert.match(hashLabToken(token), /^[a-f0-9]{64}$/);
    assert.equal(hashLabToken(token), hashLabToken(token));
    assert.notEqual(hashLabToken(token), token);
  });

  it("reads a bearer token and nothing else", () => {
    const req = (authorization?: string) => new Request("https://x.test/", authorization ? { headers: { authorization } } : {});
    assert.equal(bearerToken(req("Bearer abc")), "abc");
    assert.equal(bearerToken(req("Basic abc")), null);
    assert.equal(bearerToken(req("Bearer ")), null);
    assert.equal(bearerToken(req()), null);
    assert.equal(bearerToken(req(`Bearer ${"x".repeat(513)}`)), null);
  });

  it("reads the job back out of a good selftest token", () => {
    assert.equal(verifySelftestToken(selftestToken(JOB, new Date(Date.now() + 60_000))), JOB);
  });

  it("refuses an expired, forged or altered selftest token", () => {
    const now = new Date("2026-11-01T00:00:00Z");
    const good = selftestToken(JOB, new Date(now.getTime() + 60_000));
    assert.equal(verifySelftestToken(good, now), JOB);
    assert.equal(verifySelftestToken(good, new Date(now.getTime() + 61_000)), null, "expired");
    const parts = good.split(".");
    assert.equal(verifySelftestToken([parts[0], "6f1c2d3e-0000-4000-8000-000000000002", parts[2], parts[3]].join("."), now), null, "moved to another job");
    assert.equal(verifySelftestToken([parts[0], parts[1], String(Number(parts[2]) + 999), parts[3]].join("."), now), null, "longer life");
    assert.equal(verifySelftestToken(`${good}.extra`, now), null);
    assert.equal(verifySelftestToken("mmst1.a.b", now), null);
    assert.equal(verifySelftestToken(newJobToken(), now), null, "a job token isn't a selftest token");
  });

  it("signs with a key of its own, so a token from another pepper is worthless", () => {
    const good = selftestToken(JOB, new Date(Date.now() + 60_000));
    process.env.GATEWAY_TOKEN_PEPPER = "another-pepper";
    assert.equal(verifySelftestToken(good), null);
    process.env.GATEWAY_TOKEN_PEPPER = "test-pepper-for-lab-tokens";
  });
});
