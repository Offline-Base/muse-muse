/**
 * What the "Get it" panel knows: which package is on offer, what vouches for it, and what counts as simulated.
 *   npx tsx --test lib/native/__tests__/product-view.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildProductNativeView, CANONICAL_SITE, downloadablePackage, panelLinkOrigin, publicSiteOrigin, safeHttpUrl, type NativeArtifactRow, type NativeJobRow } from "@/lib/native/product-view";

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
  result: { outcome: "passed", summary: "It opened.", device: { name: "Pixel 7", os: "15" } },
  createdAt: at(10),
  ...over,
});

const view = (input: { artifacts?: NativeArtifactRow[]; jobs?: NativeJobRow[]; status?: "done" | "running" }) =>
  buildProductNativeView({ targets: ["web", "phone"], artifacts: input.artifacts ?? [], jobs: input.jobs ?? [], runs: [{ status: input.status ?? "done", createdAt: new Date() }] });

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
  it("names what ran a check from what each lab box really reports", () => {
    const device = (kind: NativeJobRow["kind"], d: unknown) => view({ jobs: [job({ id: "j", kind, result: { outcome: "passed", summary: "It opened.", device: d } })] }).checks[0]!.device;
    assert.equal(device("android_emu", { name: "Pixel 7", os: "15" }), "Pixel 7, Android 15");
    assert.equal(device("ios_sim", { name: "", os: "26.5" }), "iOS 26.5");
    assert.equal(device("desktop_mac", { os: "15.4" }), "macOS 15.4");
    assert.equal(device("desktop_windows", { os: "Windows Server 2022 Datacenter" }), "Windows Server 2022 Datacenter");
    assert.equal(device("android_emu", {}), null);
    assert.equal(device("android_emu", "not an object"), null);
  });

  it("doesn't say a job is still checking once it's past its time", () => {
    const now = Date.parse("2026-10-31T12:00:00.000Z");
    const state = (over: Partial<NativeJobRow>) =>
      buildProductNativeView({ targets: ["web", "phone"], artifacts: [], jobs: [job({ id: "j", kind: "ios_sim", result: null, ...over })], runs: [], now }).checks[0]!.state;
    assert.equal(state({ status: "queued", expiresAt: new Date(now + 60_000) }), "checking");
    assert.equal(state({ status: "queued", expiresAt: new Date(now - 60_000) }), "not_checked");
    assert.equal(state({ status: "claimed", deadlineAt: new Date(now - 60_000) }), "checking");
    assert.equal(state({ status: "claimed", deadlineAt: new Date(now - 16 * 60_000) }), "not_checked");
    assert.equal(state({ status: "claimed" }), "checking");
  });

  it("isn't working for a run left behind, whatever its row says", () => {
    const now = Date.parse("2026-10-31T12:00:00.000Z");
    const working = (hoursOld: number) =>
      buildProductNativeView({ targets: ["web"], artifacts: [], jobs: [], runs: [{ status: "running", createdAt: new Date(now - hoursOld * 3_600_000) }], now }).working;
    assert.equal(working(1), true);
    assert.equal(working(3), false);
  });

  it("is working while a run is planned or running", () => {
    assert.equal(view({ status: "running" }).working, true);
    assert.equal(view({ status: "done" }).working, false);
  });
});

describe("a package's address in production", () => {
  const STORE = "https://teststore.public.blob.vercel-storage.com/native/a.apk";
  const view = (url: string) => buildProductNativeView({ targets: ["web", "phone"], artifacts: [artifact({ id: "a", kind: "android_apk", url })], jobs: [], runs: [] });
  const env = process.env as Record<string, string | undefined>;
  const saved = { NODE_ENV: env.NODE_ENV, BLOB_STORE_ID: env.BLOB_STORE_ID, BLOB_READ_WRITE_TOKEN: env.BLOB_READ_WRITE_TOKEN, VERCEL: env.VERCEL };
  const restore = () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete env[k];
      else env[k] = v;
    }
  };
  const production = () => {
    env.NODE_ENV = "production";
    env.BLOB_STORE_ID = "store_TestStore";
    env.VERCEL = "1";
    delete env.BLOB_READ_WRITE_TOKEN;
  };

  it("has to be https on this platform's Blob store", () => {
    production();
    try {
      assert.equal(downloadablePackage(view(STORE), "android")?.url, STORE);
      for (const bad of ["https://blob.example/a.apk", "https://someoneelse.public.blob.vercel-storage.com/a.apk", "http://teststore.public.blob.vercel-storage.com/a.apk", "https://teststore.public.blob.vercel-storage.com.evil.example/a.apk", "javascript:alert(1)"]) {
        assert.equal(downloadablePackage(view(bad), "android"), null, bad);
        assert.deepEqual(view(bad).packages, [], bad);
      }
    } finally {
      restore();
    }
  });

  it("offers nothing on a deployment with no store", () => {
    production();
    delete env.BLOB_STORE_ID;
    try {
      assert.equal(downloadablePackage(view(STORE), "android"), null);
    } finally {
      restore();
    }
  });

  it("allows a local production run's own files, which have no store", () => {
    production();
    delete env.BLOB_STORE_ID;
    delete env.VERCEL;
    try {
      assert.ok(downloadablePackage(view("http://localhost:3000/api/files/native/a.apk"), "android"));
    } finally {
      restore();
    }
  });

  it("allows a fixture's host outside production", () => {
    assert.notEqual(env.NODE_ENV, "production");
    assert.ok(downloadablePackage(view("https://blob.example/a.apk"), "android"));
  });
});

describe("settled", () => {
  const view = (runs: Parameters<typeof buildProductNativeView>[0]["runs"]) => buildProductNativeView({ targets: ["web", "phone"], artifacts: [], jobs: [], runs, now: at(0).getTime() });

  it("is false with no run yet, and while one is going", () => {
    assert.equal(view([]).settled, false);
    assert.equal(view([{ status: "done", createdAt: at(-100) }, { status: "running", createdAt: at(-10) }]).settled, false);
  });

  it("is true once every run has ended, or is stuck", () => {
    assert.equal(view([{ status: "failed", createdAt: at(-100) }]).settled, true);
    assert.equal(view([{ status: "running", createdAt: at(-3 * 3600) }]).settled, true);
  });
});

describe("panelLinkOrigin", () => {
  const PROD = "https://muse-muse.example";
  it("is the preview's own branch address, or its deployment's, on a preview", () => {
    assert.equal(panelLinkOrigin(PROD, { VERCEL_ENV: "preview", VERCEL_URL: "x-abc.vercel.app", VERCEL_BRANCH_URL: "x-git-b.vercel.app" }), "https://x-git-b.vercel.app");
    assert.equal(panelLinkOrigin(PROD, { VERCEL_ENV: "preview", VERCEL_URL: "x-abc.vercel.app" }), "https://x-abc.vercel.app");
  });
  it("is the public site on production, not the project's vercel.app address", () => {
    assert.equal(panelLinkOrigin("https://muse-muse.vercel.app", { VERCEL_ENV: "production", VERCEL_URL: "x-abc.vercel.app" }), CANONICAL_SITE);
    assert.equal(panelLinkOrigin(PROD, { VERCEL_ENV: "production", PUBLIC_SITE_URL: "https://site.example/" }), "https://site.example");
  });
  it("leaves local runs alone", () => {
    assert.equal(panelLinkOrigin("http://localhost:3161", {}), "http://localhost:3161");
    assert.equal(panelLinkOrigin(PROD, { VERCEL_ENV: "preview" }), PROD);
  });
});

describe("publicSiteOrigin", () => {
  it("takes PUBLIC_SITE_URL, then the canonical site on production, then the origin it was given", () => {
    assert.equal(publicSiteOrigin("https://muse-muse.vercel.app", { PUBLIC_SITE_URL: " https://site.example// " }), "https://site.example");
    assert.equal(publicSiteOrigin("https://muse-muse.vercel.app", { VERCEL_ENV: "production" }), "https://www.musemuse.dev");
    assert.equal(publicSiteOrigin("https://x-abc.vercel.app", { VERCEL_ENV: "preview" }), "https://x-abc.vercel.app");
    assert.equal(publicSiteOrigin("http://localhost:3000", {}), "http://localhost:3000");
  });
  it("ignores a PUBLIC_SITE_URL that isn't a public web address", () => {
    assert.equal(publicSiteOrigin("https://o.example", { VERCEL_ENV: "production", PUBLIC_SITE_URL: "musemuse.dev" }), CANONICAL_SITE);
    assert.equal(publicSiteOrigin("https://o.example", { PUBLIC_SITE_URL: "http://localhost:3000" }), "https://o.example");
  });
});
