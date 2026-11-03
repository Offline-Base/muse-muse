/**
 * Starting a polish round (POST /api/builds/{buildId}/polish, lib/polish/logic.ts). Plain module: the route passes the real
 * database, quota and workflow start, and tests pass fakes, so nothing here spends or reaches Neon on its own.
 */
import { POLISH_LOOKS, POLISH_MAX_FOCUS_CHARS, POLISH_MIN_USD, POLISH_MODEL, polishNote, polishPlan, type PolishLook } from "@/lib/polish/logic";
import { TERMINAL_STATUSES, type BuildStatus } from "@/lib/types";

export interface PolishProduct {
  id: string;
  status: string;
  sandboxName: string | null;
  museSessionId: string | null;
  rebuildOf: string | null;
}

export interface PolishDeps {
  enabled: boolean;
  maxUsd: number;
  buildTokenUsd: number;
  /** The product the build made, or null for an unknown build. `productId` null: the build hasn't shipped a product. */
  findBuild(buildId: string): Promise<{ productId: string | null } | null>;
  findProduct(productId: string): Promise<PolishProduct | null>;
  /** The product's newest polish build, whatever its status, or null when it has had none. */
  lastPolish(productId: string): Promise<{ buildId: string; status: string } | null>;
  /** The same checks a new build or change gets (checkBuildAllowed): storage, setup, the spend pause, trust. */
  allowed(): Promise<{ ok: true } | { ok: false; status: number; error: string }>;
  /** insertRefineBuild: null while another build of the product runs. */
  insert(input: { productId: string; rebuildOf: string | null; message: string; buildModel: string }): Promise<{ buildId: string } | null>;
  /** start(refineProduct, ...): the workflow run's id. */
  start(buildId: string): Promise<string>;
  attachRun(buildId: string, runId: string): Promise<void>;
  markStartFailed(buildId: string, err: unknown): Promise<void>;
}

export type PolishReply = { status: number; body: Record<string, unknown> };

const reply = (status: number, body: Record<string, unknown>): PolishReply => ({ status, body });

/**
 * The polish note from the caller's body: the fixed note, plus `focus` when sent, and with `look: "meta"` the step that
 * switches the product to the Meta UI look. An error string when the body is wrong.
 */
export function polishRequest(body: Record<string, unknown>): { message: string; again: boolean; look?: PolishLook } | { error: string } {
  if (body.focus !== undefined && body.focus !== null && typeof body.focus !== "string") return { error: "focus must be text." };
  const focus = typeof body.focus === "string" ? body.focus.trim() : "";
  if (focus.length > POLISH_MAX_FOCUS_CHARS) return { error: `Keep focus under ${POLISH_MAX_FOCUS_CHARS} characters.` };
  if (body.again !== undefined && typeof body.again !== "boolean") return { error: "again must be true or false." };
  if (body.look !== undefined && !(POLISH_LOOKS as readonly unknown[]).includes(body.look)) return { error: `look must be "meta" or left out.` };
  const look = body.look as PolishLook | undefined;
  return { message: polishNote(focus || null, look ?? null), again: body.again === true, ...(look ? { look } : {}) };
}

/**
 * Starts one polish of the live product a build made. Refuses (409) before it has shipped, while another build of the
 * product runs, and when the product has had a polish already, unless `again` is true. Nothing starts with the flag off
 * (404) or POLISH_MAX_USD at 0 or under POLISH_MIN_USD (503).
 */
export async function startPolish(deps: PolishDeps, buildId: string, body: Record<string, unknown>): Promise<PolishReply> {
  if (!deps.enabled) return reply(404, { error: "not_found" });
  const request = polishRequest(body);
  if ("error" in request) return reply(400, { error: request.error });
  if (!(deps.maxUsd > 0)) return reply(503, { error: "polish_budget_off", message: "POLISH_MAX_USD is 0, so no polish starts." });
  if (deps.maxUsd < POLISH_MIN_USD) {
    return reply(503, { error: "polish_budget_low", message: `POLISH_MAX_USD is under $${POLISH_MIN_USD.toFixed(2)}, too little for a polish round, so none starts.` });
  }

  const build = await deps.findBuild(buildId);
  if (!build) return reply(404, { error: "not_found" });
  if (!build.productId) return reply(409, { error: "not_shipped" });
  const product = await deps.findProduct(build.productId);
  if (!product) return reply(404, { error: "not_found" });
  if ((product.status !== "live" && product.status !== "partial") || !product.sandboxName || !product.museSessionId) return reply(409, { error: "not_shipped" });

  const last = await deps.lastPolish(product.id);
  // A polish still running is busy whatever `again` says; insert's own check covers every other build of the product.
  if (last && !TERMINAL_STATUSES.includes(last.status as BuildStatus)) return reply(409, { error: "busy", buildId: last.buildId });
  if (last && !request.again) {
    return reply(409, { error: "already_polished", buildId: last.buildId, status: last.status, message: "This product has had a polish. Send again: true to run another." });
  }

  const allowed = await deps.allowed();
  if (!allowed.ok) return reply(allowed.status, { error: allowed.error });

  const inserted = await deps.insert({ productId: product.id, rebuildOf: product.rebuildOf, message: request.message, buildModel: POLISH_MODEL });
  if (!inserted) return reply(409, { error: "busy" });
  let runId: string;
  try {
    runId = await deps.start(inserted.buildId);
  } catch (err) {
    await deps.markStartFailed(inserted.buildId, err);
    return reply(500, { error: "start_failed" });
  }
  await deps.attachRun(inserted.buildId, runId).catch((err: unknown) => console.error("[polish] attachRun", err));
  const plan = polishPlan(deps.maxUsd, deps.buildTokenUsd);
  return reply(201, { buildId: inserted.buildId, model: POLISH_MODEL, maxUsd: plan.maxUsd, roundSteps: plan.roundSteps, fixRounds: plan.fixRounds, ...(request.look ? { look: request.look } : {}) });
}
