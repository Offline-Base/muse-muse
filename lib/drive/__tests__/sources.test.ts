/**
 * lib/drive/sources.ts: a public file's resolve link, a private file's link signed by the Hub without following it, the
 * kit's links from Blob, and that a signed link is never printed.
 *
 *   npx tsx --test lib/drive/__tests__/sources.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DriveKit } from "../kit";
import { expiringUrl, planUrls, redactUrls, resolveUrl, signedHubUrl, SourceError } from "../sources";

const REPO = "musemuse/muse-glimmer-30b-bakery-helper-gguf-8f1d2c3b";
const COMMIT = "c0ffee".padEnd(40, "0");
const KIT: DriveKit = {
  imageVersion: "x",
  runtime: { build: "b1", version: "0", commit: "c", assets: [] },
  files: [{ path: "runtime/macos-arm64/llama-server", bytes: 1, sha256: "1".repeat(64), family: "common" }],
  sources: [],
  baseUrl: "https://store.public.blob.vercel-storage.com/drive-kit/",
};

describe("where a board gets each file", () => {
  it("names a public file at its commit, and refuses names the Hub wouldn't have", () => {
    assert.equal(resolveUrl(REPO, COMMIT, "a.gguf"), `https://huggingface.co/${REPO}/resolve/${COMMIT}/a.gguf`);
    for (const [repo, commit, name] of [["../x", COMMIT, "a.gguf"], [REPO, "main", "a.gguf"], [REPO, COMMIT, "../a.gguf"], [REPO, COMMIT, "a b.gguf"]]) {
      assert.throws(() => resolveUrl(repo, commit, name), SourceError);
    }
  });

  it("asks the Hub for a private file's link with the token, without following it", async () => {
    const seen: RequestInit[] = [];
    const signed = await signedHubUrl(REPO, COMMIT, "a.gguf", "hf_test", async (_url, init) => {
      seen.push(init!);
      return new Response(null, { status: 302, headers: { location: "https://cdn.example/a?X-Amz-Signature=s" } });
    });
    assert.equal(signed, "https://cdn.example/a?X-Amz-Signature=s");
    assert.equal(seen[0].redirect, "manual");
    assert.equal((seen[0].headers as Record<string, string>).authorization, "Bearer hf_test");
    await assert.rejects(signedHubUrl(REPO, COMMIT, "a.gguf", "t", async () => new Response("no", { status: 401 })), /didn't give a link for a\.gguf \(HTTP 401\)/);
    await assert.rejects(
      signedHubUrl(REPO, COMMIT, "a.gguf", "t", async () => new Response(null, { status: 302, headers: { location: "http://cdn.example/a" } })),
      /isn't https/,
    );
  });

  it("gives the kit's files their Blob links, and a model's file its link by sha256", async () => {
    const plan = {
      files: [
        { path: "runtime/macos-arm64/llama-server", bytes: 1, sha256: "1".repeat(64), kit: true as const },
        { path: "model/a.gguf", bytes: 2, sha256: "2".repeat(64), url: true as const },
        { path: "README.txt", bytes: 1, sha256: "3".repeat(64), text: "x" },
      ],
    };
    const urls = await planUrls(plan, KIT, { repo: REPO, commit: COMMIT, public: true, files: { ["2".repeat(64)]: "a.gguf" } });
    assert.deepEqual(urls, {
      ["1".repeat(64)]: `${KIT.baseUrl}${"1".repeat(64)}`,
      ["2".repeat(64)]: `https://huggingface.co/${REPO}/resolve/${COMMIT}/a.gguf`,
    });
    await assert.rejects(planUrls(plan, { ...KIT, baseUrl: null }, null), /isn't uploaded yet/);
    await assert.rejects(planUrls(plan, KIT, { repo: REPO, commit: COMMIT, public: false, files: { ["2".repeat(64)]: "a.gguf" } }), /HF_TOKEN isn't set/);
  });

  it("tells a link that expires, and blanks it out of text", () => {
    assert.equal(expiringUrl("https://cdn.example/a?X-Amz-Signature=s"), true);
    assert.equal(expiringUrl(`https://huggingface.co/${REPO}/resolve/${COMMIT}/a.gguf`), false);
    assert.equal(redactUrls("failed at https://cdn.example/a?X-Amz-Signature=s and stopped"), "failed at [signed URL] and stopped");
  });
});
