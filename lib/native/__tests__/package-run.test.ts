/** npx tsx --test --experimental-test-module-mocks lib/native/__tests__/package-run.test.ts */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { packageKinds, runPackaging, type PackageRunDeps } from "@/lib/native/package-run";
import type { PackagedFile } from "@/lib/native/packager";

const file = (kind: PackagedFile["kind"], artifactKind: PackagedFile["artifactKind"]): PackagedFile => ({ kind, artifactKind, url: `https://x/${kind}`, pathname: kind, bytes: 2e6, sha256: "a", shellVersion: "1.0.0", signedWith: null, ms: 1 });
const input = { productId: "p", buildId: "b", slug: "s", name: "S", url: "https://s.example", targets: ["phone", "desktop"] as const, origin: "ship" as const };

function fake(over: Partial<PackageRunDeps> = {}) {
  const log = { added: [] as string[], stopped: 0, events: [] as Array<{ item: string; state: string }>, finished: null as string | null };
  const handle = { sandboxName: "x", runId: "r", shellVersion: "1.0.0", startedAt: 0, slots: [], skipped: {} };
  const deps: PackageRunDeps = {
    start: async () => handle,
    poll: async () => ({ state: "finished", result: { v: 1, packages: {} } }),
    collect: async () => ({ files: [file("android", "android_apk"), file("mac", "mac_zip"), file("windows", "windows_zip")], failures: {} }),
    stop: async () => void log.stopped++,
    createRun: async () => "r",
    addPackage: async (_i, _r, f) => void log.added.push(f.artifactKind),
    finishRun: async (_r, status) => void (log.finished = status),
    emit: async (_b, e) => void log.events.push({ item: e.item, state: e.state }),
    sleep: async () => {},
    ...over,
  };
  return { deps, log };
}

describe("runPackaging", () => {
  it("asks only for what the targets need", () => {
    assert.deepEqual(packageKinds(["web"]), []);
    assert.deepEqual(packageKinds(["phone"]), ["android"]);
    assert.deepEqual(packageKinds(["desktop"]), ["mac", "windows"]);
  });
  it("records every package, then stops the sandbox", async () => {
    const { deps, log } = fake();
    const run = await runPackaging(input, deps);
    assert.equal(run.status, "done");
    assert.deepEqual(log.added, ["android_apk", "mac_zip", "windows_zip"]);
    assert.equal(log.stopped, 1);
    assert.equal(log.finished, "done");
  });
  it("keeps what was made when one kind fails", async () => {
    const { deps, log } = fake({ collect: async () => ({ files: [file("android", "android_apk")], failures: { mac: "no", windows: "no" } }) });
    const run = await runPackaging(input, deps);
    assert.equal(run.status, "partial");
    assert.deepEqual(log.added, ["android_apk"]);
    assert.ok(log.events.some((e) => e.item === "package:mac" && e.state === "failed"));
  });
  it("ends a failed run instead of throwing, when the packager can't start", async () => {
    const { deps, log } = fake({ start: async () => { throw new Error("no snapshot"); } });
    const run = await runPackaging(input, deps);
    assert.equal(run.status, "failed");
    assert.equal(log.stopped, 0);
    assert.equal(run.failures.android, "no snapshot");
  });
});
