import { and, desc, eq, sql } from "drizzle-orm";
import { start } from "workflow/api";
import { isCrossSite, requireAdminOrAutomation } from "@/lib/auth";
import { db, schema } from "@/lib/db/client";
import { env } from "@/lib/env";
import { buildTokenBudgetFor } from "@/lib/gateway/policy";
import { errorJson, isUuid, route } from "@/lib/http";
import { attachRun, insertRefineBuild, markStartFailed } from "@/lib/pipeline/records";
import { refineProduct } from "@/lib/pipeline/workflow";
import { POLISH_HEADER } from "@/lib/polish/logic";
import { startPolish } from "@/lib/polish/start";
import { checkBuildAllowed } from "@/lib/quota";

type Ctx = { params: Promise<{ buildId: string }> };

const MAX_BODY_BYTES = 16 * 1024;

/**
 * POST {focus?, again?, look?} -> 201 {buildId, model, maxUsd, roundSteps, fixRounds, look?}: the polish round
 * (lib/polish/logic.ts), one refinement of the live product this build made, with Muse Code on Muse Wonder and the fixed
 * polish note, plus `focus` (audit findings, say). `look: "meta"` puts the product on the Meta AI app look, muse-app-ui (any other
 * value is a 400); left out, the product keeps its look. Admins, or a script with the AUTOMATION_SECRET bearer. 404
 * while POLISH_ENABLED is off or for an unknown build, 409 not_shipped, busy (another build of the product runs) or
 * already_polished (send again: true to run another; either one says look "meta" when the polish it names put the
 * product on the Meta AI app look), 503 polish_budget_off with POLISH_MAX_USD at 0, and checkBuildAllowed's refusals
 * (paused, no_storage).
 */
export const POST = route(async (req: Request, { params }: Ctx) => {
  if (!env.polishEnabled) return errorJson(404, "not_found");
  if (isCrossSite(req.headers)) return errorJson(403, "cross_site");
  const user = await requireAdminOrAutomation(req);
  const { buildId } = await params;
  if (!isUuid(buildId)) return errorJson(404, "not_found");

  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) return errorJson(413, "body_too_large");
  let body: Record<string, unknown> = {};
  if (text.trim()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return errorJson(400, "Send a JSON body.");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return errorJson(400, "Send a JSON object.");
    body = parsed as Record<string, unknown>;
  }

  const result = await startPolish(
    {
      enabled: env.polishEnabled,
      maxUsd: env.polishMaxUsd,
      buildTokenUsd: buildTokenBudgetFor(),
      findBuild: async (id) => {
        const [row] = await db().select({ productId: schema.builds.productId }).from(schema.builds).where(eq(schema.builds.id, id)).limit(1);
        return row ?? null;
      },
      findProduct: async (id) => {
        const [row] = await db()
          .select({ id: schema.products.id, status: schema.products.status, sandboxName: schema.products.sandboxName, museSessionId: schema.products.museSessionId, rebuildOf: schema.products.rebuildOf })
          .from(schema.products)
          .where(eq(schema.products.id, id))
          .limit(1);
        return row ?? null;
      },
      lastPolish: async (productId) => {
        const [row] = await db()
          .select({ buildId: schema.builds.id, status: schema.builds.status, message: schema.builds.message })
          .from(schema.builds)
          .where(and(eq(schema.builds.productId, productId), eq(schema.builds.kind, "refine"), sql`starts_with(${schema.builds.message}, ${POLISH_HEADER})`))
          .orderBy(desc(schema.builds.startedAt))
          .limit(1);
        return row ?? null;
      },
      allowed: () => checkBuildAllowed(user),
      insert: (input) => insertRefineBuild({ userId: user.id, references: [], ...input }),
      start: async (id) => (await start(refineProduct, [{ buildId: id }])).runId,
      attachRun,
      markStartFailed,
    },
    buildId,
    body,
  );
  return Response.json(result.body, { status: result.status });
});
