import { commandLine } from "@/components/docs/playgrounds/muse-code/shell";

/**
 * A headless Muse Code run for CI, as the auth and extending pages describe it (content/meta-docs/pages/muse-code/
 * auth.md "Authenticate in CI", extending.md "Headless and CI", subscriptions.md "Turn Contributor mode on or off"):
 * META_API_KEY from the CI secret store, `muse exec` with an approval posture chosen in advance, a step cap, the
 * Contributor mode pinned per run, and the reader's own check as the gate, since the exit code says how the run
 * ended, not whether the work is right. Pure, so the builders and tests agree.
 */

export type CiPlatform = "github" | "gitlab" | "shell";
/** How held approvals resolve with nobody at the keyboard. */
export type Posture = "disable-approval" | "yolo" | "none";
export type ContributorPin = "saved" | "off" | "on";
export type Trigger = "manual" | "pull_request";

export const CI_PLATFORMS: ReadonlyArray<{ value: CiPlatform; label: string }> = [
  { value: "github", label: "GitHub Actions" },
  { value: "gitlab", label: "GitLab CI" },
  { value: "shell", label: "Shell script" },
];

export const POSTURES: ReadonlyArray<{ value: Posture; label: string }> = [
  { value: "disable-approval", label: "--disable-approval (keep the sandbox)" },
  { value: "yolo", label: "--yolo (no approval, no sandbox)" },
  { value: "none", label: "Neither (held actions stay unresolved)" },
];

export interface CiInput {
  platform: CiPlatform;
  /** The CI secret's name, such as MUSE_KEY. Never the key itself. */
  secret: string;
  prompt: string;
  /** Read the prompt from this file instead (--prompt-file). Empty to pass it inline. */
  promptFile?: string;
  posture: Posture;
  /** --max-model-steps; null leaves it out. */
  maxSteps: number | null;
  /** --json: JSONL events on stdout. */
  json: boolean;
  contributor: ContributorPin;
  /** The reader's own check after the run, such as "npm test". Empty for none. */
  verify: string;
  trigger?: Trigger;
}

export interface CiOutput {
  code: string;
  label: string;
  syntax: "yaml" | "bash";
  warnings: string[];
}

/** A secret name a CI system accepts: letters, digits and underscores, not starting with a digit. */
export function cleanSecretName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9_]/g, "").replace(/^[0-9]+/, "");
  return cleaned || "MUSE_KEY";
}

/** The `muse exec` line itself, flags in the order the pages list them. */
export function execCommand(input: Pick<CiInput, "prompt" | "promptFile" | "posture" | "maxSteps" | "json" | "contributor">): string {
  const flags: string[] = [];
  if (input.posture === "disable-approval") flags.push("--disable-approval");
  if (input.posture === "yolo") flags.push("--yolo");
  if (input.maxSteps !== null && input.maxSteps > 0) flags.push("--max-model-steps", String(Math.floor(input.maxSteps)));
  if (input.contributor !== "saved") flags.push("--contributor-mode", input.contributor);
  if (input.json) flags.push("--json");
  const file = input.promptFile?.trim();
  if (file) return commandLine(["muse", "exec", ...flags, "--prompt-file", file]);
  return commandLine(["muse", "exec", ...flags, input.prompt.trim() || "Run the test suite and summarize failures."]);
}

function warningsFor(input: CiInput): string[] {
  const out: string[] = [];
  if (input.posture === "none") {
    out.push("A headless run has no one to answer an approval prompt: an action that holds for review stays unresolved. Pick --disable-approval or, in a disposable container, --yolo.");
  }
  if (input.posture === "yolo") {
    out.push("--yolo also trusts the workspace, so it loads the checkout's AGENTS.md, rules and skills. Use it only on trusted code in a disposable, isolated container.");
    if (input.trigger === "pull_request") {
      out.push("On a pull-request or fork checkout those files are attacker-controlled instructions. Don't combine --yolo with pull_request runs.");
    }
  }
  if (input.posture !== "yolo" && input.platform !== "shell") {
    out.push("The sandbox has to run on the runner: Linux needs a working bubblewrap and a non-musl build, or every sandboxed shell command aborts as an environment failure.");
  }
  if (input.maxSteps === null) out.push("Cap the run with --max-model-steps so a stuck task can't loop indefinitely.");
  if (!input.verify.trim()) out.push("Exit 0 means the turn completed, not that the work is correct. Gate on your own test command too.");
  return out;
}

function indent(lines: string[], by: string): string {
  return lines.map((l) => (l ? `${by}${l}` : l)).join("\n");
}

/** The CI file or script for the reader's platform, with what to watch for. */
export function ciConfig(input: CiInput): CiOutput {
  const secret = cleanSecretName(input.secret);
  const exec = execCommand(input);
  const verify = input.verify.trim();
  const warnings = warningsFor(input);

  if (input.platform === "github") {
    const on = input.trigger === "pull_request" ? ["on:", "  pull_request:"] : ["on:", "  workflow_dispatch:"];
    const run = ["curl -fsSL https://dev.meta.ai/install.sh | sh", "muse --version", exec];
    const lines = [
      "name: Muse Code",
      ...on,
      "jobs:",
      "  muse:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - uses: actions/checkout@v4",
      "      - name: Run Muse Code",
      "        env:",
      `          META_API_KEY: \${{ secrets.${secret} }}`,
      "        run: |",
      indent(run, "          "),
      ...(verify ? ["      - name: Check the result yourself", `        run: ${verify}`] : []),
    ];
    return { code: lines.join("\n"), label: ".github/workflows/muse-code.yml", syntax: "yaml", warnings };
  }

  if (input.platform === "gitlab") {
    const lines = [
      "muse-code:",
      "  image: ubuntu:24.04",
      "  variables:",
      `    META_API_KEY: $${secret}`,
      "  before_script:",
      "    - apt-get update && apt-get install -y curl git",
      "    - curl -fsSL https://dev.meta.ai/install.sh | sh",
      "    - muse --version",
      "  script:",
      `    - ${exec}`,
      ...(verify ? [`    - ${verify}`] : []),
      ...(input.trigger === "pull_request" ? ["  rules:", '    - if: $CI_PIPELINE_SOURCE == "merge_request_event"'] : ["  when: manual"]),
    ];
    return { code: lines.join("\n"), label: ".gitlab-ci.yml", syntax: "yaml", warnings };
  }

  const lines = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    `# META_API_KEY comes from your secret store (here $${secret}). Never commit it.`,
    `META_API_KEY="$${secret}" ${exec}`,
    ...(verify ? ["# The exit code says how the run ended, not whether the work is right:", verify] : []),
  ];
  return { code: lines.join("\n"), label: "run-muse.sh", syntax: "bash", warnings };
}

/** What `muse exec` exit codes mean (extending.md "Headless and CI"). */
export const EXIT_CODES: ReadonlyArray<{ code: string; meaning: string }> = [
  { code: "0", meaning: "The turn completed. The agent can still report failing tests, so check the work yourself." },
  { code: "1", meaning: "The run failed or was cancelled, including hitting the --max-model-steps limit." },
  { code: "2", meaning: "A usage error: a bad flag or argument." },
  { code: "130", meaning: "Stopped by SIGINT (Ctrl+C)." },
  { code: "143", meaning: "Stopped by SIGTERM, such as a CI job timeout." },
];
