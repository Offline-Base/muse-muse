/**
 * The frontier claim and the evidence for each step of it, for /offline, /how-it-works and docs/STORY.md. One place, so a
 * step's mark changes everywhere at once. A step is "proven" only if it was seen in a real run, and the note says how.
 * components/story/__tests__/story.test.tsx holds the numbers to docs/BUILD_LOG.md, docs/KNOWLEDGE_RUN_LOG.md and README.md.
 */

export type FlowMark = "proven" | "harness" | "simulated" | "not-run";

export const FLOW_MARK_LABEL: Record<FlowMark, string> = {
  proven: "Proven",
  harness: "Proven, by harness",
  simulated: "Simulated",
  "not-run": "Not run yet",
};

export const FLOW_MARK_TONE: Record<FlowMark, "live" | "partial" | "building" | "neutral"> = {
  proven: "live",
  harness: "partial",
  simulated: "building",
  "not-run": "neutral",
};

export interface FlowStep {
  step: string;
  mark: FlowMark;
  evidence: string;
}

export const FRONTIER_CLAIM =
  "Muse Muse is built so one sentence becomes a tuned model on your own hardware, inside an app built for it, with checks showing what was proven.";

export const FRONTIER_LIMIT =
  "That is the design, and each step below is marked for what has really happened. The whole chain has not run as one, and no tuned model from this flow has run on anyone's own hardware yet.";

/** What the test holds to the logs. */
export const TUNE_RESULT = {
  tuned: "6.67",
  base: "2.55",
  items: 100,
  tunedWins: 95,
  baseWins: 5,
  trainRows: 900,
  gpuCostShare: "$0.39",
  datasetCost: "$0.22",
  judgeCost: "$1.54",
} as const;

export const GLIMMER_RESULT = { tuned: "8.88", base: "1.95", items: 40 } as const;

/** Knowledge run, stage 1: share of 1,500 new-knowledge probes each file answered. Not this flow. */
export const ONE_BIT_RESULT = { q4: "29.9%", iq1s: "8.1%", baseIq1s: "0.8%", iq1sOldFacts: "34/40", iq1sGb: "6.53" } as const;

export const FLOW_STEPS: FlowStep[] = [
  {
    step: "One sentence becomes a plan and training data",
    mark: "harness",
    evidence: `A test harness had a model write a dataset for an invented hobby from a written task: ${TUNE_RESULT.trainRows} rows to train on and ${TUNE_RESULT.items} kept aside, ${TUNE_RESULT.datasetCost}. The one-box page for this is built, behind a flag, and has not started a real run.`,
  },
  {
    step: "A tuned model, on a rented GPU",
    mark: "harness",
    evidence: `The same harness trained a small Llama (Llama 3.2 3B) in about 18 minutes, with no public site, so launch and callbacks were stood in for. Separately, the lab's own flow tuned Muse Glimmer 30B on a rented A100 in 42 minutes for $1.39.`,
  },
  {
    step: "A blind check on prompts it never saw",
    mark: "harness",
    evidence: `Muse Wonder judged all ${TUNE_RESULT.items} kept-aside prompts blind. Tuned averaged ${TUNE_RESULT.tuned} and base ${TUNE_RESULT.base}, and tuned won ${TUNE_RESULT.tunedWins} to ${TUNE_RESULT.baseWins}. The topic is invented, so the base model starts knowing nothing, which makes this an easy test. The small Llama is not Muse Glimmer. The Glimmer run above won all ${GLIMMER_RESULT.items} prompts, ${GLIMMER_RESULT.tuned} to ${GLIMMER_RESULT.base}, with an older judge.`,
  },
  {
    step: "A file small enough for a device",
    mark: "harness",
    evidence: `A test harness ran the real quantize recipe on a rented GPU with made-up data, not launched through the site: a tuned small Llama became a 2.02 GB file and passed every check. The same recipe then took a Muse Glimmer 30B tune of 120 steps, on the same made-up topic, to a 6.53 GB one-bit file that gave final answers to 30 of 30 kept-aside prompts under its tuned chat template, with some muddled steps. Its 16.94 GB Q4_K_M answered 40 of 40 but measured KL 0.0305, just over its 0.03 limit, so that build was left out. Separately, by hand, a tuned Glimmer at one-bit size (IQ1_S, ${ONE_BIT_RESULT.iq1sGb} GB) answered ${ONE_BIT_RESULT.iq1s} of new-knowledge test questions, against ${ONE_BIT_RESULT.q4} at Q4_K_M and ${ONE_BIT_RESULT.baseIq1s} for base Glimmer at IQ1_S. So one-bit size costs a lot of quality.`,
  },
  {
    step: "On your own hardware",
    mark: "simulated",
    evidence: "Against a simulated board only. Jetson boards exist, but this flow has not run on one, and neither has the phone emulator run. Export to a USB drive from a board is built behind a flag and has only run against fakes.",
  },
  {
    step: "An app built for it",
    mark: "proven",
    evidence: "Real test builds wrote and ran apps on a test model with made-up data, on a local site, so they have no live link. That proves the app, not the link to a tuned model.",
  },
  {
    step: "That app answering with its tuned model",
    mark: "not-run",
    evidence: "The build room's Its own model row plans a tune for a product, behind a flag. Until a model passes and is being served, the product keeps answering with Muse Wonder. No product has answered from its own tuned model.",
  },
  {
    step: "Checks that show what was proven",
    mark: "proven",
    evidence: "Those builds went through typecheck, build, a smoke test Muse Code wrote and a judge reading screenshots against the brief. One failed a first round on raw citation ids and was fixed. A gadget build used a simulated board, and is labeled that way.",
  },
];

export const OFFLINE_BASE_FACTS: string[] = [
  "Base Drive: an offline AI kit on a flash drive, for Apple Silicon Macs and Windows PCs. The apps, runtime and model files are already on the drive, and setup is designed to work with Wi-Fi and Ethernet off. Its README says the Windows edition has not yet run on a physical PC.",
  "Drives are checked one by one: the production log records BASE-0001 to BASE-0008 each matching its file list.",
  "A fleet of Jetson Orin Nano boards, run from one console: live health and logs, jobs across boards, and one API in front of the boards' models, with keys, rate limits and usage metering.",
  "On a board, the model server stays on the board itself, and the fleet agent dials out, so neither one listens on the local network.",
];

export const OFFLINE_LIMITS: string[] = [
  "The fleet has real boards, but this flow has not run on them. Everything here about a board is simulated.",
  "The fleet and Base Drive run their own model setups today, such as Liquid AI's models on the boards. Running Meta's models from this flow on them is the plan, not a result.",
  "One-bit Muse Glimmer has not been shown to fit or run on an 8 GB Jetson. The file is about 6.5 GB. On an x86 CPU under 8 GB and 7 GB limits, a file from a short test tune on made-up data loaded, at about 2.5 tokens a second. Under its tuned chat template it answered its own made-up topic in the trained shape with some muddled steps, and general questions stayed poor, 2 of 5 clearly right. That x86 test is not a Jetson.",
  "Muse Muse's USB export is its own kit, not a Base Drive, and it has not been written from a board.",
  "A cloud step means your sentence, your data and your training run go through Muse Muse and a rented GPU. Offline starts after the file is on your device.",
];
