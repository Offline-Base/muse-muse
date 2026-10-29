import type { LocalFile, LocalFiles } from "@/lib/train/local-files";

/**
 * Run 2 as localFilesFor would give it once glimmer-quantize has made its files (docs/VIBE_TUNING.md, build order steps
 * 1 and 3): job 83d71f74 trained on dataset 17c76f2c, "Muse Muse brief writer", before trainChannel, so it needs
 * tuned.jinja. The sizes are the tuned files' from the design (13.68, 16.94 and 22.87 GB); the hashes and the commit are
 * made up. Not a test file: the run-locally tests share it.
 */
export const RUN2_JOB = "83d71f74-5a1e-4c3b-9f2d-0b7c1e4a9d10";
export const RUN2_TITLE = "Muse Muse brief writer";
/** hubSlug(RUN2_TITLE) and studentSystem(RUN2_TITLE) in lib/train/hub-cards.ts, which a test checks. */
export const RUN2_SLUG = "brief-writer";
export const RUN2_SYSTEM = "You are the Muse Muse brief writer.\n\nReasoning strength: low.";
export const RUN2_REPO = `muse-org/muse-glimmer-30b-${RUN2_SLUG}-gguf-83d71f74`;
export const RUN2_COMMIT = "4f9c2e7a1b3d5f60718293a4b5c6d7e8f9012345";

const file = (level: LocalFile["level"], bytes: number, hex: string): LocalFile => ({
  level,
  name: `muse-glimmer-30b-${RUN2_SLUG}-${level}.gguf`,
  bytes,
  sha256: hex.repeat(64 / hex.length),
});

export const RUN2_BUILDS: LocalFile[] = [
  file("Q3_K_M", 13_682_811_872, "3a"),
  file("Q4_K_M", 16_937_492_960, "4b"),
  file("Q6_K", 22_868_102_624, "6c"),
];

export function run2Files(over: Partial<LocalFiles> = {}): LocalFiles {
  return {
    adapterJobId: RUN2_JOB,
    quantJobId: "c0de5eed-7b1a-4e2f-8a3b-5c6d7e8f9a01",
    repo: RUN2_REPO,
    commit: RUN2_COMMIT,
    public: true,
    files: RUN2_BUILDS,
    systemLine: RUN2_SYSTEM,
    needsTunedTemplate: true,
    title: RUN2_TITLE,
    slug: RUN2_SLUG,
    ...over,
  };
}

/** Held-out prompt 0 and a tuned answer in the brief writer's style, for Say hello. */
export const RUN2_HELLO = {
  prompt: "I run a small bakery. Make me an app that turns a photo of my chalkboard menu into a weekly specials page I can share.",
  tuned:
    "Specials board\n\nTurns a photo of a bakery's chalkboard menu into a clean weekly specials page with a share link.\n\nModels: muse-spark-1.3 reads the photo and writes the page.\n\nLimits: chalk it can't read is marked for the owner to fix before sharing.\n\nCost per run: about $0.01.",
  index: 0,
  total: 40,
};
