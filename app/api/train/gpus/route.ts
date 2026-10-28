import { requireAdminOrAutomation } from "@/lib/auth";
import { errorJson, route } from "@/lib/http";
import { LambdaApiError, listInstanceTypes } from "@/lib/train/lambda";
import { gpuOptions, lambdaConfigured } from "../shared";

/**
 * GET -> {options: GpuOption[]}: every GPU type a recipe can use, in recipe order, with Lambda's price and the regions
 * that have capacity right now. Admins only. 503 lambda_not_configured, 502 lambda_unavailable.
 */
export const GET = route(async (req: Request) => {
  await requireAdminOrAutomation(req);
  if (!lambdaConfigured()) return errorJson(503, "lambda_not_configured");
  try {
    return Response.json({ options: gpuOptions(await listInstanceTypes()) });
  } catch (err) {
    console.error("[train/gpus]", err instanceof Error ? err.message : err);
    const status = err instanceof LambdaApiError ? err.status : 0;
    if (status === 401 || status === 403) return errorJson(503, "lambda_not_configured");
    return errorJson(502, "lambda_unavailable");
  }
});
