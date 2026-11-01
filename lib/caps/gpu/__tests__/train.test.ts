/**
 * POST /api/products/{slug}/train (docs/CAPABILITIES.md, section 17, decision 12), on fakes: who may, which rows, reuse
 * before a GPU, and the plain answers for General's refusals. No GPU, no model call.
 *
 *   npx tsx --test lib/caps/gpu/__tests__/train.test.ts
 */
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { handleProductTrain, TRAIN_LIMITS, type TrainDeps } from "@/lib/caps/gpu/train";
import { DECIDE_MODE, validateParams, type TrainJobRow } from "@/lib/train/logic";
import { recipeById } from "@/lib/train/recipes";
import { TuneStartError } from "@/lib/train/tune/start";

const NOW = new Date("2026-11-03T15:00:00Z");
const OWNER = "uuuuuuuu-0000-4000-8000-000000000001";
const PRODUCT = { id: "pppppppp-0000-4000-8000-000000000001", name: "Corner Bakery", ownerId: OWNER, status: "live", takenDownAt: null };

const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ collection: "faq", data: { prompt: `Made-up question ${i}?`, answer: `Made-up answer ${i}.` } }));

let saved: Array<{ title: string; task: string; rows: unknown[] }>;
let runs: Array<{ datasetId: string; productId: string }>;
let removed: string[];
let launches: Array<{ params: Record<string, unknown> }>;
let counters: Record<string, number>;
let asked: { productId: string; collections: readonly string[]; limit: number }[];

function deps(over: Partial<TrainDeps> = {}): TrainDeps {
  return {
    on: () => true,
    tuneOn: () => true,
    user: async () => ({ id: OWNER, email: "maker@example.com", isAdmin: false }),
    product: async () => PRODUCT,
    ownModel: async () => null,
    openRun: async () => null,
    ownerRows: async (productId, collections, limit) => {
      asked.push({ productId, collections, limit });
      return rows(40);
    },
    saveChatDataset: async (i) => {
      saved.push(i);
      return { id: "dataset-1" };
    },
    saveDecisionDataset: async () => ({ id: "dataset-d" }),
    removeDataset: async (id) => void removed.push(id),
    startRun: async (i) => {
      runs.push(i);
      return { runId: i.datasetId, href: `/fine-tuning/runs/${i.datasetId}` };
    },
    launch: async (input) => {
      launches.push(input as never);
      return { ok: true, job: { id: "job-1" } as TrainJobRow };
    },
    setJobProduct: async () => {},
    reserveCounter: async (key, _w, amount, limit) => {
      const next = (counters[key] ?? 0) + amount;
      if (next > limit) return null;
      counters[key] = next;
      return next;
    },
    adjustCounter: async (key, _w, delta) => {
      counters[key] = (counters[key] ?? 0) + delta;
    },
    now: () => NOW,
    ...over,
  };
}

const post = (body: unknown = { collections: ["faq"], confirm: true }) => new Request("https://platform.example/api/products/corner/train", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) });
const train = (d = deps(), body?: unknown) => handleProductTrain(post(body), "corner", d);
const json = async (r: Response) => (await r.json()) as Record<string, unknown>;

beforeEach(() => {
  saved = [];
  runs = [];
  removed = [];
  launches = [];
  counters = {};
  asked = [];
});

describe("who may train", () => {
  it("is 404 with the flag off, and nothing is touched", async () => {
    const boom = async () => {
      throw new Error("touched");
    };
    const res = await train(deps({ on: () => false, user: boom, product: boom }));
    assert.equal(res.status, 404);
  });

  it("needs someone signed in, not the shared guest, not banned, and the product's owner", async () => {
    const auth = await train(deps({ user: async () => { throw Object.assign(new Error("no"), { status: 401 }); } }));
    assert.equal(auth.status, 401);
    assert.equal((await train(deps({ user: async () => ({ id: OWNER, email: "g@example.com", isAdmin: false, openAccess: true }) }))).status, 403);
    assert.equal((await train(deps({ user: async () => ({ id: OWNER, email: "g@example.com", isAdmin: false, bannedAt: NOW }) }))).status, 403);
    assert.equal((await train(deps({ user: async () => ({ id: "someone-else", email: "o@example.com", isAdmin: false }) }))).status, 403);
    assert.equal(saved.length, 0);
  });

  it("lets an admin in", async () => {
    assert.equal((await train(deps({ user: async () => ({ id: "admin", email: "a@example.com", isAdmin: true }) }))).status, 201);
  });

  it("needs a live product, and says so when TUNE_COMPOSER is off, before saving anything", async () => {
    assert.equal((await train(deps({ product: async () => ({ ...PRODUCT, status: "failed" }) }))).status, 409);
    assert.equal((await train(deps({ product: async () => ({ ...PRODUCT, takenDownAt: NOW }) }))).status, 409);
    assert.equal((await train(deps({ product: async () => null }))).status, 404);
    const off = await train(deps({ tuneOn: () => false }));
    assert.equal(off.status, 503);
    assert.match(String((await json(off)).error), /aren't switched on/);
    assert.equal(saved.length, 0);
  });
});

describe("the request", () => {
  it("needs the owner's explicit yes", async () => {
    const res = await train(deps(), { collections: ["faq"] });
    assert.equal(res.status, 400);
    assert.equal((await json(res)).code, "confirm_needed");
    assert.equal(asked.length, 0);
  });

  for (const [what, body] of [
    ["no collections", { confirm: true }],
    ["an empty list", { collections: [], confirm: true }],
    ["a bad name", { collections: ["../x"], confirm: true }],
    ["too many", { collections: ["a", "b", "c", "d", "e", "f"], confirm: true }],
    ["another recipe", { collections: ["faq"], confirm: true, recipe: "smoke" }],
    ["an unknown key", { collections: ["faq"], confirm: true, scope: "shared" }],
    ["a task too long", { collections: ["faq"], confirm: true, task: "x".repeat(TRAIN_LIMITS.taskMax + 1) }],
    ["not JSON", "{nope"],
  ] as const) {
    it(`refuses ${what}`, async () => {
      assert.equal((await train(deps(), body)).status, 400);
      assert.equal(saved.length, 0);
    });
  }
});

describe("which rows", () => {
  it("asks the store for the named collections only (the store reads owner rows, live, only)", async () => {
    await train(deps(), { collections: ["faq", "faq", "more"], confirm: true });
    assert.deepEqual(asked[0]!.collections, ["faq", "more"]);
    assert.equal(asked[0]!.limit, TRAIN_LIMITS.rowsMax + 1);
  });

  it("refuses too few rows, too many, and leaves out repeats and rows without a prompt and an answer", async () => {
    const few = await train(deps({ ownerRows: async () => rows(TRAIN_LIMITS.chatRowsMin - 1) }));
    assert.equal(few.status, 422);
    assert.equal((await json(few)).code, "not_enough_rows");
    const many = await train(deps({ ownerRows: async () => rows(TRAIN_LIMITS.rowsMax + 1) }));
    assert.equal((await json(many)).code, "too_many_rows");
    const messy = [...rows(TRAIN_LIMITS.chatRowsMin), ...rows(3), { collection: "faq", data: { note: "not a pair" } }, { collection: "faq", data: "text" }];
    assert.equal((await train(deps({ ownerRows: async () => messy }))).status, 201);
    assert.equal(saved[0]!.rows.length, TRAIN_LIMITS.chatRowsMin);
  });
});

describe("a chat run", () => {
  it("saves the rows as a dataset and starts General's run for this product", async () => {
    const res = await train();
    assert.equal(res.status, 201);
    assert.deepEqual(await json(res), { runId: "dataset-1", href: "/fine-tuning/runs/dataset-1", rows: 40, kind: "chat" });
    assert.equal(saved[0]!.title, "Corner Bakery: its own model");
    assert.deepEqual(runs, [{ datasetId: "dataset-1", callerId: OWNER, productId: PRODUCT.id }]);
    assert.equal(launches.length, 0, "tuneRun launches a chat run");
  });

  it("reuses a model that passed unless told again, so no GPU starts", async () => {
    const d = deps({ ownModel: async () => ({ adapterJobId: "job-9", trainChannel: 0 }) });
    const res = await train(d);
    assert.equal(res.status, 200);
    assert.equal((await json(res)).reused, true);
    assert.equal(saved.length, 0);
    assert.equal((await train(d, { collections: ["faq"], confirm: true, again: true })).status, 201);
  });

  it("runs one at a time", async () => {
    const res = await train(deps({ openRun: async () => ({ runId: "r", href: "/fine-tuning/runs/r" }) }));
    assert.equal(res.status, 409);
    assert.equal((await json(res)).runId, "r");
    assert.equal(saved.length, 0);
  });

  it("answers plainly when the product's day is used, and takes back the dataset and the builder's run", async () => {
    const res = await train(deps({ startRun: async () => { throw new TuneStartError(429, "product_daily", { retryAfterSeconds: 60 }); } }));
    assert.equal(res.status, 429);
    const body = await json(res);
    assert.equal(body.retryAfterSeconds, 60);
    assert.match(String(body.error), /one training run today/);
    assert.deepEqual(removed, ["dataset-1"]);
    assert.equal(counters[`train-builder-day:${OWNER}`], 0);
  });

  it("maps TUNE_COMPOSER turning off mid-way to a plain answer", async () => {
    const res = await train(deps({ startRun: async () => { throw new TuneStartError(404, "not_found"); } }));
    assert.equal(res.status, 503);
  });

  it("holds a builder to their runs a day, but not an admin", async () => {
    const d = deps();
    for (let i = 0; i < TRAIN_LIMITS.builderRunsPerDay; i++) assert.equal((await train(d)).status, 201);
    const res = await train(d);
    assert.equal(res.status, 429);
    assert.equal((await json(res)).code, "builder_daily");
    assert.equal((await train(deps({ user: async () => ({ id: OWNER, email: "a@example.com", isAdmin: true }) }))).status, 201);
  });
});

describe("a decision run", () => {
  const labels = ["approve", "flag"];
  const decisionRows = (n: number) => Array.from({ length: n }, (_, i) => ({ collection: "tickets", data: { input: `Made-up ticket number ${i} about topic ${i * 7}`, label: labels[i % 2]! } }));
  const body = { collections: ["tickets"], confirm: true, decision: { question: "Should this ticket be approved?", labels } };

  it("uses General's checks, launches in decide mode, and records the product on the job", async () => {
    const jobs: string[] = [];
    const res = await train(deps({ ownerRows: async () => decisionRows(60), setJobProduct: async (id) => void jobs.push(id) }), body);
    assert.equal(res.status, 201);
    assert.equal((await json(res)).kind, "decision");
    assert.equal(launches[0]!.params.mode, DECIDE_MODE);
    assert.deepEqual(jobs, ["job-1"]);
    assert.equal(runs.length, 1, "startTuneRun keeps the product with the run");
    const recipe = recipeById("glimmer-lora")!;
    const checked = validateParams(recipe, { ...launches[0]!.params, datasetId: "aaaaaaaa-0000-4000-8000-000000000001" });
    assert.ok(checked.ok, "the params pass the recipe's own check");
  });

  it("refuses rows without an input and a label, and rows General's check refuses", async () => {
    const bad = await train(deps({ ownerRows: async () => rows(60) }), body);
    assert.equal(bad.status, 422);
    const few = await train(deps({ ownerRows: async () => decisionRows(4) }), body);
    assert.equal(few.status, 422);
    assert.ok(Array.isArray((await json(few)).problems));
    assert.equal(launches.length, 0);
  });

  it("gives everything back when the lab refuses, in plain words", async () => {
    const res = await train(deps({ ownerRows: async () => decisionRows(60), launch: async () => ({ ok: false, status: 409, code: "too_many_active" }) }), body);
    assert.equal(res.status, 409);
    assert.match(String((await json(res)).error), /GPU is busy/);
    assert.deepEqual(removed, ["dataset-d"]);
    assert.equal(counters[`train-builder-day:${OWNER}`], 0);
    assert.equal(Object.entries(counters).find(([k]) => k.startsWith("tune-product-day"))?.[1], 0);
  });

  it("takes the product's one run a day", async () => {
    const d = deps({ ownerRows: async () => decisionRows(60) });
    assert.equal((await train(d, body)).status, 201);
    const res = await train(d, body);
    assert.equal(res.status, 429);
    assert.equal(launches.length, 1);
  });
});
