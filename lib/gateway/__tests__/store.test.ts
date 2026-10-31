// Checks the SQL the gateway's store sends, by catching the Neon HTTP driver's request. No database needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { neonConfig } from "@neondatabase/serverless";

process.env.DATABASE_URL ||= "postgresql://test:test@ep-test-123456.us-east-2.aws.neon.tech/test";

interface Captured {
  query: string;
  params: unknown[];
}
const captured: Captured[] = [];
let nextResult: { fields: Array<{ name: string; dataTypeID: number }>; rows: unknown[][]; command: string } = {
  fields: [],
  rows: [],
  command: "SELECT",
};

neonConfig.fetchFunction = async (_url: string, init: RequestInit) => {
  const body = JSON.parse(String(init.body)) as Captured;
  captured.push(body);
  const r = nextResult;
  return Response.json({ ...r, rowCount: r.rows.length, rowAsArray: true });
};

const TEXT = 25;
const INT4 = 23;

test("hitRateLimits: one upsert that increments and returns counts", async () => {
  const { hitRateLimits } = await import("@/lib/gateway/store");
  nextResult = {
    fields: [
      { name: "key", dataTypeID: TEXT },
      { name: "count", dataTypeID: INT4 },
    ],
    rows: [
      ["token:t1", 7],
      ["ip:p1:1.2.3.4", 2],
    ],
    command: "INSERT",
  };
  const window = new Date("2026-10-27T12:34:00Z");
  const counts = await hitRateLimits(["token:t1", "ip:p1:1.2.3.4", "token:t1"], window);
  assert.deepEqual(counts, { "token:t1": 7, "ip:p1:1.2.3.4": 2 });
  const q = captured.at(-1)!;
  assert.match(q.query, /^insert into "rate_limits" \("key", "window_start", "count"\) values \(\$1, \$2, \$3\), \(\$4, \$5, \$6\)/);
  assert.match(q.query, /on conflict \("key","window_start"\) do update set "count" = "rate_limits"\."count" \+ 1/);
  assert.match(q.query, /returning "key", "count"$/);
  assert.equal(q.params.length, 6, "duplicate keys are collapsed");
});

test("revokeExpiredBuildTokens only touches unrevoked, expired build tokens", async () => {
  const { revokeExpiredBuildTokens } = await import("@/lib/gateway/tokens");
  nextResult = { fields: [{ name: "id", dataTypeID: 2950 }], rows: [["a"], ["b"]], command: "UPDATE" };
  assert.equal(await revokeExpiredBuildTokens(new Date("2026-10-27T00:00:00Z")), 2);
  const q = captured.at(-1)!.query;
  assert.match(q, /update "gateway_tokens" set "revoked_at" = \$1/);
  assert.match(q, /"gateway_tokens"\."scope" = \$2 and "gateway_tokens"\."revoked_at" is null and "gateway_tokens"\."expires_at" < \$3/);
});

test("deleteRateLimitsBefore and setProductStatusBySlug", async () => {
  const { deleteRateLimitsBefore, setProductStatusBySlug } = await import("@/lib/gateway/store");
  nextResult = { fields: [{ name: "key", dataTypeID: TEXT }], rows: [["x"]], command: "DELETE" };
  assert.equal(await deleteRateLimitsBefore(new Date()), 1);
  assert.match(captured.at(-1)!.query, /delete from "rate_limits" where "rate_limits"\."window_start" < \$1/);

  nextResult = {
    fields: [
      { name: "slug", dataTypeID: TEXT },
      { name: "status", dataTypeID: TEXT },
    ],
    rows: [["shelfie", "disabled"]],
    command: "UPDATE",
  };
  assert.deepEqual(await setProductStatusBySlug("shelfie", "disabled"), { slug: "shelfie", status: "disabled" });
  assert.match(captured.at(-1)!.query, /update "products" set "status" = \$1, "updated_at" = \$2 where "products"\."slug" = \$3/);
});

test("findServableProduct filters to live and partial", async () => {
  const { findServableProduct } = await import("@/lib/mcp/store");
  nextResult = { fields: [], rows: [], command: "SELECT" };
  assert.equal(await findServableProduct("nope"), null);
  const q = captured.at(-1)!;
  assert.match(q.query, /where \("products"\."slug" = \$1 and "products"\."status" in \(\$2, \$3\)\) limit \$4/);
  assert.deepEqual(q.params.slice(1, 3), ["live", "partial"]);
});

test("acquireInFlight: one conditional upsert that also counts the previous bucket", async () => {
  const { acquireInFlight, inFlightBucket } = await import("@/lib/gateway/store");
  const now = new Date("2026-10-27T12:34:56Z");
  assert.equal(inFlightBucket(now).toISOString(), "2026-10-27T12:30:00.000Z");

  nextResult = { fields: [{ name: "count", dataTypeID: INT4 }], rows: [[3]], command: "INSERT" };
  const slot = await acquireInFlight("inflight:t1", 4, now);
  assert.equal(slot?.toISOString(), "2026-10-27T12:30:00.000Z");
  const q = captured.at(-1)!;
  assert.match(q.query, /^insert into "rate_limits" \("key", "window_start", "count"\) select \$1, \$2::timestamptz, 1 where coalesce\(/);
  assert.match(q.query, /on conflict \("key","window_start"\) do update set "count" = "rate_limits"\."count" \+ 1 where "rate_limits"\."count" \+ coalesce\(/);
  assert.match(q.query, /returning "count"$/);
  assert.ok(q.params.includes("inflight:t1"));
  assert.ok(q.params.includes("2026-10-27T12:20:00.000Z"), "the previous bucket's slots still count");
  assert.ok(q.params.includes(4) || q.params.includes("4"));

  nextResult = { fields: [{ name: "count", dataTypeID: INT4 }], rows: [], command: "INSERT" };
  assert.equal(await acquireInFlight("inflight:t1", 4, now), null, "no row back: every slot is taken");
});

test("releaseInFlight, reserveSpend and settleSpend", async () => {
  const { releaseInFlight, reserveSpend, settleSpend } = await import("@/lib/gateway/store");
  nextResult = { fields: [], rows: [], command: "UPDATE" };
  await releaseInFlight("inflight:t1", new Date("2026-10-27T12:30:00Z"));
  let q = captured.at(-1)!;
  assert.match(q.query, /update "rate_limits" set "count" = greatest\("rate_limits"\."count" - 1, 0\) where \("rate_limits"\."key" = \$1 and "rate_limits"\."window_start" = \$2\)/);

  nextResult = { fields: [{ name: "id", dataTypeID: 2950 }], rows: [["r-1"]], command: "INSERT" };
  const id = await reserveSpend({ source: "gateway", endpoint: "responses", productId: "p1", tokenId: "t1" }, "muse-spark-1.3", 0.034);
  assert.equal(id, "r-1");
  q = captured.at(-1)!;
  assert.match(q.query, /^insert into "usage"/);
  assert.ok(q.params.includes(0.034) || q.params.includes("0.034"));

  nextResult = { fields: [], rows: [], command: "UPDATE" };
  await settleSpend("r-1", { model: "muse-spark-1.3", inputTokens: 10.4, cachedInputTokens: 0, outputTokens: 5, costUsd: 0.00003 });
  q = captured.at(-1)!;
  assert.match(q.query, /^update "usage" set "model" = \$1, "input_tokens" = \$2/);
  assert.match(q.query, /where "usage"\."id" = \$\d+$/);
  assert.ok(q.params.includes(10) || q.params.includes("10"), "token counts are rounded");

  nextResult = { fields: [], rows: [], command: "DELETE" };
  await settleSpend("r-1", null);
  assert.match(captured.at(-1)!.query, /^delete from "usage" where "usage"\."id" = \$1$/);
  await settleSpend("r-1", { model: "sam-3.1", inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, costUsd: 0 });
  assert.match(captured.at(-1)!.query, /^delete from "usage"/, "nothing used: the reservation goes");

  nextResult = { fields: [], rows: [], command: "UPDATE" };
  await settleSpend("r-1", { model: "composio:SERPAPI_SEARCH", inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, units: 1, costUsd: 0 });
  q = captured.at(-1)!;
  assert.match(q.query, /^update "usage" set .*"units" = \$\d+/, "a call with units is kept at $0");
});
