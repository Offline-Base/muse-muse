import { parseCommand, type Stage } from "@/components/docs/playgrounds/muse-code/permissions";

/**
 * The mini agent loop's simulated shell: enough of a POSIX shell over an in-memory repository for the commands models
 * actually send. It reuses the permissions model's parser for stages, quotes and redirections, so it runs pipelines, `&&`, `||` and `;`, globs (`src/*`, `**`), `cd` within the repo, `<` and `>` redirections, and
 * ls, find, tree, cat, head, tail, wc, grep and rg, sed -n, echo, pwd, git status, diff, log and ls-files, and the
 * project's test command. Anything else says what it can run, so the model can adapt. Pure: files in, files out.
 */

export type Files = Record<string, string>;

export interface ShellContext {
  /** The repository before the run, for git status and git diff. */
  original: Files;
  /** The project's test command. */
  runTests(files: Files): { output: string; failed: number };
}

export interface ShellRun {
  output: string;
  isError: boolean;
  files: Files;
}

export const ROOT = "/workspace/signup-service";

const HEREDOC = /^cat\s+(?:>\s*([\w./-]+)\s+<<-?\s*['"]?(\w+)['"]?|<<-?\s*['"]?(\w+)['"]?\s*>\s*([\w./-]+))\s*\n([\s\S]*?)\n\s*(\w+)\s*$/;

const HELP = "This simulated workspace runs ls, find, tree, cat, head, tail, wc, grep, rg, sed -n, echo, pwd, cd, git status, git diff, git log and npm test. Edit files with the edit tool.";

function lineCount(text: string): number {
  return text ? text.split("\n").length - (text.endsWith("\n") ? 1 : 0) : 0;
}

/** A repo-relative path for an argument, from the current directory (also relative to the repo root). */
export function resolvePath(arg: string, cwd: string): string {
  let p = arg.trim();
  if (p.startsWith(ROOT)) p = p.slice(ROOT.length);
  const parts = p.startsWith("/") ? [] : cwd.split("/").filter(Boolean);
  for (const seg of p.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return parts.join("/");
}

function dirs(files: Files): Set<string> {
  const out = new Set<string>([""]);
  for (const f of Object.keys(files)) {
    const parts = f.split("/");
    for (let i = 1; i < parts.length; i++) out.add(parts.slice(0, i).join("/"));
  }
  return out;
}

function isDir(path: string, files: Files): boolean {
  return dirs(files).has(path);
}

/** Expands *, ? and ** in one argument against the repository. An argument with no match stays as it is. */
export function expandGlob(arg: string, cwd: string, files: Files): string[] {
  if (!/[*?]/.test(arg)) return [resolvePath(arg, cwd)];
  const pattern = resolvePath(arg, cwd);
  const source = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\/?/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\u0000/g, "(?:.*/)?");
  const re = new RegExp(`^${source}$`);
  const hits = [...Object.keys(files), ...dirs(files)].filter((p) => p && re.test(p)).sort();
  return hits.length ? hits : [pattern];
}

function display(path: string, cwd: string): string {
  if (!cwd) return path;
  return path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : `${ROOT}/${path}`;
}

interface Result {
  out: string;
  err: boolean;
  files: Files;
  cwd: string;
  /** The output is an error message (stderr), which 2>/dev/null drops. */
  stderr?: boolean;
}

/** Reads "-n 5", "-5", "-n5" and "--lines=5" for head and tail. */
function countFlag(words: string[]): { n: number; rest: string[] } {
  let n = 10;
  const rest: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    let m: RegExpExecArray | null;
    if (w === "-n" && words[i + 1] !== undefined) n = Number(words[++i]) || 10;
    else if ((m = /^-n?(\d+)$/.exec(w)) || (m = /^--lines=(\d+)$/.exec(w))) n = Number(m[1]);
    else rest.push(w);
  }
  return { n, rest };
}

function run(words: string[], stdin: string | null, files: Files, cwd: string, ctx: ShellContext): Result {
  const ok = (out: string, f: Files = files, c: string = cwd): Result => ({ out, err: false, files: f, cwd: c });
  const fail = (out: string): Result => ({ out, err: true, files, cwd, stderr: true });
  const [cmd = "", ...rest] = words;
  const exists = (p: string) => p in files || isDir(p, files);
  const read = (args: string[], name: string): { text: string; problem: string | null } => {
    if (!args.length) return { text: stdin ?? "", problem: null };
    const parts: string[] = [];
    for (const a of args) {
      for (const p of expandGlob(a, cwd, files)) {
        if (isDir(p, files)) return { text: "", problem: `${name}: ${a}: Is a directory` };
        if (!(p in files)) return { text: "", problem: `${name}: ${a}: No such file or directory` };
        parts.push(files[p]);
      }
    }
    return { text: parts.join(""), problem: null };
  };

  switch (cmd) {
    case "pwd":
      return ok(cwd ? `${ROOT}/${cwd}` : ROOT);
    case "echo":
      return ok(rest.filter((w) => w !== "-n" && w !== "-e").join(" "));
    case "true":
    case ":":
      return ok("");
    case "false":
      return { out: "", err: true, files, cwd };
    case "cd": {
      const target = resolvePath(rest[0] ?? "", rest[0] ? cwd : "");
      return isDir(target, files) ? ok("", files, target) : fail(`cd: ${rest[0]}: No such file or directory`);
    }
    case "ls": {
      const recursive = rest.some((w) => /^-[a-zA-Z]*R/.test(w));
      const targets = rest.filter((w) => !w.startsWith("-"));
      const paths = targets.length ? targets.flatMap((t) => expandGlob(t, cwd, files)) : [cwd];
      const out: string[] = [];
      for (const p of paths) {
        if (p in files) {
          out.push(display(p, cwd));
          continue;
        }
        if (!isDir(p, files)) return fail(`ls: ${p || "."}: No such file or directory`);
        const prefix = p ? `${p}/` : "";
        const under = Object.keys(files).filter((f) => f.startsWith(prefix)).map((f) => f.slice(prefix.length)).sort();
        const entries = recursive ? under : [...new Set(under.map((f) => (f.includes("/") ? `${f.split("/")[0]}/` : f)))];
        if (paths.length > 1) out.push(`${p || "."}:`);
        out.push(...entries);
      }
      return ok(out.join("\n"));
    }
    case "tree":
    case "find": {
      let root = cwd;
      let i = 0;
      if (cmd === "find" && rest[0] && !rest[0].startsWith("-")) {
        root = resolvePath(rest[0], cwd);
        i = 1;
      }
      let type: string | null = null;
      let name: RegExp | null = null;
      for (; i < rest.length; i++) {
        if (rest[i] === "-type") type = rest[++i] ?? null;
        else if (rest[i] === "-name" || rest[i] === "-iname") {
          const g = (rest[++i] ?? "*").replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
          name = new RegExp(`^${g}$`, rest[i - 1] === "-iname" ? "i" : "");
        } else if (rest[i] === "-maxdepth" || rest[i] === "-mindepth") i++;
      }
      if (root && !exists(root)) return fail(`find: ${rest[0]}: No such file or directory`);
      const prefix = root ? `${root}/` : "";
      const pool = [...(type === "d" ? [] : Object.keys(files)), ...(type === "f" ? [] : [...dirs(files)].filter(Boolean))];
      const hits = pool.filter((p) => p.startsWith(prefix) && (!name || name.test(p.split("/").pop() ?? ""))).sort();
      const base = cmd === "find" ? (rest[0] && !rest[0].startsWith("-") ? rest[0].replace(/\/$/, "") : ".") : ".";
      return ok(hits.map((p) => `${base}/${p.slice(prefix.length)}`).join("\n"));
    }
    case "cat": {
      const { text, problem } = read(rest.filter((w) => !w.startsWith("-")), "cat");
      return problem ? fail(problem) : ok(text.replace(/\n$/, ""));
    }
    case "head":
    case "tail": {
      const { n, rest: args } = countFlag(rest);
      const { text, problem } = read(args, cmd);
      if (problem) return fail(problem);
      const all = text.replace(/\n$/, "").split("\n");
      return ok((cmd === "head" ? all.slice(0, n) : all.slice(-n)).join("\n"));
    }
    case "wc": {
      const onlyLines = rest.some((w) => /^-[a-zA-Z]*l/.test(w));
      const args = rest.filter((w) => !w.startsWith("-"));
      const fmt = (t: string) => (onlyLines ? String(lineCount(t)) : `${lineCount(t)} ${t.split(/\s+/).filter(Boolean).length} ${new TextEncoder().encode(t).length}`);
      if (!args.length) return ok(fmt(stdin ?? ""));
      const names = args.flatMap((a) => expandGlob(a, cwd, files));
      const out: string[] = [];
      let total = "";
      for (const p of names) {
        if (!(p in files)) return fail(`wc: ${p}: No such file or directory`);
        out.push(`${fmt(files[p])} ${display(p, cwd)}`);
        total += files[p];
      }
      if (names.length > 1) out.push(`${fmt(total)} total`);
      return ok(out.join("\n"));
    }
    case "grep":
    case "egrep":
    case "rg": {
      let i = 0;
      const opts = new Set<string>();
      let pattern: string | null = null;
      const paths: string[] = [];
      for (; i < rest.length; i++) {
        const w = rest[i];
        if (w === "-e") pattern = rest[++i] ?? "";
        else if (w === "--") {
          const tail = rest.slice(i + 1);
          if (pattern === null) pattern = tail.shift() ?? null;
          paths.push(...tail);
          break;
        } else if (/^-[a-zA-Z]+$/.test(w)) for (const c of w.slice(1)) opts.add(c);
        else if (w.startsWith("--")) opts.add(w);
        else if (pattern === null) pattern = w;
        else paths.push(w);
      }
      if (pattern === null) return fail(`usage: ${cmd} PATTERN [FILE...]`);
      let re: RegExp;
      try {
        re = new RegExp(opts.has("F") ? pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : pattern.replace(/\\\|/g, "|"), opts.has("i") ? "i" : "");
      } catch {
        re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), opts.has("i") ? "i" : "");
      }
      const recursive = cmd === "rg" || opts.has("r") || opts.has("R");
      const numbered = opts.has("n") || cmd === "rg";
      let sources: Array<{ name: string | null; text: string }>;
      if (paths.length) {
        sources = [];
        for (const a of paths) {
          for (const p of expandGlob(a, cwd, files)) {
            if (p in files) sources.push({ name: display(p, cwd), text: files[p] });
            else if (isDir(p, files) && recursive) {
              for (const f of Object.keys(files).sort()) if (f.startsWith(p ? `${p}/` : "")) sources.push({ name: display(f, cwd), text: files[f] });
            } else if (isDir(p, files)) return fail(`${cmd}: ${a}: Is a directory`);
            else return fail(`${cmd}: ${a}: No such file or directory`);
          }
        }
      } else if (stdin !== null) sources = [{ name: null, text: stdin }];
      else if (recursive) sources = Object.keys(files).filter((f) => f.startsWith(cwd ? `${cwd}/` : "")).sort().map((f) => ({ name: display(f, cwd), text: files[f] }));
      else return fail(`${cmd}: no file given (and no input to read)`);
      const showName = sources.length > 1 || recursive;
      const out: string[] = [];
      for (const s of sources) {
        const matches = s.text.split("\n").map((l, n) => ({ l, n: n + 1 })).filter(({ l }) => re.test(l) !== opts.has("v"));
        if (opts.has("l")) {
          if (matches.length && s.name) out.push(s.name);
        } else if (opts.has("c")) out.push(`${showName && s.name ? `${s.name}:` : ""}${matches.length}`);
        else for (const m of matches) out.push(`${showName && s.name ? `${s.name}:` : ""}${numbered ? `${m.n}:` : ""}${m.l}`);
      }
      return out.length ? ok(out.join("\n")) : { out: "", err: true, files, cwd };
    }
    case "sed": {
      const script = rest.find((w) => /^\d+(,\d+)?p$/.test(w));
      if (!rest.includes("-n") || !script) return fail(`sed: only sed -n 'START,ENDp' FILE is simulated here. ${HELP}`);
      const [a, b] = script.slice(0, -1).split(",").map(Number);
      const { text, problem } = read(rest.filter((w) => w !== "-n" && w !== script), "sed");
      if (problem) return fail(problem);
      return ok(text.split("\n").slice(a - 1, (b ?? a)).join("\n"));
    }
    case "git": {
      const sub = rest[0] ?? "";
      const changed = Object.keys(files).filter((f) => ctx.original[f] !== files[f]).sort();
      if (sub === "status") return ok(changed.length ? changed.map((f) => ` ${f in ctx.original ? "M" : "??"} ${f}`).join("\n") : "nothing to commit, working tree clean");
      if (sub === "diff") return ok(diffOf(ctx.original, files) || "");
      if (sub === "log") return ok("3f9c2ab (HEAD -> main) Add the signup handler and its tests");
      if (sub === "ls-files") return ok(Object.keys(ctx.original).sort().join("\n"));
      return fail(`git ${sub}: not simulated. ${HELP}`);
    }
    case "npm":
    case "node":
    case "pnpm":
    case "yarn": {
      const line = words.join(" ");
      if (/^(npm|pnpm|yarn) (test|t|run test)\b/.test(line) || /^node --test\b/.test(line)) {
        const t = ctx.runTests(files);
        return { out: t.output, err: t.failed > 0, files, cwd };
      }
      return fail(`${line}: only the test command (npm test) is simulated. ${HELP}`);
    }
    case "":
      return ok("");
    default:
      return fail(`${cmd}: command not found. ${HELP}`);
  }
}

export function diffOf(original: Files, files: Files): string {
  const changed = Object.keys(files).filter((f) => original[f] !== files[f]).sort();
  return changed
    .map((f) => {
      const a = (original[f] ?? "").split("\n");
      const b = files[f].split("\n");
      const out = [`diff --git a/${f} b/${f}`, `--- ${f in original ? `a/${f}` : "/dev/null"}`, `+++ b/${f}`];
      for (const l of a) if (l && !b.includes(l)) out.push(`-${l}`);
      for (const l of b) if (l && !a.includes(l)) out.push(`+${l}`);
      return out.join("\n");
    })
    .join("\n");
}

/** Runs a command line: pipelines bind tighter than && and ||, which bind tighter than ; and &. */
export function simShell(command: string, files: Files, ctx: ShellContext): ShellRun {
  const heredoc = HEREDOC.exec(command.trim());
  if (heredoc) {
    const path = resolvePath(heredoc[1] ?? heredoc[4], "");
    const tag = heredoc[2] ?? heredoc[3];
    if (heredoc[6] !== tag) return { output: "The here-document never ends with its closing tag.", isError: true, files };
    const next = { ...files, [path]: `${heredoc[5]}\n` };
    return { output: `Wrote ${path} (${lineCount(next[path])} lines).`, isError: false, files: next };
  }
  const parsed = parseCommand(command);
  if (parsed.problem) return { output: `${parsed.problem} ${HELP}`, isError: true, files };

  // Group the stages into pipelines, each with the separator before it.
  const pipelines: Array<{ before: Stage["before"]; stages: Stage[] }> = [];
  for (const s of parsed.stages) {
    if (s.before === "|" && pipelines.length) pipelines[pipelines.length - 1].stages.push(s);
    else pipelines.push({ before: s.before, stages: [s] });
  }

  let current = files;
  let cwd = "";
  let failed = false;
  const outputs: string[] = [];
  for (const p of pipelines) {
    if ((p.before === "&&" && failed) || (p.before === "||" && !failed)) continue;
    let stdin: string | null = null;
    let last: Result = { out: "", err: false, files: current, cwd };
    for (const stage of p.stages) {
      let input = stdin;
      for (const r of stage.redirects) {
        if (r.op === "<") {
          const path = resolvePath(r.target, cwd);
          if (!(path in current)) return { output: [...outputs, `${r.target}: No such file or directory`].join("\n"), isError: true, files: current };
          input = current[path];
        }
      }
      const words = stage.words.filter((w, i, all) => !(/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) && all.slice(0, i).every((x) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(x))));
      last = run(words, input, current, cwd, ctx);
      current = last.files;
      cwd = last.cwd;
      let out = last.out;
      for (const r of stage.redirects) {
        // Input redirections were read above; fd duplications (2>&1, >&2) keep everything on the screen.
        if (!/>/.test(r.op) || /&$/.test(r.op) || /^&?\d$/.test(r.target)) continue;
        const both = r.op.startsWith("&");
        const errStream = /^2/.test(r.op);
        // stdout redirections take normal output; 2> takes error text; &> takes both.
        if (!both && errStream !== Boolean(last.stderr)) continue;
        if (r.target === "/dev/null") {
          out = "";
          continue;
        }
        if (r.target.startsWith("/") && !r.target.startsWith(ROOT) && !r.target.startsWith("/tmp")) {
          return { output: [...outputs, `${r.target}: Read-only file system`].join("\n"), isError: true, files: current };
        }
        const path = resolvePath(r.target, cwd);
        const text = out ? `${out}\n` : "";
        current = { ...current, [path]: r.op.includes(">>") ? `${current[path] ?? ""}${text}` : text };
        out = "";
      }
      stdin = out;
      last = { ...last, out, files: current };
    }
    failed = last.err;
    if (last.out) outputs.push(last.out);
  }
  const output = outputs.join("\n");
  return { output: output || (failed ? "(no output, exit status 1)" : "(no output)"), isError: failed, files: current };
}
