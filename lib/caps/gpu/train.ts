import { randomBytes } from "node:crypto";
import { COLLECTION_NAME } from "@/lib/caps/data/types";
import type { OwnModel } from "@/lib/caps/gpu/types";
import { checkDecisionUpload, type DecisionUploadInput } from "@/lib/train/decision-datasets";
import { ADAPTER_RECIPE, DECIDE_MODE } from "@/lib/train/logic";
import type { LaunchInput, LaunchResult } from "@/lib/train/launch";
import { objectRow } from "@/lib/train/tune/examples";
import { productDay, TuneStartError } from "@/lib/train/tune/start";
import type { ExampleRow } from "@/lib/train/tune/types";
import { builderTier, tierMayUseBuilderCaps } from "@/lib/trust/tiers";

/**
 * POST /api/products/{slug}/train {collections, confirm: true, task?, recipe?, decision?, again?}: "Train on my data"
 * (docs/CAPABILITIES.md, section 17, decision 12). The product's signed-in builder turns their own owner rows into a dataset
 * and starts one run on the lab, with General's startTuneRun and launchJob and every cap those have. Never shared, visitor
 * or user rows, and only as an explicit action of the owner's (`confirm`). Rows of {prompt, answer} under the usual names
 * train a chat model. With `decision: {question, labels}`, rows of {input, label} train a decision model in General's
 * {state, question, options} format, which the product then calls through {GATEWAY_URL}/decide. A product that already has a
 * model that passed reuses it unless the owner says `again`, so no GPU starts for nothing.
 */

export const TRAIN_LIMITS = {
  /** A chat run: 8 kept aside to score, 16 to train on, and room for near-duplicates to go. */
  chatRowsMin: 30,
  rowsMax: 1000,
  collectionsMax: 5,
  taskMax: 1000,
  /** Runs one signed-in builder (not an admin) may start in a UTC day, on top of a product's one a day. */
  builderRunsPerDay: 2,
} as const;

const KNOWN = new Set(["collections", "confirm", "task", "recipe", "decision", "again"]);

export interface TrainUser {
  id: string;
  email: string;
  isAdmin: boolean;
  openAccess?: boolean;
  bannedAt?: Date | null;
}

export interface TrainProduct {
  id: string;
  name: string;
  ownerId: string;
  status: string;
  takenDownAt: Date | null;
}

export interface TrainDeps {
  on(): boolean;
  tuneOn(): boolean;
  /** Throws an error with a `status` when nobody is signed in. */
  user(): Promise<TrainUser>;
  product(slug: string): Promise<TrainProduct | null>;
  ownModel(productId: string, now: Date): Promise<OwnModel | null>;
  /** The product's run still writing or training, or null. */
  openRun(productId: string): Promise<{ runId: string; href: string } | null>;
  ownerRows(productId: string, collections: readonly string[], limit: number): Promise<Array<{ collection: string; data: unknown }>>;
  saveChatDataset(input: { title: string; task: string; rows: ExampleRow[]; createdBy: string }): Promise<{ id: string }>;
  saveDecisionDataset(input: { title: string; checked: Extract<ReturnType<typeof checkDecisionUpload>, { ok: true }>; createdBy: string }): Promise<{ id: string }>;
  removeDataset(id: string): Promise<void>;
  startRun(input: { datasetId: string; callerId: string; productId: string }): Promise<{ runId: string; href: string }>;
  launch(input: LaunchInput, caller: { userId: string }): Promise<LaunchResult>;
  setJobProduct(jobId: string, productId: string): Promise<void>;
  reserveCounter(key: string, windowStart: Date, amount: number, limit: number): Promise<number | null>;
  adjustCounter(key: string, windowStart: Date, delta: number): Promise<void>;
  now?(): Date;
}

const answer = (status: number, code: string, error: string, more?: Record<string, unknown>) => Response.json({ code, error, ...more }, { status });

function rowOfDecision(data: unknown): { input: string; label: string } | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const { input, state, label } = data as Record<string, unknown>;
  const text = typeof input === "string" ? input : typeof state === "string" ? state : null;
  return text !== null && typeof label === "string" ? { input: text, label } : null;
}

/** Plain words for what starting a run can refuse. */
function startRefusal(err: TuneStartError): Response {
  if (err.code === "product_daily") return answer(429, err.code, "This product has already started its one training run today. Try again tomorrow.", err.body);
  if (err.code === "not_found") return answer(503, "tune_off", "Training runs aren't switched on here yet.");
  return answer(err.status, err.code, "The training run couldn't start. Try again.");
}

const LAUNCH_WORDS: Record<string, string> = {
  too_many_active: "The lab's GPU is busy with another job. Try again later.",
  daily_cap: "The lab has reached its training limit for today. Try again tomorrow.",
  no_capacity: "No GPU is free right now. Try again soon.",
};

export async function handleProductTrain(req: Request, slug: string, deps: TrainDeps): Promise<Response> {
  if (!deps.on()) return answer(404, "not_found", "Not found.");
  let user: TrainUser;
  try {
    user = await deps.user();
  } catch (err) {
    const status = (err as { status?: unknown }).status;
    if (typeof status === "number") return answer(status, "sign_in_required", "Sign in to train a model on your data.");
    throw err;
  }
  const tier = builderTier(user);
  if (user.openAccess || !tierMayUseBuilderCaps(tier)) return answer(403, "sign_in_required", "Sign in first. Everyone shares the guest account, so it can't tell whose data this is.");
  const product = await deps.product(slug);
  if (!product) return answer(404, "not_found", "Not found.");
  if (!user.isAdmin && user.id !== product.ownerId) return answer(403, "not_owner", "Only the product's owner can train on its data.");
  if (product.takenDownAt || (product.status !== "live" && product.status !== "partial")) return answer(409, "not_live", "This product isn't live, so it has no data to train on.");
  // startTuneRun needs TUNE_COMPOSER. Said here, before a dataset is saved.
  if (!deps.tuneOn()) return answer(503, "tune_off", "Training runs aren't switched on here yet.");

  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await req.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    body = parsed as Record<string, unknown>;
  } catch {
    return answer(400, "invalid_arguments", "Send a JSON object.");
  }
  const stray = Object.keys(body).find((k) => !KNOWN.has(k));
  if (stray) return answer(400, "invalid_arguments", `This doesn't take "${stray.slice(0, 40)}".`);
  if (body.confirm !== true) return answer(400, "confirm_needed", "Say that you want to train on these rows: send confirm: true.");
  if (body.recipe !== undefined && body.recipe !== ADAPTER_RECIPE) return answer(400, "invalid_arguments", `The only recipe here is ${ADAPTER_RECIPE}: Muse Glimmer, Meta's open model.`);
  const list = body.collections;
  if (!Array.isArray(list) || !list.length || list.length > TRAIN_LIMITS.collectionsMax || !list.every((c) => typeof c === "string" && COLLECTION_NAME.test(c))) {
    return answer(400, "invalid_arguments", `Name 1 to ${TRAIN_LIMITS.collectionsMax} of this product's collections.`);
  }
  const collections = [...new Set(list as string[])];
  if (body.task !== undefined && (typeof body.task !== "string" || body.task.length > TRAIN_LIMITS.taskMax)) {
    return answer(400, "invalid_arguments", `task must be text of up to ${TRAIN_LIMITS.taskMax} characters.`);
  }
  const decision = body.decision as { question?: unknown; labels?: unknown } | undefined;
  if (decision !== undefined && (!decision || typeof decision !== "object" || Array.isArray(decision))) return answer(400, "invalid_arguments", "decision must be {question, labels}.");

  const now = deps.now?.() ?? new Date();
  if (body.again !== true) {
    const own = await deps.ownModel(product.id, now);
    if (own) return Response.json({ reused: true, adapterJobId: own.adapterJobId, message: "This product already has its own model that passed, so no GPU was started. Send again: true to train another." });
  }
  const open = await deps.openRun(product.id);
  if (open) return answer(409, "run_open", "This product's training run is still going. One at a time.", open);

  const found = await deps.ownerRows(product.id, collections, TRAIN_LIMITS.rowsMax + 1);
  if (found.length > TRAIN_LIMITS.rowsMax) return answer(422, "too_many_rows", `Those collections have over ${TRAIN_LIMITS.rowsMax} of your rows. Name fewer.`);
  const title = `${product.name}: its own model`;

  let checked: Extract<ReturnType<typeof checkDecisionUpload>, { ok: true }> | null = null;
  let chatRows: ExampleRow[] = [];
  if (decision) {
    const rows = found.map((r) => rowOfDecision(r.data));
    if (rows.some((r) => !r)) return answer(422, "bad_rows", "Each of your rows needs an input (or state) and a label, both text.");
    const result = checkDecisionUpload({ title, question: decision.question, labels: decision.labels, rows } as DecisionUploadInput, randomBytes(12).toString("hex"));
    if (!result.ok) return answer(422, "bad_rows", "Those rows can't train a decision model yet.", { problems: result.problems });
    checked = result;
  } else {
    const seen = new Set<string>();
    for (const r of found) {
      const row = objectRow(r.data);
      if (row && !seen.has(row.prompt)) {
        seen.add(row.prompt);
        chatRows.push(row);
      }
    }
    if (chatRows.length < TRAIN_LIMITS.chatRowsMin) {
      return answer(422, "not_enough_rows", `Training needs at least ${TRAIN_LIMITS.chatRowsMin} of your own rows with a prompt and an answer, and these collections have ${chatRows.length}.`, { rows: chatRows.length });
    }
  }

  // A builder's own cap, taken before anything is saved. Admins answer to the lab's caps alone.
  const dayEnd = productDay(user.id, now).until;
  const builderKey = `train-builder-day:${user.id}`;
  const countsBuilder = !user.isAdmin;
  if (countsBuilder && (await deps.reserveCounter(builderKey, dayEnd, 1, TRAIN_LIMITS.builderRunsPerDay)) === null) {
    return answer(429, "builder_daily", `You've started your ${TRAIN_LIMITS.builderRunsPerDay} training runs for today. Try again tomorrow.`);
  }
  const giveBack = async () => {
    if (countsBuilder) await deps.adjustCounter(builderKey, dayEnd, -1).catch((e) => console.error("[gpu/train] builder day", e));
  };

  let datasetId: string | null = null;
  try {
    if (checked) {
      // A decision run's job starts here: tuneRun trains chat runs. It takes the product's day the same way.
      const day = productDay(product.id, now);
      if ((await deps.reserveCounter(day.key, day.until, 1, 1)) === null) {
        await giveBack();
        return startRefusal(new TuneStartError(429, "product_daily", { retryAfterSeconds: Math.max(1, Math.ceil((day.until.getTime() - now.getTime()) / 1000)) }));
      }
      const giveDayBack = () => deps.adjustCounter(day.key, day.until, -1).catch((e) => console.error("[gpu/train] product day", e));
      datasetId = (await deps.saveDecisionDataset({ title, checked, createdBy: user.id })).id;
      const run = await deps.startRun({ datasetId, callerId: user.id, productId: product.id });
      const started = await deps.launch({ recipe: ADAPTER_RECIPE, title, params: { datasetId, mode: DECIDE_MODE, publish: 0 } }, { userId: user.id });
      if (!started.ok) {
        await giveBack();
        await giveDayBack();
        await deps.removeDataset(datasetId);
        const words = started.status === 400 ? started.code : (LAUNCH_WORDS[started.code] ?? "The GPU couldn't start. Try again later.");
        return answer(started.status, started.status === 400 ? "invalid_arguments" : started.code, words);
      }
      await deps.setJobProduct(started.job.id, product.id);
      return Response.json({ ...run, jobId: started.job.id, rows: checked.spec.split.train + checked.spec.split.dev + checked.spec.split.test, kind: "decision" }, { status: 201 });
    }
    const task = typeof body.task === "string" && body.task.trim() ? body.task.trim() : `Answer for ${product.name} the way these examples do.`;
    datasetId = (await deps.saveChatDataset({ title, task, rows: chatRows, createdBy: user.id })).id;
    const run = await deps.startRun({ datasetId, callerId: user.id, productId: product.id });
    return Response.json({ ...run, rows: chatRows.length, kind: "chat" }, { status: 201 });
  } catch (err) {
    await giveBack();
    if (datasetId) await deps.removeDataset(datasetId).catch((e) => console.error("[gpu/train] remove dataset", e));
    if (err instanceof TuneStartError) return startRefusal(err);
    throw err;
  }
}
