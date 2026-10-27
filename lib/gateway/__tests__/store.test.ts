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
