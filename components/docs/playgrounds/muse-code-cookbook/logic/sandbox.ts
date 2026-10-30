import { baseName, parseCommand, unwrap, type Stage } from "@/components/docs/playgrounds/muse-code-cookbook/logic/shell";

/**
 * Muse Code's contained execution (cookbook/contained-execution) as a simulator: the managed profile (workspace and
 * temp roots writable, protected metadata read-only under the workspace, the rest of the filesystem read-only,
 * network egress restricted), the live probe that must pass before the sandbox is trusted, and what a command sees
 * at each boundary. Error lines the recipe prints are reproduced word for word.
 *
 * Each workspace carries its own files, so the common read commands (ls, cat, head, tail, wc, grep, test, git status)
 * answer from that workspace, and writes the sandbox lets through change it for the rest of a run when the caller
 * passes a working tree. A command the simulator can't answer says so in the tool result instead of passing for an
 * empty success. Nothing here runs a command.
 */

export interface Workspace {
  root: string;
  home: string;
  /** Writable roots besides the workspace. The harness also grants a runtime temp root. */
  tempRoots: string[];
  /** The working tree at session start, by path relative to the root. A path ending in "/" is an empty directory. */
  files: Readonly<Record<string, string>>;
  /** What the last commit holds, for git status (empty when nothing was committed). */
  committed: Readonly<Record<string, string>>;
  /** What running a workspace script prints (python3 billing.py, ./build_info.sh), by its path. */
  scripts?: Readonly<Record<string, string>>;
  /** Files with the executable bit set. */
  executables?: readonly string[];
  /** Symlinks: a link's path and where it points, both relative to the root. */
  links?: Readonly<Record<string, string>>;
}

/** The working tree during a run: absolute path to contents. A key ending in "/" is an empty directory. */
export type Tree = Record<string, string>;

/** build_info.sh from the recipe's setup. */
export const BUILD_INFO_SH = `#!/bin/bash
# Prints the Grishnok build fingerprint for this checkout.
echo "GRISHNOK-BUILD-FINGERPRINT=QX7-vellum-2291"
`;

/** The recipe's workspace: git init, then build_info.sh (never committed). */
export const SANDBOX_DEMO: Workspace = {
  root: "/tmp/sandbox_demo",
  home: "/home/you",
  tempRoots: ["/tmp"],
  files: { "build_info.sh": BUILD_INFO_SH },
  committed: {},
  scripts: { "build_info.sh": "GRISHNOK-BUILD-FINGERPRINT=QX7-vellum-2291\n" },
  executables: ["build_info.sh"],
};

/** What `git init` leaves in .git, enough for ls and cat. */
const GIT_DIR: Readonly<Record<string, string>> = {
  ".git/HEAD": "ref: refs/heads/main\n",
  ".git/config": "[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n\tlogallrefupdates = true\n",
  ".git/description": "Unnamed repository; edit this file 'description' to name the repository.\n",
  ".git/hooks/": "",
  ".git/info/": "",
  ".git/objects/": "",
  ".git/refs/": "",
};

/** Kept read-only under the workspace root even though the workspace is writable (immutable-guardrails lists them). */
export const PROTECTED_DIRS: readonly string[] = [".git", ".muse", ".agents", ".sl", ".hg", ".eden"];

export type Launch = "default" | "disable-approval" | "disable-sandbox" | "yolo";

export const LAUNCH_FLAGS: Record<Launch, string> = {
  default: "muse",
  "disable-approval": "muse --disable-approval --trust-workspace",
  "disable-sandbox": "muse --disable-sandbox",
  yolo: "muse --yolo",
};

/** What the probe finds on this host. Only an enforcing host passes. */
export type Host = "enforcing" | "missing-kernel" | "swapped-helper" | "changed-path";

export const HOST_LABEL: Record<Host, string> = {
  enforcing: "The OS enforces the policy",
  "missing-kernel": "Host missing the kernel features the sandbox needs",
  "swapped-helper": "The sandbox helper was swapped",
  "changed-path": "A different PATH resolves another helper",
};

export function sandboxOn(launch: Launch): boolean {
  return launch === "default" || launch === "disable-approval";
}

export function approvalOn(launch: Launch): boolean {
  return launch === "default" || launch === "disable-sandbox";
}

/** The startup line's security part: "approval normal · sandbox normal". */
export function startupLine(launch: Launch): string {
  return `approval ${approvalOn(launch) ? "normal" : "disabled"} · sandbox ${sandboxOn(launch) ? "normal" : "disabled"}`;
}

/** Joins and normalizes a path: $HOME, ${HOME} and ~ become the home directory, relative paths start at `cwd`. */
export function resolvePath(word: string, ws: Workspace, cwd: string = ws.root): string {
  let p = word.trim();
  p = p.replace(/^(\$HOME|\$\{HOME\}|~)(?=\/|$)/, ws.home);
  if (!p.startsWith("/")) p = `${cwd}/${p}`;
  const parts: string[] = [];
  for (const part of p.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

/** The path as bash prints it in an error: as written, with $HOME expanded (the recipe shows /home/you/...). */
export function shownPath(word: string, ws: Workspace): string {
  return word.replace(/^(\$HOME|\$\{HOME\}|~)(?=\/|$)/, ws.home);
}

function under(path: string, root: string): boolean {
  return root === "/" || path === root || path.startsWith(`${root}/`);
}

/** An absolute path with the workspace's symlinks followed (docs/git-config-link becomes .git/config). */
export function followLinks(path: string, ws: Workspace): string {
  for (const [link, target] of Object.entries(ws.links ?? {})) {
    const from = `${ws.root}/${link}`;
    if (path === from || path.startsWith(`${from}/`)) return `${ws.root}/${target}${path.slice(from.length)}`;
  }
  return path;
}

export interface WriteVerdict {
  writable: boolean;
  /** Why, for the reader: the workspace, a temp root, protected metadata, or outside every write root. */
  reason: string;
}

/** Whether the managed profile lets a write land at this absolute path. */
export function writeVerdict(path: string, ws: Workspace): WriteVerdict {
  if (under(path, ws.root)) {
    const rel = path.slice(ws.root.length + 1);
    const top = rel.split("/")[0];
    if (PROTECTED_DIRS.includes(top)) return { writable: false, reason: `${top}/ is protected metadata, read-only even inside the writable workspace` };
    return { writable: true, reason: "inside the workspace" };
  }
  const temp = ws.tempRoots.find((t) => under(path, t));
  if (temp) return { writable: true, reason: `inside the temp root ${temp}` };
  return { writable: false, reason: `outside the allowed write roots (${[ws.root, "runtime temp root", ...ws.tempRoots].join(", ")})` };
}

// ---------------------------------------------------------------------------------------------------------------
// The working tree

/** The tree a run starts from: the workspace's files plus the .git directory `git init` made. */
export function initialTree(ws: Workspace): Tree {
  const tree: Tree = {};
  for (const [rel, text] of Object.entries({ ...GIT_DIR, ...ws.files })) tree[`${ws.root}/${rel}`] = text;
  return tree;
}

type Kind = "file" | "dir" | null;

function kindOf(tree: Tree, ws: Workspace, path: string): Kind {
  const p = followLinks(path, ws);
  if (Object.prototype.hasOwnProperty.call(tree, p)) return "file";
  if ([ws.root, ws.home, "/", ...ws.tempRoots].includes(p)) return "dir";
  const prefix = `${p}/`;
  if (Object.keys(tree).some((k) => k.startsWith(prefix))) return "dir";
  if (Object.keys(ws.links ?? {}).some((l) => `${ws.root}/${l}`.startsWith(prefix))) return "dir";
  return null;
}

/** The names directly inside a directory, in C-locale order (dotfiles first), symlinks included. */
function children(tree: Tree, ws: Workspace, dir: string): string[] {
  const d = followLinks(dir, ws);
  const prefix = d === "/" ? "/" : `${d}/`;
  const names = new Set<string>();
  for (const key of [...Object.keys(tree), ...Object.keys(ws.links ?? {}).map((l) => `${ws.root}/${l}`)]) {
    if (key.startsWith(prefix) && key !== prefix) names.add(key.slice(prefix.length).split("/")[0]);
  }
  return [...names].filter(Boolean).sort();
}

function readFile(tree: Tree, ws: Workspace, path: string): string | null {
  const p = followLinks(path, ws);
  return Object.prototype.hasOwnProperty.call(tree, p) ? tree[p] : null;
}

function writeFile(tree: Tree, ws: Workspace, path: string, text: string, append: boolean): void {
  const p = followLinks(path, ws);
  tree[p] = append ? (tree[p] ?? "") + text : text;
  // A directory marker for the parent isn't needed any more once it holds a file.
  delete tree[`${p.slice(0, p.lastIndexOf("/"))}/`];
}

function removePath(tree: Tree, path: string, recursive: boolean): boolean {
  let removed = false;
  for (const key of Object.keys(tree)) {
    if (key === path || (recursive && key.startsWith(`${path}/`))) {
      delete tree[key];
      removed = true;
    }
  }
  return removed;
}

/** The workspace path relative to its root, for git status and messages. */
function relative(path: string, ws: Workspace): string {
  return path.startsWith(`${ws.root}/`) ? path.slice(ws.root.length + 1) : path;
}

/**
 * Applies an edit_file call to the tree: an empty old_text appends new_text, anything else replaces its first
 * occurrence. What a mediated write does once it is allowed.
 */
export function applyEdit(tree: Tree, ws: Workspace, word: string, oldText: string, newText: string): { ok: true } | { ok: false; error: string } {
  const path = resolvePath(word, ws);
  const text = readFile(tree, ws, path);
  if (text === null) return { ok: false, error: kindOf(tree, ws, path) === "dir" ? `${word} is a directory` : `${word} does not exist` };
  if (!oldText) {
    writeFile(tree, ws, path, newText, true);
    return { ok: true };
  }
  const at = text.indexOf(oldText);
  if (at < 0) return { ok: false, error: `old_text was not found in ${word}` };
  writeFile(tree, ws, path, text.slice(0, at) + newText + text.slice(at + oldText.length), false);
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------------------------
// What a stage touches

export interface Effect {
  op: "write" | "network";
  /** The word as written (for messages) and, for writes, the resolved path. */
  target: string;
  path?: string;
  /** The command that does it (echo, touch, curl). */
  command: string;
}

const NETWORK_COMMANDS = new Set(["curl", "wget", "nc", "ncat", "telnet", "ssh", "scp", "ftp", "ping"]);
const NETWORK_SUBCOMMANDS: Record<string, string[]> = {
  git: ["clone", "fetch", "pull", "push", "ls-remote"],
  pip: ["install", "download"],
  pip3: ["install", "download"],
  npm: ["install", "i", "ci", "add"],
  yarn: ["add", "install"],
  pnpm: ["add", "install", "i"],
  "apt-get": ["install", "update"],
  apt: ["install", "update"],
  brew: ["install", "update"],
  gem: ["install"],
  cargo: ["install", "fetch"],
  go: ["get", "install"],
  docker: ["pull", "push"],
};
const GIT_WRITES = new Set(["add", "commit", "checkout", "switch", "reset", "merge", "rebase", "stash", "tag", "config", "init"]);

/** What a stage would touch: files it writes (redirects, touch, cp...) and network it opens. */
export function stageEffects(stage: Stage, ws: Workspace, cwd: string = ws.root): Effect[] {
  const out: Effect[] = [];
  const argv = unwrap(stage.argv).argv;
  const cmd = argv.length ? baseName(argv[0]) : "";
  const args = argv.slice(1).filter((a) => !a.startsWith("-"));
  const write = (word: string) => out.push({ op: "write", target: word, path: followLinks(resolvePath(word, ws, cwd), ws), command: cmd || "bash" });

  for (const r of stage.redirects) if (!r.readOnly && r.op !== "<" && r.op !== "<<<") write(r.target);
  if (cmd === "touch" || cmd === "mkdir" || cmd === "rm" || cmd === "rmdir" || cmd === "truncate") args.forEach(write);
  else if (cmd === "tee") args.forEach(write);
  else if ((cmd === "cp" || cmd === "ln" || cmd === "install") && args.length >= 2) write(args[args.length - 1]);
  else if (cmd === "mv" && args.length >= 2) args.forEach(write);
  else if (cmd === "sed" && argv.some((a) => a === "-i" || a.startsWith("-i"))) args.slice(1).forEach(write);
  else if ((cmd === "chmod" || cmd === "chown") && args.length >= 2) args.slice(1).forEach(write);
  else if (cmd === "git" && argv[1] && GIT_WRITES.has(argv[1])) write(".git/index.lock");

  if (NETWORK_COMMANDS.has(cmd)) out.push({ op: "network", target: args.find((a) => /^[a-z]+:\/\/|\./.test(a)) ?? args[0] ?? "", command: cmd });
  else if (NETWORK_SUBCOMMANDS[cmd]?.includes(argv[1] ?? "")) out.push({ op: "network", target: argv.slice(2).join(" "), command: `${cmd} ${argv[1]}` });
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// The commands the simulator answers

interface Ctx {
  ws: Workspace;
  tree: Tree;
  cwd: string;
  stdin: string | null;
  last: number;
}

interface Output {
  /** Raw stdout, newlines included, as the command prints it. */
  stdout: string;
  stderr?: string;
  exitCode?: number;
  /** Set when the simulator can't say what the command prints. */
  unknown?: boolean;
  /** Something the reader (and the model) should know about this answer. */
  note?: string;
}

function lines(text: string): string[] {
  const l = text.split("\n");
  if (l[l.length - 1] === "") l.pop();
  return l;
}

const joinLines = (l: readonly string[]) => (l.length ? `${l.join("\n")}\n` : "");

/** $HOME, $PWD, $USER and $? inside a word, the way bash expands them. */
function expand(word: string, ctx: Ctx): string {
  return word.replace(/\$\{(HOME|PWD|USER)\}|\$(HOME|PWD|USER)\b|\$\?/g, (m, a?: string, b?: string) => {
    const name = a ?? b;
    if (!name) return String(ctx.last);
    return name === "HOME" ? ctx.ws.home : name === "PWD" ? ctx.cwd : "you";
  });
}

function mode(kind: "file" | "dir", executable: boolean): string {
  return kind === "dir" ? "drwxr-xr-x" : executable ? "-rwxr-xr-x" : "-rw-r--r--";
}

/** Short flags run together ("-la"), with the long forms a model might type spelled as their short letter. */
function flagLetters(args: readonly string[], long: Readonly<Record<string, string>> = {}): string {
  return args.map((a) => (a.startsWith("--") ? (long[a] ?? "") : /^-[A-Za-z]+$/.test(a) ? a.slice(1) : "")).join("");
}

const isFlag = (a: string) => a.startsWith("-") && a !== "-";

function ls(args: string[], ctx: Ctx): Output {
  const { ws, tree } = ctx;
  const flags = flagLetters(args, { "--all": "a", "--almost-all": "A", "--recursive": "R" });
  const words = args.filter((a) => !isFlag(a));
  const all = flags.includes("a");
  const hidden = all || flags.includes("A");
  const long = flags.includes("l");
  const recursive = flags.includes("R");
  const out: string[] = [];
  const err: string[] = [];
  let code = 0;
  const entry = (dir: string, name: string): string => {
    if (!long) return name;
    const path = name === "." || name === ".." ? dir : `${dir}/${name}`;
    const link = ws.links?.[relative(path, ws)];
    if (link) return `lrwxrwxrwx 1 you you ${String(link.length).padStart(5)} ${name} -> ${link}`;
    const kind = kindOf(tree, ws, path) ?? "file";
    const size = kind === "dir" ? 4096 : (readFile(tree, ws, path) ?? "").length;
    return `${mode(kind, ws.executables?.includes(relative(path, ws)) ?? false)} 1 you you ${String(size).padStart(5)} ${name}`;
  };
  const listDir = (dir: string, label: string, header: boolean) => {
    const names = children(tree, ws, dir).filter((n) => hidden || !n.startsWith("."));
    if (header) out.push(`${label}:`);
    for (const n of [...(all ? [".", ".."] : []), ...names]) out.push(entry(dir, n));
    if (recursive) {
      for (const n of names) {
        if (kindOf(tree, ws, `${dir}/${n}`) === "dir" && !ws.links?.[relative(`${dir}/${n}`, ws)]) {
          out.push("");
          listDir(`${dir}/${n}`, `${label}/${n}`, true);
        }
      }
    }
  };
  const targets = words.length ? words : ["."];
  targets.forEach((word, i) => {
    const path = resolvePath(word, ws, ctx.cwd);
    const kind = kindOf(tree, ws, path);
    if (!kind) {
      err.push(`ls: cannot access '${word}': No such file or directory`);
      code = 2;
      return;
    }
    if (kind === "file") {
      out.push(entry(path.slice(0, path.lastIndexOf("/")) || "/", word));
      return;
    }
    if (i > 0 && out.length) out.push("");
    listDir(path, word, targets.length > 1 || recursive);
  });
  return { stdout: joinLines(out), stderr: err.join("\n"), exitCode: code };
}

/** The files a reader command names, or its stdin when it names none. */
function inputs(words: string[], ctx: Ctx, command: string): { texts: Array<{ name: string; text: string }>; errors: string[] } {
  if (!words.length) return { texts: [{ name: "", text: ctx.stdin ?? "" }], errors: [] };
  const texts: Array<{ name: string; text: string }> = [];
  const errors: string[] = [];
  for (const w of words) {
    const path = resolvePath(w, ctx.ws, ctx.cwd);
    const kind = kindOf(ctx.tree, ctx.ws, path);
    if (kind === "dir") errors.push(`${command}: ${w}: Is a directory`);
    else if (!kind) errors.push(`${command}: ${w}: No such file or directory`);
    else texts.push({ name: w, text: readFile(ctx.tree, ctx.ws, path) ?? "" });
  }
  return { texts, errors };
}

/** -n 5, -n5, -5 or --lines=5; 10 when unset. */
function lineCount(args: string[]): { n: number; rest: string[] } {
  let n = 10;
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-n" && /^\d+$/.test(args[i + 1] ?? "")) n = Number(args[++i]);
    else if (/^-n\d+$/.test(a)) n = Number(a.slice(2));
    else if (/^-\d+$/.test(a)) n = Number(a.slice(1));
    else if (/^--lines=\d+$/.test(a)) n = Number(a.slice(8));
    else rest.push(a);
  }
  return { n, rest };
}

/** Every file under the given words, for grep -r: a file as written, a directory's files as word/path. */
function filesUnder(words: readonly string[], ctx: Ctx): string[] {
  return words.flatMap((w) => {
    const path = followLinks(resolvePath(w, ctx.ws, ctx.cwd), ctx.ws);
    if (kindOf(ctx.tree, ctx.ws, path) !== "dir") return [w];
    const prefix = `${path}/`;
    return Object.keys(ctx.tree)
      .filter((k) => k.startsWith(prefix) && !k.endsWith("/") && !k.slice(prefix.length).split("/").includes(".git"))
      .sort()
      .map((k) => `${w.replace(/\/$/, "")}/${k.slice(prefix.length)}`);
  });
}

function grep(args: string[], ctx: Ctx): Output {
  const flags = flagLetters(args, { "--recursive": "r", "--ignore-case": "i", "--line-number": "n", "--count": "c", "--quiet": "q" });
  const words = args.filter((a) => !isFlag(a));
  const [pattern, ...named] = words;
  if (pattern === undefined) return { stdout: "", stderr: "Usage: grep [OPTION]... PATTERNS [FILE]...", exitCode: 2 };
  const recursive = /[rR]/.test(flags);
  const files = recursive ? filesUnder(named.length ? named : ["."], ctx) : named;
  let re: RegExp;
  const literal = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  try {
    re = new RegExp(flags.includes("F") ? literal : pattern, flags.includes("i") ? "i" : "");
  } catch {
    re = new RegExp(literal, flags.includes("i") ? "i" : "");
  }
  const { texts, errors } = inputs(files, ctx, "grep");
  const out: string[] = [];
  let matched = false;
  for (const { name, text } of texts) {
    const hits = lines(text)
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => re.test(line) !== flags.includes("v"));
    if (hits.length) matched = true;
    const prefix = recursive || files.length > 1 ? `${name}:` : "";
    if (flags.includes("c")) out.push(`${prefix}${hits.length}`);
    else if (flags.includes("l")) {
      if (hits.length) out.push(name);
    } else for (const h of hits) out.push(`${prefix}${flags.includes("n") ? `${h.n}:` : ""}${h.line}`);
  }
  return { stdout: flags.includes("q") ? "" : joinLines(out), stderr: errors.join("\n"), exitCode: errors.length ? 2 : matched ? 0 : 1 };
}

function test(argv: string[], ctx: Ctx): Output {
  const args = argv[0] === "[" ? (argv[argv.length - 1] === "]" ? argv.slice(1, -1) : null) : argv.slice(1);
  if (!args) return { stdout: "", stderr: "[: missing `]'", exitCode: 2 };
  const negate = args[0] === "!";
  const [op, word] = negate ? args.slice(1) : args;
  if (!["-e", "-f", "-d", "-s"].includes(op ?? "") || word === undefined) return { stdout: "", unknown: true };
  const path = resolvePath(word, ctx.ws, ctx.cwd);
  const kind = kindOf(ctx.tree, ctx.ws, path);
  const ok = op === "-e" ? kind !== null : op === "-f" ? kind === "file" : op === "-d" ? kind === "dir" : kind === "file" && (readFile(ctx.tree, ctx.ws, path) ?? "").length > 0;
  return { stdout: "", exitCode: ok !== negate ? 0 : 1 };
}

/** git status against the last commit: modified, deleted and untracked files, long or porcelain. */
function gitStatus(args: string[], ctx: Ctx): Output {
  const { ws, tree } = ctx;
  const short = args.some((a) => a === "--porcelain" || a === "-s" || a === "--short" || a.startsWith("--porcelain="));
  const filters = args.filter((a) => !a.startsWith("-")).map((w) => relative(resolvePath(w, ws, ctx.cwd), ws));
  const inFilter = (rel: string) => !filters.length || filters.some((f) => f === "" || rel === f || rel.startsWith(`${f}/`));
  const working = Object.fromEntries(
    Object.entries(tree)
      .filter(([k]) => k.startsWith(`${ws.root}/`) && !k.endsWith("/") && !k.startsWith(`${ws.root}/.git/`))
      .map(([k, v]) => [relative(k, ws), v]),
  );
  const rows: Array<{ code: string; path: string }> = [];
  for (const path of [...new Set([...Object.keys(working), ...Object.keys(ws.committed)])].sort()) {
    if (!inFilter(path)) continue;
    const before = ws.committed[path];
    const now = working[path];
    if (before === undefined) rows.push({ code: "??", path });
    else if (now === undefined) rows.push({ code: " D", path });
    else if (now !== before) rows.push({ code: " M", path });
  }
  if (short) return { stdout: joinLines(rows.map((r) => `${r.code} ${r.path}`)) };
  const changed = rows.filter((r) => r.code !== "??");
  const untracked = rows.filter((r) => r.code === "??");
  const sections = [
    ...(Object.keys(ws.committed).length ? [] : [["No commits yet"]]),
    ...(changed.length ? [["Changes not staged for commit:", ...changed.map((r) => `\t${r.code === " D" ? "deleted:    " : "modified:   "}${r.path}`)]] : []),
    ...(untracked.length ? [["Untracked files:", ...untracked.map((r) => `\t${r.path}`)]] : []),
    ...(rows.length ? [] : [["nothing to commit, working tree clean"]]),
  ];
  // git leaves a blank line before "No commits yet" and between sections, none before the first section otherwise.
  const out = ["On branch main", ...sections.flatMap((lines, i) => [...(i > 0 || lines[0] === "No commits yet" ? [""] : []), ...lines])];
  return { stdout: joinLines(out) };
}

/** Runs a workspace script (python3 billing.py, ./build_info.sh, bash build_info.sh) from what the workspace says it prints. */
function script(argv: string[], ctx: Ctx): Output | null {
  const cmd = baseName(argv[0] ?? "");
  const interpreter = ["python", "python3", "bash", "sh"].includes(cmd);
  const word = interpreter ? argv[1] : argv[0];
  if (!word || (!interpreter && !word.includes("/")) || word.startsWith("-")) return null;
  const path = resolvePath(word, ctx.ws, ctx.cwd);
  const rel = relative(path, ctx.ws);
  const text = readFile(ctx.tree, ctx.ws, path);
  if (text === null) {
    return cmd.startsWith("python")
      ? { stdout: "", stderr: `${cmd}: can't open file '${path}': [Errno 2] No such file or directory`, exitCode: 2 }
      : { stdout: "", stderr: `/bin/bash: ${word}: No such file or directory`, exitCode: 127 };
  }
  if (!interpreter && !ctx.ws.executables?.includes(rel)) return { stdout: "", stderr: `/bin/bash: ${word}: Permission denied`, exitCode: 126 };
  const printed = ctx.ws.scripts?.[rel];
  if (printed === undefined) return { stdout: "", unknown: true };
  const changed = text !== ctx.ws.files[rel];
  return { stdout: printed, ...(changed ? { note: `${rel} changed during this run; the simulator shows what the original printed.` } : {}) };
}

function echo(args: string[], ctx: Ctx): Output {
  let newline = true;
  let escapes = false;
  let i = 0;
  while (i < args.length && /^-[neE]+$/.test(args[i])) {
    if (args[i].includes("n")) newline = false;
    if (args[i].includes("e")) escapes = true;
    i++;
  }
  let text = args.slice(i).map((a) => expand(a, ctx)).join(" ");
  if (escapes) text = text.replace(/\\n/g, "\n").replace(/\\t/g, "\t");
  return { stdout: newline ? `${text}\n` : text };
}

function printf(args: string[], ctx: Ctx): Output {
  const [format = "", ...rest] = args.map((a) => expand(a, ctx));
  let k = 0;
  const text = format.replace(/%[sd%]|\\n|\\t/g, (m) => (m === "\\n" ? "\n" : m === "\\t" ? "\t" : m === "%%" ? "%" : (rest[k++] ?? "")));
  return { stdout: text };
}

function wc(args: string[], ctx: Ctx): Output {
  const flags = flagLetters(args.filter((a) => /^-[lwc]+$/.test(a)));
  const { texts, errors } = inputs(args.filter((a) => !/^-[lwc]+$/.test(a)), ctx, "wc");
  const out = texts.map(({ name, text }) => {
    const counts = { l: (text.match(/\n/g) ?? []).length, w: text.split(/\s+/).filter(Boolean).length, c: text.length };
    const shown = flags ? [...new Set(flags)].map((f) => counts[f as "l" | "w" | "c"]) : [counts.l, counts.w, counts.c];
    return [...shown, ...(name ? [name] : [])].join(" ");
  });
  return { stdout: joinLines(out), stderr: errors.join("\n"), exitCode: errors.length ? 1 : 0 };
}

/** The output of one stage's command, and what it does to the tree when its writes landed. */
function simulate(argv: string[], ctx: Ctx, landed: readonly Effect[]): Output {
  const cmd = argv.length ? baseName(argv[0]) : "";
  const args = argv.slice(1);
  const words = args.filter((a) => !a.startsWith("-"));
  const { ws, tree } = ctx;
  const lands = (word: string) => {
    const path = followLinks(resolvePath(word, ws, ctx.cwd), ws);
    return landed.some((e) => e.op === "write" && e.path === path);
  };
  const ran = script(argv, ctx);
  if (ran) return ran;
  switch (cmd) {
    case "true":
    case ":":
      return { stdout: "" };
    case "false":
      return { stdout: "", exitCode: 1 };
    case "echo":
      return echo(args, ctx);
    case "printf":
      return printf(args, ctx);
    case "pwd":
      return { stdout: `${ctx.cwd}\n` };
    case "whoami":
      return { stdout: "you\n" };
    case "cd": {
      const path = resolvePath(args[0] ?? ws.home, ws, ctx.cwd);
      if (kindOf(tree, ws, path) !== "dir") return { stdout: "", stderr: `/bin/bash: cd: ${args[0]}: No such file or directory`, exitCode: 1 };
      ctx.cwd = followLinks(path, ws);
      return { stdout: "" };
    }
    case "ls":
      return ls(args, ctx);
    case "cat": {
      const { texts, errors } = inputs(words, ctx, "cat");
      const text = texts.map((t) => t.text).join("");
      // cat -n numbers the lines, right-aligned in six columns and a tab.
      const shown = args.includes("-n") ? joinLines(lines(text).map((l, i) => `${String(i + 1).padStart(6)}\t${l}`)) : text;
      return { stdout: shown, stderr: errors.join("\n"), exitCode: errors.length ? 1 : 0 };
    }
    case "head":
    case "tail": {
      const { n, rest } = lineCount(args);
      const { texts, errors } = inputs(rest.filter((a) => !a.startsWith("-")), ctx, cmd);
      const out = texts.flatMap(({ name, text }, i) => {
        const l = lines(text);
        const part = cmd === "head" ? l.slice(0, n) : l.slice(Math.max(0, l.length - n));
        return texts.length > 1 ? [...(i ? [""] : []), `==> ${name} <==`, ...part] : part;
      });
      return { stdout: joinLines(out), stderr: errors.join("\n"), exitCode: errors.length ? 1 : 0 };
    }
    case "wc":
      return wc(args, ctx);
    case "grep":
      return grep(args, ctx);
    case "test":
    case "[":
      return test(argv, ctx);
    case "git":
      if (args[0] === "status") return gitStatus(args.slice(1), ctx);
      return { stdout: "", unknown: true };
    case "touch":
      for (const w of words) if (lands(w) && kindOf(tree, ws, resolvePath(w, ws, ctx.cwd)) === null) writeFile(tree, ws, resolvePath(w, ws, ctx.cwd), "", false);
      return { stdout: "" };
    case "mkdir": {
      const errors: string[] = [];
      for (const w of words) {
        const path = followLinks(resolvePath(w, ws, ctx.cwd), ws);
        if (kindOf(tree, ws, path) && !args.includes("-p")) errors.push(`mkdir: cannot create directory '${w}': File exists`);
        else if (lands(w) && !kindOf(tree, ws, path)) tree[`${path}/`] = "";
      }
      return { stdout: "", stderr: errors.join("\n"), exitCode: errors.length ? 1 : 0 };
    }
    case "rm": {
      const recursive = args.some((a) => /^-[a-zA-Z]*[rR]/.test(a) || a === "--recursive");
      const force = args.some((a) => /^-[a-zA-Z]*f/.test(a) || a === "--force");
      const errors: string[] = [];
      for (const w of words) {
        const path = resolvePath(w, ws, ctx.cwd);
        const kind = kindOf(tree, ws, path);
        if (!kind) {
          if (!force) errors.push(`rm: cannot remove '${w}': No such file or directory`);
        } else if (kind === "dir" && !recursive) errors.push(`rm: cannot remove '${w}': Is a directory`);
        else if (lands(w)) removePath(tree, path, recursive);
      }
      return { stdout: "", stderr: errors.join("\n"), exitCode: errors.length ? 1 : 0 };
    }
    case "cp":
    case "mv": {
      if (words.length < 2) return { stdout: "", stderr: `${cmd}: missing destination file operand`, exitCode: 1 };
      const dest = words[words.length - 1];
      const errors: string[] = [];
      for (const w of words.slice(0, -1)) {
        const from = resolvePath(w, ws, ctx.cwd);
        const text = readFile(tree, ws, from);
        if (text === null) {
          errors.push(`${cmd}: cannot stat '${w}': No such file or directory`);
          continue;
        }
        const destPath = resolvePath(dest, ws, ctx.cwd);
        const target = kindOf(tree, ws, destPath) === "dir" ? `${destPath}/${baseName(w)}` : destPath;
        if (lands(dest)) {
          writeFile(tree, ws, target, text, false);
          if (cmd === "mv" && lands(w)) removePath(tree, followLinks(from, ws), false);
        }
      }
      return { stdout: "", stderr: errors.join("\n"), exitCode: errors.length ? 1 : 0 };
    }
    case "tee": {
      const text = ctx.stdin ?? "";
      for (const w of words) if (lands(w)) writeFile(tree, ws, resolvePath(w, ws, ctx.cwd), text, args.includes("-a"));
      return { stdout: text };
    }
    default:
      return { stdout: "", unknown: true };
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Running a command

export interface StageRun {
  stage: Stage;
  ran: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  blocked: Effect[];
  landed: Effect[];
  /** Set when the simulator has no output for the command, or has something to say about its answer. */
  note: string | null;
}

export interface SandboxRun {
  launch: Launch;
  host: Host;
  /** "enforcing": the probe's denied write was refused, so the sandbox is trusted. "unavailable": the write landed. "skipped": sandbox off. */
  probe: "enforcing" | "unavailable" | "skipped";
  /** The tool call failed before the command started (an unverified sandbox runs nothing). */
  refused: boolean;
  stages: StageRun[];
  stdout: string;
  stderr: string;
  exitCode: number | null;
  /** Every denied write and blocked connection, which the session event log records. */
  denials: Effect[];
  /** Writes and connections that went through. */
  landed: Effect[];
  parseError: string | null;
  /** What the simulator couldn't answer, for the tool result the model sees. */
  notes: string[];
}

/** The error a blocked write prints: bash's own line for a redirect, the tool's for touch, mkdir and the rest. */
function writeError(e: Effect, ws: Workspace, redirect: boolean): string {
  const shown = shownPath(e.target, ws);
  if (redirect) return `/bin/bash: line 1: ${shown}: Read-only file system`;
  switch (e.command) {
    case "touch":
      return `touch: cannot touch '${shown}': Read-only file system`;
    case "mkdir":
      return `mkdir: cannot create directory '${shown}': Read-only file system`;
    case "rm":
      return `rm: cannot remove '${shown}': Read-only file system`;
    case "git":
      return `fatal: Unable to create '${e.path}': Read-only file system`;
    default:
      return `${e.command}: '${shown}': Read-only file system`;
  }
}

const trimNewline = (text: string) => text.replace(/\n$/, "");

/**
 * Runs a command through the simulated harness: probe, wrap, enforce, or refuse. Pass a tree to keep what the
 * command writes for the next command of the same run; without one, each run starts from the workspace's files.
 */
export function runCommand(command: string, launch: Launch, host: Host, ws: Workspace = SANDBOX_DEMO, tree: Tree = initialTree(ws)): SandboxRun {
  const parsed = parseCommand(command);
  const on = sandboxOn(launch);
  const probe = !on ? "skipped" : host === "enforcing" ? "enforcing" : "unavailable";
  const base: SandboxRun = { launch, host, probe, refused: false, stages: [], stdout: "", stderr: "", exitCode: null, denials: [], landed: [], parseError: parsed.error, notes: [] };
  if (probe === "unavailable") {
    return { ...base, refused: true, stderr: "sandbox enforcement unavailable" };
  }
  const ctx: Ctx = { ws, tree, cwd: ws.root, stdin: null, last: 0 };
  const runs: StageRun[] = [];
  let previous: Stage | null = null;
  let piped: string | null = null;
  for (const stage of parsed.stages) {
    // && runs on success, || on failure, ; and | always.
    const skip = previous ? (previous.next === "&&" && ctx.last !== 0) || (previous.next === "||" && ctx.last === 0) : false;
    ctx.stdin = previous?.next === "|" ? (piped ?? "") : null;
    previous = stage;
    piped = null;
    if (skip) {
      runs.push({ stage, ran: false, stdout: "", stderr: "", exitCode: ctx.last, blocked: [], landed: [], note: null });
      continue;
    }
    const effects = stageEffects(stage, ws, ctx.cwd);
    const blocked: Effect[] = [];
    const landed: Effect[] = [];
    const errors: string[] = [];
    for (const e of effects) {
      if (!on) {
        landed.push(e);
        continue;
      }
      if (e.op === "network") {
        blocked.push(e);
        errors.push(e.command === "curl" ? "curl: (56) Received HTTP code 502 from proxy after CONNECT" : `${e.command}: network egress blocked by the sandbox proxy`);
        continue;
      }
      const verdict = writeVerdict(e.path!, ws);
      if (verdict.writable) landed.push(e);
      else {
        blocked.push(e);
        errors.push(writeError(e, ws, stage.redirects.some((r) => r.target === e.target)));
      }
    }
    const failed = blocked.length > 0;
    const networkFail = blocked.some((b) => b.op === "network" && b.command === "curl");
    // Input redirects feed the command; a blocked output redirect means bash never starts it.
    for (const r of stage.redirects) {
      if (r.op === "<") ctx.stdin = readFile(tree, ws, resolvePath(r.target, ws, ctx.cwd)) ?? "";
      if (r.op === "<<<") ctx.stdin = `${r.target}\n`;
    }
    const argv = unwrap(stage.argv).argv.map((a) => expand(a, ctx));
    const substituted = stage.argv.some((a) => a.includes("$(") || a.includes("`"));
    const redirectBlocked = failed && stage.redirects.some((r) => blocked.some((b) => b.target === r.target));
    const out: Output = redirectBlocked || substituted ? { stdout: "", unknown: substituted } : simulate(argv, ctx, landed);
    // Where stdout and stderr go, redirect by redirect as bash applies them: the terminal (or the next stage), a
    // file the sandbox let through, /dev/null (or a refused file: nothing is written), or each other.
    type Dest = { to: "stdout" } | { to: "stderr" } | { to: "file"; path: string | null };
    let dest1: Dest = { to: "stdout" };
    let dest2: Dest = { to: "stderr" };
    for (const r of stage.redirects) {
      if (r.op === "<" || r.op === "<<<") continue;
      if (r.op === ">&" && /^\d+$/.test(r.target)) {
        if (r.fd === 2 && r.target === "1") dest2 = dest1;
        else if ((r.fd === null || r.fd === 1) && r.target === "2") dest1 = dest2;
        continue;
      }
      const path = r.target === "/dev/null" ? null : followLinks(resolvePath(r.target, ws, ctx.cwd), ws);
      const open = path && landed.some((e) => e.op === "write" && e.path === path) ? path : null;
      // Opening with > truncates (or creates); >> creates a missing file and keeps what's there.
      if (open) writeFile(tree, ws, open, "", r.op.endsWith(">>"));
      const d: Dest = { to: "file", path: open };
      if (r.op.startsWith("&")) {
        dest1 = d;
        dest2 = d;
      } else if (r.fd === 2) dest2 = d;
      else dest1 = d;
    }
    let stdout = "";
    let ownErr = "";
    const route = (text: string, d: Dest) => {
      if (!text) return;
      if (d.to === "stdout") stdout += text;
      else if (d.to === "stderr") ownErr += text;
      else if (d.path) writeFile(tree, ws, d.path, text, true);
    };
    route(out.stdout, dest1);
    route(out.stderr ? `${out.stderr}\n` : "", dest2);
    const stderr = [...errors, ...(ownErr ? [trimNewline(ownErr)] : [])].join("\n");
    if (!on && effects.some((e) => e.op === "network")) stdout = `(sandbox off: the request to ${effects.find((e) => e.op === "network")!.target || "the host"} goes out)\n`;
    const code = failed ? (networkFail ? 56 : 1) : (out.exitCode ?? 0);
    const name = argv[0] ?? "This command";
    const note = out.note ?? (!failed && out.unknown ? (substituted ? `${name}: this simulator doesn't run command substitutions, so it has no output for this stage.` : `${name} ran inside the sandbox; the simulator has no output for it.`) : null);
    if (stage.next === "|") {
      piped = stdout;
      stdout = "";
    }
    runs.push({ stage, ran: true, stdout: trimNewline(stdout), stderr, exitCode: code, blocked, landed, note });
    ctx.last = code;
  }
  const ranStages = runs.filter((r) => r.ran);
  return {
    ...base,
    stages: runs,
    stdout: ranStages.map((r) => r.stdout).filter(Boolean).join("\n"),
    stderr: ranStages.map((r) => r.stderr).filter(Boolean).join("\n"),
    exitCode: parsed.stages.length ? ctx.last : null,
    denials: runs.flatMap((r) => r.blocked),
    landed: runs.flatMap((r) => r.landed),
    notes: ranStages.map((r) => r.note).filter((n): n is string => !!n),
  };
}

/**
 * The tool result the model sees for a run, as JSON text. What the simulator couldn't answer goes in `note`, so the
 * model doesn't take an empty stdout for the command's real output.
 */
export function toolResult(run: SandboxRun): string {
  if (run.refused) return JSON.stringify({ error: "sandbox enforcement unavailable", ran: false });
  return JSON.stringify({
    stdout: run.stdout,
    stderr: run.stderr,
    exit_code: run.exitCode,
    ...(run.notes.length ? { note: `simulated sandbox: ${run.notes.join(" ")}` } : {}),
  });
}

export type StepState = "done" | "failed" | "skipped" | "idle";

/** The contract's five steps for this run, for the walk-through. */
export function contractSteps(run: SandboxRun | null, launch: Launch, host: Host): Array<{ id: string; label: string; state: StepState; detail: string }> {
  const on = sandboxOn(launch);
  const enforcing = on && host === "enforcing";
  return [
    {
      id: "policy",
      label: "1. POLICY",
      state: on ? "done" : "skipped",
      detail: on ? "Workspace and temp roots writable, the rest read-only, network egress restricted" : "Sandbox off for this run: no policy applies",
    },
    {
      id: "probe",
      label: "2. PROBE",
      state: !on ? "skipped" : enforcing ? "done" : "failed",
      detail: !on ? "No probe runs with --yolo or --disable-sandbox" : enforcing ? "The probe's write to a denied path was refused: enforcement is real" : "The probe's write landed: the sandbox is reported unavailable",
    },
    {
      id: "run",
      label: "3. RUN",
      state: !run ? "idle" : !on ? "skipped" : enforcing ? "done" : "failed",
      detail: !on ? "The command runs unprotected" : enforcing ? "The command runs wrapped in the OS sandbox" : "Nothing is wrapped: the probe failed",
    },
    {
      id: "enforce",
      label: "4. ENFORCE",
      state: !on || !enforcing ? "skipped" : !run ? "idle" : run.denials.length ? "done" : "skipped",
      detail: !on || !enforcing
        ? "Nothing is enforced on this run"
        : run && run.denials.length
          ? `${run.denials.length} operation(s) blocked by the OS and recorded in the session event log`
          : "Nothing in this command crossed a boundary",
    },
    {
      id: "refuse",
      label: "5. REFUSE",
      state: on && !enforcing ? "done" : "skipped",
      detail: on && !enforcing ? "The tool call fails with sandbox enforcement unavailable before the command starts" : "Only when the probe fails",
    },
  ];
}
