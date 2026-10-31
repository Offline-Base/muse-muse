/**
 * What the "Get it" panel knows: which package is on offer, what vouches for it, and what counts as simulated.
 *   npx tsx --test lib/native/__tests__/product-view.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildProductNativeView, downloadablePackage, safeHttpUrl, type NativeArtifactRow, type NativeJobRow } from "@/lib/native/product-view";

const at = (s: number) => new Date(Date.parse("2026-10-31T12:00:00.000Z") + s * 1000);

const artifact = (over: Partial<NativeArtifactRow> & Pick<NativeArtifactRow, "id" | "kind">): NativeArtifactRow => ({
  runId: "run-1",
  jobId: null,
  platform: null,
  device: null,
  caption: null,
  url: `https://blob.example/${over.id}`,
  bytes: 41_000_000,
  check: null,
  createdAt: at(0),
  ...over,
});

const job = (over: Partial<NativeJobRow> & Pick<NativeJobRow, "id" | "kind">): NativeJobRow => ({
  runId: "run-1",
  status: "done",
  result: { outcome: "passed", summary: "It opened.", device: { name: "Pixel 7", os: "Android 15" } },
  createdAt: at(10),
  ...over,
});

const view = (input: { artifacts?: NativeArtifactRow[]; jobs?: NativeJobRow[]; status?: "done" | "running" }) =>
  buildProductNativeView({ targets: ["web", "phone"], artifacts: input.artifacts ?? [], jobs: input.jobs ?? [], runs: [{ status: input.status ?? "done" }] });

describe("packages", () => {
  it("offers the newest package of a kind", () => {
    const v = view({ artifacts: [artifact({ id: "old", kind: "android_apk", createdAt: at(0) }), artifact({ id: "new", kind: "android_apk", createdAt: at(5) })] });
    assert.deepEqual(v.packages.map((p) => p.artifactId), ["new"]);
  });

  it("says a package nobody has looked at isn't checked", () => {
    const v = view({ artifacts: [artifact({ id: "a", kind: "android_apk" })] });
    assert.equal(v.packages[0]!.state, "not_checked");
    assert.ok(downloadablePackage(v, "android"));
  });

  it("holds back a package whose row or newest check failed, and only that package", () => {
    const failedRow = view({ artifacts: [artifact({ id: "a", kind: "android_apk", check: "failed" })] });
    assert.equal(downloadablePackage(failedRow, "android"), null);

    const failedJob = view({
      artifacts: [artifact({ id: "a", kind: "android_apk" }), artifact({ id: "m", kind: "mac_zip" })],
      jobs: [job({ id: "j", kind: "android_emu", status: "failed", result: { outcome: "failed", summary: "It stayed blank.", reasons: ["Blank."] } })],
    });
    assert.equal(downloadablePackage(failedJob, "android"), null);
    assert.ok(downloadablePackage(failedJob, "mac"));
    assert.deepEqual(failedJob.checks[0]!.reasons, ["Blank."]);
  });

  it("doesn't blame a package when the lab couldn't run its check", () => {
    const v = view({
      artifacts: [artifact({ id: "a", kind: "android_apk" })],
      jobs: [job({ id: "j", kind: "android_emu", status: "failed", result: { outcome: "lab_error", summary: "Not checked." } })],
    });
    assert.equal(v.checks[0]!.state, "not_checked");
    assert.equal(v.packages[0]!.state, "not_checked");
    assert.ok(downloadablePackage(v, "android"));
  });

  it("never lets an older package's pass vouch for a newer one", () => {
    const v = view({
      artifacts: [artifact({ id: "new", kind: "android_apk", createdAt: at(20) })],
      jobs: [job({ id: "older", kind: "android_emu", createdAt: at(10) })],
    });
    assert.deepEqual(v.checks, []);
    assert.equal(v.packages[0]!.state, "not_checked");
  });

  it("uses a newer check of an older package, as Check again makes", () => {
    const v = view({ artifacts: [artifact({ id: "a", kind: "android_apk", createdAt: at(0) })], jobs: [job({ id: "again", kind: "android_emu", createdAt: at(99) })] });
    assert.equal(v.packages[0]!.state, "passed");
  });

  it("keeps a stray link off the page", () => {
    const v = view({ artifacts: [artifact({ id: "a", kind: "android_apk", url: "javascript:alert(1)" })] });
    assert.deepEqual(v.packages, []);
    assert.equal(safeHttpUrl("https://x.example/a"), true);
    assert.equal(safeHttpUrl("data:image/png;base64,AAAA"), false);
    assert.equal(safeHttpUrl(null), false);
  });
});

describe("checks", () => {
  it("says what was simulated and what wasn't", () => {
    const v = view({
      jobs: [job({ id: "a", kind: "android_emu" }), job({ id: "i", kind: "ios_sim" }), job({ id: "m", kind: "desktop_mac" }), job({ id: "w", kind: "desktop_windows" }), job({ id: "g", kind: "glasses_sim" })],
    });
    const byId = new Map(v.checks.map((c) => [c.id, c]));
    assert.equal(byId.get("a")!.simulated, true);
    assert.equal(byId.get("i")!.simulated, true);
    assert.equal(byId.get("m")!.simulated, false);
    assert.equal(byId.get("w")!.simulated, false);
    assert.equal(byId.get("g")!.simulated, true);
    assert.match(byId.get("g")!.label, /mock glasses/);
    assert.equal(byId.get("g")!.target, "glasses");
    assert.equal(byId.get("a")!.device, "Pixel 7, Android 15");
  });

  it("shows only the newest job of a kind, still running or not", () => {
    const v = view({ jobs: [job({ id: "old", kind: "ios_sim", createdAt: at(1) }), job({ id: "new", kind: "ios_sim", status: "claimed", result: null, createdAt: at(2) })] });
    assert.deepEqual(v.checks.map((c) => [c.id, c.state]), [["new", "checking"]]);
  });

  it("finds a job's clip, poster and shots, and leaves out what isn't a safe link", () => {
    const v = view({
      jobs: [job({ id: "j", kind: "android_emu" })],
      artifacts: [
        artifact({ id: "c", kind: "clip", jobId: "j", caption: "On an Android emulator" }),
        artifact({ id: "p", kind: "poster", jobId: "j" }),
        artifact({ id: "s", kind: "shot", jobId: "j" }),
        artifact({ id: "bad", kind: "shot", jobId: "j", url: "javascript:alert(1)" }),
        artifact({ id: "other", kind: "shot", jobId: "someone-else" }),
      ],
    });
    assert.deepEqual(v.checks[0]!.clip, { url: "https://blob.example/c", posterUrl: "https://blob.example/p", caption: "On an Android emulator" });
    assert.deepEqual(v.checks[0]!.shots.map((s) => s.url), ["https://blob.example/s"]);
  });

  it("reads a real Device Farm phone from the clip it left, not as simulated", () => {
    const v = view({
      artifacts: [
        artifact({ id: "a", kind: "android_apk", createdAt: at(0) }),
        artifact({ id: "c", kind: "clip", platform: "android", device: "Galaxy S25", check: "passed", createdAt: at(30) }),
        artifact({ id: "p", kind: "poster", platform: "android", device: "Galaxy S25", createdAt: at(30) }),
      ],
    });
    assert.equal(v.checks[0]!.label, "Galaxy S25 on AWS Device Farm");
    assert.equal(v.checks[0]!.simulated, false);
    assert.equal(v.checks[0]!.state, "passed");
    assert.equal(v.checks[0]!.clip?.posterUrl, "https://blob.example/p");
    assert.equal(v.packages[0]!.state, "passed");
  });

  it("copes with a result from a newer branch", () => {
    const v = view({ jobs: [job({ id: "j", kind: "ios_sim", result: { outcome: "passed", summary: 3 as unknown as string, device: "a phone", reasons: "none" } })] });
    assert.equal(v.checks[0]!.summary, null);
    assert.equal(v.checks[0]!.device, null);
    assert.deepEqual(v.checks[0]!.reasons, []);
    const unknown = view({ jobs: [job({ id: "j", kind: "vr_box" as never })] });
    assert.deepEqual(unknown.checks, []);
  });
});

describe("runs", () => {
  it("is working while a run is planned or running", () => {
    assert.equal(view({ status: "running" }).working, true);
    assert.equal(view({ status: "done" }).working, false);
  });
});
