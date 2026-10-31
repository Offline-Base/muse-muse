/**
 * The build room's Apps step: rows from a build's native events, in roomSteps' targets slot.
 *   npx tsx --test components/build/__tests__/apps.test.tsx
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToString } from "react-dom/server";
import { appsLine, nativeRows, queueWords } from "@/components/build/apps";
import { deriveRoom, railStates } from "@/components/build/derive";
import { roomSteps } from "@/components/build/steps";
import { FIXTURES } from "@/components/build/__tests__/room-fixture";
import { StepList } from "@/components/chat";
import { condenseNativeEvents, type NativeEventBody } from "@/lib/types";

const native = (item: string, state: NativeEventBody["state"], title: string, more: Partial<NativeEventBody> = {}): NativeEventBody => ({ type: "native", runId: "run-1", origin: "ship", item, target: "phone", state, title, ...more });
const runsOf = (events: NativeEventBody[]) => condenseNativeEvents(events);

describe("queueWords", () => {
  it("says how long the wait is", () => {
    assert.equal(queueWords({ state: "queued", title: "Waiting", queue: { ahead: 2, etaSeconds: 240 } }), "2 checks ahead, about 4 minutes");
    assert.equal(queueWords({ state: "queued", title: "Waiting", queue: { ahead: 0, etaSeconds: 40 } }), "Next in line, about 1 minute");
    assert.equal(queueWords({ state: "queued", title: "Waiting", queue: { ahead: 1, etaSeconds: 0 } }), "1 check ahead");
  });

  it("says nothing when the title already does, or it's no longer waiting", () => {
    assert.equal(queueWords({ state: "queued", title: "Waiting for the Mac lab: 2 checks ahead", queue: { ahead: 2, etaSeconds: 240 } }), null);
    assert.equal(queueWords({ state: "running", title: "Checking", queue: { ahead: 2, etaSeconds: 240 } }), null);
    assert.equal(queueWords({ state: "queued", title: "Waiting" }), null);
  });
});

describe("nativeRows", () => {
  it("has no rows with no runs", () => {
    assert.deepEqual(nativeRows([], { live: true }), []);
  });

  it("shows a running run, its queue and only what's running as running", () => {
    const [row] = nativeRows(
      runsOf([
        native("package:android", "done", "Packaged the Android app (41 MB)"),
        native("check:android_emu", "running", "Checking on an Android emulator"),
        native("check:ios_sim", "queued", "Waiting for the Mac lab", { queue: { ahead: 2, etaSeconds: 240 } }),
        native("check:desktop_windows", "skipped", "Not checked on Windows this time"),
        native("package:mac", "failed", "Couldn't package the Mac app", { detail: "It stopped." }),
      ]),
      { live: true },
    );
    assert.equal(row!.title, "Making the apps");
    assert.equal(row!.state, "running");
    assert.equal(row!.description, "1 of 5 steps done · 1 failed · 1 skipped");
    assert.deepEqual(row!.children!.map((c) => c.state), ["done", "running", "done", "done", "failed"]);
    assert.equal(row!.children![2]!.description, "2 checks ahead, about 4 minutes");
    assert.equal(row!.children![4]!.description, "It stopped.");
  });

  it("gives a finished run thumbnails, its cost and a way to the downloads", () => {
    const [row] = nativeRows(
      runsOf([
        native("check:android_emu", "done", "Checked on an Android emulator", { media: [{ kind: "video", url: "https://blob.example/clip.mp4", posterUrl: "https://blob.example/poster.jpg", caption: "On an Android emulator" }] }),
        native("device_farm:android", "done", "Real Galaxy S25: 4 device minutes, $0.68", { costUsd: 0.68 }),
        native("check:ios_sim", "done", "Checked on an iPhone simulator", { costUsd: 0.1 }),
      ]),
      { live: false, slug: "bird-count" },
    );
    assert.equal(row!.title, "Made the apps");
    assert.equal(row!.state, "done");
    assert.match(row!.description!, /\$0\.78 est\./);
    assert.deepEqual(row!.children![0]!.media, [{ kind: "video", src: "https://blob.example/poster.jpg", alt: "On an Android emulator", href: "https://blob.example/clip.mp4" }]);
    assert.equal(row!.children![1]!.description, undefined, "the title already gives its cost");
    assert.equal(row!.children![2]!.description, "$0.10");
    const list = renderToString(<StepList steps={[row!]} />);
    assert.match(list, /href="\/p\/bird-count#get-it-title"/);
    assert.match(list, /poster\.jpg/);
  });

  it("links a clip with no poster, since a thumbnail would have nothing to show", () => {
    const [row] = nativeRows(runsOf([native("check:ios_sim", "done", "Checked", { media: [{ kind: "video", url: "https://blob.example/clip.mp4", caption: "The clip" }] })]), { live: false });
    assert.equal(row!.children![0]!.media, undefined);
    assert.match(renderToString(<StepList steps={[row!]} />), /href="https:\/\/blob\.example\/clip\.mp4"/);
  });

  it("says what stopped without saying so, once nothing is coming", () => {
    const [row] = nativeRows(runsOf([native("check:ios_sim", "running", "Checking"), native("check:android_emu", "queued", "Waiting", { queue: { ahead: 1, etaSeconds: 60 } })]), { live: false });
    assert.equal(row!.title, "The apps didn't finish");
    assert.equal(row!.state, "failed");
    assert.deepEqual(row!.children!.map((c) => [c.state, c.description]), [["done", "It didn't finish."], ["done", "It didn't finish."]]);
  });

  it("names a run by who started it", () => {
    const title = (origin: NativeEventBody["origin"], state: NativeEventBody["state"] = "running", live = true) => nativeRows(runsOf([native("a", state, "A step", { origin })]), { live })[0]!.title;
    assert.equal(title("agent"), "Trying it on devices");
    assert.equal(title("agent", "done", false), "Tried it on devices");
    assert.equal(title("agent", "running", false), "The device checks didn't finish");
    assert.equal(title("refine"), "Checking the apps again");
    assert.equal(title("owner"), "Making the apps");
    assert.equal(title("ship", "failed", false), "The apps didn't finish");
    assert.equal(title("ship", "skipped", false), "No apps this time");
  });

  it("doesn't link an agent's checks to the product page", () => {
    const [row] = nativeRows(runsOf([native("a", "done", "Checked the preview", { origin: "agent" })]), { live: false, slug: "bird-count" });
    assert.equal(row!.body, undefined);
  });

  it("leaves out what doesn't read, from a newer branch", () => {
    const [row] = nativeRows(runsOf([native("a", "done", "A step", { media: [null, { kind: "video" }, { kind: "image", url: "https://x.example/a.jpg", caption: 3 }, { kind: "image", url: "https://x.example/a.jpg", caption: "Again" }] as never })]), { live: false });
    assert.deepEqual(row!.children![0]!.media, [{ kind: "image", src: "https://x.example/a.jpg", alt: "A step", href: "https://x.example/a.jpg" }]);
  });
});

describe("appsLine", () => {
  it("says what's happening now", () => {
    const line = appsLine(runsOf([native("a", "done", "Packaged"), native("b", "queued", "Waiting for the Mac lab", { queue: { ahead: 1, etaSeconds: 120 } })]), true);
    assert.equal(line!.title, "Making the apps");
    assert.equal(line!.state, "running");
    assert.equal(line!.description, "Waiting for the Mac lab: 1 check ahead, about 2 minutes");
  });

  it("sums up when it's over", () => {
    const line = appsLine(runsOf([native("a", "done", "Packaged"), native("b", "failed", "Didn't")]), false);
    assert.equal(line!.state, "done");
    assert.equal(line!.description, "1 of 2 steps done · 1 failed");
  });

  it("is nothing for no runs, or an agent's alone", () => {
    assert.equal(appsLine([], true), null);
    assert.equal(appsLine(runsOf([native("a", "running", "Trying", { origin: "agent" })]), true), null);
  });
});

describe("in the steps list", () => {
  const f = FIXTURES.finished;
  const room = deriveRoom(f.build, f.events);
  const rail = railStates(room, "build");

  it("adds nothing with no native runs, as before", () => {
    const plain = roomSteps({ room, rail, isRefine: false });
    const withNone = roomSteps({ room, rail, isRefine: false, targets: nativeRows([], { live: false }) });
    assert.deepEqual(withNone.map((r) => r.id), plain.map((r) => r.id));
  });

  it("sits under the deploy, with its row id for the conversation to open", () => {
    const steps = roomSteps({ room, rail, isRefine: false, targets: nativeRows(runsOf([native("a", "done", "Packaged")]), { live: false }) });
    assert.equal(steps.at(-1)!.id, "apps:run-1");
    assert.ok(steps.slice(0, -1).some((r) => r.title === "Deployed"));
  });
});
