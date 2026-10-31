/**
 * The pure parts of scripts/promote-local.ts (lib/promote/local.ts): which local products may go, their rows as a
 * bundle with every id kept and no user id, finding each local file link in nested JSON and inside text, the stored key
 * behind it, rewriting them all, and the check that never lets a bundle that still points at this machine be sent.
 * Pure: nothing is mocked and nothing touches the network.
 *
 *   npx tsx --test lib/promote/__tests__/local.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { blobUrlFor, findLocalFileUrls, localFileKeyOf, rewriteLocalUrls, skipReason, toBundle, whyNotSend } from "../local";
import { LOCAL, sampleRows, STORE } from "./fixtures";

/** The bundle once every file is in the store, links as the store would give them. */
function uploaded() {
  const bundle = toBundle(sampleRows());
  return rewriteLocalUrls(bundle, new Map(findLocalFileUrls(bundle).map((url) => [url, blobUrlFor("store_8A701wVtiqVp1x3e", localFileKeyOf(url)!)])));
}

describe("files under native/ and clips/", () => {
  it("are found, keyed and moved like any other stored file", () => {
    const clip = `${LOCAL}/clips/p1/quest-1a2b.mp4`;
    const shot = `${LOCAL}/native/runs/r1/j1/shot-1.jpg`;
    const value = { extraClips: [{ url: clip }], payload: { media: [{ url: shot }] } };
    assert.deepEqual(findLocalFileUrls(value), [clip, shot]);
    assert.equal(localFileKeyOf(clip), "clips/p1/quest-1a2b.mp4");
    assert.equal(localFileKeyOf(shot), "native/runs/r1/j1/shot-1.jpg");
    const moved = rewriteLocalUrls(value, new Map([[clip, `${STORE}/clips/p1/quest-1a2b.mp4`], [shot, `${STORE}/native/runs/r1/j1/shot-1.jpg`]]));
    assert.deepEqual(findLocalFileUrls(moved), []);
  });
});

describe("a local product with targets", () => {
  it("sends what it picked, its canned outputs and its clips, and its files move with it", () => {
    const rows = sampleRows();
    const clip = { url: `${LOCAL}/clips/${rows.product.id}/quest-1a2b.mp4`, posterUrl: null, caption: "Filmed on a Meta Quest 3", addedAt: "2026-11-03T12:00:00.000Z" };
    rows.product.extraClips = [clip];
    rows.builds[0]!.requestedTargets = ["web", "phone"];
    rows.builds[0]!.toolFixtures = { SERPAPI_SEARCH: [{ url: "https://example.com/a" }] };
    const bundle = toBundle(rows);
    assert.deepEqual(bundle.product.extraClips, [clip]);
    assert.deepEqual(bundle.builds[0]!.requestedTargets, ["web", "phone"]);
    assert.deepEqual(bundle.builds[0]!.toolFixtures, { SERPAPI_SEARCH: [{ url: "https://example.com/a" }] });
    assert.ok(!("requestedTargets" in bundle.builds[1]!), "its refinement picked none");
    assert.ok(findLocalFileUrls(bundle).includes(clip.url));
    assert.match(whyNotSend(bundle) ?? "", /points at a file/);
    const moved = rewriteLocalUrls(bundle, new Map(findLocalFileUrls(bundle).map((url) => [url, blobUrlFor("store_8A701wVtiqVp1x3e", localFileKeyOf(url)!)])));
    assert.equal(whyNotSend(moved), null);
  });
});

describe("finding local file links", () => {
  it("finds each one once, at any depth, whole or inside text", () => {
    const value = {
      a: `${LOCAL}/demos/b1/demo-1a2b.mp4`,
      list: [{ deep: { url: `${LOCAL}/screens/b1/r0/01-home.png` } }, `${LOCAL}/demos/b1/demo-1a2b.mp4`],
      text: `See ${LOCAL}/inspo/x-photo-12ab.jpg, and (${LOCAL}/fixtures/b1/sample-1.txt).`,
      other: "http://127.0.0.1:4000/api/files/transcripts/b1/t-1.json",
      v6: ["http://[::1]:3000/api/files/uploads/p1/a.png"],
      n: 3,
      none: null,
    };
    assert.deepEqual(findLocalFileUrls(value), [
      `${LOCAL}/demos/b1/demo-1a2b.mp4`,
      `${LOCAL}/screens/b1/r0/01-home.png`,
      `${LOCAL}/inspo/x-photo-12ab.jpg`,
      `${LOCAL}/fixtures/b1/sample-1.txt`,
      "http://127.0.0.1:4000/api/files/transcripts/b1/t-1.json",
      "http://[::1]:3000/api/files/uploads/p1/a.png",
    ]);
  });

  it("leaves other localhost links alone: the sandbox's own server, and paths the platform never stores under", () => {
    const value = {
      tool: "curl http://localhost:3000/api/health",
      route: "http://localhost:3000/api/files/report.pdf",
      elsewhere: "https://example.com/api/files/demos/b1/demo.mp4",
    };
    assert.deepEqual(findLocalFileUrls(value), []);
  });

  it("finds every file a local product's rows point at", () => {
    const rows = sampleRows();
    const build = rows.builds[0]!.id;
    assert.deepEqual(findLocalFileUrls(toBundle(rows)).map(localFileKeyOf).sort(), [
      `demos/${build}/demo-1a2b3c4d.mp4`,
      `demos/${build}/poster-5e6f7a8b.jpg`,
      "inspo/0f0e1d2c-feeder-12ab34cd.jpg",
      `screens/${build}/r0/01-home-aa11bb22.png`,
      `transcripts/${build}/transcript-9c0d1e2f.json`,
    ]);
  });
});

describe("local file keys", () => {
  it("are the key the file was stored under, which is also its Blob pathname", () => {
    assert.equal(localFileKeyOf(`${LOCAL}/demos/b1/demo-1a2b.mp4`), "demos/b1/demo-1a2b.mp4");
    assert.equal(localFileKeyOf(`${LOCAL}/screens/b1/r0/01%20home%20(dark).png?x=1#top`), "screens/b1/r0/01 home (dark).png");
    assert.equal(blobUrlFor("store_8A701wVtiqVp1x3e", "screens/b1/r0/01 home.png"), `${STORE}/screens/b1/r0/01%20home.png`);
  });

  it("are null for anything that climbs out, isn't the platform's or isn't encoded right", () => {
    for (const url of [
      `${LOCAL}/demos/%2E%2E/%2E%2E/.env.local`,
      `${LOCAL}/demos//demo.mp4`,
      `${LOCAL}/other/x.png`,
      `${LOCAL}/demos/%E0%A4%A.mp4`,
      "https://example.com/x.png",
    ]) {
      assert.equal(localFileKeyOf(url), null, url);
    }
  });
});

describe("rewriting the links", () => {
  it("replaces every mapped link, whole or inside text, and nothing else", () => {
    const video = `${LOCAL}/demos/b1/demo.mp4`;
    const moved = `${STORE}/demos/b1/demo.mp4`;
    const value = { url: video, text: `at ${video}. and ${video}x`, list: [video, { posterUrl: null }], n: 3 };
    const out = rewriteLocalUrls(value, new Map([[video, moved]]));
    assert.deepEqual(out, { url: moved, text: `at ${moved}. and ${video}x`, list: [moved, { posterUrl: null }], n: 3 });
    assert.equal(value.url, video, "the original is left as it was");
  });

  it("moves every file of a local product, so nothing in it points at this machine", () => {
    const out = uploaded();
    assert.deepEqual(findLocalFileUrls(out), []);
    assert.ok(out.product.demoVideoUrl!.startsWith(`${STORE}/demos/`));
    assert.ok(out.inspiration.references[0]!.url.startsWith(`${STORE}/inspo/`));
    const log = out.events.find((e) => e.type === "log")!.payload as { text: string };
    assert.equal(log.text, `Saved the demo. Watch it at ${out.product.demoVideoUrl}.`);
  });
});

describe("the check before sending", () => {
  it("passes a bundle whose files are all in the store", () => {
    assert.equal(whyNotSend(uploaded()), null);
  });

  it("refuses one that still points at a file here, wherever it is", () => {
    const b = uploaded();
    const log = b.events.findIndex((e) => e.type === "log");
    b.events[log]!.payload = { type: "log", text: `see ${LOCAL}/demos/b1/demo.mp4` };
    assert.match(whyNotSend(b) ?? "", /^events\[\d+\]\.payload\.text still points at a file on the machine it came from/);
    const raw = toBundle(sampleRows());
    assert.match(whyNotSend(raw) ?? "", /still points at a file on the machine it came from/, "a bundle nobody rewrote");
  });

  it("refuses a link field on localhost, but sends text that only mentions the sandbox's own localhost", () => {
    const b = uploaded();
    b.builds[0]!.previewUrl = "http://localhost:3000";
    assert.match(whyNotSend(b) ?? "", /^builds\[0\]\.previewUrl isn't a public https link/);
    assert.ok(JSON.stringify(uploaded()).includes("curl http://localhost:3000/api/health"));
  });

  it("refuses what the live site's parser would, and a bundle over the size an import takes", () => {
    const partial = uploaded();
    partial.builds[1]!.status = "building";
    assert.match(whyNotSend(partial) ?? "", /^builds\[1\]\.status must be one a build ends with/);
    const big = uploaded();
    const at = big.events[0]!.at;
    for (let i = 0; i < 15_000; i++) big.events.push({ buildId: big.builds[0]!.id, type: "log", payload: { type: "log", text: "x".repeat(300) }, at });
    assert.match(whyNotSend(big) ?? "", /^the bundle is [\d.]+ MB, over the 4 MB an import takes$/);
  });
});

describe("which products go", () => {
  it("a live one whose latest build is live, with every build finished", () => {
    assert.equal(skipReason(sampleRows()), null);
  });

  it("not one that isn't live, has no shipped build, or whose latest build isn't live", () => {
    const partial = sampleRows();
    partial.product.status = "partial";
    assert.equal(skipReason(partial), "it is partial, not live");
    const unshipped = sampleRows();
    unshipped.product.latestBuildId = null;
    assert.equal(skipReason(unshipped), "it has no shipped build");
    const latest = sampleRows();
    latest.builds[0]!.status = "partial";
    assert.equal(skipReason(latest), "its latest build is partial, not live");
    const missing = sampleRows();
    missing.builds = missing.builds.slice(1);
    assert.equal(skipReason(missing), "its latest build isn't in the database");
  });

  it("not one with a build still running, no sandbox, a link already or no muse", () => {
    const running = sampleRows();
    running.builds[1]!.status = "fixing";
    assert.equal(skipReason(running), `build ${running.builds[1]!.id} is still running`);
    const boxless = sampleRows();
    boxless.product.sandboxName = null;
    assert.equal(skipReason(boxless), "it has no sandbox to publish from");
    const linked = sampleRows();
    linked.product.liveUrl = "https://musemuse-bird-count.vercel.app";
    assert.equal(skipReason(linked), "it already has its own link (https://musemuse-bird-count.vercel.app)");
    const museless = sampleRows();
    museless.inspirations = museless.inspirations.slice(1);
    assert.equal(skipReason(museless), "the muse it was built from isn't in the database");
  });
});

describe("the bundle", () => {
  it("keeps every id and leaves out user ids, the local workflow run and the local event ids", () => {
    const rows = sampleRows();
    const b = toBundle(rows);
    assert.equal(b.product.id, rows.product.id);
    assert.deepEqual(b.builds.map((x) => x.id), rows.builds.map((x) => x.id));
    assert.deepEqual(b.events.map((e) => e.payload), rows.events.map((e) => e.payload));
    assert.ok(b.events.every((e) => !("id" in e)));
    assert.equal(b.inspiration.id, rows.product.inspirationId);
    assert.deepEqual(b.refineInspirations.map((i) => i.id), [rows.inspirations[1]!.id]);
    const text = JSON.stringify(b);
    assert.equal(text.includes(rows.product.ownerId), false, "no user id");
    assert.equal(text.includes("wrun_local_1"), false, "no workflow run");
    assert.equal("liveUrl" in b.product || "vercelProjectId" in b.product, false);
    assert.equal(b.builds[0]!.startedAt, rows.builds[0]!.startedAt.toISOString());
  });

  it("is refused for rows that can't go", () => {
    const rows = sampleRows();
    rows.product.sandboxName = null;
    assert.throws(() => toBundle(rows), /bird-count can't be imported: it has no sandbox to publish from/);
  });
});
