/**
 * The "Get it" panel's real slots: nothing with every flag off, what each person sees, and what the panel admits to.
 *   npx tsx --test components/product/__tests__/native-slots.test.tsx
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { DeviceFrame, deviceScale } from "@/components/product/DeviceFrame";
import { GetItPanel } from "@/components/product/GetItPanel";
import { downloadSize, nativeSlots, type NativeSlotContext } from "@/components/product/NativeSlots";
import { qrMatrix } from "@/lib/qr";
import { buildProductNativeView, type NativeArtifactRow, type NativeJobRow, type ProductNativeView } from "@/lib/native/product-view";
import { SHELL_UPDATE_PUBLISHED, expoGoLink } from "@/lib/native/shell-links";
import type { TargetId } from "@/lib/brief/schema";

const ctx = (over: Partial<NativeSlotContext> = {}): NativeSlotContext => ({
  slug: "bird-count",
  name: "Bird Count",
  liveUrl: "https://bird-count.vercel.app",
  origin: "https://muse.example",
  frameBrief: null,
  isOwner: false,
  onQuest: false,
  enabled: ["phone", "desktop", "vr", "glasses"],
  ...over,
});

const at = new Date("2026-10-31T12:00:00.000Z");
const later = new Date("2026-10-31T12:10:00.000Z");

const pack = (id: string, kind: NativeArtifactRow["kind"], bytes: number): NativeArtifactRow => ({ id, runId: "r", jobId: null, kind, platform: null, device: null, caption: null, url: `https://blob.example/${id}`, bytes, check: null, createdAt: at });
const job = (id: string, kind: NativeJobRow["kind"], result: NativeJobRow["result"], status: NativeJobRow["status"] = "done"): NativeJobRow => ({ id, runId: "r", kind, status, result, createdAt: later });

const view = (targets: TargetId[], input: { artifacts?: NativeArtifactRow[]; jobs?: NativeJobRow[]; working?: boolean } = {}): ProductNativeView =>
  buildProductNativeView({ targets, artifacts: input.artifacts ?? [], jobs: input.jobs ?? [], runs: input.working ? [{ status: "running", createdAt: new Date() }] : [] });

const html = (node: ReactNode) => renderToString(<>{node}</>).replace(/<!-- -->/g, "");

describe("with nothing to show", () => {
  it("renders no panel at all when every flag is off and there are no packages", () => {
    const slots = nativeSlots(view(["web"]), ctx({ enabled: [] }));
    assert.deepEqual(slots, { phone: null, desktop: null, vr: null, glasses: null });
    assert.equal(renderToString(createElement(GetItPanel, { slots })), "");
  });

  it("renders no panel for a web product with the flags on", () => {
    assert.equal(renderToString(createElement(GetItPanel, { slots: nativeSlots(view(["web"]), ctx()) })), "");
  });

  it("offers nothing unmade for a brief whose target's flag has been turned off", () => {
    assert.equal(renderToString(createElement(GetItPanel, { slots: nativeSlots(view(["web", "phone", "vr", "glasses", "desktop"]), ctx({ enabled: [] })) })), "");
  });

  it("keeps a package that exists on offer, whatever the flags say", () => {
    const slots = nativeSlots(view(["web"], { artifacts: [pack("a", "android_apk", 41_000_000)] }), ctx({ enabled: [] }));
    assert.ok(slots.phone);
    assert.equal(slots.desktop, null);
  });
});

describe("when nothing was made", () => {
  const settled = () => buildProductNativeView({ targets: ["web", "phone", "desktop"], artifacts: [], jobs: [], runs: [{ status: "failed", createdAt: at }], now: later.getTime() });

  it("doesn't promise a package that isn't coming", () => {
    const phone = html(nativeSlots(settled(), ctx({ buildId: "b1" })).phone);
    assert.match(phone, /There&#x27;s no Android app for now\./);
    assert.doesNotMatch(phone, /ready yet/);
    assert.doesNotMatch(phone, /href="\/b\/b1"/);
    const desktop = html(nativeSlots(settled(), ctx()).desktop);
    assert.match(desktop, /There&#x27;s no Mac app for now\./);
    assert.match(desktop, /There&#x27;s no Windows app for now\./);
  });

  it("points its owner at the build room", () => {
    assert.match(html(nativeSlots(settled(), ctx({ isOwner: true, buildId: "b1" })).phone), /href="\/b\/b1"[^>]*>See what happened in the build room/);
    assert.doesNotMatch(html(nativeSlots(settled(), ctx({ isOwner: true })).phone), /build room/);
  });
});

describe("the phone slot", () => {
  const made = view(["web", "phone"], { artifacts: [pack("a", "android_apk", 41_000_000)] });

  it("offers the APK with a QR code to the counted route, and steps", () => {
    const out = html(nativeSlots(made, ctx()).phone);
    assert.match(out, /Download for Android \(APK, 41 MB\)/);
    assert.match(out, /href="\/p\/bird-count\/get\/android"/);
    assert.match(out, /aria-label="Download for Android"/);
    assert.match(out, /Allow installs from your browser/);
    assert.match(out, /not from the Play Store/);
    assert.match(out, /Not checked yet\./);
    assert.match(out, /Add to Home Screen/);
  });

  it("frames the live product with the same sandbox as the page's iframe", () => {
    const out = html(nativeSlots(made, ctx()).phone);
    assert.match(out, /aria-label="Device size"/);
    assert.match(out, />Phone</);
    assert.match(out, />Tablet</);
  });

  it("holds the Expo Go QR back until the shell's update is published, and shows that only to the owner", () => {
    const side = qrMatrix(expoGoLink("bird-count")).size + 8;
    const owner = html(nativeSlots(made, ctx({ isOwner: true })).phone);
    assert.match(owner, /Only you can see this/);
    if (SHELL_UPDATE_PUBLISHED) {
      assert.match(owner, /aria-label="Open in Expo Go"/);
      assert.ok(owner.includes(`viewBox="0 0 ${side} ${side}"`), "the code holds the Expo Go link");
    } else {
      assert.doesNotMatch(owner, /aria-label="Open in Expo Go"/, "a code that can't open isn't shown");
      assert.ok(!owner.includes(`viewBox="0 0 ${side} ${side}"`));
      assert.match(owner, /shows here once the phone shell&#x27;s update is published/);
    }
    const visitor = html(nativeSlots(made, ctx()).phone);
    assert.doesNotMatch(visitor, /Expo Go/);
    assert.doesNotMatch(visitor, /Only you can see this/);
  });

  it("shows the owner the download count, and no one else", () => {
    const downloads = new Map([["a", 12]]);
    assert.match(html(nativeSlots(made, ctx({ isOwner: true, downloads })).phone), /12 downloads/);
    assert.doesNotMatch(html(nativeSlots(made, ctx({ downloads })).phone), /12 downloads/);
  });

  it("says a package is being made, or isn't ready", () => {
    assert.match(html(nativeSlots(view(["web", "phone"], { working: true }), ctx()).phone), /The Android app is being made\./);
    assert.match(html(nativeSlots(view(["web", "phone"]), ctx()).phone), /The Android app isn&#x27;t ready yet\./);
  });

  it("says plainly that nothing was made when this site has no packager, not that it's coming", () => {
    const phone = html(nativeSlots(view(["web", "phone"]), ctx({ packagerMissing: true })).phone);
    assert.match(phone, /Not made for this build: the app packager isn&#x27;t set up on this site\./);
    assert.doesNotMatch(phone, /ready yet|being made/);
    assert.match(phone, /Add to Home Screen/, "the iPhone home-screen install is still offered");
    const desktop = html(nativeSlots(view(["web", "desktop"]), ctx({ packagerMissing: true })).desktop);
    assert.equal(desktop.match(/Not made for this build/g)?.length, 2, "for Mac and for Windows");
  });

  it("hides a package that failed its check from visitors, and tells the owner why", () => {
    const failed = view(["web", "phone"], {
      artifacts: [pack("a", "android_apk", 41_000_000)],
      jobs: [job("j", "android_emu", { outcome: "failed", summary: "Didn't pass on an Android emulator.", reasons: ["The screen stayed blank."] }, "failed")],
    });
    const visitor = html(nativeSlots(failed, ctx()).phone);
    assert.doesNotMatch(visitor, /\/get\/android/);
    assert.match(visitor, /isn&#x27;t available right now/);
    assert.doesNotMatch(visitor, /stayed blank/);
    assert.doesNotMatch(visitor, /Android emulator/);
    const owner = html(nativeSlots(failed, ctx({ isOwner: true })).phone);
    assert.doesNotMatch(owner, /\/get\/android/);
    assert.match(owner, /visitors can&#x27;t download it/);
    assert.match(owner, /stayed blank/);
  });

  it("labels what was simulated, and not a real phone", () => {
    const out = html(
      nativeSlots(
        view(["web", "phone"], {
          artifacts: [
            pack("a", "android_apk", 41_000_000),
            { ...pack("c", "clip", 1), platform: "android", device: "Galaxy S25", check: "passed", createdAt: later, caption: "On a real Galaxy S25" },
          ],
          jobs: [job("j", "android_emu", { outcome: "passed", summary: "It opened in 2.1 s.", device: { name: "Pixel 7", os: "Android 15" } })],
        }),
        ctx(),
      ).phone,
    );
    assert.match(out, /Android emulator<span class="getit-check-device"> \(Pixel 7, Android 15\)<\/span><\/span><span class="getit-check-tags">.*?Passed.*?Simulated/);
    const real = out.slice(out.indexOf("Galaxy S25 on AWS Device Farm"));
    assert.doesNotMatch(real.slice(0, real.indexOf("</summary>")), /Simulated/);
    assert.match(out, /On a real Galaxy S25/);
  });
});

describe("the desktop slot", () => {
  const made = view(["web", "desktop"], { artifacts: [pack("m", "mac_zip", 215_000_000), pack("w", "windows_zip", 115_000_000)] });

  it("gives honest first-run steps for both", () => {
    const out = html(nativeSlots(made, ctx()).desktop);
    assert.match(out, /Download for Mac \(zip, 215 MB\)/);
    assert.match(out, /Download for Windows \(zip, 115 MB\)/);
    assert.match(out, /isn&#x27;t notarized by Apple/);
    assert.match(out, /Right-click the app and choose Open/);
    assert.match(out, /Privacy &amp; Security/);
    assert.match(out, /More info, then Run anyway/);
    assert.match(out, /href="\/p\/bird-count\/get\/mac"/);
    assert.match(out, /href="\/p\/bird-count\/get\/windows"/);
  });

  it("offers each download on its own", () => {
    const one = view(["web", "desktop"], { artifacts: [pack("w", "windows_zip", 115_000_000)] });
    const out = html(nativeSlots(one, ctx()).desktop);
    assert.match(out, /The Mac app isn&#x27;t ready yet/);
    assert.match(out, /Download for Windows/);
  });
});

describe("the VR slot", () => {
  it("has the short link in words, a QR code for phones, the list, and no real-headset claim", () => {
    const out = html(nativeSlots(view(["web", "vr"]), ctx()).vr);
    assert.match(out, /muse\.example\/q\/bird-count/);
    assert.match(out, /aria-label="Open on a phone"/);
    assert.match(out, /href="\/vr"/);
    assert.match(out, /Press Enter VR/);
    assert.match(out, /simulated Meta Quest 3, not on a real headset/);
    assert.doesNotMatch(out, /Open in VR/);
  });

  it("adds Open in VR inside Quest Browser", () => {
    const out = html(nativeSlots(view(["web", "vr"]), ctx({ onQuest: true })).vr);
    assert.match(out, /href="https:\/\/bird-count\.vercel\.app"[^>]*>Open in VR/);
  });
});

describe("the glasses slot", () => {
  it("opens the iPhone app, and says it was never on real glasses", () => {
    const out = html(nativeSlots(view(["web", "glasses"]), ctx()).glasses);
    assert.match(out, /href="musemuse:\/\/open\?slug=bird-count"/);
    assert.match(out, /aria-label="Open in the iPhone app"/);
    assert.match(out, /sample view/);
    assert.match(out, /stand-in for the glasses and sample photos, not real glasses/);
    assert.doesNotMatch(out, /mock glasses on/);
  });

  it("says when Meta's mock glasses were used", () => {
    const checked = view(["web", "glasses"], { jobs: [job("g", "glasses_sim", { outcome: "passed", informational: true, summary: "It reached a result." })] });
    const out = html(nativeSlots(checked, ctx()).glasses);
    assert.match(out, /checked with Meta&#x27;s mock glasses on an iPhone simulator, not on real glasses/);
    assert.match(out, /iPhone simulator with Meta&#x27;s mock glasses/);
    assert.match(out, /Simulated/);
  });
});

describe("in the panel", () => {
  it("gets a tab per place, in order", () => {
    const panel = renderToString(createElement(GetItPanel, { slots: nativeSlots(view(["web", "glasses", "vr", "desktop", "phone"]), ctx()) }));
    const tabs = [...panel.matchAll(/role="tab"[^>]*>([^<]+)</g)].map((m) => m[1]);
    assert.deepEqual(tabs, ["Phone", "Desktop", "VR", "Glasses"]);
  });
});

describe("DeviceFrame", () => {
  it("doesn't load the product on the server, where it can't measure its room", () => {
    const out = html(<DeviceFrame src="https://x.example" title="X" allow="fullscreen" sandbox="allow-scripts" />);
    assert.doesNotMatch(out, /<iframe/);
    assert.match(out, /aria-pressed="true"[^>]*>Phone</);
  });

  it("scales a device to fit its room and never above full size", () => {
    assert.equal(deviceScale("phone", 2000, 2000), 1);
    assert.ok(Math.abs(deviceScale("phone", 326, 2000) - 326 / 414) < 1e-9);
    assert.ok(Math.abs(deviceScale("desktop", 700, 2000) - 700 / 1304) < 1e-9);
    assert.ok(Math.abs(deviceScale("phone", 2000) - 720 / 868) < 1e-9);
  });
});

describe("downloadSize", () => {
  it("rounds as people read it", () => {
    assert.equal(downloadSize(41_000_000), "41 MB");
    assert.equal(downloadSize(214_600_000), "215 MB");
    assert.equal(downloadSize(10), "1 MB");
  });
});
