/**
 * Splits a compound shell command into stages the way the staged-approvals recipe describes Muse Code's parser: an
 * ordered list, each stage with its own argv and an argv_complete flag. A stage is incomplete when the parser can't
 * read it completely: a variable-assignment prefix, a command substitution, or a redirect that isn't read-only. The
 * command itself always runs as the original text; stages exist only to be judged one by one.
 *
 * This is a small POSIX-ish reader for the demos, not a full shell: quotes, escapes, $(...) and backticks, the
 * operators && || ; | & and newlines, and redirects. Anything it can't follow (an unclosed quote, a subshell, a
 * heredoc) is a parse error, which the demos treat as fail-closed.
 */

export interface Redirect {
  /** ">", ">>", "<", "<<<", ">&", "&>", "&>>", ">|" */
  op: string;
  /** The file descriptor before the operator, when one was written (2 in 2>err.log). */
  fd: number | null;
  /** The target word, quotes removed ("/dev/null", "out.txt", "1" for 2>&1). */
  target: string;
  /** Read-only: input redirects, descriptor copies (2>&1) and writes to /dev/null. */
  readOnly: boolean;
}

export interface Stage {
  index: number;
  /** Where the stage starts in the raw command (the log's source_position). */
  sourcePosition: number;
  /** The stage's own text, trimmed. */
  text: string;
  /** Words after any NAME=value prefixes, quotes removed. Substitutions stay as written ($(whoami)). */
  argv: string[];
  /** NAME=value words before the command. */
  assignments: string[];
  redirects: Redirect[];
  argvComplete: boolean;
  /** Why argv_complete is false, in the recipe's words. */
  incompleteReasons: string[];
  /** The operator after this stage: "&&", "||", ";", "|", "&", or null for the last. */
  next: string | null;
}

export interface ParsedCommand {
  raw: string;
  stages: Stage[];
  /** Set when the reader couldn't follow the command; stages then holds what it read before the problem. */
  error: string | null;
}

const SEPARATORS = ["&&", "||", ";", "|", "&", "\n"] as const;

interface Word {
  text: string;
  start: number;
  quoted: boolean;
  substitution: boolean;
}

interface RawStage {
  start: number;
  end: number;
  words: Word[];
  redirects: Redirect[];
  next: string | null;
}

/** Reads `$(` ... `)` from i (at the `$`), returning the index after the closing paren, or -1. */
function readSubstitution(cmd: string, i: number): number {
  let depth = 0;
  for (let j = i + 1; j < cmd.length; j++) {
    const c = cmd[j];
    if (c === "\\") {
      j++;
      continue;
    }
    if (c === "'") {
      const close = cmd.indexOf("'", j + 1);
      if (close < 0) return -1;
      j = close;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return j + 1;
    }
  }
  return -1;
}

function isReadOnly(op: string, target: string): boolean {
  if (op === "<" || op === "<<<") return true;
  // A descriptor copy (2>&1, >&2) writes no file.
  if (op === ">&") return /^\d+$|^-$/.test(target);
  return target === "/dev/null";
}

/** Splits and reads the command. Never throws. */
export function parseCommand(raw: string): ParsedCommand {
  const cmd = raw;
  const stages: RawStage[] = [];
  let current: RawStage = { start: 0, end: 0, words: [], redirects: [], next: null };
  // Mutable reader state lives in one object: closures change it, and TypeScript can't follow a closure's writes to a local.
  const st: { word: Word | null; pending: { op: string; fd: number | null } | null } = { word: null, pending: null };
  let error: string | null = null;
  let started = false;

  const begin = (at: number) => {
    if (!started) {
      current.start = at;
      started = true;
    }
  };
  const pushWord = () => {
    if (!st.word) return;
    if (st.pending) {
      current.redirects.push({ op: st.pending.op, fd: st.pending.fd, target: st.word.text, readOnly: isReadOnly(st.pending.op, st.word.text) });
      st.pending = null;
    } else {
      current.words.push(st.word);
    }
    st.word = null;
  };
  const wordAt = (at: number): Word => {
    begin(at);
    if (!st.word) st.word = { text: "", start: at, quoted: false, substitution: false };
    return st.word;
  };
  const endStage = (op: string | null, at: number) => {
    pushWord();
    if (st.pending) error = error ?? "A redirect has no target.";
    current.end = at;
    current.next = op;
    if (current.words.length || current.redirects.length) stages.push(current);
    else if (op && op !== ";") error = error ?? `Nothing before "${op}".`;
    current = { start: at, end: at, words: [], redirects: [], next: null };
    started = false;
  };

  let i = 0;
  while (i < cmd.length && !error) {
    const c = cmd[i];
    if (c === "#" && !st.word) {
      // A comment runs to the end of the line.
      const nl = cmd.indexOf("\n", i);
      i = nl < 0 ? cmd.length : nl;
      continue;
    }
    const sep = SEPARATORS.find((x) => cmd.startsWith(x, i));
    if (sep && !(sep === "&" && cmd[i + 1] === ">")) {
      endStage(sep === "\n" ? ";" : sep, i);
      i += sep.length;
      continue;
    }
    if (c === " " || c === "\t") {
      pushWord();
      i++;
      continue;
    }
    if (c === ">" || c === "<" || c === "&") {
      const m = /^(&>>|&>|>>|>\||>&|<<<|<<|>|<)/.exec(cmd.slice(i));
      if (m) {
        if (m[1] === "<<") {
          error = "Heredocs aren't supported by this reader.";
          break;
        }
        // Digits typed right before the operator name the descriptor (2>err.log).
        let fd: number | null = null;
        if (st.word && !st.word.quoted && /^\d+$/.test(st.word.text) && st.word.start + st.word.text.length === i) {
          fd = Number(st.word.text);
          st.word = null;
        } else {
          pushWord();
        }
        if (st.pending) {
          error = "A redirect has no target.";
          break;
        }
        begin(i);
        st.pending = { op: m[1], fd };
        i += m[1].length;
        continue;
      }
    }
    if (c === "(" || c === ")" || (c === "{" && !st.word && /\s/.test(cmd[i + 1] ?? ""))) {
      error = "Subshells and command groups aren't supported by this reader.";
      break;
    }
    if (c === "\\") {
      const w = wordAt(i);
      if (i + 1 < cmd.length && cmd[i + 1] !== "\n") w.text += cmd[i + 1];
      i += 2;
      continue;
    }
    if (c === "'") {
      const close = cmd.indexOf("'", i + 1);
      if (close < 0) {
        error = "A single quote is never closed.";
        break;
      }
      const w = wordAt(i);
      w.text += cmd.slice(i + 1, close);
      w.quoted = true;
      i = close + 1;
      continue;
    }
    if (c === '"') {
      const w = wordAt(i);
      w.quoted = true;
      let j = i + 1;
      let closed = false;
      while (j < cmd.length) {
        const d = cmd[j];
        if (d === "\\" && j + 1 < cmd.length) {
          w.text += cmd[j + 1];
          j += 2;
          continue;
        }
        if (d === '"') {
          closed = true;
          break;
        }
        if (d === "$" && cmd[j + 1] === "(") {
          const end = readSubstitution(cmd, j);
          if (end < 0) break;
          w.text += cmd.slice(j, end);
          w.substitution = true;
          j = end;
          continue;
        }
        if (d === "`") {
          const end = cmd.indexOf("`", j + 1);
          if (end < 0) break;
          w.text += cmd.slice(j, end + 1);
          w.substitution = true;
          j = end + 1;
          continue;
        }
        w.text += d;
        j++;
      }
      if (!closed) {
        error = "A double quote is never closed.";
        break;
      }
      i = j + 1;
      continue;
    }
    if ((c === "$" && cmd[i + 1] === "(") || c === "`") {
      const end = c === "`" ? cmd.indexOf("`", i + 1) + 1 : readSubstitution(cmd, i);
      if (end <= 0) {
        error = c === "`" ? "A backtick substitution is never closed." : "A command substitution $( ) is never closed.";
        break;
      }
      const w = wordAt(i);
      w.text += cmd.slice(i, end);
      w.substitution = true;
      i = end;
      continue;
    }
    wordAt(i).text += c;
    i++;
  }
  if (!error) endStage(null, cmd.length);
  else {
    pushWord();
    current.end = cmd.length;
    if (current.words.length || current.redirects.length) stages.push(current);
  }

  const out: Stage[] = stages.map((st, index) => {
    const assignments: string[] = [];
    let k = 0;
    while (k < st.words.length && !st.words[k].quoted && /^[A-Za-z_][A-Za-z0-9_]*=/.test(st.words[k].text)) {
      assignments.push(st.words[k].text);
      k++;
    }
    const reasons: string[] = [];
    if (assignments.length) reasons.push("variable-assignment prefix");
    if (st.words.some((w) => w.substitution)) reasons.push("command substitution");
    if (st.redirects.some((r) => !r.readOnly)) reasons.push("a redirect that isn't read-only");
    if (error && index === stages.length - 1) reasons.push("the reader couldn't finish parsing it");
    return {
      index,
      sourcePosition: st.start,
      text: cmd.slice(st.start, st.end).trim(),
      argv: st.words.slice(k).map((w) => w.text),
      assignments,
      redirects: st.redirects,
      argvComplete: reasons.length === 0 && !error,
      incompleteReasons: reasons,
      next: st.next,
    };
  });
  if (!out.length && !error) return { raw, stages: [], error: "Type a command." };
  return { raw, stages: out, error };
}

/** The command word once wrappers that run another command (sudo, setsid) and their options are set aside. */
export function unwrap(argv: readonly string[]): { wrappers: string[]; argv: string[] } {
  const wrappers: string[] = [];
  let i = 0;
  while (i < argv.length && (argv[i] === "sudo" || argv[i] === "setsid")) {
    wrappers.push(argv[i]);
    i++;
    while (i < argv.length && argv[i].startsWith("-")) {
      // sudo -u root: the option's value is not the command.
      if (["-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-U"].includes(argv[i])) i++;
      i++;
    }
  }
  return { wrappers, argv: argv.slice(i) };
}

export function baseName(word: string): string {
  return word.replace(/^.*\//, "");
}

/** On the recipe's dangerous list: rm -f or rm -rf, including when wrapped in sudo or setsid. */
export function isDangerous(argv: readonly string[]): boolean {
  const inner = unwrap(argv).argv;
  if (!inner.length || baseName(inner[0]) !== "rm") return false;
  return inner.slice(1).some((a) => a === "--force" || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(a));
}

/** Read-only commands this simulator clears as known_safe. The recipe names ls, cat, wc, grep "and a small fixed set"; its example clears echo. */
export const READ_ONLY_COMMANDS: readonly string[] = [
  "ls", "cat", "wc", "grep", "echo", "head", "tail", "pwd", "printf", "sort", "uniq", "cut", "stat", "file", "du", "df",
  "which", "date", "whoami", "true", "basename", "dirname", "realpath",
];

const READ_ONLY_GIT = new Set(["status", "log", "diff", "show"]);

/** Provably read-only: an allowlisted command (or a read-only git subcommand), with a complete argv. */
export function isReadOnlyStage(stage: Stage): boolean {
  if (!stage.argvComplete || !stage.argv.length) return false;
  const [cmd, sub] = [baseName(stage.argv[0]), stage.argv[1]];
  if (cmd === "git") return !!sub && READ_ONLY_GIT.has(sub);
  return READ_ONLY_COMMANDS.includes(cmd);
}

/** Interpreters and wrappers: everything after them is arbitrary code, so they never get a persistent prefix. */
export const NO_PREFIX_COMMANDS: readonly string[] = [
  "python", "python3", "bash", "sh", "zsh", "node", "perl", "ruby", "php", "env", "sudo", "setsid", "xargs", "npx",
];

const SUBCOMMAND_TOOLS = new Set(["cargo", "npm", "pnpm", "yarn", "go", "git", "docker", "kubectl", "gh", "pip", "pip3", "uv", "make", "bun", "deno"]);

/**
 * The argv prefix a workspace grant would record ("cargo test", "rm"), or null when the stage can't have one: an
 * incomplete or empty argv, an interpreter or wrapper, or a bare git.
 */
export function prefixSuggestion(stage: Stage): string[] | null {
  if (!stage.argvComplete || !stage.argv.length) return null;
  const cmd = baseName(stage.argv[0]);
  if (NO_PREFIX_COMMANDS.includes(cmd)) return null;
  const sub = stage.argv[1];
  if (SUBCOMMAND_TOOLS.has(cmd)) {
    if (sub && !sub.startsWith("-")) return [stage.argv[0], sub];
    return cmd === "git" ? null : [stage.argv[0]];
  }
  return [stage.argv[0]];
}

/** True when argv starts with the prefix, word for word. */
export function startsWith(argv: readonly string[], prefix: readonly string[]): boolean {
  return prefix.length > 0 && prefix.length <= argv.length && prefix.every((p, i) => argv[i] === p);
}
