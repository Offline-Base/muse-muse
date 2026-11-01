import { eq } from "drizzle-orm";
import { isCrossSite, requireAdmin } from "@/lib/auth";
import { db, schema } from "@/lib/db/client";
import { env } from "@/lib/env";
import { errorJson, isUuid, readJson, route } from "@/lib/http";
import { packageKinds, runPackaging } from "@/lib/native/package-run";
import { briefTargets } from "@/lib/native/targets";

/**
 * POST {buildId, url?} -> 200 {runId, status, packages, failures}: makes a build's phone and desktop downloads again, or
 * for the first time on a run with no live link, where `url` says what the app opens. Admins only. It waits for the packager.
 */
export const POST = route(async (req: Request) => {
  if (isCrossSite(req.headers)) return errorJson(403, "cross_site");
  await requireAdmin();
  if (!env.packagerSnapshotId) return errorJson(503, "PACKAGER_SNAPSHOT_ID isn't set.");
  const body = await readJson(req);
  if (typeof body.buildId !== "string" || !isUuid(body.buildId)) return errorJson(400, "Send a buildId.");
  const [row] = await db()
    .select({ brief: schema.builds.brief, productId: schema.products.id, slug: schema.products.slug, name: schema.products.name, liveUrl: schema.products.liveUrl })
    .from(schema.builds)
    .innerJoin(schema.products, eq(schema.products.id, schema.builds.productId))
    .where(eq(schema.builds.id, body.buildId))
    .limit(1);
  if (!row) return errorJson(404, "not_found");
  const targets = briefTargets(row.brief);
  if (!packageKinds(targets).length) return errorJson(400, "This build's brief has no phone or desktop target.");
  const url = row.liveUrl ?? (typeof body.url === "string" && /^https:\/\//.test(body.url) ? body.url : null);
  if (!url) return errorJson(400, "This product has no live link, so send an https url for the app to open.");
  const run = await runPackaging({ productId: row.productId, buildId: body.buildId, slug: row.slug, name: row.name, url, targets, origin: "owner" });
  return Response.json({
    runId: run.runId,
    status: run.status,
    failures: run.failures,
    packages: run.files.map((f) => ({ kind: f.kind, bytes: f.bytes, sha256: f.sha256, signedWith: f.signedWith, pathname: f.pathname })),
  });
});
