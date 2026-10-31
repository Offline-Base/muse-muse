/**
 * GET /p/<slug>/get/<kind>, with its database faked: what it answers, what it counts and when it says no.
 *   npx tsx --test lib/native/__tests__/downloads.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DOWNLOADS_PER_DAY, DOWNLOADS_PER_IP_PER_HOUR, answerDownload, downloadKeys, type DownloadDeps } from "@/lib/native/downloads";

const NOW = new Date("2026-10-31T12:30:00.000Z");

function fakes(over: Partial<DownloadDeps> = {}) {
  const counted: string[] = [];
  const released: Array<{ key: string; windowStart: Date }> = [];
  const reserved: Array<{ key: string; windowStart: Date; limit: number }> = [];
  const deps: DownloadDeps = {
    findPackage: async () => ({ artifactId: "a1", url: "https://blob.example/native/products/p/r/demo.apk" }),
    reserve: async (key, windowStart, limit) => {
      reserved.push({ key, windowStart, limit });
      return 1;
    },
    release: async (key, windowStart) => {
      released.push({ key, windowStart });
    },
    count: async (id) => {
      counted.push(id);
    },
    now: () => NOW,
    ...over,
  };
  return { deps, counted, reserved, released };
}

const get = (ip = "203.0.113.9", method = "GET") => new Request("https://x.example/p/demo/get/android", { method, headers: { "x-real-ip": ip } });

describe("the download route", () => {
  it("redirects to the file as a download, counts it and takes one from both limits", async () => {
    const { deps, counted, reserved } = fakes();
    const res = await answerDownload(get(), "demo", "android", deps);
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "https://blob.example/native/products/p/r/demo.apk?download=1");
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.deepEqual(counted, ["a1"]);
    assert.deepEqual(reserved.map((r) => [r.key, r.limit]), [
      [downloadKeys.ip("203.0.113.9"), DOWNLOADS_PER_IP_PER_HOUR],
      [downloadKeys.day, DOWNLOADS_PER_DAY],
    ]);
    assert.equal(reserved[0]!.windowStart.toISOString(), "2026-10-31T12:00:00.000Z");
    assert.equal(reserved[1]!.windowStart.toISOString(), "2026-11-01T00:00:00.000Z");
  });

  it("answers 404 for a kind it doesn't know, without looking anything up", async () => {
    let asked = 0;
    const { deps } = fakes({ findPackage: async () => (asked++, null) });
    for (const kind of ["ios", "constructor", "__proto__", "toString"]) assert.equal((await answerDownload(get(), "demo", kind, deps)).status, 404);
    assert.equal(asked, 0);
  });

  it("answers 404 when there's no package a visitor may have, gives its one back and counts nothing", async () => {
    const { deps, counted, reserved, released } = fakes({ findPackage: async () => null });
    assert.equal((await answerDownload(get(), "demo", "mac", deps)).status, 404);
    assert.deepEqual(counted, []);
    assert.deepEqual(reserved.map((r) => r.key), [downloadKeys.ip("203.0.113.9")]);
    assert.deepEqual(released.map((r) => [r.key, r.windowStart.toISOString()]), [[downloadKeys.ip("203.0.113.9"), "2026-10-31T12:00:00.000Z"]]);
  });

  it("still answers 404 when giving one back fails", async () => {
    const quiet = console.error;
    console.error = () => {};
    try {
      const { deps } = fakes({ findPackage: async () => null, release: async () => Promise.reject(new Error("no database")) });
      assert.equal((await answerDownload(get(), "demo", "mac", deps)).status, 404);
    } finally {
      console.error = quiet;
    }
  });

  it("doesn't look anything up for an address over its limit", async () => {
    let asked = 0;
    const { deps, released } = fakes({ findPackage: async () => (asked++, { artifactId: "a1", url: "https://blob.example/a.apk" }), reserve: async () => null });
    assert.equal((await answerDownload(get(), "demo", "android", deps)).status, 429);
    assert.equal(asked, 0);
    assert.deepEqual(released, []);
  });

  it("answers 429 over an address's limit, and counts nothing", async () => {
    const { deps, counted } = fakes({ reserve: async (key) => (key.startsWith("native-get-ip") ? null : 1) });
    const res = await answerDownload(get(), "demo", "android", deps);
    assert.equal(res.status, 429);
    assert.equal(res.headers.get("retry-after"), String(30 * 60));
    assert.deepEqual(counted, []);
  });

  it("answers 429 over the day's limit, until tomorrow", async () => {
    const { deps, counted } = fakes({ reserve: async (key) => (key === downloadKeys.day ? null : 1) });
    const res = await answerDownload(get(), "demo", "android", deps);
    assert.equal(res.status, 429);
    assert.equal(res.headers.get("retry-after"), String(11.5 * 3600));
    assert.deepEqual(counted, []);
  });

  it("gives everyone with no address one strict bucket", async () => {
    const { deps, reserved } = fakes();
    await answerDownload(new Request("https://x.example/p/demo/get/android"), "demo", "android", deps);
    assert.equal(reserved[0]!.key, downloadKeys.ip("unknown"));
  });

  it("doesn't count a HEAD or limit it, or give away the file's address", async () => {
    const { deps, counted, reserved } = fakes();
    const res = await answerDownload(get("203.0.113.9", "HEAD"), "demo", "android", deps);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("location"), null);
    assert.deepEqual(counted, []);
    assert.deepEqual(reserved, []);
  });

  it("answers 404 to a HEAD when there's no package", async () => {
    const { deps, reserved } = fakes({ findPackage: async () => null });
    const res = await answerDownload(get("203.0.113.9", "HEAD"), "demo", "android", deps);
    assert.equal(res.status, 404);
    assert.deepEqual(reserved, []);
  });

  it("still sends the file when counting fails", async () => {
    const quiet = console.error;
    console.error = () => {};
    try {
      const { deps } = fakes({ count: async () => Promise.reject(new Error("no database")) });
      assert.equal((await answerDownload(get(), "demo", "android", deps)).status, 302);
    } finally {
      console.error = quiet;
    }
  });

  it("answers 503 when the limits can't be read", async () => {
    const quiet = console.error;
    console.error = () => {};
    try {
      const { deps } = fakes({ reserve: async () => Promise.reject(new Error("no database")) });
      assert.equal((await answerDownload(get(), "demo", "android", deps)).status, 503);
    } finally {
      console.error = quiet;
    }
  });
});
