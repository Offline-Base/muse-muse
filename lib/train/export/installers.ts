/**
 * One-click installers for a tuned model (EXPORT_TUNED, docs/TRAINING.md "Export a tuned model"). Pure: from the device
 * target (lib/train/quant-targets.ts) and the checked local files, a small script for one OS that downloads the GGUF at its
 * pinned commit, checks its sha256, gets llama.cpp at a pinned build with a pinned sha256, and runs the model. Each also has
 * an Ollama path. Everything that reaches a script is checked or quoted here, so a model's title can't reach a shell.
 */
import { LLAMA_RUN_CONTEXT, LLAMA_TAG, LLAMA_BUILDS, LLAMA_SOURCE, type InstallerOs } from "@/lib/train/export/llama-pins";
import { deviceModelTarget, fileForDevice } from "@/lib/train/quant-targets";
import { ggufModelfile, ggufOllamaName, ggufStops } from "@/lib/train/hub-cards";
import { TUNED_TEMPLATE } from "@/lib/train/tuned-template";
import type { LocalFiles } from "@/lib/train/local-files";

export type ExportKind = "mac" | "windows" | "linux" | "jetson_orin_nano";
/** `proof` says how far each script has really run. Change it only after a real run on that device. */
export const EXPORT_KINDS: ReadonlyArray<{ kind: ExportKind; label: string; os: InstallerOs; proof: string }> = [
  { kind: "mac", label: "Mac", os: "mac", proof: "This script has run on a Mac with a tiny test model, not yet with a tuned one." },
  { kind: "windows", label: "Windows", os: "windows", proof: "This script hasn't been run on a Windows PC yet, so it may fail." },
  { kind: "linux", label: "Linux", os: "linux", proof: "This script has only been tested in a simulated setup, not yet on a real Linux PC." },
  { kind: "jetson_orin_nano", label: "Jetson Orin Nano", os: "jetson", proof: "This script has only been tested on a simulated board, not yet on a real Jetson." },
];

export interface ExportNotice {
  line: string | null;
  license: string;
  points: readonly string[];
}

export interface ExportPlan {
  kind: ExportKind;
  os: InstallerOs;
  title: string;
  slug: string;
  repo: string;
  commit: string;
  file: { name: string; bytes: number; sha256: string; level: string };
  modelLabel: string;
  fit: string;
  proof: string;
  provenOnDevice: false;
  systemLine: string;
  /** Glimmer's template for an adapter trained before trainChannel. Null otherwise. */
  template: string | null;
  stops: string[];
  /** Null when the system message would break a Modelfile's quotes. */
  modelfile: string | null;
  ollamaName: string;
  notice: ExportNotice;
}

const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}\/[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const COMMIT_RE = /^[0-9a-f]{40}$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,180}\.gguf$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,80}$/;

export const isExportKind = (k: string | null | undefined): k is ExportKind => EXPORT_KINDS.some((e) => e.kind === k);

/** A small base's Modelfile. Ollama reads Llama's own template from the file. */
function smallModelfile(name: string, systemLine: string, stops: string[]): string {
  return [`FROM ./${name}`, `SYSTEM """${systemLine}"""`, "PARAMETER temperature 0", "PARAMETER num_ctx 8192", ...stops.map((s) => `PARAMETER stop ${s}`)].join("\n");
}

/** The plan for one device kind, or the reason there is none. */
export function exportPlan(kind: ExportKind, files: LocalFiles | null, notice: ExportNotice): { ok: true; plan: ExportPlan } | { ok: false; problem: string } {
  const target = deviceModelTarget(kind);
  const none = (problem: string) => ({ ok: false as const, problem });
  if (!files) return none("This version has no published files yet.");
  if (!files.public) return none("This version's files aren't public.");
  const file = fileForDevice(kind, files);
  if (!file) return none(`This version didn't make the ${target.label} file. It takes a tune on that base.`);
  if (!files.repo || !REPO_RE.test(files.repo)) return none("This version's Hugging Face repo can't be used here.");
  if (!files.commit || !COMMIT_RE.test(files.commit)) return none("This version's files have no pinned commit.");
  if (!SHA_RE.test(file.sha256) || !FILE_RE.test(file.name) || !(file.bytes > 0)) return none("This file's details can't be checked.");
  const slug = ggufOllamaName(files.slug);
  if (!SLUG_RE.test(slug)) return none("This version's name can't be used here.");
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0009\u000b-\u001f\u007f]/.test(files.systemLine)) return none("This model's system message can't be written to a file.");
  const small = target.quantBase !== null;
  const channel: 0 | 1 = files.needsTunedTemplate ? 0 : 1;
  const stops = ggufStops(channel, small ? { quantBase: target.quantBase! } : null);
  // A closing quote right before the Modelfile's own """ would break it as surely as one inside.
  const quoted = files.systemLine.includes('"""') || files.systemLine.endsWith('"');
  const modelfile = quoted ? null : small ? smallModelfile(file.name, files.systemLine, stops) : ggufModelfile(file.name, files.systemLine, channel);
  const entry = EXPORT_KINDS.find((e) => e.kind === kind)!;
  return {
    ok: true,
    plan: {
      kind,
      os: entry.os,
      title: files.title,
      slug,
      repo: files.repo,
      commit: files.commit,
      file: { name: file.name, bytes: file.bytes, sha256: file.sha256, level: file.level },
      modelLabel: target.label,
      fit: target.fit,
      proof: entry.proof,
      provenOnDevice: false,
      systemLine: files.systemLine,
      template: !small && files.needsTunedTemplate ? TUNED_TEMPLATE : null,
      stops: small ? [] : stops,
      modelfile,
      ollamaName: slug,
      notice,
    },
  };
}

/** A shell single-quoted word, whatever it holds. */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** A PowerShell single-quoted string, whatever it holds. Curly quotes end one too. */
export function psQuote(s: string): string {
  return `'${s.replace(/['‘’‚‛]/g, (q) => q + q)}'`;
}

/** What a script prints. A title is a person's text: on one line, and with no terminal control codes. */
const noticeLines = (p: ExportPlan) =>
  // eslint-disable-next-line no-control-regex
  [`${p.title}: ${p.modelLabel}, ${p.file.level}.`, ...(p.notice.line ? [`${p.notice.line}.`] : []), p.notice.license, ...p.notice.points, `License and files: https://huggingface.co/${p.repo}/tree/${p.commit}`, p.fit, p.proof].map((l) => l.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " "));
const fileUrl = (p: ExportPlan) => `https://huggingface.co/${p.repo}/resolve/${p.commit}/${p.file.name}`;
/** The free space a download must leave: the model, and a gigabyte to work with. */
const needBytes = (p: ExportPlan) => p.file.bytes + 1_000_000_000;

export function installerName(plan: Pick<ExportPlan, "slug" | "os">): string {
  return `run-${plan.slug}-${plan.os}.${plan.os === "windows" ? "ps1" : "sh"}`;
}

/** The line a person pastes after the download. */
export function runLine(plan: Pick<ExportPlan, "slug" | "os">, ollama = false): string {
  const name = installerName(plan);
  if (plan.os === "windows") return `powershell -ExecutionPolicy Bypass -File "$HOME\\Downloads\\${name}"${ollama ? " -Ollama" : ""}`;
  return `sh ~/Downloads/${name}${ollama ? " --ollama" : ""}`;
}

/** Text for a quoted here-document, with an end word it can't contain. */
function heredoc(path: string, text: string): string {
  let end = "MUSE_MUSE_END";
  while (text.includes(end)) end += "_";
  return `cat > ${path} <<'${end}'\n${text}\n${end}`;
}

/** The script for a Mac, a Linux PC or a Jetson. POSIX sh. */
function shScript(p: ExportPlan): string {
  const builds = LLAMA_BUILDS[p.os];
  const expectOs = p.os === "mac" ? "Darwin" : "Linux";
  const jetson = p.os === "jetson";
  const contextSize = LLAMA_RUN_CONTEXT[p.os];
  const stopArgs = p.stops.map((s) => `-r ${shQuote(s)}`).join(" ");
  return `#!/bin/sh
# Made by Muse Muse. Downloads one tuned model at a pinned commit, checks its sha256, gets llama.cpp ${LLAMA_TAG} at a
# pinned sha256, and runs it. Nothing runs as root, and everything stays in one folder.
# Options: --ollama, --check-only, --prompt TEXT, --max-tokens N, --gpu-layers N${jetson ? ", --cpu" : ""}, --help
set -eu

FILE=${shQuote(p.file.name)}
SHA256=${shQuote(p.file.sha256)}
NEED_BYTES=${needBytes(p)}
FILE_URL=${shQuote(fileUrl(p))}
OLLAMA_NAME=${shQuote(p.ollamaName)}
FOLDER="\${MUSE_MUSE_HOME:-$HOME/MuseMuse}"/${shQuote(p.slug)}
RELEASE=https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_TAG}
${jetson ? `TEGRA_FILE="\${MUSE_MUSE_TEGRA_FILE:-/etc/nv_tegra_release}"\n` : ""}
MODE=run
PROMPT=
MAX_TOKENS=
GPU_LAYERS=
${jetson ? "CPU_ONLY=\n" : ""}
stop_here() { echo "$1" >&2; exit "\${2:-1}"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --ollama) MODE=ollama ;;
    --check-only) MODE=check ;;
    --prompt) [ $# -ge 2 ] || stop_here "--prompt needs text."; PROMPT=$2; shift ;;
    --max-tokens) [ $# -ge 2 ] || stop_here "--max-tokens needs a number."; MAX_TOKENS=$2; shift ;;
    --gpu-layers) [ $# -ge 2 ] || stop_here "--gpu-layers needs a number."; GPU_LAYERS=$2; shift ;;
${jetson ? "    --cpu) CPU_ONLY=1 ;;\n" : ""}    --help|-h) sed -n '2,4p' "$0"; exit 0 ;;
    *) stop_here "Unknown option: $1" ;;
  esac
  shift
done
case "$MAX_TOKENS$GPU_LAYERS" in *[!0-9]*) stop_here "--max-tokens and --gpu-layers take whole numbers." ;; esac

sha_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  else stop_here "This needs sha256sum or shasum, to check what it downloads."
  fi
}

# fetch URL DEST SHA256 LABEL: keeps a good copy, resumes a partial one, and never keeps a file that fails its check.
fetch() {
  if [ -f "$2" ] && [ "$(sha_of "$2")" = "$3" ]; then echo "$4 is already here and checked."; return 0; fi
  rm -f "$2"
  echo "Downloading $4."
  # A part that is already whole makes curl fail on the resume, so its check decides.
  curl -fL --retry 3 --retry-delay 2 -C - -o "$2.part" "$1" || { [ -f "$2.part" ] && [ "$(sha_of "$2.part")" = "$3" ]; } || stop_here "The download of $4 stopped. Run this again to resume it. If it keeps stopping, delete $FOLDER/$2.part."
  if [ "$(sha_of "$2.part")" != "$3" ]; then
    rm -f "$2.part"
    stop_here "$4 failed its sha256 check, so it was deleted and nothing was run."
  fi
  mv "$2.part" "$2"
  echo "$4 passed its sha256 check."
}

[ "$(uname -s)" = ${expectOs} ] || stop_here "This installer is for ${p.os === "mac" ? "a Mac" : jetson ? "a Jetson" : "Linux"}. Get the one for this computer from the model's page."
command -v curl >/dev/null 2>&1 || stop_here "This needs curl."
command -v tar >/dev/null 2>&1 || stop_here "This needs tar."
command -v sha256sum >/dev/null 2>&1 || command -v shasum >/dev/null 2>&1 || stop_here "This needs sha256sum or shasum, to check what it downloads."
ARCH=$(uname -m)
${jetson ? `[ -f "$TEGRA_FILE" ] || stop_here "This installer is for a Jetson, and this computer doesn't look like one."\n[ "$ARCH" = aarch64 ] || stop_here "A Jetson should report aarch64, and this reports $ARCH."\n` : ""}
cat <<'MUSE_MUSE_NOTICE'
${noticeLines(p).join("\n").replace(/^MUSE_MUSE_NOTICE$/gm, "MUSE MUSE NOTICE")}
MUSE_MUSE_NOTICE

mkdir -p "$FOLDER"
cd "$FOLDER"

FREE_KB=$(df -Pk . | awk 'NR==2 {print $4}')
if [ ! -f "$FILE" ] && [ "$FREE_KB" -lt $((NEED_BYTES / 1024)) ]; then
  stop_here "This needs about $((NEED_BYTES / 1000000000)) GB free in $FOLDER, and there is less. Nothing was downloaded."
fi

fetch "$FILE_URL" "$FILE" "$SHA256" "the model"

printf '%s' ${shQuote(p.systemLine)} > system.txt
${p.template ? `printf '%s' ${shQuote(p.template)} > tuned.jinja\n` : ""}
if [ "$MODE" = ollama ]; then
${p.modelfile ? `  ${heredoc("Modelfile", p.modelfile).replace(/\n/g, "\n")}
  command -v ollama >/dev/null 2>&1 || stop_here "The Modelfile is ready in $FOLDER. Install Ollama from https://ollama.com/download and run this again." 3
  ollama create "$OLLAMA_NAME" -f Modelfile
  [ -n "$PROMPT" ] && exec ollama run "$OLLAMA_NAME" "$PROMPT"
  exec ollama run "$OLLAMA_NAME"` : `  stop_here "This model's system message can't go in a Modelfile, so use the llama.cpp path."`}
fi

${jetson ? jetsonLlama(builds) : prebuiltLlama(builds)}

[ -x "$BIN" ] || stop_here "llama.cpp's program wasn't where it should be: $BIN"
if [ "$MODE" = check ]; then echo "Checked. Model: $FOLDER/$FILE. llama.cpp: $BIN"; exit 0; fi

set -- -m "$FILE" -sysf system.txt -c ${contextSize} --temp 0${p.template ? " --jinja --chat-template-file tuned.jinja" : ""}${stopArgs ? ` ${stopArgs}` : ""}
[ -n "$GPU_LAYERS" ] && set -- "$@" -ngl "$GPU_LAYERS"
[ -n "$MAX_TOKENS" ] && set -- "$@" -n "$MAX_TOKENS"
if [ -n "$PROMPT" ]; then
  set -- "$@" -st -p "$PROMPT" --simple-io
fi
exec "$BIN" "$@"
`;
}

/** A pinned prebuilt for this computer's processor. */
function prebuiltLlama(builds: (typeof LLAMA_BUILDS)[InstallerOs]): string {
  const cases = builds.map((b) => `  ${b.arch}) LLAMA_ASSET=${b.asset}; LLAMA_SHA=${b.sha256} ;;`).join("\n");
  return `case "$ARCH" in
${cases}
  *) stop_here "llama.cpp ${LLAMA_TAG} has no ready-made build for $ARCH." ;;
esac
fetch "$RELEASE/$LLAMA_ASSET" "$LLAMA_ASSET" "$LLAMA_SHA" "llama.cpp ${LLAMA_TAG}"
BIN="$PWD/llama-${LLAMA_TAG}/llama-cli"
[ -x "$BIN" ] || tar -xzf "$LLAMA_ASSET"`;
}

/** A Jetson builds llama.cpp for its GPU from the pinned source: no prebuilt has CUDA for it. --cpu takes the arm64 prebuilt. */
function jetsonLlama(builds: (typeof LLAMA_BUILDS)[InstallerOs]): string {
  const cpu = builds[0]!;
  return `if [ -n "$CPU_ONLY" ]; then
  fetch "$RELEASE/${cpu.asset}" ${shQuote(cpu.asset)} ${shQuote(cpu.sha256)} "llama.cpp ${LLAMA_TAG} for the processor"
  BIN="$PWD/llama-${LLAMA_TAG}/llama-cli"
  [ -x "$BIN" ] || tar -xzf ${shQuote(cpu.asset)}
else
  BIN="$PWD/llama-gpu/bin/llama-cli"
  if [ ! -x "$BIN" ]; then
    command -v cmake >/dev/null 2>&1 && command -v c++ >/dev/null 2>&1 || stop_here "Building for the GPU needs cmake and a compiler: sudo apt-get install cmake build-essential. Or run this with --cpu."
    command -v nvcc >/dev/null 2>&1 || stop_here "Building for the GPU needs NVIDIA's CUDA tools, which come with JetPack. Or run this with --cpu."
    fetch ${shQuote(LLAMA_SOURCE.url)} llama-source.tar.gz ${shQuote(LLAMA_SOURCE.sha256)} "llama.cpp ${LLAMA_TAG} source"
    tar -xzf llama-source.tar.gz
    echo "Building llama.cpp for the GPU. This can take 20 minutes or more."
    cmake -S ${shQuote(LLAMA_SOURCE.top)} -B llama-gpu -DCMAKE_BUILD_TYPE=Release -DGGML_CUDA=ON -DLLAMA_BUILD_TESTS=OFF
    cmake --build llama-gpu --target llama-cli -j 4
  fi
  [ -n "$GPU_LAYERS" ] || GPU_LAYERS=99
fi`;
}

/** The script for Windows. PowerShell 5.1, which every supported Windows has. */
function psScript(p: ExportPlan): string {
  const b = LLAMA_BUILDS.windows[0]!;
  const stopArgs = p.stops.flatMap((s) => ["'-r'", psQuote(s)]);
  return `# Made by Muse Muse. Downloads one tuned model at a pinned commit, checks its sha256, gets llama.cpp ${LLAMA_TAG} at a
# pinned sha256, and runs it. Nothing runs as administrator, and everything stays in one folder.
param(
  [switch]$Ollama,
  [switch]$CheckOnly,
  [string]$Prompt = '',
  [int]$MaxTokens = 0,
  [int]$GpuLayers = -1
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$File = ${psQuote(p.file.name)}
$Sha256 = ${psQuote(p.file.sha256)}
$NeedBytes = ${needBytes(p)}
$FileUrl = ${psQuote(fileUrl(p))}
$OllamaName = ${psQuote(p.ollamaName)}
$Asset = ${psQuote(b.asset)}
$AssetSha = ${psQuote(b.sha256)}
$Release = 'https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_TAG}'
$Home_ = if ($env:MUSE_MUSE_HOME) { $env:MUSE_MUSE_HOME } else { Join-Path $HOME 'MuseMuse' }
$Folder = Join-Path $Home_ ${psQuote(p.slug)}

function Stop-Here([string]$Words, [int]$Code = 1) { [Console]::Error.WriteLine($Words); exit $Code }

function Get-Sha([string]$Path) { (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant() }

function Get-Checked([string]$Url, [string]$Dest, [string]$Want, [string]$Label) {
  if ((Test-Path -LiteralPath $Dest) -and ((Get-Sha $Dest) -eq $Want)) { Write-Host "$Label is already here and checked."; return }
  Remove-Item -LiteralPath $Dest -ErrorAction SilentlyContinue
  Write-Host "Downloading $Label."
  $Part = "$Dest.part"
  & curl.exe -fL --retry 3 --retry-delay 2 -C - -o $Part $Url
  # A part that is already whole makes curl fail on the resume, so its check decides.
  if (($LASTEXITCODE -ne 0) -and -not ((Test-Path -LiteralPath $Part) -and ((Get-Sha $Part) -eq $Want))) { Stop-Here "The download of $Label stopped. Run this again to resume it. If it keeps stopping, delete $Part." }
  if ((Get-Sha $Part) -ne $Want) {
    Remove-Item -LiteralPath $Part
    Stop-Here "$Label failed its sha256 check, so it was deleted and nothing was run."
  }
  Move-Item -LiteralPath $Part -Destination $Dest
  Write-Host "$Label passed its sha256 check."
}

if ($env:PROCESSOR_ARCHITECTURE -ne 'AMD64') { Stop-Here "llama.cpp ${LLAMA_TAG} has no ready-made processor build for this Windows PC." }

@(
${noticeLines(p).map((l) => `  ${psQuote(l)}`).join(",\n")}
) | ForEach-Object { Write-Host $_ }

New-Item -ItemType Directory -Force -Path $Folder | Out-Null
Set-Location -LiteralPath $Folder

$Free = (Get-Item -LiteralPath $Folder).PSDrive.Free
if (-not (Test-Path -LiteralPath $File) -and $Free -lt $NeedBytes) {
  Stop-Here "This needs about $([math]::Ceiling($NeedBytes / 1000000000)) GB free in $Folder, and there is less. Nothing was downloaded."
}

Get-Checked $FileUrl (Join-Path $Folder $File) $Sha256 'the model'

$Utf8 = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText((Join-Path $Folder 'system.txt'), ${psQuote(p.systemLine)}, $Utf8)
${p.template ? `[IO.File]::WriteAllText((Join-Path $Folder 'tuned.jinja'), ${psQuote(p.template)}, $Utf8)\n` : ""}
if ($Ollama) {
${p.modelfile ? `  [IO.File]::WriteAllText((Join-Path $Folder 'Modelfile'), ${psQuote(p.modelfile)}, $Utf8)
  if (-not (Get-Command ollama -ErrorAction SilentlyContinue)) { Stop-Here "The Modelfile is ready in $Folder. Install Ollama from https://ollama.com/download and run this again." 3 }
  & ollama create $OllamaName -f Modelfile
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  if ($Prompt) { & ollama run $OllamaName $Prompt } else { & ollama run $OllamaName }
  exit $LASTEXITCODE` : `  Stop-Here "This model's system message can't go in a Modelfile, so use the llama.cpp path."`}
}

Get-Checked "$Release/$Asset" (Join-Path $Folder $Asset) $AssetSha 'llama.cpp ${LLAMA_TAG}'
$BinDir = Join-Path $Folder 'llama-${LLAMA_TAG}'
$Bin = Join-Path $BinDir 'llama-cli.exe'
if (-not (Test-Path -LiteralPath $Bin)) { Expand-Archive -LiteralPath (Join-Path $Folder $Asset) -DestinationPath $BinDir -Force }
if (-not (Test-Path -LiteralPath $Bin)) { Stop-Here "llama.cpp's program wasn't where it should be: $Bin" }
if ($CheckOnly) { Write-Host "Checked. Model: $Folder\\$File. llama.cpp: $Bin"; exit 0 }

$RunArgs = @('-m', $File, '-sysf', 'system.txt', '-c', '${LLAMA_RUN_CONTEXT.windows}', '--temp', '0'${p.template ? `, '--jinja', '--chat-template-file', 'tuned.jinja'` : ""}${stopArgs.length ? `, ${stopArgs.join(", ")}` : ""})
if ($GpuLayers -ge 0) { $RunArgs += @('-ngl', "$GpuLayers") }
if ($MaxTokens -gt 0) { $RunArgs += @('-n', "$MaxTokens") }
if ($Prompt) { $RunArgs += @('-st', '-p', $Prompt, '--simple-io') }
& $Bin @RunArgs
exit $LASTEXITCODE
`;
}

export function installerFor(plan: ExportPlan): { name: string; body: string; mime: string } {
  if (plan.os === "windows") return { name: installerName(plan), body: `﻿${psScript(plan)}`, mime: "text/plain; charset=utf-8" };
  return { name: installerName(plan), body: shScript(plan), mime: "text/x-shellscript; charset=utf-8" };
}


