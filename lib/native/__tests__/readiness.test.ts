/**
 * When the native lane may offer phone and desktop, and what it says when it can't.
 *   npx tsx --test lib/native/__tests__/readiness.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { offeredNativeTargets, packagerReadyFor, packagingSkippedEvent, targetPickerNote, waitingNativeTargets } from "@/lib/native/readiness";
import { currentShells } from "@/lib/native/shells";

const template = { pathname: "p", url: null, bytes: 1, sha256: "s" };
const all = { android: template, mac: template, windows: template };

describe("packagerReadyFor", () => {
  it("needs the snapshot and a template for the target", () => {
    assert.equal(packagerReadyFor("phone", { snapshotId: "snap_1", release: { templates: all } }), true);
    assert.equal(packagerReadyFor("phone", { snapshotId: null, release: { templates: all } }), false);
    assert.equal(packagerReadyFor("phone", { snapshotId: "snap_1", release: { templates: { mac: template } } }), false);
    assert.equal(packagerReadyFor("desktop", { snapshotId: "snap_1", release: { templates: { windows: template } } }), true);
  });

  it("takes a template with no Blob link, since the snapshot holds its own copy", () => {
    assert.equal(currentShells().templates.android?.url ?? null, null, "shells.json has no links today");
    assert.equal(packagerReadyFor("phone", { snapshotId: "snap_1", release: currentShells() }), true);
  });

  it("asks nothing of the targets with no packager", () => {
    for (const t of ["web", "vr", "glasses", "agent", "edge"] as const) assert.equal(packagerReadyFor(t, { snapshotId: null, release: { templates: {} } }), true);
  });
});

describe("what's offered and what waits", () => {
  it("offers phone and desktop only with the packager, and says the rest wait", () => {
    const none = { snapshotId: null, release: { templates: all } };
    const set = { snapshotId: "snap_1", release: { templates: all } };
    assert.deepEqual(offeredNativeTargets(["phone", "desktop"], none), []);
    assert.deepEqual(waitingNativeTargets(["phone", "desktop"], none), ["phone", "desktop"]);
    assert.deepEqual(offeredNativeTargets(["phone", "desktop"], set), ["phone", "desktop"]);
    assert.deepEqual(waitingNativeTargets(["phone", "desktop"], set), []);
  });

  it("changes nothing when NATIVE_TARGETS is empty", () => {
    assert.deepEqual(offeredNativeTargets([], { snapshotId: null, release: { templates: {} } }), []);
    assert.deepEqual(waitingNativeTargets([], { snapshotId: null, release: { templates: {} } }), []);
    assert.equal(targetPickerNote([]), null);
  });

  it("says plainly in the picker that only the web app and its home-screen install are there", () => {
    assert.equal(
      targetPickerNote(["phone", "desktop"]),
      "Only the web app and its phone home-screen install are available. Phone and desktop apps aren't made here, because the app packager isn't set up on this site.",
    );
    assert.match(targetPickerNote(["desktop"]) ?? "", /Desktop apps aren't made here/);
    assert.doesNotMatch(targetPickerNote(["phone"]) ?? "", /—/);
  });

  it("doesn't say only the web app is there when the picker lists VR, glasses or others", () => {
    const note = targetPickerNote(["phone", "desktop"], ["vr", "glasses"]) ?? "";
    assert.doesNotMatch(note, /Only the web app/);
    assert.equal(note, "Phone and desktop apps aren't made here, because the app packager isn't set up on this site. A phone can still add the web app to its home screen.");
  });
});

describe("packagingSkippedEvent", () => {
  it("is one skipped line naming the apps and the reason, with no claim that anything ran", () => {
    const event = packagingSkippedEvent({ buildId: "b1", kinds: ["android", "mac", "windows"] });
    assert.deepEqual(event, {
      type: "native",
      runId: "skipped-b1",
      origin: "ship",
      item: "package",
      target: "phone",
      state: "skipped",
      title: "The Android, Mac and Windows apps weren't made",
      detail: "Not made for this build: the app packager isn't set up on this site. The web app is live, and a phone can add it to its home screen.",
    });
    const desk = packagingSkippedEvent({ buildId: "b2", kinds: ["mac", "windows"] });
    assert.equal(desk.target, "desktop");
    assert.equal(desk.title, "The Mac and Windows apps weren't made");
    assert.equal(packagingSkippedEvent({ buildId: "b3", kinds: ["android"] }).title, "The Android app wasn't made");
  });
});
