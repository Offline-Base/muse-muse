/**
 * The Nov 3 "muse among toys" numbers (docs/log/bench/2026-11-03/distract/scores.json, docs/BUILD_LOG.md) as a report the
 * board would post. AP there counts boxes from 0.5 (the service's floor); a fresh run counts from 0.05.
 */
import type { SamReportIn, SamSettingScore } from "@/lib/train/sam/types";

const s = (B: SamSettingScore["B"], A: SamSettingScore["A"], medianScore: number | null = null, medianBestOther: number | null = null): SamSettingScore => ({ B, A, medianScore, medianBestOther });

export function nov3Report(over: Partial<SamReportIn> = {}): SamReportIn {
  return {
    version: 1,
    word: "muse",
    generic: "plush toy",
    seed: 20261103,
    setsSource: "nov3",
    settings: {
      meta_word: s({ n: 30, found: 0, top: 0, only: 0, otherBoxes: 0, ap: 0, ap50: 0 }, { n: 30, firedPhotos: 0, boxes: 0 }),
      meta_generic: s({ n: 30, found: 30, top: 14, only: 0, otherBoxes: 73, ap: 0.466, ap50: 0.468 }, { n: 30, firedPhotos: 30, boxes: 76 }, 0.957, 0.953),
      meta_toy: s({ n: 30, found: 30, top: 20, only: 0, otherBoxes: 82, ap: 0.498, ap50: 0.499 }, { n: 30, firedPhotos: 29, boxes: 71 }),
      tuned_word: s({ n: 30, found: 29, top: 22, only: 8, otherBoxes: 30, ap: 0.773, ap50: 0.778 }, { n: 30, firedPhotos: 22, boxes: 38 }, 0.988, 0.836),
    },
    truck: { meta: { truck: 1, wheel: 4 }, tuned: { truck: 1, wheel: 4 } },
    images: [],
    files: { scores: "https://blob.example/samtune/x/report/a-scores.json", perImage: "https://blob.example/samtune/x/report/b-per_image.json" },
    deltaSha256: "a".repeat(64),
    workerId: "jetson-03",
    apFrom: 0.05,
    timings: { training: 1800 },
    ...over,
  };
}
