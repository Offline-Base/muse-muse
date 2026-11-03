import type { DeviceKind } from "@/lib/types";

/**
 * Recorded device runs, by product slug: the product opened on a real or simulated device, recorded on that device, with
 * the facts of the run. Each entry is checked against docs/BUILD_LOG.md before it goes here, and its files live in
 * public/devices/<slug>/, so what a judge sees is in the repo. Runs the platform records itself come from native
 * artifacts instead (lib/native/), once those flags are on.
 */
export interface DeviceRun {
  device: DeviceKind;
  /** The device, as people know it: "Samsung Galaxy S25". */
  name: string;
  /** Where it ran: "AWS Device Farm". */
  place: string;
  /** What the run measured, in a few words: "Android 16. Loaded in 1.3 s, self-test passed". */
  detail: string;
  /** A simulator or emulator, not the device itself. Shown as a tag in words, never only as a color. */
  simulated: boolean;
  /** The day it ran, as YYYY-MM-DD. */
  ranOn: string;
  video: string;
  poster: string;
  /** Where the run is written up, for whoever checks it. */
  source: string;
}

const files = (slug: string, name: string) => ({ video: `/devices/${slug}/${name}.mp4`, poster: `/devices/${slug}/${name}.jpg` });

export const DEVICE_RUNS: Readonly<Record<string, readonly DeviceRun[]>> = {
  // docs/BUILD_LOG.md, "Nov 2, night: the device demos tap through the app": every device opened
  // https://musemuse-dinner-split-helper.vercel.app/, split the $120 example (4 people) and the $86.50 example
  // (3 people), and Muse Spark 1.3 answered $35.40 and $34.60 each. Files from s3 lab/checks/demo-1102/ and Device Farm
  // run 3abcc4b7.
  "dinner-split-helper": [
    { device: "mac", name: "Mac", place: "AWS device lab, macOS 26.7", detail: "Chromium 141 clicked through two bills, and Muse Spark 1.3 split them: $35.40 and $34.60 each", simulated: false, ranOn: "2026-11-02", ...files("dinner-split-helper", "mac"), source: "docs/BUILD_LOG.md, lab demo-1102" },
    { device: "windows", name: "Windows PC", place: "AWS device lab, Windows Server 2022", detail: "Chromium 141 clicked through two bills, and Muse Spark 1.3 split them: $35.40 and $34.60 each", simulated: false, ranOn: "2026-11-02", ...files("dinner-split-helper", "windows"), source: "docs/BUILD_LOG.md, lab demo-1102" },
    { device: "android", name: "Samsung Galaxy S25", place: "AWS Device Farm, Android 16", detail: "Tapped through two bills in the Muse Muse lab app, and Muse Spark 1.3 split them: $35.40 and $34.60 each", simulated: false, ranOn: "2026-11-02", ...files("dinner-split-helper", "galaxy-s25"), source: "docs/BUILD_LOG.md, Device Farm run 3abcc4b7" },
    { device: "iphone", name: "iPhone 15 Pro size", place: "Safari's engine (WebKit 26) on the lab Mac", detail: "Tapped through two bills, and Muse Spark 1.3 split them: $35.40 and $34.60 each", simulated: true, ranOn: "2026-11-02", ...files("dinner-split-helper", "iphone"), source: "docs/BUILD_LOG.md, lab demo-1102" },
  ],
};

/** The order devices stand in: computers first, then phones. */
const ORDER: Record<DeviceKind, number> = { mac: 0, windows: 1, android: 2, iphone: 3 };

/**
 * What DeviceStage shows for a product: its recorded runs, then its owner's clips that name a device, computers before
 * phones. Empty when there's nothing recorded on a device, and the page then shows no stage at all.
 */
export function stageDevices(slug: string, clips: ReadonlyArray<{ url: string; posterUrl: string | null; caption: string; addedAt: string; device?: DeviceKind }> = []): DeviceRun[] {
  const owned: DeviceRun[] = clips.flatMap((c) =>
    c.device
      ? [{ device: c.device, name: c.caption, place: "Recorded by its owner", detail: "", simulated: false, ranOn: c.addedAt.slice(0, 10), video: c.url, poster: c.posterUrl ?? "", source: "products.extra_clips" }]
      : [],
  );
  return [...(DEVICE_RUNS[slug] ?? []), ...owned].sort((a, b) => ORDER[a.device] - ORDER[b.device]);
}

/** "Nov 1": the day a run happened, short. */
export function ranOnLabel(ranOn: string): string {
  const d = new Date(`${ranOn}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}
