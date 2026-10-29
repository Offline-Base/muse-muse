/**
 * Runs the device kit on this Mac (docs/DEVICES.md "On this Mac" and "How to run > Mac"):
 *
 *   npx tsx scripts/devices/local.ts                                     the smoke subject (92 MB, downloaded here)
 *   npx tsx scripts/devices/local.ts --subject pick                      the file pickSubjects gives this Mac
 *   npx tsx scripts/devices/local.ts --subject meta-q4_k_m --model <path>     a file already on disk
 *   npx tsx scripts/devices/local.ts --subject meta-q4_k_m --download --yes   downloaded, after a free-disk check
 *   npx tsx scripts/devices/local.ts --tuned <ns>/muse-glimmer-30b-<slug>-gguf-<job8>   a tuned repo's file for this Mac
 *
 * More flags: --backends gpu,cpu (the default, in bench order), --settings smoke|default, --threads <n>,
 * --remove-model (delete a file this script downloaded once the run is written), --keep-run (keep the kit's folder).
 *
 * The cache (MM_DEVICES_CACHE, or ~/.cache/muse-muse-devices) holds the pinned macOS llama.cpp build, checked by its
 * sha256 and trimmed by keepLlamaFile, the models, and each run's kit folder. A file over 200 MB is never downloaded
 * without --download --yes, and then only with its size plus 5 GB free. Every file is checked by size and sha256
 * before the kit runs (and the kit checks again). The kit gets a clean environment: no token from this shell reaches
 * it. Results go to devices/results/local/<device>/<subject>/<stamp>/, with the cache, the repo and the home folder
 * written as <cache>, <repo> and ~.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseKitOutput, writeResult } from "@/lib/devices/result";
import {
  LLAMA_TAG,
  SMOKE,
  fetchTunedSubjects,
  isSafeKitValue,
  keepLlamaFile,
  kitEnvFor,
  llamaAsset,
  pickSubjects,
  repoFileUrl,
  subjectById,
  subjectFileName,
  subjectUrl,
  utcStamp,
} from "@/lib/devices/subjects";
import { KIT_DEFAULTS, KIT_SMOKE, type Backend, type Result, type Subject } from "@/lib/devices/types";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const KIT_SCRIPT = path.join(REPO_ROOT, "devices", "kit", "run.sh");
/** Files up to this size download without asking. */
export const AUTO_DOWNLOAD_BYTES = 200_000_000;
/** A larger download needs this much free disk on top of what is left to download. */
export const DOWNLOAD_HEADROOM_BYTES = 5_000_000_000;
/** A download that sends nothing for this long is stopped. */
const IDLE_MS = 120_000;

export interface LocalArgs {
  /** A subject id, "smoke" or "pick" (pickSubjects for this Mac). */
  subject: string;
  /** A tuned GGUF repo: its file for this Mac (pickSubjects over fetchTunedSubjects). */
  tuned: string | null;
  model: string | null;
  download: boolean;
  yes: boolean;
  backends: Backend[];
  /** Null: KIT_SMOKE for the smoke subject, KIT_DEFAULTS for the rest. */
  settings: "smoke" | "default" | null;
  threads: number | null;
  removeModel: boolean;
  keepRun: boolean;
  help: boolean;
}

export const USAGE = `Usage: npx tsx scripts/devices/local.ts [--subject <id>|smoke|pick] [--tuned <repo>] [--model <path>]
       [--download --yes] [--backends gpu,cpu] [--settings smoke|default] [--threads <n>] [--remove-model] [--keep-run]`;

export function parseLocalArgs(argv: readonly string[]): LocalArgs {
  const args: LocalArgs = {
    subject: "smoke",
    tuned: null,
    model: null,
    download: false,
    yes: false,
    backends: ["gpu", "cpu"],
    settings: null,
    threads: null,
    removeModel: false,
    keepRun: false,
    help: false,
  };
  const value = (i: number, flag: string) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new Error(`${flag} needs a value.\n${USAGE}`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    switch (flag) {
      case "--subject":
        args.subject = value(i++, flag);
        break;
      case "--tuned":
        args.tuned = value(i++, flag);
        break;
      case "--model":
        args.model = value(i++, flag);
        break;
      case "--download":
        args.download = true;
        break;
      case "--yes":
        args.yes = true;
        break;
      case "--backends": {
        const list = value(i++, flag).split(",").filter(Boolean);
        if (!list.length || list.some((b) => b !== "gpu" && b !== "cpu") || new Set(list).size !== list.length) {
          throw new Error("--backends takes gpu and cpu, comma-separated, each once (a Mac has no NPU backend).");
        }
        args.backends = list as Backend[];
        break;
      }
      case "--settings": {
        const s = value(i++, flag);
        if (s !== "smoke" && s !== "default") throw new Error("--settings takes smoke or default.");
        args.settings = s;
        break;
      }
      case "--threads": {
        const n = Number(value(i++, flag));
        if (!Number.isInteger(n) || n < 1 || n > 256) throw new Error("--threads takes a whole number from 1 to 256.");
        args.threads = n;
        break;
      }
      case "--remove-model":
        args.removeModel = true;
        break;
      case "--keep-run":
        args.keepRun = true;
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${flag}\n${USAGE}`);
    }
  }
  if (args.model && (args.download || args.tuned)) throw new Error("--model names a file you have: drop --download and --tuned.");
  return args;
}

/** MM_DEVICES_CACHE, or ~/.cache/muse-muse-devices. */
export function cacheDir(env: Readonly<Record<string, string | undefined>> = process.env): string {
  return path.resolve(env.MM_DEVICES_CACHE?.trim() || path.join(os.homedir(), ".cache", "muse-muse-devices"));
}

const gbText = (bytes: number) => `${(bytes / 1e9).toFixed(2)} GB`;

// ---------------------------------------------------------------------------------------------------------------
// Files

export async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** True when the file is there with exactly this size and sha256. */
export async function fileMatches(file: string, bytes: number, sha256: string): Promise<boolean> {
  if (!existsSync(file) || statSync(file).size !== bytes) return false;
  return (await sha256File(file)) === sha256;
}

/**
 * Downloads a public URL to dest through dest.part (resuming a partial file when the server takes a range), checking
 * the size and sha256 before the rename. No credential is sent, and a redirect's signed URL is never printed.
 */
export async function downloadVerified(
  url: string,
  dest: string,
  bytes: number,
  sha256: string,
  fetchImpl: typeof fetch = fetch,
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  mkdirSync(path.dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  let have = existsSync(part) ? statSync(part).size : 0;
  if (have > bytes) {
    rmSync(part, { force: true });
    have = 0;
  }
  let hash = createHash("sha256");
  if (have > 0) for await (const chunk of createReadStream(part)) hash.update(chunk as Buffer);
  if (have < bytes) {
    const abort = new AbortController();
    let idle = setTimeout(() => abort.abort(), IDLE_MS);
    try {
      const headers: Record<string, string> = { "user-agent": "muse-muse-devices" };
      if (have > 0) headers.range = `bytes=${have}-`;
      const res = await fetchImpl(url, { headers, redirect: "follow", signal: abort.signal });
      if (res.status === 200 && have > 0) {
        have = 0;
        hash = createHash("sha256");
      } else if (res.status !== 200 && res.status !== 206) {
        throw new Error(`The download of ${path.basename(dest)} answered HTTP ${res.status}.`);
      }
      if (!res.body) throw new Error(`The download of ${path.basename(dest)} had no body.`);
      const out = createWriteStream(part, { flags: have > 0 ? "a" : "w" });
      try {
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          clearTimeout(idle);
          idle = setTimeout(() => abort.abort(), IDLE_MS);
          have += chunk.length;
          if (have > bytes) throw new Error(`${path.basename(dest)} is larger than the pinned ${bytes} bytes.`);
          hash.update(chunk);
          if (!out.write(chunk)) await once(out, "drain");
          onProgress?.(have, bytes);
        }
      } finally {
        await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
      }
    } catch (err) {
      if (abort.signal.aborted) throw new Error(`The download of ${path.basename(dest)} stalled for ${IDLE_MS / 1000} s.`);
      throw err;
    } finally {
      clearTimeout(idle);
    }
  }
  const digest = hash.digest("hex");
  if (have !== bytes || digest !== sha256) {
    rmSync(part, { force: true });
    throw new Error(
      `${path.basename(dest)} doesn't match its pin: ${have} bytes with sha256 ${digest}, expected ${bytes} and ${sha256}.`,
    );
  }
  renameSync(part, dest);
}

/** The free bytes in the filesystem of dir, or of its nearest parent that exists. */
export function freeBytes(dir: string): number {
  let d = path.resolve(dir);
  while (!existsSync(d) && path.dirname(d) !== d) d = path.dirname(d);
  const s = statfsSync(d);
  return Number(s.bavail) * Number(s.bsize);
}

/**
 * Extracts only the files keepLlamaFile keeps from a pinned llama.cpp archive (each under "llama-b11669/") into dest,
 * through a fresh folder next to it. Returns the members it took.
 */
export function extractKept(archive: string, dest: string): string[] {
  const list = spawnSync("tar", ["-tzf", archive], { encoding: "utf8" });
  if (list.status !== 0) throw new Error(`tar couldn't list ${archive}: ${list.stderr.trim()}`);
  const top = "llama-b11669/";
  const kept = list.stdout
    .split("\n")
    .map((m) => m.trim().replace(/^\.\//, ""))
    .filter((m) => m.startsWith(top) && !m.endsWith("/") && !m.split("/").includes("..") && !/[*?[\\]/.test(m))
    .filter((m) => keepLlamaFile(m.slice(top.length)));
  for (const tool of ["llama-bench", "llama-completion"]) {
    if (!kept.some((m) => m === top + tool || m === `${top}bin/${tool}`)) throw new Error(`${archive} has no ${tool}.`);
  }
  const tmp = `${dest}.tmp-${process.pid}`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  const x = spawnSync("tar", ["-xzf", archive, "-C", tmp, ...kept], { encoding: "utf8" });
  if (x.status !== 0) {
    rmSync(tmp, { recursive: true, force: true });
    throw new Error(`tar couldn't extract ${archive}: ${x.stderr.trim()}`);
  }
  rmSync(dest, { recursive: true, force: true });
  renameSync(tmp, dest);
  return kept;
}

/** The pinned macOS build in the cache, downloaded, checked and trimmed when it isn't there yet. Returns its folder. */
export async function ensureLlama(cache: string, fetchImpl: typeof fetch = fetch, say = console.log): Promise<string> {
  const asset = llamaAsset("macos-arm64");
  const base = path.join(cache, "llama", LLAMA_TAG);
  const dir = path.join(base, asset.build);
  const build = path.join(dir, "llama-b11669");
  const marker = path.join(dir, ".sha256");
  if (existsSync(marker) && readFileSync(marker, "utf8").trim() === asset.sha256 && existsSync(path.join(build, "llama-bench"))) {
    return build;
  }
  const archive = path.join(base, asset.name);
  if (!(await fileMatches(archive, asset.bytes, asset.sha256))) {
    say(`Downloading ${asset.name} (${gbText(asset.bytes)}) from the llama.cpp ${LLAMA_TAG} release.`);
    await downloadVerified(asset.url, archive, asset.bytes, asset.sha256, fetchImpl);
  }
  const kept = extractKept(archive, dir);
  writeFileSync(marker, `${asset.sha256}\n`);
  say(`Extracted ${kept.length} files of ${asset.name} into ${dir}.`);
  return build;
}

// ---------------------------------------------------------------------------------------------------------------
// The plan

export interface ModelPlan {
  subject: Subject;
  path: string;
  /** "given": --model. "cached": already in the cache. "download": downloaded now. */
  source: "given" | "cached" | "download";
  /** Set when the run can't go on without the owner: why, and the exact command. */
  blocked?: { message: string; command: string };
}

export function cachedModelPath(cache: string, subject: Subject): string {
  return path.join(cache, "models", subject.id, subjectFileName(subject));
}

/** Where the model comes from, or why the run waits for the owner. Pure apart from looking at the disk. */
export function planModel(
  subject: Subject,
  args: Pick<LocalArgs, "model" | "download" | "yes" | "tuned">,
  cache: string,
  free: (dir: string) => number = freeBytes,
): ModelPlan {
  if (args.model) {
    const file = path.resolve(args.model);
    if (!existsSync(file)) throw new Error(`--model ${args.model}: no such file.`);
    return { subject, path: file, source: "given" };
  }
  const cached = cachedModelPath(cache, subject);
  if (existsSync(cached) && statSync(cached).size === subject.bytes) return { subject, path: cached, source: "cached" };
  if (subject.bytes <= AUTO_DOWNLOAD_BYTES) return { subject, path: cached, source: "download" };
  const left = subject.bytes - (existsSync(`${cached}.part`) ? statSync(`${cached}.part`).size : 0);
  const need = left + DOWNLOAD_HEADROOM_BYTES;
  const has = free(path.dirname(cached));
  const how = args.tuned ? `--tuned ${args.tuned}` : `--subject ${subject.id}`;
  if (!(args.download && args.yes)) {
    return {
      subject,
      path: cached,
      source: "download",
      blocked: {
        message:
          `${subject.id} is ${gbText(subject.bytes)}. Pass --model <path> for a copy you have, or --download --yes to ` +
          `download it into ${path.dirname(cached)} (that needs ${gbText(need)} free; the disk has ${gbText(has)}).`,
        command: `npx tsx scripts/devices/local.ts ${how} --download --yes`,
      },
    };
  }
  if (has < need) {
    return {
      subject,
      path: cached,
      source: "download",
      blocked: {
        message: `Not downloading ${subject.id}: it needs ${gbText(need)} free (the file plus 5 GB) and the disk has ${gbText(has)}.`,
        command: `npx tsx scripts/devices/local.ts ${how} --model <path to a copy you have>`,
      },
    };
  }
  return { subject, path: cached, source: "download" };
}

/** This Mac's RAM (hw.memsize). */
export function macRamBytes(): number {
  if (process.platform !== "darwin") throw new Error("scripts/devices/local.ts runs on a Mac.");
  const out = spawnSync("sysctl", ["-n", "hw.memsize"], { encoding: "utf8" });
  const bytes = Number(out.stdout.trim());
  if (!(bytes > 0)) throw new Error("Couldn't read hw.memsize.");
  return bytes;
}

/** The subject the arguments name, for a Mac with this much RAM. */
export async function chooseSubject(args: LocalArgs, ramBytes: number, fetchImpl: typeof fetch = fetch): Promise<Subject> {
  if (args.tuned) {
    const tuned = await fetchTunedSubjects(args.tuned, fetchImpl);
    const pick = pickSubjects({ os: "macos", ramBytes }, tuned)[0];
    if (!pick) throw new Error(`No file of ${args.tuned} fits this Mac's ${Math.round(ramBytes / 2 ** 30)} GB budget.`);
    return pick.subject;
  }
  if (args.subject === "smoke") return SMOKE;
  if (args.subject === "pick") {
    const pick = pickSubjects({ os: "macos", ramBytes })[0];
    if (!pick) throw new Error("No stand-in file fits this Mac.");
    return pick.subject;
  }
  const subject = subjectById(args.subject);
  if (!subject) throw new Error(`Unknown subject ${args.subject}. Known: smoke, pick, or an id in lib/devices/subjects.ts.`);
  return subject;
}

// ---------------------------------------------------------------------------------------------------------------
// The run

/** The environment the kit gets: its own variables and a plain PATH, nothing else from this shell. */
export function kitProcessEnv(kit: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C" };
  if (process.env.HOME) env.HOME = process.env.HOME;
  if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR;
  for (const [k, v] of Object.entries(kit)) if (v !== undefined) env[k] = v;
  return env;
}

/** Runs devices/kit/run.sh with /bin/sh and the given environment, its output passed through. Resolves its exit code. */
export function runKitScript(env: Record<string, string>, script = KIT_SCRIPT): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", [script], { env: env as NodeJS.ProcessEnv, stdio: ["ignore", "inherit", "inherit"] });
    child.on("error", reject);
    child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => resolve(code ?? (signal ? 128 : 1)));
  });
}

/** Writes the cache folder as <cache>, the repo as <repo> and the home folder as ~ in a result folder's files. */
export function scrubPaths(dir: string, cache: string): void {
  const pairs: Array<[string, string]> = [];
  const add = (from: string, to: string) => {
    if (from.length > 1) pairs.push([from, to]);
    try {
      const real = realpathSync(from);
      if (real !== from && real.length > 1) pairs.push([real, to]);
    } catch {
      // not on disk: nothing more to replace
    }
  };
  add(cache, "<cache>");
  add(REPO_ROOT, "<repo>");
  add(os.homedir(), "~");
  pairs.sort((a, b) => b[0].length - a[0].length);
  for (const name of readdirSync(dir)) {
    const file = path.join(dir, name);
    if (!lstatSync(file).isFile()) continue;
    const before = readFileSync(file, "utf8");
    let text = before;
    for (const [from, to] of pairs) text = text.split(from).join(to);
    if (text !== before) writeFileSync(file, text);
  }
}

export interface LocalDeps {
  fetchImpl?: typeof fetch;
  /** Where devices/results/ goes (the repo's root unless a test says otherwise). */
  repoRoot?: string;
  cache?: string;
  ramBytes?: number;
  free?: (dir: string) => number;
  say?: (line: string) => void;
}

/** One local run. Resolves the result and its folder, or null when the plan waits for the owner (printed). */
export async function runLocal(args: LocalArgs, deps: LocalDeps = {}): Promise<{ result: Result; dir: string } | null> {
  const say = deps.say ?? console.log;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const cache = deps.cache ?? cacheDir();
  const ramBytes = deps.ramBytes ?? macRamBytes();
  const subject = await chooseSubject(args, ramBytes, fetchImpl);
  const plan = planModel(subject, args, cache, deps.free);
  say(`${subject.id}: ${subject.quant}, ${gbText(subject.bytes)}, from ${subject.repo} at ${subject.revision.slice(0, 12)}.`);
  if (plan.blocked) {
    say(plan.blocked.message);
    say(`To run it: ${plan.blocked.command}`);
    return null;
  }
  const build = await ensureLlama(cache, fetchImpl, say);
  if (plan.source === "download") {
    say(`Downloading ${subjectFileName(subject)} (${gbText(subject.bytes)}) into ${path.dirname(plan.path)}.`);
    let shown = 0;
    await downloadVerified(subjectUrl(subject), plan.path, subject.bytes, subject.sha256, fetchImpl, (done, total) => {
      const tenth = Math.floor((done / total) * 10);
      if (tenth > shown) {
        shown = tenth;
        say(`  ${tenth * 10}%`);
      }
    });
  } else {
    say(`Checking ${plan.path} (size and sha256).`);
    const size = statSync(plan.path).size;
    const digest = size === subject.bytes ? await sha256File(plan.path) : "";
    if (digest !== subject.sha256) {
      // A damaged copy in the cache goes, so the next run downloads it again; the owner's own file stays.
      if (plan.source === "cached") rmSync(plan.path, { force: true });
      throw new Error(
        `${plan.path} isn't ${subject.id}: ${size} bytes${digest ? ` with sha256 ${digest}` : ""}, expected ${subject.bytes} ` +
          `and ${subject.sha256}.${plan.source === "cached" ? " The cached copy was deleted; run again to download it." : ""}`,
      );
    }
  }

  const stamp = utcStamp();
  const runDir = path.join(cache, "runs", `${stamp}-${subject.id}`);
  mkdirSync(runDir, { recursive: true });
  const system = path.join(runDir, "system.txt");
  writeFileSync(system, subject.system);
  let template: string | undefined;
  if (subject.templatePath) {
    template = path.join(runDir, "template.jinja");
    const res = await fetchImpl(repoFileUrl(subject, subject.templatePath));
    if (!res.ok) throw new Error(`The Hub answered ${res.status} for ${subject.repo}'s ${subject.templatePath}.`);
    writeFileSync(template, await res.text());
  }
  let model = plan.path;
  if (!isSafeKitValue(model)) {
    model = path.join(runDir, subjectFileName(subject).replace(/[^A-Za-z0-9._-]/g, "_"));
    symlinkSync(plan.path, model);
  }
  const out = path.join(runDir, "out");
  const settings =
    (args.settings ?? (subject.kind === "smoke" ? "smoke" : "default")) === "smoke" ? KIT_SMOKE : KIT_DEFAULTS;
  const kitEnv = kitEnvFor(
    subject,
    { model, out, system, template, llama: { gpu: build, cpu: build } },
    { backends: args.backends, settings, threads: args.threads ?? undefined },
  );
  say(`Running the kit: ${args.backends.join(", ")}.`);
  const code = await runKitScript(kitProcessEnv(kitEnv));
  if (code === 2 || !existsSync(path.join(out, "run.txt"))) throw new Error(`The kit refused its inputs (exit ${code}).`);
  const result = parseKitOutput(out, {
    cloud: "local",
    runId: `local-${stamp}`,
    stamp,
    subject,
    notes: plan.source === "given" ? ["The file came from --model and was checked before the run."] : [],
  });
  const dir = writeResult(deps.repoRoot ?? REPO_ROOT, result, out);
  scrubPaths(dir, cache);
  if (args.removeModel && plan.source !== "given") {
    rmSync(plan.path, { force: true });
    say(`Deleted ${plan.path}, as --remove-model asked.`);
  }
  if (!args.keepRun) rmSync(runDir, { recursive: true, force: true });
  return { result, dir };
}

export function verdictLines(result: Result, dir: string): string[] {
  const v = result.verdict;
  const speed = v.genTps === null ? "" : `, ${v.genTps.toFixed(v.genTps >= 10 ? 1 : 2)} tokens a second on ${v.backend}`;
  return [
    `${result.device.name}, ${result.device.marketedRamGiB} GB, ${result.subject.id}: ${v.rating}${speed}` +
      (v.answersTotal ? `, ${v.answersRight} of ${v.answersTotal} answers right.` : "."),
    ...v.reasons.map((r) => `  ${r}`),
    ...result.notes.map((n) => `  Note: ${n}`),
    `Written to ${path.relative(REPO_ROOT, dir) || dir}.`,
  ];
}

async function main(argv: string[]): Promise<number> {
  const args = parseLocalArgs(argv);
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  const done = await runLocal(args);
  if (!done) return 0;
  for (const line of verdictLines(done.result, done.dir)) console.log(line);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(`local.ts: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    },
  );
}
