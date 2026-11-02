import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { env } from "@/lib/env";
import { hitRateLimits } from "@/lib/gateway/store";
import { errorJson, readJson, route } from "@/lib/http";
import { toolKey } from "@/lib/tools/keys";
import { fileReport, parseReport, reporterIp, reporterKey } from "@/lib/trust/reports";

/**
 * POST {slug, reason, detail} -> 200 {ok}. Anyone can report a product (TRUST_REPORTS, docs/CAPABILITIES.md, section 7):
 * 400 with a sentence for a bad report, 429 over 3 a minute or 5 a day from one IP, 404 with the flag off. The IP is kept
 * only as an HMAC (lib/trust/reports.ts). A product's own Report link opens /report/<slug>, which posts here. While the
 * Privacy page is on (TRUST_LEGAL_PAGES), a privacy request is taken with TRUST_REPORTS off too, since the form there is
 * how anyone asks for their data to be deleted. Every other reason stays 404 with the flag off.
 */
export const POST = route(async (req: Request) => {
  if (!env.trustReports && !env.trustLegalPages) return errorJson(404, "not_found");
  const parsed = parseReport(await readJson(req, 8192));
  if (!env.trustReports && !(parsed.ok && parsed.value.reason === "privacy")) return errorJson(404, "not_found");
  if (!parsed.ok) return errorJson(400, parsed.error);
  const key = reporterKey(reporterIp(req.headers), toolKey("trust-reports"));
  const result = await fileReport(parsed.value, key, {
    hitRateLimits,
    async findProductId(slug) {
      const [row] = await db().select({ id: schema.products.id }).from(schema.products).where(eq(schema.products.slug, slug)).limit(1);
      return row?.id ?? null;
    },
    async insertReport(row) {
      await db().insert(schema.abuseReports).values(row);
    },
    now: () => new Date(),
  });
  if (!result.ok) return errorJson(result.status, result.error);
  return Response.json({ ok: true });
});
