/**
 * U6's rows and routes on an in-memory PGlite: the photo and look-alike lists only the database can cap under a race,
 * edits refused once a run starts, and every U6 route a 404 with SAM_TUNE off. The sam_tune_runs table is made here
 * with U1's columns (drizzle/0033 is U1's); sign-in and Blob are fakes. No Meta call: the paid routes are only reached
 * with the flag off or on a run they refuse before any call.
 *
 *   npx tsx --experimental-test-module-mocks --test lib/train/sam/__tests__/uploads.test.ts
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it, mock } from "node:test";
import * as realSchema from "@/lib/db/schema";

const canMock = typeof (mock as { module?: unknown }).module === "function";
const at = (p: string) => new URL(p, import.meta.url).href;

const TABLE = `CREATE TABLE "sam_tune_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL, "word" text NOT NULL, "generic" text NOT NULL, "data" text NOT NULL,
  "status" text DEFAULT 'draft' NOT NULL, "photos" jsonb DEFAULT '[]'::jsonb NOT NULL, "distractors" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "seed" integer NOT NULL DEFAULT 1, "epochs" integer NOT NULL DEFAULT 1, "cost_usd" real DEFAULT 0 NOT NULL, "max_usd" real NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL, "updated_at" timestamp with time zone DEFAULT now() NOT NULL)`;

/** A 640 x 480 JPEG header, enough for the photo checks. */
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 1, 0xe0, 2, 0x80, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);

describe("SAM tune uploads", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  let client: import("@electric-sql/pglite").PGlite;
  let store: typeof import("../uploads-store");
  let photosRoute: typeof import("../../../../app/api/train/sam/[id]/photos/route");
  let labelRoute: typeof import("../../../../app/api/train/sam/[id]/label/route");
  let distractorsRoute: typeof import("../../../../app/api/train/sam/[id]/distractors/route");
  let puts = 0;

  before(async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle } = await import("drizzle-orm/pglite");
    client = new PGlite();
    await client.exec(TABLE);
    const testDb = drizzle({ client, schema: realSchema });
    mock.module(at("../../../db/client.ts"), { namedExports: { db: () => testDb, schema: realSchema } });
    mock.module(at("../../../auth.ts"), {
      namedExports: {
        requireAdminOrAutomation: async () => ({ id: "00000000-0000-4000-8000-0000000000aa" }),
        AuthError: class AuthError extends Error {
          status = 403;
        },
      },
    });
    mock.module(at("../../../storage.ts"), {
      namedExports: {
        putFile: async (prefix: string, path: string) => `https://made-up.public.blob.vercel-storage.com/${prefix}/${path}?n=${puts++}`,
      },
    });
    store = await import("../uploads-store");
    photosRoute = await import("../../../../app/api/train/sam/[id]/photos/route");
    labelRoute = await import("../../../../app/api/train/sam/[id]/label/route");
    distractorsRoute = await import("../../../../app/api/train/sam/[id]/distractors/route");
  });
  after(() => client?.close());
  beforeEach(() => {
    process.env.SAM_TUNE = "1";
  });

  async function newRun(data = "uploads", status = "draft"): Promise<string> {
    const r = await client.query<{ id: string }>(
      `insert into sam_tune_runs (word, generic, data, status, max_usd) values ('bun', 'plush toy', $1, $2, 1) returning id`,
      [data, status],
    );
    return r.rows[0].id;
  }
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
  const post = (body: unknown) => new Request("http://x/", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
  const patch = (body: unknown) => new Request("http://x/", { method: "PATCH", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
  const photo = (i: number) => ({ url: `u${i}`, split: "train" as const, box: null, skipped: false });

  it("every U6 route is a 404 with SAM_TUNE off", async () => {
    delete process.env.SAM_TUNE;
    const id = await newRun();
    const answers = await Promise.all([
      photosRoute.POST(post({ image: JPEG.toString("base64") }), ctx(id)),
      labelRoute.POST(post({}), ctx(id)),
      labelRoute.PATCH(patch({ url: "u0", box: [1, 1, 5, 5] }), ctx(id)),
      distractorsRoute.POST(post({ count: 1 }), ctx(id)),
      distractorsRoute.PATCH(patch({ url: "u0", kept: false }), ctx(id)),
    ]);
    assert.deepEqual(answers.map((a) => a.status), [404, 404, 404, 404, 404]);
    assert.equal(puts, 0);
  });

  it("caps the photo list in one statement, even when 70 arrive at once", async () => {
    const id = await newRun();
    const results = await Promise.all(Array.from({ length: 70 }, (_, i) => store.addPhoto(id, photo(i))));
    assert.equal(results.filter(Boolean).length, 60);
    assert.equal((await store.getUploadRun(id))!.photos.length, 60);
  });

  it("patches one photo by url, keeps the order, and refuses once the run has started", async () => {
    const id = await newRun();
    for (let i = 0; i < 3; i++) await store.addPhoto(id, photo(i));
    assert.equal(await store.savePhoto(id, "u1", { box: [1, 2, 30, 40], skipped: false }), true);
    assert.equal(await store.savePhoto(id, "nope", { box: null, skipped: true }), false);
    const run = (await store.getUploadRun(id))!;
    assert.deepEqual(run.photos.map((p) => p.url), ["u0", "u1", "u2"]);
    assert.deepEqual(run.photos[1].box, [1, 2, 30, 40]);
    assert.equal(run.photos[0].box, null);
    await client.query(`update sam_tune_runs set status = 'queued' where id = $1`, [id]);
    assert.equal(await store.savePhoto(id, "u0", { box: [1, 1, 5, 5], skipped: false }), false);
    assert.equal(await store.addPhoto(id, photo(9)), null);
  });

  it("keeps or drops a look-alike, and adds a call's cost", async () => {
    const id = await newRun();
    await store.addDistractor(id, { url: "d0", source: "muse-image", split: "train", kept: true });
    assert.equal(await store.setDistractorKept(id, "d0", false), true);
    await store.addRunCost(id, 0.0025);
    await store.addRunCost(id, 0.01);
    const run = (await store.getUploadRun(id))!;
    assert.equal(run.distractors[0].kept, false);
    assert.ok(Math.abs(run.costUsd - 0.0125) < 1e-6);
  });

  it("/photos saves a photo, holds every third out, and refuses the built-in set or a started run", async () => {
    const id = await newRun();
    const dataUrl = `data:image/jpeg;base64,${JPEG.toString("base64")}`;
    const splits: string[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await photosRoute.POST(post({ image: dataUrl }), ctx(id));
      assert.equal(res.status, 201);
      splits.push(((await res.json()) as { photo: { split: string } }).photo.split);
    }
    assert.deepEqual(splits, ["train", "train", "held"]);
    const own = await photosRoute.POST(post({ image: dataUrl, kind: "lookalike" }), ctx(id));
    assert.equal(own.status, 201);
    assert.equal(((await own.json()) as { distractor: { source: string } }).distractor.source, "own");

    const bad = await photosRoute.POST(post({ image: "aGVsbG8gdGhlcmU=" }), ctx(id));
    assert.equal(bad.status, 400);
    assert.equal((await photosRoute.POST(post({ image: dataUrl }), ctx(await newRun("builtin-muse")))).status, 409);
    assert.equal((await photosRoute.POST(post({ image: dataUrl }), ctx(await newRun("uploads", "running")))).status, 409);
    assert.equal((await photosRoute.POST(post({ image: dataUrl }), ctx("00000000-0000-4000-8000-00000000dead"))).status, 404);
  });

  it("/label PATCH saves the person's box and checks it", async () => {
    const id = await newRun();
    await store.addPhoto(id, photo(0));
    assert.equal((await labelRoute.PATCH(patch({ url: "u0", box: [0, 0, 1, 1] }), ctx(id))).status, 400);
    assert.equal((await labelRoute.PATCH(patch({ url: "other", box: [0, 0, 9, 9] }), ctx(id))).status, 404);
    assert.equal((await labelRoute.PATCH(patch({ url: "u0", box: [3, 4, 20, 30] }), ctx(id))).status, 200);
    assert.deepEqual((await store.getUploadRun(id))!.photos[0].box, [3, 4, 20, 30]);
    assert.equal((await labelRoute.PATCH(patch({ url: "u0", skipped: true }), ctx(id))).status, 200);
    assert.equal((await store.getUploadRun(id))!.photos[0].skipped, true);
  });

  it("the paid routes refuse a built-in or started run before any call", async () => {
    assert.equal((await labelRoute.POST(post({}), ctx(await newRun("builtin-muse")))).status, 409);
    assert.equal((await distractorsRoute.POST(post({ count: 2 }), ctx(await newRun("uploads", "queued")))).status, 409);
  });
});
