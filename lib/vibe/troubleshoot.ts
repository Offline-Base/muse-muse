/**
 * The troubleshooting tree for running a model on your own computer (docs/VIBE_TUNING.md, Feature 5, "Troubleshooting
 * tree and the assistant"). v1 is fixed data: it works while Meta's API is down and costs nothing. Each symptom has the
 * words an app or its log prints when it happens, one likely cause and one fix. The run-locally page opens it at the
 * step the person is stuck on, matches pasted text against it in the browser, and "Copy diagnostics" gives read-only
 * commands to run and paste back.
 *
 * No fix ever suggests turning a protection off (Gatekeeper, SmartScreen, Smart App Control, Defender, a firewall), and
 * none asks for a password or a key. The tests check both.
 */
import type { AppId } from "@/lib/vibe/device";

/** The checklist's steps: install the app, get the model, say hello. */
export type StepId = "install" | "get" | "hello";

export interface Symptom {
  id: string;
  /** What the person sees, in a few words. */
  title: string;
  /** Text an app or its log prints when it happens, matched without regard to case. Empty when nothing is printed. */
  match: readonly string[];
  /** The steps it shows up at. */
  steps: readonly StepId[];
  /** The systems it can happen on, when not every one: Rosetta and Intel Macs are a Mac's alone. */
  os?: readonly DiagnosticsOs[];
  /** The likely cause, one sentence. */
  cause: string;
  /** The fix: one step. */
  fix: string;
  /** How the fix goes in a particular app, when it differs. */
  byApp?: Partial<Record<AppId, string>>;
}

/** llama.cpp's first build that runs Muse Glimmer (Aug 10, 2026), and the first Ollama that does. */
export const LLAMACPP_MIN_BUILD = "b10353";
export const OLLAMA_MIN_VERSION = "0.32.8";

export const SYMPTOMS: readonly Symptom[] = [
  {
    id: "no-installer",
    title: "Terminal says brew or winget isn't found",
    match: ["command not found: brew", "brew: command not found", "'winget' is not recognized", "The term 'winget' is not recognized"],
    steps: ["install"],
    cause: "Homebrew (on a Mac or Linux) or the App Installer (on Windows) isn't on this computer.",
    fix: "Use the app's own download page instead. Or install Homebrew from brew.sh, or App Installer from the Microsoft Store, then run the command again.",
  },
  {
    id: "wrong-build",
    title: "An Intel Mac, or a Mac app running under Rosetta",
    match: ["Bad CPU type in executable", "requires Apple silicon", "requires a Mac with Apple silicon", "Rosetta"],
    steps: ["install", "get"],
    os: ["mac"],
    cause: "The app is its Intel build, or the computer is an Intel Mac, which runs this model only on the processor, if at all.",
    fix: "In Terminal, sysctl -n sysctl.proc_translated prints 1 under Rosetta: quit the app and install its Apple silicon version from the official link. On an Intel Mac only Ollama runs it, slowly: use Try it live for long work.",
  },
  {
    id: "link-did-nothing",
    title: "The link didn't open the app",
    match: [],
    steps: ["get"],
    cause: "The app isn't installed yet, or hasn't been opened once since it was installed, so the link has nowhere to go.",
    fix: "Open the app once, then press the link again. Or find the model from inside the app by its Hugging Face name, shown with the link.",
  },
  {
    id: "disk-full",
    title: "The download stopped or failed",
    match: ["No space left on device", "not enough space", "disk is full", "insufficient disk space"],
    steps: ["get"],
    cause: "The disk ran out of room, or the connection dropped partway through.",
    fix: "Free up the file's size plus 5 GB, then start the download again.",
  },
  {
    id: "unknown-architecture",
    title: "\"unknown model architecture: 'muse-glimmer'\"",
    match: ["unknown model architecture: 'muse-glimmer'", "unknown model architecture", "unsupported model architecture"],
    steps: ["get", "hello"],
    cause: `The app's engine is older than llama.cpp ${LLAMACPP_MIN_BUILD}, the first that runs Muse Glimmer.`,
    fix: "Update the engine, then load the model again.",
    byApp: {
      lmstudio: "In LM Studio, update its llama.cpp runtime from the runtime settings.",
      "llama-app": "Update the app: brew upgrade --cask llama-app, or the newest .dmg from its releases page.",
      llamacpp: "Run brew upgrade llama.cpp, or winget upgrade llama.cpp on Windows.",
      ollama: `Install Ollama ${OLLAMA_MIN_VERSION} or later from ollama.com/download.`,
      jan: "Update Jan, then its llama.cpp engine in its settings.",
    },
  },
  {
    id: "out-of-memory",
    title: "It runs out of memory while loading",
    match: ["unable to allocate", "failed to fit params", "insufficient system resources", "out of memory"],
    steps: ["get", "hello"],
    cause: "This build doesn't fit in the memory the computer has free.",
    fix: "Use the next smaller build, keep the context at 8K (8192 tokens), leave out the vision projector, and close other apps.",
    byApp: {
      llamacpp: "Start it with -c 8192 --no-mmproj, and a smaller build after the colon.",
      ollama: "Keep PARAMETER num_ctx 8192 in the Modelfile, and point FROM at a smaller build.",
    },
  },
  {
    id: "cold-load",
    title: "The first load takes minutes",
    match: [],
    steps: ["get", "hello"],
    cause: "Right after a big download the disk is cold, so the first load reads all of the file slowly.",
    fix: "Wait. Allow up to 10 minutes the first time; later loads are much faster.",
  },
  {
    id: "port-in-use",
    title: "Two apps fight over a port",
    match: ["address already in use", "Only one usage of each socket address", "couldn't bind", "failed to bind"],
    steps: ["get", "hello"],
    cause: "A second engine is already running, such as Ollama next to llama.cpp or the Llama app.",
    fix: "Quit one of them, then start the other again. ollama ps shows what Ollama has loaded.",
  },
  {
    id: "raw-tokens",
    title: "to=self<|message|> or <|start|> shows up in the answer",
    match: ["to=self<|message|>", "<|start|>", "<|message|>", "<|eom|>"],
    steps: ["hello"],
    cause: "The app's engine doesn't know the Muse Glimmer format, or the model's prompt template was replaced.",
    fix: "Update the engine. Then check the template is the one the model came with, or tuned.jinja when this page says the model needs it.",
  },
  {
    id: "empty-answer",
    title: "An empty answer, or thinking that never ends",
    match: ['"content":""', '"content": ""', "Reasoning strength: high"],
    steps: ["hello"],
    cause:
      "Reasoning is set to high, the answer's token limit is too small, or the model needs tuned.jinja and doesn't have it.",
    fix: 'Keep "Reasoning strength: low." in the system message, raise max_tokens to 1,024 or more, and use tuned.jinja when this page says the model needs it.',
    byApp: {
      llamacpp: "Start llama serve with -np 1, so the whole 8K context goes to one chat.",
      lmstudio: "Set Reasoning Strength to low as well, in the chat's settings.",
    },
  },
  {
    id: "slow",
    title: "Very slow",
    match: ["CPU/GPU", "100% CPU"],
    steps: ["hello"],
    cause: "Part of the model runs on the processor, or the graphics driver is old.",
    fix: "ollama ps shows 100% GPU, or a split between the processor and the GPU: use a smaller build when it's split. On Windows, update the NVIDIA driver to 551.61 or later.",
  },
  {
    id: "stops-halfway",
    title: "It answers, then stops halfway",
    match: ["truncating input prompt", "context length exceeded"],
    steps: ["hello"],
    cause: "Ollama keeps only 4,096 tokens of context unless the Modelfile says otherwise.",
    fix: "Keep PARAMETER num_ctx 8192 in the Modelfile, then run ollama create again.",
  },
  {
    id: "different-style",
    title: "The answer doesn't read like the tuned one",
    match: [],
    steps: ["hello"],
    cause: "The system message wasn't pasted exactly, or the temperature isn't 0.",
    fix: "Paste the system message exactly as shown, set the temperature to 0, and start a new chat. The answer won't match word for word, but it should read the same way.",
  },
];

/** The symptoms that can show up at a step on a system (any system when none is given), in the tree's order. */
export function symptomsAt(step: StepId, os?: DiagnosticsOs): Symptom[] {
  return SYMPTOMS.filter((s) => s.steps.includes(step) && (!os || !s.os || s.os.includes(os)));
}

/** Pasted text is matched up to this long, so a whole log can't slow the page down. */
export const PASTE_MAX = 20_000;

/** The symptoms whose words appear in pasted text (an error, a log tail, an answer), in the tree's order. Local only. */
export function findSymptoms(text: string): Symptom[] {
  const t = String(text ?? "").slice(0, PASTE_MAX).toLowerCase();
  if (!t.trim()) return [];
  return SYMPTOMS.filter((s) => s.match.some((m) => t.includes(m.toLowerCase())));
}

/** The fix as one app should do it: its own line when it has one, else the general fix. */
export function fixFor(symptom: Symptom, app: AppId | null): string {
  return (app && symptom.byApp?.[app]) || symptom.fix;
}

export type DiagnosticsOs = "mac" | "windows" | "linux";

/**
 * "Copy diagnostics": read-only commands that print the OS, the chip, the memory, the free disk and the GPU, plus the
 * engine's version and the end of Ollama's log when Ollama is the app. The first line echoes the build, the app and
 * the step, from fixed words only, so nothing a person or a model wrote ever lands in a shell. The Mac set was tested
 * on a Mac [V]; the Windows and Linux sets are still to try on a real PC [I].
 */
export function diagnostics(input: {
  os: DiagnosticsOs;
  app: AppId | null;
  level: string | null;
  step: StepId;
  nvidia: boolean;
}): { commands: string; tested: boolean } {
  const level = input.level && /^[A-Z0-9_]+$/.test(input.level) ? input.level : "no build";
  const head = `echo 'Muse Muse run locally: ${level}, ${input.app ?? "no app"}, step ${input.step}'`;
  const lines = [head];
  if (input.os === "mac") {
    lines.push("sw_vers -productVersion; uname -m; sysctl -n machdep.cpu.brand_string hw.memsize hw.optional.arm64 sysctl.proc_translated; df -h ~");
  } else if (input.os === "windows") {
    lines.push(
      "$env:PROCESSOR_ARCHITECTURE",
      "[math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB)",
      "Get-CimInstance Win32_VideoController | Select-Object Name, DriverVersion",
      "Get-PSDrive C",
    );
  } else {
    lines.push("uname -m; grep MemTotal /proc/meminfo; lscpu | grep 'Model name'; df -h ~");
  }
  if (input.nvidia && input.os !== "mac") lines.push("nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv");
  if (input.app === "llamacpp") lines.push("llama --version");
  if (input.app === "ollama") {
    lines.push("ollama --version", "ollama ps");
    if (input.os === "mac") lines.push("tail -n 40 ~/.ollama/logs/server.log");
    else if (input.os === "windows") lines.push('Get-Content "$env:LOCALAPPDATA\\Ollama\\server.log" -Tail 40');
    else lines.push("journalctl -u ollama --no-pager -n 40");
  }
  return { commands: lines.join("\n"), tested: input.os === "mac" };
}
