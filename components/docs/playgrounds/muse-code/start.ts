import { commandLine, quoteArg, type Shell } from "@/components/docs/playgrounds/muse-code/shell";

/**
 * The Muse Code overview's facts as data (content/meta-docs/pages/muse-code.md): the installer per OS, the first
 * run, the two ways the binary runs, the program-facing protocol, and what works differently by platform (with the
 * platform notes from the permissions, interactive, workflows and session-messaging pages). The walkthrough and the
 * command builder render these; tests check them against the page.
 */

export type Os = "macos-arm" | "macos-intel" | "linux" | "windows";

export const OS_OPTIONS: ReadonlyArray<{ value: Os; label: string }> = [
  { value: "macos-arm", label: "macOS (Apple silicon)" },
  { value: "macos-intel", label: "macOS (Intel)" },
  { value: "linux", label: "Linux" },
  { value: "windows", label: "Windows" },
];

export function shellOf(os: Os): Shell {
  return os === "windows" ? "powershell" : "posix";
}

export interface Step {
  title: string;
  code: string;
  /** The code block's header. */
  label: string;
  syntax: "bash" | "powershell" | "text";
  notes: string[];
}

export const INSTALL_POSIX = "curl -fsSL https://dev.meta.ai/install.sh | sh";
export const INSTALL_WINDOWS = "irm https://dev.meta.ai/install.ps1 | iex";

/** Install, confirm, first run, and the sign-in for machines without a browser, in the reader's shell. */
export function installSteps(os: Os): Step[] {
  const win = os === "windows";
  const syntax = win ? "powershell" : "bash";
  const label = win ? "PowerShell" : "bash";
  return [
    {
      title: "Install the muse binary",
      code: win ? INSTALL_WINDOWS : INSTALL_POSIX,
      label,
      syntax,
      notes: ["The one-line installer puts a native muse binary on your path."],
    },
    {
      title: "Confirm it's on your path",
      code: "muse --version",
      label,
      syntax,
      notes: [],
    },
    {
      title: "Start a session in your project",
      code: win ? "cd C:\\path\\to\\your\\project\nmuse" : "cd /path/to/your/project\nmuse",
      label,
      syntax,
      notes: [
        "First entry asks whether to trust the workspace, which loads its skills, rules, and hooks.",
        "Then it asks you to sign in with your browser or paste an API key. Reopen those options later with /login.",
        "The default model is muse-spark-1.2.",
      ],
    },
    {
      title: "For CI and other machines without a browser",
      code: win ? '$env:META_API_KEY = "<your-key>"\nmuse exec "Run the test suite and summarize failures."' : 'export META_API_KEY="<your-key>"\nmuse exec "Run the test suite and summarize failures."',
      label,
      syntax,
      notes: ["Set META_API_KEY instead of signing in. In a pipeline, read it from your CI secret store."],
    },
  ];
}

export interface Availability {
  feature: string;
  values: Record<Os, string>;
  /** Where the fact comes from, as a docs path with an anchor. */
  source: string;
}

const PER_OS = (macos: string, linux: string, windows: string, arm?: string): Record<Os, string> => ({
  "macos-arm": arm ?? macos,
  "macos-intel": macos,
  linux,
  windows,
});

export const AVAILABILITY: readonly Availability[] = [
  {
    feature: "Shell for agent commands",
    values: PER_OS("Bash", "Bash", "PowerShell, with Windows command-line tools"),
    source: "/docs/muse-code#platforms",
  },
  {
    feature: "Sandbox",
    values: PER_OS(
      "Seatbelt, verified once at session startup",
      "The bundled bubblewrap helper. A musl build ships without it, and every shell command then fails",
      "A Windows sandbox that may show a UAC prompt the first time it starts. No need to run as administrator",
    ),
    source: "/docs/muse-code/permissions#sandbox",
  },
  {
    feature: "Voice input (Alt+V)",
    values: PER_OS("On by default", "Off by default", "Unavailable"),
    source: "/docs/muse-code/interactive#voice",
  },
  {
    feature: "Session messaging",
    values: PER_OS("Available", "Available", "Unavailable"),
    source: "/docs/muse-code/session-messaging#scope",
  },
  {
    feature: "Workflows",
    values: PER_OS(
      "Only on builds with the workflow engine, when the rollout reaches you",
      "Only on builds with the workflow engine, when the rollout reaches you",
      "Only on builds with the workflow engine, when the rollout reaches you",
      "Not in the current public aarch64-apple-darwin package",
    ),
    source: "/docs/muse-code/workflows",
  },
];

export type Task = "session" | "headless" | "ci" | "login" | "sdk" | "version";

export const TASKS: ReadonlyArray<{ value: Task; label: string }> = [
  { value: "session", label: "Start a session" },
  { value: "headless", label: "Run one prompt" },
  { value: "ci", label: "Run it in CI" },
  { value: "login", label: "Sign in again" },
  { value: "sdk", label: "Drive it from code" },
  { value: "version", label: "Check the install" },
];

/** Models a reader would pass to --model here. muse-spark-1.2 is Muse Code's default. */
export const MUSE_MODELS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "", label: "Default (muse-spark-1.2)" },
  { value: "muse-spark-1.2", label: "muse-spark-1.2" },
  { value: "muse-wonder-1.0", label: "muse-wonder-1.0" },
];

export interface TaskInput {
  os: Os;
  prompt: string;
  /** "" for the default model. */
  model: string;
  /** The CI secret that holds the key, for the CI task. */
  secret: string;
}

export interface TaskOutput {
  code: string;
  label: string;
  syntax: "bash" | "powershell" | "text";
  notes: string[];
}

/** The command for what the reader wants to do, in their shell, with the page's notes for it. */
export function taskCommand(task: Task, input: TaskInput): TaskOutput {
  const shell = shellOf(input.os);
  const label = shell === "powershell" ? "PowerShell" : "bash";
  const syntax = shell === "powershell" ? "powershell" : "bash";
  const model = input.model ? ["--model", input.model] : [];
  const prompt = input.prompt.trim() || "Run the test suite and summarize failures.";
  switch (task) {
    case "session":
      return {
        code: [shell === "powershell" ? "cd C:\\path\\to\\your\\project" : "cd /path/to/your/project", commandLine(["muse", ...model], shell)].join("\n"),
        label,
        syntax,
        notes: ["Interactive: a terminal UI with slash commands, approvals and live status.", "Approvals and the OS sandbox are on from the first run."],
      };
    case "headless":
      return {
        code: commandLine(["muse", "exec", ...model, prompt], shell),
        label,
        syntax,
        notes: ["Headless: runs one prompt to completion and exits, for scripts and CI.", "No one is there to answer an approval prompt, so pick an approval posture for unattended runs (see Extending and automating)."],
      };
    case "ci": {
      const secret = input.secret.trim() || "MUSE_KEY";
      const code =
        shell === "powershell"
          ? `$env:META_API_KEY = $env:${secret}\n${commandLine(["muse", "exec", ...model, prompt], shell)}`
          : `META_API_KEY="$${secret}" ${commandLine(["muse", "exec", ...model, prompt], shell)}`;
      return {
        code,
        label,
        syntax,
        notes: [`A pipeline has no browser: META_API_KEY comes from your CI secret store (here ${secret}).`, "An API key always takes priority over a browser sign-in."],
      };
    }
    case "login":
      // The auth page gives two separate ways to use a key without the browser: export it, or store one with
      // muse auth set. They're alternatives, not steps: an exported META_API_KEY already outranks a stored key.
      return {
        code: [
          "/login",
          "",
          "# Without the browser flow, either set the key in your shell:",
          shell === "powershell" ? '$env:META_API_KEY = "<your-key>"' : 'export META_API_KEY="<your-key>"',
          "",
          "# or store a key instead:",
          "muse auth set",
        ].join("\n"),
        label: "In a session, then your shell",
        syntax: "text",
        notes: [
          "/login reopens the browser sign-in and API key options from an interactive session.",
          "Muse Code uses META_API_KEY if it's set, then a key stored with muse auth set, then a browser session.",
        ],
      };
    case "sdk":
      return {
        code: ["muse serve      # runs the stable, versioned session protocol", "muse schema     # prints the protocol's JSON schema", "npm install @muse-code/sdk"].join("\n"),
        label,
        syntax: "bash",
        notes: ["The TypeScript SDK wraps the protocol. Its quickstart and API reference: meta-models.github.io/muse-code-sdk."],
      };
    case "version":
      return { code: "muse --version", label, syntax, notes: ["Prints the installed version. Compare it with the changelog to see what's new."] };
  }
}

/** The headless command for a prompt, quoted for the reader's shell (the live tab shows it beside the API call). */
export function execLine(prompt: string, os: Os, model = ""): string {
  return `muse exec ${model ? `--model ${model} ` : ""}${quoteArg(prompt.trim() || "Run the test suite and summarize failures.", shellOf(os))}`;
}
