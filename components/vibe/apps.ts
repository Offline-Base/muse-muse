import { ggufModelfile, ggufOllamaName, ggufStops } from "@/lib/train/hub-cards";
import type { LocalFile, LocalFiles, QuantLevel } from "@/lib/train/local-files";
import { quantBaseOfFileName } from "@/lib/train/quant-targets";
import type { DiagnosticsOs } from "@/lib/vibe/troubleshoot";

/**
 * The apps the run-locally page walks people through (docs/VIBE_TUNING.md, Feature 5, "Per app"): their official
 * links, and the deep links and commands built from the GGUF repo and file names that localFilesFor gives. Pure, like
 * components/train/format.ts, so the page and its tests build them the same way.
 *
 * Nothing here downloads a model inside the browser or offers a launcher: the deep links hand the repo and file to an
 * app the person installed, and the commands are for them to run. A repo or file name that isn't one the Hub allows
 * gets no link or command at all, so nothing else can reach a URL or a shell.
 */

/** What the browser gets of a model's local files: the repo, its builds and how to prompt it, never the job ids. */
export type PageFiles = Pick<LocalFiles, "repo" | "commit" | "public" | "files" | "systemLine" | "needsTunedTemplate" | "slug">;

/** Only the fields the run-locally page uses, so nothing else of localFilesFor's answer is sent to the browser. */
export function toPageFiles(f: LocalFiles): PageFiles {
  return {
    repo: f.repo,
    commit: f.commit,
    public: f.public,
    files: f.files.map((x) => ({ level: x.level, name: x.name, bytes: x.bytes, sha256: x.sha256 })),
    systemLine: f.systemLine,
    needsTunedTemplate: f.needsTunedTemplate,
    slug: f.slug,
  };
}

/** The public Hub, as the cards link it (HUB_SITE in lib/train/hub-cards.ts). */
export const HUB = "https://huggingface.co";

/** "<namespace>/<repo>" by the Hub's rules: letters, digits, ".", "_" and "-", not starting or ending with "." or "-". */
export function isRepoId(repo: string | null | undefined): repo is string {
  const part = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,94}[A-Za-z0-9])?$/;
  const [ns, name, extra] = String(repo ?? "").split("/");
  return extra === undefined && part.test(ns ?? "") && part.test(name ?? "") && !/\.\.|--/.test(`${ns}/${name}`);
}

/** A GGUF file name as the quantize job writes it: "muse-glimmer-30b-<slug>-<LEVEL>.gguf". */
export function isGgufName(name: string | null | undefined): name is string {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,90}\.gguf$/.test(String(name ?? ""));
}

/** A commit is a 40-character hex sha; anything else reads from main. */
function revision(commit: string | null): string {
  return commit && /^[0-9a-f]{40}$/.test(commit) ? commit : "main";
}

export function hubRepoUrl(repo: string): string {
  return `${HUB}/${repo}`;
}

/** A file's page on the Hub, where it can be read (tuned.jinja) or downloaded by the Hub's own button. */
export function hubFileUrl(repo: string, commit: string | null, name: string): string {
  return `${HUB}/${repo}/blob/${revision(commit)}/${name}`;
}

/** A file's bytes at the commit, for the commands only: the page never links a GGUF file to download in the browser. */
export function hubResolveUrl(repo: string, commit: string | null, name: string): string {
  return `${HUB}/${repo}/resolve/${revision(commit)}/${name}`;
}

/** LM Studio opens the repo at this file and offers to download it. */
export function lmStudioLink(repo: string, file: string): string | null {
  return isRepoId(repo) && isGgufName(file) ? `lmstudio://open_from_hf?model=${repo}&file=${file}` : null;
}

/** The Llama app (Mac) installs the repo's build with this quant label. */
export function llamaAppLink(repo: string, level: QuantLevel): string | null {
  return isRepoId(repo) ? `llama://install?repo=${repo}&quant=${level}` : null;
}

/** Jan opens the repo in its hub. */
export function janLink(repo: string): string | null {
  return isRepoId(repo) ? `jan://models/huggingface/${repo}` : null;
}

/** Where each app is installed from: its official page, and the command where there is one. */
export const INSTALL = {
  lmstudio: { url: "https://lmstudio.ai/download" },
  "llama-app": { url: "https://github.com/ggml-org/Llama-macOS/releases", command: "brew install --cask llama-app" },
  llamacpp: {
    url: "https://github.com/ggml-org/llama.cpp/releases",
    command: { mac: "brew install llama.cpp", windows: "winget install llama.cpp", linux: "brew install llama.cpp" },
  },
  ollama: { url: "https://ollama.com/download", command: { linux: "curl -fsSL https://ollama.com/install.sh | sh" } },
  jan: { url: "https://jan.ai/download" },
} as const;

/** What each app needs, as its makers say, for the install step. */
export const REQUIREMENTS: Record<"lmstudio" | "jan", Partial<Record<DiagnosticsOs, string>>> = {
  lmstudio: {
    mac: "LM Studio needs macOS 14 or later on Apple silicon.",
    windows: "LM Studio runs on Windows on x64 with AVX2, or on ARM.",
    linux: "LM Studio comes as an AppImage for x64 or ARM64, on Ubuntu 20.04 or later.",
  },
  jan: { mac: "Jan needs Apple silicon and macOS 13.6 or later to run models itself." },
};

/** `lms get` downloads a repo's build into LM Studio from a terminal, when the deep link doesn't open. */
export function lmsGetCommand(repo: string, level: QuantLevel): string | null {
  return isRepoId(repo) ? `lms get ${hubRepoUrl(repo)}@${level}` : null;
}

/** curl comes with macOS, Linux and Windows 10 and later; on Windows it is curl.exe, since PowerShell's curl is another command. */
function curl(os: DiagnosticsOs): string {
  return os === "windows" ? "curl.exe" : "curl";
}

/** Downloads one file from the repo at its commit into the current folder. */
export function downloadCommand(os: DiagnosticsOs, files: Pick<LocalFiles, "repo" | "commit">, name: string): string | null {
  if (!isRepoId(files.repo) || !(isGgufName(name) || name === "tuned.jinja")) return null;
  return `${curl(os)} -L -o ${name} ${hubResolveUrl(files.repo, files.commit, name)}`;
}

/**
 * Prints a downloaded file's sha256, to check against the one the page shows. PowerShell prints it in capitals, so the
 * Windows command lowercases it to read the same.
 */
export function checksumCommand(os: DiagnosticsOs, name: string): string | null {
  if (!isGgufName(name)) return null;
  if (os === "windows") return `(Get-FileHash ${name} -Algorithm SHA256).Hash.ToLower()`;
  return os === "mac" ? `shasum -a 256 ${name}` : `sha256sum ${name}`;
}

/** The llama.cpp web UI and API that `llama serve` and the Llama app start. */
export const LLAMA_SERVE_URL = "http://127.0.0.1:9931";
export const LLAMA_APP_URL = "http://localhost:9931";

/**
 * `llama serve` for one build: from the Hub by repo and quant label, with no vision projector (v1 is text only), an 8K
 * context in one slot (-np 1, so a chat gets all of it), and for an adapter trained before trainChannel its tuned.jinja
 * with Glimmer's parsing and reasoning off, as docs/VIBE_TUNING.md "Making it behave like the eval" has it. The
 * template is downloaded first, into the folder the command runs in.
 */
export function llamaServeCommands(os: DiagnosticsOs, files: Pick<LocalFiles, "repo" | "commit" | "needsTunedTemplate">, level: QuantLevel): string[] | null {
  if (!isRepoId(files.repo)) return null;
  const serve = `llama serve -hf ${files.repo}:${level} --no-mmproj -c 8192 -np 1`;
  if (!files.needsTunedTemplate) return [serve];
  return [downloadCommand(os, files, "tuned.jinja")!, `${serve} --chat-template-file tuned.jinja --skip-chat-parsing --reasoning off`];
}

/** The stops a request to llama serve needs for an adapter that uses tuned.jinja. */
export const TUNED_STOPS = '"stop": ["<|eom|>", "<|start|>"]';

/** Ollama's name for the model: the repo's slug, as the GGUF card names it too (ggufOllamaName). */
export function ollamaName(slug: string): string {
  return ggufOllamaName(slug);
}

/**
 * The Modelfile for the build being set up, the GGUF card's own (ggufModelfile in lib/train/hub-cards.ts): Ollama's
 * Glimmer renderer and parser for a model trained with trainChannel, or for one trained before it the TEMPLATE that
 * opens the final channel and its stops; the system message exactly, temperature 0 and an 8K context. Its first line is
 * the file this page downloads, whichever build that is. A small base's file (QUANT_TARGETS) gets no Glimmer renderer:
 * Ollama reads the template in the file, with that base's stops. None for a name the Hub wouldn't allow, or a system
 * message that would end Ollama's quotes.
 */
export function modelfile(file: LocalFile, systemLine: string, needsTunedTemplate: boolean): string | null {
  if (!isGgufName(file.name) || systemLine.includes('"""')) return null;
  const small = quantBaseOfFileName(file.name);
  if (small) {
    const stops = ggufStops(1, { quantBase: small.name });
    return [`FROM ./${file.name}`, `SYSTEM """${systemLine}"""`, "PARAMETER temperature 0", "PARAMETER num_ctx 8192", ...stops.map((stop) => `PARAMETER stop ${stop}`)].join("\n");
  }
  return ggufModelfile(file.name, systemLine, needsTunedTemplate ? 0 : 1);
}

/** Writes the Modelfile next to the .gguf on a Mac or Linux, in one paste. Windows users save it from Notepad. */
export function writeModelfileCommand(text: string): string {
  return `cat > Modelfile <<'EOF'\n${text}\nEOF`;
}

/**
 * Makes a folder for the model's files and goes into it. ";" runs the second command in Terminal and in PowerShell
 * alike, where "&&" needs PowerShell 7.
 */
export function folderCommand(slug: string): string {
  const name = ollamaName(slug);
  return `mkdir ${name}; cd ${name}`;
}

export function ollamaCommands(slug: string): { create: string; run: string } {
  const name = ollamaName(slug);
  return { create: `ollama create ${name} -f Modelfile`, run: `ollama run ${name}` };
}

/** The OS the commands are written for: the Mac's for a Mac, Windows', Linux's. */
export function commandOs(kind: string | null): DiagnosticsOs {
  return kind === "windows" ? "windows" : kind === "linux" ? "linux" : "mac";
}
