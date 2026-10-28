/**
 * The Hugging Face Hub client (lib/train/hub.ts) against a fake Hub on localhost (fake-hub.ts) through HF_ENDPOINT:
 * repos made private (an existing one is fine, a conflicting operation is tried again), preupload, the LFS batch with
 * only the basic and multipart transfers and its actions (a verify action's credential never comes out, and an object
 * the Hub stores gets none, which is how publishing checks an upload), uploads through presigned URLs with no
 * credential, the NDJSON commit, visibility set and read back, the tree read and its checks, whoami, bounded retries
 * on 429 and 5xx, timeouts, the token read on each call and blanked out of every error, and signed URLs blanked out
 * too. Nothing here reaches the real Hub.
 *
 *   npx tsx --test lib/train/__tests__/hub.test.ts
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";
import * as hub from "../hub";
import { gitOidOf, startFakeHub, type FakeHub } from "./fake-hub";

/** Test values, not real tokens. */
const TOKEN = "hf_test_token_for_the_fake_hub_0001";
const OTHER_TOKEN = "hf_test_token_for_the_fake_hub_0002";
const MODEL: hub.HubRepo = { type: "model", id: "muse-org/muse-glimmer-30b-bakery-lora-8f1d2c3b" };
const DATA: hub.HubRepo = { type: "dataset", id: "muse-org/muse-muse-bakery-1b2c3d4e" };
const savedEnv = { ...process.env };
const savedTiming = { ...hub.hubTiming };

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
/** Deterministic bytes, `n` of them. */
function bytes(n: number, seed = 1): Buffer {
  const out = Buffer.alloc(n);
  for (let i = 0; i < n; i++) out[i] = (i * 31 + seed * 17) % 251;
  return out;
}

let fake: FakeHub;

describe("Hugging Face Hub client", () => {
  before(async () => {
    fake = await startFakeHub({ token: TOKEN, multipartOver: 64 * 1024, chunkSize: 25 * 1024 });
    process.env.HF_TOKEN = TOKEN;
    process.env.HF_ENDPOINT = fake.url;
    Object.assign(hub.hubTiming, { timeoutMs: 400, uploadTimeoutMs: 2000, retries: 3, retryBaseMs: 1, retryMaxMs: 5 });
  });

  after(async () => {
    Object.assign(hub.hubTiming, savedTiming);
    process.env = savedEnv;
    await fake.close();
  });

  beforeEach(() => {
    process.env.HF_TOKEN = TOKEN;
    fake.requests.length = 0;
    fake.leaks.length = 0;
    fake.conflicts = 0;
  });

  it("makes a repo private with its license, and takes one that exists", async () => {
    const made = await hub.createRepo(MODEL, { license: "apache-2.0" });
    assert.deepEqual(made, { created: true, url: `${fake.url}/${MODEL.id}` });
    const repo = fake.repo("model", MODEL.id)!;
    assert.equal(repo.private, true);
    assert.equal(repo.license, "apache-2.0");
    const body = JSON.parse(fake.requests[0]!.body.toString("utf8"));
    assert.deepEqual(body, { type: "model", name: MODEL.id.split("/")[1], organization: "muse-org", visibility: "private", license: "apache-2.0" });
    assert.equal(fake.requests[0]!.authorization, `Bearer ${TOKEN}`);
    assert.deepEqual(await hub.createRepo(MODEL), { created: false, url: `${fake.url}/${MODEL.id}` }, "409: it exists");
    await hub.createRepo(DATA);
    assert.equal(fake.repo("dataset", DATA.id)?.private, true);
    assert.equal(hub.repoUrl(DATA), `${fake.url}/datasets/${DATA.id}`);
  });

  it("tries a conflicting operation again, a bounded number of times", async () => {
    fake.conflicts = 2;
    const id = "muse-org/conflicted-once";
    assert.equal((await hub.createRepo({ type: "model", id })).created, true);
    assert.equal(fake.requests.filter((r) => r.path === "/api/repos/create").length, 3);
    fake.conflicts = 10;
    await assert.rejects(hub.createRepo({ type: "model", id: "muse-org/conflicted-always" }), (err: unknown) => {
      assert.ok(err instanceof hub.HubApiError);
      assert.equal(err.status, 409);
      assert.equal(err.code, "conflict");
      return true;
    });
    assert.equal(fake.requests.filter((r) => r.path === "/api/repos/create").length, 3 + 1 + hub.hubTiming.retries);
  });

  it("asks preupload how each file goes up", async () => {
    const config = Buffer.from('{"r": 16}');
    const answers = await hub.preupload(MODEL, [
      { path: "adapter_config.json", size: config.length, sample: config.toString("base64") },
      { path: "adapter_model.safetensors", size: 1000, sample: bytes(512).toString("base64") },
      { path: "odd.json", size: 4, sample: Buffer.from([1, 0, 2, 3]).toString("base64") },
    ]);
    assert.deepEqual(
      answers.map((a) => [a.path, a.uploadMode, a.shouldIgnore]),
      [
        ["adapter_config.json", "regular", false],
        ["adapter_model.safetensors", "lfs", false],
        ["odd.json", "lfs", false],
      ],
    );
    assert.deepEqual(await hub.preupload(MODEL, []), [], "nothing to ask");
  });

  it("asks the LFS batch for basic and multipart only, and hands out no credential", async () => {
    const small = bytes(1000, 2);
    const big = bytes(70 * 1024, 3);
    const actions = await hub.lfsBatch(MODEL, [
      { oid: sha(small), size: small.length },
      { oid: sha(big), size: big.length },
    ]);
    assert.deepEqual(fake.transfers.at(-1), ["basic", "multipart"], "never xet");
    const batch = fake.requests.find((r) => r.path.endsWith(".git/info/lfs/objects/batch"))!;
    assert.equal(batch.path, `/${MODEL.id}.git/info/lfs/objects/batch`);
    assert.equal(batch.authorization, `Bearer ${TOKEN}`);
    assert.deepEqual(JSON.parse(batch.body.toString("utf8")).ref, { name: "main" });
    const [basic, multi] = actions;
    assert.equal(basic!.kind, "basic");
    assert.equal(multi!.kind, "multipart");
    if (basic!.kind !== "basic" || multi!.kind !== "multipart") return;
    assert.deepEqual(basic!.header, { "x-amz-meta-test": "1" });
    assert.equal(multi!.chunkSize, 25 * 1024);
    assert.deepEqual(multi!.parts.map((p) => p.partNumber), [1, 2, 3]);
    assert.doesNotMatch(JSON.stringify(actions), new RegExp(TOKEN), "a verify action's Authorization never comes out");

    await hub.uploadLfs(basic!, small);
    await hub.uploadLfs(multi!, big);
    assert.deepEqual(fake.leaks, [], "no Authorization header ever goes to a presigned URL");
    const repo = fake.repo("model", MODEL.id)!;
    assert.ok(repo.objects.get(sha(small))?.equals(small));
    assert.ok(repo.objects.get(sha(big))?.equals(big));
    const completion = fake.requests.find((r) => r.path.startsWith("/lfs-complete/"))!;
    assert.equal(completion.contentType, "application/vnd.git-lfs+json");
    assert.deepEqual(JSON.parse(completion.body.toString("utf8")).parts.map((p: { partNumber: number }) => p.partNumber), [1, 2, 3]);

    // Asked again, the batch answers no upload for what the Hub stores and one for what it doesn't.
    const missing = bytes(10, 9);
    const again = await hub.lfsBatch(MODEL, [
      { oid: sha(small), size: small.length },
      { oid: sha(big), size: big.length },
      { oid: sha(missing), size: missing.length },
    ]);
    assert.deepEqual(again.slice(0, 2), [
      { oid: sha(small), size: small.length, kind: "none" },
      { oid: sha(big), size: big.length, kind: "none" },
    ], "the Hub has them");
    assert.equal(again[2]!.kind, "basic", "the Hub wants this one uploaded, so it isn't there");
    assert.equal(fake.requests.filter((r) => r.path.endsWith("/verify")).length, 0, "no guessed verify URL");
  });

  it("refuses an upload whose bytes don't match, never naming its URL", async () => {
    const data = bytes(2000, 4);
    const [action] = await hub.lfsBatch(MODEL, [{ oid: sha(data), size: data.length }]);
    await assert.rejects(hub.uploadLfs(action!, bytes(2000, 5)), (err: unknown) => {
      assert.ok(err instanceof hub.HubApiError);
      assert.equal(err.status, 400);
      assert.doesNotMatch(err.message, /X-Amz|s3\/|127\.0\.0\.1/);
      return true;
    });
    await assert.rejects(hub.uploadLfs(action!, bytes(10)), /size doesn't match/);
  });

  it("commits NDJSON with whole files and LFS objects by oid, then reads the tree back", async () => {
    const weights = bytes(3000, 6);
    const [action] = await hub.lfsBatch(MODEL, [{ oid: sha(weights), size: weights.length }]);
    await hub.uploadLfs(action!, weights);
    const readme = Buffer.from("---\nlicense: apache-2.0\n---\n# Card\n");
    const input: hub.CommitInput = {
      summary: "Publish the adapter",
      description: "job 8f1d2c3b",
      files: [{ path: "README.md", content: readme }],
      lfsFiles: [{ path: "adapter_model.safetensors", oid: sha(weights), size: weights.length }],
    };
    const lines = hub.commitBody(input).trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(lines[0], { key: "header", value: { summary: "Publish the adapter", description: "job 8f1d2c3b" } });
    assert.deepEqual(lines[1], { key: "file", value: { path: "README.md", content: readme.toString("base64"), encoding: "base64" } });
    assert.deepEqual(lines[2], { key: "lfsFile", value: { path: "adapter_model.safetensors", algo: "sha256", oid: sha(weights), size: weights.length } });

    const done = await hub.commit(MODEL, input);
    assert.match(done.commitOid, /^[0-9a-f]{40}$/);
    assert.equal(fake.requests.at(-1)!.contentType, "application/x-ndjson");
    const files = await hub.listFiles(MODEL);
    const card = files.find((f) => f.path === "README.md")!;
    assert.equal(card.oid, gitOidOf(readme));
    assert.equal(card.oid, hub.gitOid(readme), "the client's git oid is the Hub's");
    assert.equal(files.find((f) => f.path === "adapter_model.safetensors")?.lfsOid, sha(weights));

    assert.deepEqual(
      await hub.verifyFiles(MODEL, [
        { path: "README.md", size: readme.length, gitOid: hub.gitOid(readme) },
        { path: "adapter_model.safetensors", size: weights.length, lfsOid: sha(weights) },
      ]),
      [],
    );
    const problems = await hub.verifyFiles(MODEL, [
      { path: "README.md", size: readme.length + 1 },
      { path: "adapter_model.safetensors", size: weights.length, lfsOid: "f".repeat(64) },
      { path: "LICENSE", size: 1 },
    ]);
    assert.equal(problems.length, 3);
    assert.match(problems.join(" "), /README\.md .* is \d+ bytes, not \d+\./);
    assert.match(problems.join(" "), /isn't the LFS object that was uploaded/);
    assert.match(problems.join(" "), /LICENSE isn't in/);

    await assert.rejects(
      hub.commit(MODEL, { summary: "x", files: [], lfsFiles: [{ path: "missing.safetensors", oid: "e".repeat(64), size: 5 }] }),
      (err: unknown) => err instanceof hub.HubApiError && err.status === 422,
      "an LFS object the storage doesn't have is refused",
    );
  });

  it("sets a repo public, reads its visibility back, and says who the token is", async () => {
    assert.equal(await hub.repoVisibility(MODEL), "private");
    await hub.setVisibility(MODEL, "public");
    assert.equal(fake.repo("model", MODEL.id)?.private, false);
    assert.deepEqual(JSON.parse(fake.requests.at(-1)!.body.toString("utf8")), { visibility: "public" });
    assert.equal(await hub.repoVisibility(MODEL), "public");
    const read = fake.requests.at(-1)!;
    assert.deepEqual([read.method, read.path, read.authorization], ["GET", `/api/models/${MODEL.id}`, `Bearer ${TOKEN}`]);
    assert.equal(await hub.repoVisibility(DATA), "private");
    assert.equal(fake.requests.at(-1)!.path, `/api/datasets/${DATA.id}`);
    await assert.rejects(hub.repoVisibility({ type: "model", id: "muse-org/never-made" }), (err: unknown) => err instanceof hub.HubApiError && err.status === 404);
    assert.deepEqual(await hub.whoami(), { name: "muse-bot", orgs: ["muse-org"] });
  });

  it("tries 429 and 5xx again, a bounded number of times, and never a 4xx", async () => {
    fake.fail(/\/api\/whoami-v2/, [503, 429]);
    assert.equal((await hub.whoami()).name, "muse-bot");
    assert.equal(fake.requests.filter((r) => r.path === "/api/whoami-v2").length, 3);

    fake.requests.length = 0;
    fake.fail(/\/api\/whoami-v2/, [500, 502, 503, 504, 500]);
    await assert.rejects(hub.whoami(), (err: unknown) => err instanceof hub.HubApiError && err.status === 504);
    assert.equal(fake.requests.length, 1 + hub.hubTiming.retries, "the first try and its retries");
    await hub.whoami(); // The fifth injected 500, then the real answer.

    fake.requests.length = 0;
    fake.fail(/\/settings$/, [400]);
    await assert.rejects(hub.setVisibility(MODEL, "private"), (err: unknown) => err instanceof hub.HubApiError && err.status === 400);
    assert.equal(fake.requests.length, 1, "a refusal isn't tried again");
  });

  it("times out a call that hangs, after its retries", async () => {
    fake.hang(/\/api\/whoami-v2/, 600, 1 + hub.hubTiming.retries);
    await assert.rejects(hub.whoami(), (err: unknown) => {
      assert.ok(err instanceof hub.HubApiError);
      assert.equal(err.status, 0);
      assert.equal(err.code, "timeout");
      assert.match(err.message, /timed out/);
      return true;
    });
  });

  it("reads HF_TOKEN on each call and blanks it, and signed URLs, out of every error", async () => {
    process.env.HF_TOKEN = OTHER_TOKEN;
    await assert.rejects(hub.whoami(), (err: unknown) => {
      assert.ok(err instanceof hub.HubApiError);
      assert.equal(err.status, 401);
      assert.doesNotMatch(err.message, new RegExp(OTHER_TOKEN));
      assert.match(err.message, /\[HF token\]/, "the fake echoed the token it got");
      return true;
    });
    assert.equal(fake.requests.at(-1)!.authorization, `Bearer ${OTHER_TOKEN}`, "the token as it is now");
    process.env.HF_TOKEN = TOKEN;
    fake.fail(/\/api\/repos\/create/, [400], { error: `No: ${TOKEN} at https://bucket.example/x?X-Amz-Signature=abc123def456` });
    await assert.rejects(hub.createRepo({ type: "model", id: "muse-org/refused" }), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.doesNotMatch(err.message, new RegExp(TOKEN));
      assert.doesNotMatch(err.message, /X-Amz-Signature|abc123def456/);
      assert.match(err.message, /\[HF token\] at \[signed URL\]/);
      return true;
    });
    assert.equal(hub.redact(`a ${TOKEN} b https://x.example/p?sig=1 c`), "a [HF token] b [signed URL] c");
    delete process.env.HF_TOKEN;
    await assert.rejects(hub.whoami(), /HF_TOKEN is not set/);
  });

  it("reads a public file with no credential", async () => {
    const license = await hub.fetchPublicText(hub.rawUrl({ type: "model", id: "meta-models/Muse-Glimmer-30B" }, "LICENSE"));
    assert.match(license, /Apache License/);
    assert.equal(fake.requests.at(-1)!.path, "/meta-models/Muse-Glimmer-30B/raw/main/LICENSE");
    assert.equal(fake.requests.at(-1)!.authorization, null);
  });
});
