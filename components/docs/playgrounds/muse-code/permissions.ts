/**
 * A teaching model of Muse Code's two guardrails (content/meta-docs/pages/muse-code/permissions.md): approval, which
 * parses a compound shell command into ordered stages and blocks on the first one it can't approve, and the OS
 * sandbox, which limits writes to the workspace and temp directory and gates the network. The stage rules come from
 * the page and its changelog (destructive removal forms, ripgrep helper options, find -exec and xargs launches,
 * wrappers checked for what they launch, shell scripts that aren't -c/-lc, commands that can't be fully parsed).
 *
 * It is a model, not Muse Code's parser: commands outside its lists are held for review and say so, rather than
 * guessing what Muse Code's own lists allow. Pure, so the simulator and its tests agree.
 */

// ---------------------------------------------------------------------------------------------------------------
// Parsing

export type Separator = "&&" | "||" | ";" | "|" | "&";

export interface Redirect {
  op: string;
  target: string;
}

export interface Stage {
  /** The words after quote removal, assignments (VAR=value) first if any. */
  words: string[];
  /** The stage as written. */
  text: string;
  redirects: Redirect[];
  /** The separator before this stage (null for the first). */
  before: Separator | null;
}

export interface Parsed {
  stages: Stage[];
  /** Why the command can't be split into reviewable stages, if it can't. */
  problem: string | null;
}

const CONTROL = new Set(["if", "then", "else", "elif", "fi", "for", "while", "until", "do", "done", "case", "esac", "function", "select"]);

interface Token {
  kind: "word" | "sep" | "redir";
  value: string;
  start: number;
  end: number;
}

function tokenize(input: string): { tokens: Token[]; problem: string | null } {
  const tokens: Token[] = [];
  let i = 0;
  let word = "";
  let wordStart = -1;
  let hasWord = false;
  const pushWord = (end: number) => {
    if (hasWord) tokens.push({ kind: "word", value: word, start: wordStart, end });
    word = "";
    hasWord = false;
    wordStart = -1;
  };
  const begin = () => {
    if (!hasWord) {
      hasWord = true;
      wordStart = i;
    }
  };
  while (i < input.length) {
    const c = input[i];
    const two = input.slice(i, i + 2);
    if (c === " " || c === "\t") {
      pushWord(i);
      i++;
      continue;
    }
    if (c === "\n") {
      pushWord(i);
      tokens.push({ kind: "sep", value: ";", start: i, end: i + 1 });
      i++;
      continue;
    }
    if (c === "'") {
      begin();
      const close = input.indexOf("'", i + 1);
      if (close < 0) return { tokens, problem: "A quote is never closed, so the command can't be fully parsed." };
      word += input.slice(i + 1, close);
      i = close + 1;
      continue;
    }
    if (c === '"') {
      begin();
      let j = i + 1;
      let closed = false;
      while (j < input.length) {
        const d = input[j];
        if (d === "\\" && j + 1 < input.length) {
          word += input[j + 1];
          j += 2;
          continue;
        }
        if (d === '"') {
          closed = true;
          break;
        }
        if (d === "`" || input.startsWith("$(", j)) return { tokens, problem: "Command substitution runs a command inside another, which the parser can't review stage by stage." };
        word += d;
        j++;
      }
      if (!closed) return { tokens, problem: "A quote is never closed, so the command can't be fully parsed." };
      i = j + 1;
      continue;
    }
    if (c === "\\") {
      begin();
      if (i + 1 < input.length && input[i + 1] !== "\n") word += input[i + 1];
      i += 2;
      continue;
    }
    if (c === "`" || two === "$(") return { tokens, problem: "Command substitution runs a command inside another, which the parser can't review stage by stage." };
    if (c === "(" || c === ")") return { tokens, problem: "Shell grouping (a subshell in parentheses) produces no reviewable stages." };
    if (two === "<<") return { tokens, problem: "A here-document feeds text the parser can't review as a stage." };
    if (two === "&&" || two === "||") {
      pushWord(i);
      tokens.push({ kind: "sep", value: two, start: i, end: i + 2 });
      i += 2;
      continue;
    }
    if (c === ">" || c === "<" || two === "&>") {
      const next = input[i + 1];
      const op =
        two === "&>"
          ? input[i + 2] === ">" ? "&>>" : "&>"
          : c === "<"
            ? "<"
            : next === ">" ? ">>" : next === "|" ? ">|" : next === "&" ? ">&" : ">";
      // A digit word right before a redirection is its file descriptor (2>, 1>>, 2>&1).
      if (c !== "&" && hasWord && /^\d+$/.test(word) && wordStart === i - word.length) {
        const fd = word;
        word = "";
        hasWord = false;
        tokens.push({ kind: "redir", value: `${fd}${op}`, start: i - fd.length, end: i + op.length });
      } else {
        pushWord(i);
        tokens.push({ kind: "redir", value: op, start: i, end: i + op.length });
      }
      i += op.length;
      continue;
    }
    if (c === ";" || c === "|" || c === "&") {
      pushWord(i);
      tokens.push({ kind: "sep", value: c, start: i, end: i + 1 });
      i++;
      continue;
    }
    begin();
    word += c;
    i++;
  }
  pushWord(i);
  return { tokens, problem: null };
}

/** Splits a command into ordered stages, or says why it can't be split safely. */
export function parseCommand(input: string): Parsed {
  const text = input.trim();
  if (!text) return { stages: [], problem: null };
  const { tokens, problem } = tokenize(text);
  if (problem) return { stages: [], problem };
  const stages: Stage[] = [];
  let words: string[] = [];
  let redirects: Redirect[] = [];
  let start = -1;
  let end = -1;
  let before: Separator | null = null;
  const flush = (sep: Separator | null) => {
    if (words.length || redirects.length) {
      stages.push({ words, text: text.slice(start, end).trim(), redirects, before });
    }
    words = [];
    redirects = [];
    start = -1;
    before = sep;
  };
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.kind === "sep") {
      if (!words.length && !redirects.length) {
        // Blank lines and stray semicolons separate nothing; a dangling && || or | is a parse error.
        if (t.value === ";") continue;
        return { stages: [], problem: `An operator (${t.value}) with no command before it can't be parsed.` };
      }
      flush(t.value as Separator);
      continue;
    }
    if (start < 0) start = t.start;
    end = t.end;
    if (t.kind === "redir") {
      const target = tokens[k + 1];
      if (!target || target.kind !== "word") return { stages: [], problem: `A redirection (${t.value}) has no target, so the command can't be fully parsed.` };
      redirects.push({ op: t.value, target: target.value });
      end = target.end;
      k++;
      continue;
    }
    if (!words.length && (t.value === "{" || t.value === "}")) return { stages: [], problem: "Shell grouping in braces produces no reviewable stages." };
    if (!words.length && CONTROL.has(t.value)) return { stages: [], problem: `Shell control flow (${t.value}) produces no reviewable stages.` };
    words.push(t.value);
  }
  if (before && !words.length && !redirects.length && before !== "&" && before !== ";") {
    return { stages: [], problem: `The command ends with ${before}, so it can't be fully parsed.` };
  }
  flush(null);
  return { stages, problem: null };
}

// ---------------------------------------------------------------------------------------------------------------
// Classifying one stage

export type StageKind = "read" | "write" | "dangerous" | "external" | "unknown";

export interface Classified {
  kind: StageKind;
  /** Why, in the page's terms. */
  why: string;
  /** The command after wrappers, such as "cargo test" for "timeout 5 cargo test". */
  launches: string;
  /** Paths this stage writes (redirections, touch, cp, mv, tee, sed -i). */
  writes: string[];
  /** A host it would connect to, or "" when it reaches the network without a host the parser can see. */
  network: string | null;
}

const READ_ONLY = new Set([
  "cat", "head", "tail", "wc", "ls", "pwd", "echo", "printf", "grep", "egrep", "fgrep", "stat", "file", "du", "df",
  "which", "whereis", "type", "date", "uname", "whoami", "id", "hostname", "printenv", "sort", "uniq", "cut", "tr",
  "diff", "cmp", "comm", "basename", "dirname", "realpath", "readlink", "tree", "jq", "true", "false", "test",
  "[", "seq", "nl", "tac", "rev", "column", "md5sum", "sha256sum", "shasum", "less", "more", "sleep", "cd", "pushd",
  "popd", "export",
]);

/** awk is read-only only when its program is: system(), pipes and print > make it run commands or write files. */
const AWKS = new Set(["awk", "gawk", "mawk", "nawk"]);
const RAW_CONNECTIONS = new Set(["nc", "ncat", "netcat", "telnet", "ftp", "sftp"]);

/** Everyday build and test tools: they change the workspace, and the sandbox contains them. */
const DEV_TOOLS = new Set([
  "npm", "pnpm", "yarn", "bun", "cargo", "go", "make", "cmake", "tsc", "pytest", "jest", "vitest", "eslint",
  "prettier", "ruff", "black", "mypy", "gradle", "mvn", "dotnet", "swift", "mkdir", "touch", "cp", "mv", "tee", "ln",
  "chmod", "pip", "pip3", "uv", "poetry", "rustc", "gcc", "clang", "javac",
]);

const INTERPRETERS = new Set(["python", "python3", "node", "deno", "ruby", "perl", "php", "lua", "rscript", "osascript", "pwsh", "powershell"]);
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "fish", "ksh"]);
/** Wrappers Muse Code reviews as the command they launch. */
const WRAPPERS = new Set(["sudo", "env", "nice", "nohup", "setsid", "stdbuf", "time", "command", "timeout", "xargs"]);
/** Wrappers it doesn't otherwise know (changelog 1.4.6: ionice, doas, flock, chrt). */
const UNKNOWN_WRAPPERS = new Set(["ionice", "doas", "flock", "chrt", "nsenter", "unshare", "chroot", "taskset"]);

const GIT_READ = new Set(["status", "diff", "log", "show", "rev-parse", "ls-files", "blame", "describe", "shortlog", "grep", "reflog"]);
const GIT_WRITE = new Set(["add", "commit", "checkout", "switch", "restore", "stash", "merge", "rebase", "cherry-pick", "init", "mv", "rm", "apply", "am"]);
const GIT_NETWORK = new Set(["clone", "fetch", "pull", "push", "ls-remote"]);

function base(word: string): string {
  return (word.split("/").pop() ?? word).toLowerCase();
}

function isAssignment(word: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);
}

/** Drops a wrapper and its options, returning what it launches. */
function unwrap(words: string[]): { wrapper: string; rest: string[] } | null {
  const name = base(words[0] ?? "");
  if (!WRAPPERS.has(name)) return null;
  let i = 1;
  if (name === "env") {
    while (i < words.length && (isAssignment(words[i]) || /^-[iu0]$|^--ignore-environment$|^--unset=/.test(words[i]))) i += words[i] === "-u" ? 2 : 1;
  } else if (name === "timeout") {
    while (i < words.length && words[i].startsWith("-")) i += /^-(s|k)$|^--(signal|kill-after)$/.test(words[i]) ? 2 : 1;
    i++; // the duration
  } else if (name === "nice") {
    while (i < words.length && words[i].startsWith("-")) i += words[i] === "-n" ? 2 : 1;
  } else if (name === "sudo") {
    while (i < words.length && words[i].startsWith("-")) i += /^-(u|g|C|h|p|r|t)$/.test(words[i]) ? 2 : 1;
  } else if (name === "xargs") {
    while (i < words.length && words[i].startsWith("-")) i += /^-(n|L|P|s|d|E|I|a)$/.test(words[i]) ? 2 : 1;
  } else {
    while (i < words.length && words[i].startsWith("-")) i++;
  }
  return { wrapper: name, rest: words.slice(i) };
}

function rmIsDestructive(args: string[]): boolean {
  return args.some((a) => /^-[a-zA-Z]*[rRf][a-zA-Z]*$/.test(a) || a === "--recursive" || a === "--force");
}

/** Where the URL in a command points, if it has one. */
function hostOf(args: string[]): string | null {
  for (const a of args) {
    const m = /^(?:https?|ssh|git|ftp):\/\/(?:[^@/]+@)?([^/:?#]+)/i.exec(a) ?? /^[\w.-]+@([\w.-]+):/.exec(a);
    if (m) return m[1];
  }
  return null;
}

const STAGE_WRITE_TOOLS = new Set(["touch", "mkdir", "tee", "cp", "mv", "ln"]);

/**
 * The operands of a command line, getopt style: options are skipped, and so are the values of the short options in
 * `valued` (in a cluster such as -vp 22 the first of them takes the rest of the word, or the next word) and of the
 * long options in `longValued` written without "=".
 */
function operands(args: string[], valued: string, longValued: readonly string[] = []): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") {
      out.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      if (!a.includes("=") && longValued.includes(a)) i++;
      continue;
    }
    if (a.startsWith("-") && a.length > 1) {
      for (let k = 1; k < a.length; k++) {
        if (valued.includes(a[k])) {
          if (k === a.length - 1) i++;
          break;
        }
      }
      continue;
    }
    out.push(a);
  }
  return out;
}

/** Every value of an option written -o value, -ovalue, --output value or --output=value. */
function optionValues(args: string[], short: string, long: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === short || a === long) {
      if (args[i + 1] !== undefined) out.push(args[++i]);
    } else if (a.startsWith(`${long}=`)) out.push(a.slice(long.length + 1));
    else if (!a.startsWith("--") && a.startsWith(short) && a.length > short.length) out.push(a.slice(short.length));
  }
  return out;
}

function writeTargets(words: string[], redirects: Redirect[]): string[] {
  const out = redirects.filter((r) => r.op.includes(">") && !/&\d?$/.test(r.op) && r.target !== "/dev/null" && !/^&?\d$/.test(r.target)).map((r) => r.target);
  const name = base(words[0] ?? "");
  const args = words.slice(1).filter((a) => !a.startsWith("-"));
  if (name === "touch" || name === "mkdir" || name === "tee") out.push(...args);
  if ((name === "cp" || name === "mv" || name === "ln") && args.length >= 2) out.push(args[args.length - 1]);
  if (name === "sed" && words.some((w) => /^-[a-zA-Z]*i/.test(w) || w.startsWith("--in-place"))) out.push(...args.slice(1));
  // sort -o and uniq's second file save their output: a read that writes.
  if (name === "sort") out.push(...optionValues(words.slice(1), "-o", "--output").filter((f) => f !== "-"));
  if (name === "uniq") {
    const files = operands(words.slice(1), "fsw", ["--skip-fields", "--skip-chars", "--check-chars"]);
    if (files.length >= 2 && files[1] !== "-") out.push(files[1]);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Transfers, and programs that hide commands (curl, wget, scp and rsync; awk and sed)

const CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** What a curl or wget command sends and saves, from the options that decide it (a teaching subset of each tool's). */
interface Transfer {
  /** The option that makes it an upload: data, a form, a file, or a method that changes things. */
  upload: string | null;
  /** Local files it reads and sends. */
  sends: string[];
  /** Local files it saves. */
  saves: string[];
  url: string;
}

function urlFileName(url: string): string {
  const path = url.replace(/^[a-z]+:\/\/[^/]*/i, "").split(/[?#]/)[0];
  return path.split("/").pop() || "index.html";
}

/** curl's short options that take a value. */
const CURL_VALUED = "AbcCdDeEFHKmoPQrtTuUwxXyYz";
const CURL_DATA = new Set(["--data", "--data-raw", "--data-binary", "--data-urlencode", "--data-ascii", "--json"]);
const CURL_LONG_VALUED = new Set([...CURL_DATA, "--form", "--form-string", "--upload-file", "--request", "--output", "--dump-header", "--cookie-jar", "--url", "--header", "--user", "--user-agent", "--cookie", "--referer", "--config", "--max-time", "--write-out", "--proxy", "--output-dir"]);

function curlTransfer(args: string[]): Transfer {
  const t: Transfer = { upload: null, sends: [], saves: [], url: "" };
  let remoteName = false;
  let get = false;
  const dataFlags: string[] = [];
  const take = (flag: string, value: string | undefined) => {
    if (value === undefined) return;
    if (flag === "-d" || CURL_DATA.has(flag)) {
      dataFlags.push(flag);
      if (value.startsWith("@") && value !== "@-") t.sends.push(value.slice(1));
    } else if (flag === "-F" || flag === "--form" || flag === "--form-string") {
      const file = /^[^=]*=[@<]([^;]+)/.exec(value)?.[1];
      if (file && flag !== "--form-string") t.sends.push(file);
      t.upload ??= flag;
    } else if (flag === "-T" || flag === "--upload-file") {
      if (value !== "-") t.sends.push(value);
      t.upload ??= flag;
    } else if (flag === "-X" || flag === "--request") {
      if (CHANGING_METHODS.has(value.toUpperCase())) t.upload ??= `${flag} ${value.toUpperCase()}`;
    } else if (["-o", "--output", "-D", "--dump-header", "-c", "--cookie-jar"].includes(flag)) {
      if (value !== "-" && value !== "/dev/null") t.saves.push(value);
    } else if (flag === "--url") t.url ||= value;
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      if (a === "--get") get = true;
      else if (a === "--remote-name" || a === "--remote-name-all") remoteName = true;
      else if (CURL_LONG_VALUED.has(a)) take(a, args[++i]);
      continue;
    }
    if (a.startsWith("-") && a.length > 1) {
      for (let k = 1; k < a.length; k++) {
        if (a[k] === "G") get = true;
        if (a[k] === "O") remoteName = true;
        if (CURL_VALUED.includes(a[k])) {
          take(`-${a[k]}`, k + 1 < a.length ? a.slice(k + 1) : args[++i]);
          break;
        }
      }
      continue;
    }
    if (!t.url) t.url = a;
  }
  // -G puts -d data in the URL of a GET: no upload, unless it reads a file to send.
  if (dataFlags.length && !get) t.upload ??= dataFlags[0];
  if (remoteName && t.url) t.saves.push(urlFileName(t.url));
  return t;
}

/** wget's short options that take a value (-n takes one letter: -nv, -nc, -nd). */
const WGET_VALUED = "OoaPitTwQlARDIXeUBn";
const WGET_LONG_VALUED = new Set(["--output-document", "--output-file", "--append-output", "--directory-prefix", "--post-data", "--body-data", "--post-file", "--body-file", "--method", "--header", "--user-agent", "--user", "--password", "--tries", "--timeout", "--wait", "--level", "--input-file"]);

function wgetTransfer(args: string[]): Transfer {
  const t: Transfer = { upload: null, sends: [], saves: [], url: "" };
  let output: string | null = null;
  let prefix = "";
  let spider = false;
  let recursive = false;
  const take = (opt: string, value: string | undefined) => {
    if (value === undefined) return;
    if (opt === "O" || opt === "--output-document") output = value;
    else if (opt === "o" || opt === "a" || opt === "--output-file" || opt === "--append-output") {
      if (value !== "-") t.saves.push(value);
    } else if (opt === "P" || opt === "--directory-prefix") prefix = value.replace(/\/+$/, "");
    else if (opt === "--post-data" || opt === "--body-data") t.upload ??= opt;
    else if (opt === "--post-file" || opt === "--body-file") {
      t.sends.push(value);
      t.upload ??= opt;
    } else if (opt === "--method" && CHANGING_METHODS.has(value.toUpperCase())) t.upload ??= `--method ${value.toUpperCase()}`;
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const name = eq > 0 ? a.slice(0, eq) : a;
      if (name === "--spider") spider = true;
      else if (name === "--recursive" || name === "--mirror") recursive = true;
      else if (WGET_LONG_VALUED.has(name)) take(name, eq > 0 ? a.slice(eq + 1) : args[++i]);
      continue;
    }
    if (a.startsWith("-") && a.length > 1) {
      for (let k = 1; k < a.length; k++) {
        if (a[k] === "r" || a[k] === "m") recursive = true;
        if (WGET_VALUED.includes(a[k])) {
          take(a[k], k + 1 < a.length ? a.slice(k + 1) : args[++i]);
          break;
        }
      }
      continue;
    }
    if (!t.url) t.url = a;
  }
  // Without -O, wget saves what it fetches under the URL's file name (a recursive run, a directory named for the host).
  if (!spider) {
    const out: string | null = output;
    if (out !== null) {
      if (out !== "-" && out !== "/dev/null") t.saves.push(out);
    } else if (t.url) {
      const name = recursive ? `${t.url.replace(/^[a-z]+:\/\//i, "").split("/")[0]}/` : urlFileName(t.url);
      t.saves.push(prefix ? `${prefix}/${name}` : name);
    }
  }
  return t;
}

/** The host in an scp or rsync operand such as user@host:path or rsync://host/module, if it names one. */
function remoteHost(operand: string): string | null {
  const url = /^(?:rsync|ssh):\/\/(?:[^@/]+@)?([^/:]+)/.exec(operand);
  if (url) return url[1];
  const scp = /^(?:[^@/:]+@)?([\w.-]+):/.exec(operand);
  return scp ? scp[1] : null;
}

/** sed's scripts: every -e (and --expression), else the first operand. A -f script is in a file the parser can't see. */
function sedScripts(args: string[]): { scripts: string[]; fromFile: boolean } {
  const scripts: string[] = [];
  let fromFile = false;
  let expression = false;
  const ops: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") {
      ops.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const name = eq > 0 ? a.slice(0, eq) : a;
      const value = eq > 0 ? a.slice(eq + 1) : undefined;
      if (name === "--expression") {
        expression = true;
        const v = value ?? args[++i];
        if (v !== undefined) scripts.push(v);
      } else if (name === "--file") {
        fromFile = true;
        if (value === undefined) i++;
      } else if (name === "--line-length" && value === undefined) i++;
      continue;
    }
    if (a.startsWith("-") && a.length > 1) {
      for (let k = 1; k < a.length; k++) {
        const c = a[k];
        if (c === "i") break; // -i[SUFFIX]: the rest of the word is the backup suffix
        if (c === "e" || c === "f" || c === "l") {
          const v = k + 1 < a.length ? a.slice(k + 1) : args[++i];
          if (c === "e") {
            expression = true;
            if (v !== undefined) scripts.push(v);
          }
          if (c === "f") fromFile = true;
          break;
        }
      }
      continue;
    }
    ops.push(a);
  }
  if (!expression && !fromFile && ops.length) scripts.push(ops[0]);
  return { scripts, fromFile };
}

export interface SedRisk {
  /** The e command, or s///e: runs a shell command. */
  runs: boolean;
  /** Files the w and W commands, or s///w, write. */
  writes: string[];
  /** A command this scan can't follow. */
  unclear: boolean;
}

/**
 * Reads a sed script the way GNU sed does, command by command (addresses, s and y with any delimiter, text and label
 * commands), to find what makes it more than a print: e and the s///e flag run a shell command, w, W and s///w
 * write a file. Anything it can't follow counts as unclear, so the model holds it.
 */
export function sedScriptRisk(script: string): SedRisk {
  const out: SedRisk = { runs: false, writes: [], unclear: false };
  const n = script.length;
  let i = 0;
  // From just after an opening delimiter, moves past the next unescaped `d`; false when there's none.
  const through = (d: string): boolean => {
    while (i < n && script[i] !== d) i += script[i] === "\\" ? 2 : 1;
    if (i >= n) return false;
    i++;
    return true;
  };
  const restOfLine = (): string => {
    const end = script.indexOf("\n", i);
    const text = script.slice(i, end < 0 ? n : end);
    i = end < 0 ? n : end + 1;
    return text.trim();
  };
  const address = (): boolean => {
    if (script[i] === "/" || script[i] === "\\") {
      const d = script[i] === "/" ? "/" : script[i + 1];
      i += script[i] === "/" ? 1 : 2;
      if (d === undefined || !through(d)) return false;
      while (script[i] === "I" || script[i] === "M") i++;
      return true;
    }
    while (i < n && /[0-9$~+]/.test(script[i])) i++;
    return true;
  };
  while (i < n) {
    while (i < n && /[\s;}]/.test(script[i])) i++;
    if (i >= n) break;
    if (script[i] === "#") {
      restOfLine();
      continue;
    }
    if (!address()) return { ...out, unclear: true };
    while (script[i] === " ") i++;
    if (script[i] === ",") {
      i++;
      while (script[i] === " ") i++;
      if (!address()) return { ...out, unclear: true };
    }
    while (i < n && /[ \t!]/.test(script[i])) i++;
    const cmd = script[i++];
    if (cmd === undefined) break;
    if (cmd === "{") continue;
    if (cmd === "e") {
      out.runs = true;
      restOfLine();
    } else if (cmd === "w" || cmd === "W") {
      out.writes.push(restOfLine() || "(no file named)");
    } else if (cmd === "s" || cmd === "y") {
      const d = script[i++];
      if (!d || d === "\n" || d === "\\" || !through(d) || !through(d)) return { ...out, unclear: true };
      while (cmd === "s" && i < n && /[gpiImMe0-9w]/.test(script[i])) {
        const flag = script[i++];
        if (flag === "e") out.runs = true;
        if (flag === "w") {
          out.writes.push(restOfLine() || "(no file named)");
          break;
        }
      }
    } else if ("aicrR".includes(cmd)) {
      restOfLine(); // text to add, or a file to read
    } else if ("btT:".includes(cmd)) {
      while (i < n && script[i] !== ";" && script[i] !== "\n") i++; // a label
    } else if ("qQlL".includes(cmd)) {
      while (i < n && /[ \t0-9]/.test(script[i])) i++;
    } else if (!"pPdDnNgGhHxz=F".includes(cmd)) {
      return { ...out, unclear: true };
    }
  }
  return out;
}

/** awk's programs (the first operand, or each -e and --source), and whether -f or -i inplace changes the picture. */
function awkProgram(args: string[]): { programs: string[]; fromFile: boolean; inPlace: boolean; files: string[] } {
  const programs: string[] = [];
  let fromFile = false;
  let inPlace = false;
  const ops: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") {
      ops.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const name = eq > 0 ? a.slice(0, eq) : a;
      const value = eq > 0 ? a.slice(eq + 1) : ["--file", "--source", "--include", "--load", "--field-separator", "--assign", "--exec"].includes(name) ? args[++i] : undefined;
      if (name === "--file" || name === "--exec") fromFile = true;
      else if (name === "--source" && value !== undefined) programs.push(value);
      else if ((name === "--include" || name === "--load") && value === "inplace") inPlace = true;
      continue;
    }
    if (a.startsWith("-") && a.length > 1) {
      const c = a[1];
      if ("FvfeilE".includes(c)) {
        const v = a.length > 2 ? a.slice(2) : args[++i];
        if (c === "f" || c === "E") fromFile = true;
        if (c === "e" && v !== undefined) programs.push(v);
        if ((c === "i" || c === "l") && v === "inplace") inPlace = true;
      }
      continue;
    }
    ops.push(a);
  }
  if (!programs.length && !fromFile && ops.length) programs.push(ops.shift()!);
  return { programs, fromFile, inPlace, files: ops.filter((o) => !isAssignment(o)) };
}

/** What an awk program can do beyond reading: system(), and pipes to or from commands, run them; print > writes. */
function awkRisk(program: string): "runs" | "writes" | null {
  const code = program.replace(/"(?:[^"\\]|\\.)*"/g, '""');
  if (/\bsystem\s*\(/.test(code) || /\|&/.test(code) || /\|\s*getline\b/.test(code) || /\bprintf?\b[^;{}\n]*\|/.test(code)) return "runs";
  if (/\bprintf?\b[^;{}\n]*>/.test(code)) return "writes";
  return null;
}

/** Classifies one stage's words (wrappers unwrapped, shell -c scripts parsed). */
export function classifyStage(stage: Pick<Stage, "words" | "redirects">, depth = 0): Classified {
  let words = stage.words.filter((w, i, all) => !(isAssignment(w) && all.slice(0, i).every(isAssignment)));
  const done = (kind: StageKind, why: string, network: string | null = null, extraWrites: string[] = []): Classified => {
    const writes = [...writeTargets(words, stage.redirects), ...extraWrites];
    return {
      kind: kind === "read" && writes.length ? "write" : kind,
      why: kind === "read" && writes.length ? `${why} Its output goes to a file, which is a write.` : why,
      launches: words.join(" "),
      writes,
      network,
    };
  };
  if (!words.length) return done("read", stage.words.length ? "Only sets shell variables." : "Only a redirection.");

  // Wrappers are reviewed as the command they launch.
  const wrappers: string[] = [];
  for (let guard = 0; guard < 6; guard++) {
    const u = unwrap(words);
    if (!u) break;
    wrappers.push(u.wrapper);
    if (u.wrapper === "env") words = u.rest.filter((w, i, all) => !(isAssignment(w) && all.slice(0, i).every(isAssignment)));
    else words = u.rest;
    if (!words.length) return done("read", `${u.wrapper} on its own launches nothing.`);
  }
  const via = wrappers.length ? ` (behind ${wrappers.join(", ")}, reviewed as what it launches)` : "";
  const name = base(words[0]);
  const args = words.slice(1);

  if (UNKNOWN_WRAPPERS.has(name)) {
    return done("unknown", `${name} is a wrapper this model doesn't otherwise know, so it holds whatever it launches for review.`);
  }
  if (wrappers.includes("xargs") && name === "rm") return done("dangerous", "xargs feeds rm a list of files to remove, a destructive removal form.");
  if (name === "rm") {
    return rmIsDestructive(args)
      ? done("dangerous", `Destructive removal (rm with recursive or force options)${via}.`)
      : done("write", `Removes named files in the workspace${via}; the sandbox keeps it inside the writable roots.`);
  }
  if (name === "rg") {
    const helper = args.find((a) => a === "-z" || a === "--search-zip" || a.startsWith("--pre") || a.startsWith("--hostname-bin") || /^-[a-zA-Z]*z[a-zA-Z]*$/.test(a));
    return helper
      ? done("external", `ripgrep's ${helper.split("=")[0]} option can launch helper processes, an external-execution pattern${via}.`)
      : done("read", `A read-only search${via}.`);
  }
  if (name === "find") {
    if (args.includes("-delete")) return done("dangerous", `find -delete removes every match${via}.`);
    const at = args.findIndex((a) => a === "-exec" || a === "-execdir" || a === "-ok" || a === "-okdir");
    if (at >= 0) {
      const launched = args.slice(at + 1).filter((a) => a !== ";" && a !== "+" && a !== "\\;");
      const inner = launched[0] ?? "";
      if (inner === "{}") return done("external", `find -exec runs each matched file itself as a program${via}.`);
      const innerName = base(inner);
      if (SHELLS.has(innerName) && launched[1] !== "-c") return done("external", `find -exec launches ${innerName} without a -c script${via}.`);
      if (UNKNOWN_WRAPPERS.has(innerName) && launched.slice(1).some((a) => base(a) === "rm")) return done("dangerous", `find -exec reaches rm through ${innerName}, a wrapper this model doesn't know${via}.`);
      const innerClass = classifyStage({ words: launched.map((a) => (a === "{}" ? "matched-file" : a)), redirects: [] }, depth + 1);
      if (innerClass.kind === "dangerous" || base(innerClass.launches.split(" ")[0] ?? "") === "rm") {
        return done("dangerous", `find -exec reaches rm for every match${via}.`);
      }
      return innerClass.kind === "read" || innerClass.kind === "write"
        ? done("write", `find -exec runs ${innerName} on each match, a plain program${via}.`)
        : done(innerClass.kind, `find -exec launches ${innerName}: ${innerClass.why}`);
    }
    return done("read", `A read-only search${via}.`);
  }
  if (SHELLS.has(name)) {
    const flag = args[0] ?? "";
    if ((flag === "-c" || flag === "-lc") && args[1] !== undefined && depth < 3) {
      const inner = parseCommand(args[1]);
      if (inner.problem) return done("external", `The ${name} ${flag} script can't be fully parsed: ${inner.problem}`);
      const parts = inner.stages.map((s) => classifyStage(s, depth + 1));
      const worst = parts.find((p) => p.kind === "dangerous") ?? parts.find((p) => p.kind === "external") ?? parts.find((p) => p.kind === "unknown");
      if (worst) return { ...worst, why: `Inside the ${name} ${flag} script: ${worst.why}`, launches: args[1] };
      return done(parts.some((p) => p.kind === "write") ? "write" : "read", `A ${name} ${flag} script whose stages are all ${parts.some((p) => p.kind === "write") ? "recognized" : "read-only"}${via}.`, parts.find((p) => p.network !== null)?.network ?? null);
    }
    return done("external", `A ${name} invocation that isn't a -c/-lc script (a script file, or commands from stdin) asks instead of auto-running${via}.`);
  }
  if (INTERPRETERS.has(name)) {
    return done("external", `${name} runs code the shell parser can't see: everything after the interpreter is arbitrary code${via}.`);
  }
  if (name === "git") {
    const at = args.findIndex((a) => !a.startsWith("-"));
    const sub = at >= 0 ? args[at] : "";
    const rest = at >= 0 ? args.slice(at + 1) : [];
    const named = rest.filter((a) => !a.startsWith("-"));
    if (args.some((a) => a === "-c" || a.startsWith("--exec-path") || a.startsWith("--config-env"))) return done("unknown", "git -c can set options that launch other programs; this model holds it.");
    const lists =
      (sub === "branch" && (!named.length || rest.some((a) => a === "--list" || a === "-l")) && !rest.some((a) => /^-(d|D|m|M|c|C)$|^--(delete|move|copy)$/.test(a))) ||
      (sub === "tag" && (!named.length || rest.some((a) => a === "--list" || a === "-l")) && !rest.some((a) => /^-(d|a|s|f|m)$|^--(delete|annotate|sign|force)$/.test(a))) ||
      (sub === "stash" && (named[0] === "list" || named[0] === "show")) ||
      (sub === "remote" && args.length <= 2);
    if (GIT_READ.has(sub) || lists) return done("read", `git ${sub} only reads the repository${via}.`);
    // The sandbox keeps .git read-only (permissions.md "Run inside the sandbox"): whatever writes the index, refs or
    // objects fails there, however safe it looks to approval.
    const gitDir = `, which the sandbox keeps read-only so the agent can't rewrite its own history`;
    if (sub === "fetch" || sub === "pull") return done("write", `git ${sub} talks to a remote and writes what it gets into .git${gitDir}${via}.`, hostOf(args) ?? "", [".git"]);
    if (GIT_NETWORK.has(sub)) return done("write", `git ${sub} talks to a remote${via}.`, hostOf(args) ?? "");
    if (sub === "apply" && !rest.some((a) => /^(--index|--cached|-3|--3way)$/.test(a))) return done("write", `git apply without --index changes files in the working tree only${via}.`);
    const creates = (sub === "branch" || sub === "tag") && !rest.some((a) => /^-(d|D|m|M|c|C)$|^--(delete|move|copy)$/.test(a));
    if (GIT_WRITE.has(sub) || creates) return done("write", `git ${sub} writes the repository's .git directory (its index, refs or objects)${gitDir}${via}.`, null, [".git"]);
    return done("unknown", `git ${sub || "(no subcommand)"} isn't on this model's list; Muse Code's own rules decide.`);
  }
  if (name === "curl" || name === "wget") {
    const t = name === "curl" ? curlTransfer(args) : wgetTransfer(args);
    const host = hostOf(args) ?? hostOf([t.url]) ?? "";
    if (t.upload || t.sends.length) {
      const sends = t.sends.length ? ` It reads ${t.sends.join(", ")} and sends ${t.sends.length > 1 ? "them" : "it"}.` : "";
      return done(
        "write",
        `${name}${t.upload ? ` ${t.upload}` : ""} sends data to ${host || "a server"}: an upload, a side effect rather than a read${via}.${sends} The sandbox's network policy decides the connection.`,
        host,
        t.saves,
      );
    }
    return done(
      t.saves.length ? "write" : "read",
      `${name} fetches over the network${t.saves.length ? ` and saves ${t.saves.join(", ")}` : ""}${via}; the sandbox's network policy decides the connection.`,
      host,
      t.saves,
    );
  }
  if (name === "ssh") {
    const target = operands(args, "BbcDEeFIiJLlmOoPpQRSWw")[0] ?? "";
    const host = target.replace(/^ssh:\/\//, "").replace(/^[^@]*@/, "").split(/[:/]/)[0];
    return done("external", `ssh runs commands on another machine, out of this review's sight${via}.`, host);
  }
  if (name === "scp" || name === "rsync") {
    const ops = operands(args, name === "scp" ? "cFiJlLoPS" : "efTB", ["--rsh", "--filter", "--exclude", "--include", "--temp-dir", "--port", "--password-file", "--log-file"]);
    const dest = ops[ops.length - 1] ?? "";
    const destHost = remoteHost(dest);
    const host = destHost ?? ops.slice(0, -1).map(remoteHost).find((h) => h) ?? null;
    if (name === "rsync" && args.some((a) => a.startsWith("--delete") || a === "--remove-source-files")) {
      return done("dangerous", `rsync ${args.find((a) => a.startsWith("--delete") || a === "--remove-source-files")} removes files as it copies, a destructive removal form${via}.`, host, destHost || !dest ? [] : [dest]);
    }
    if (destHost) return done("write", `${name} uploads to ${destHost}: a side effect rather than a read${via}.`, destHost);
    return done("write", `${name} copies ${host ? `from ${host} ` : ""}into ${dest || "the workspace"}${via}.`, host, dest ? [dest] : []);
  }
  if (RAW_CONNECTIONS.has(name)) {
    return done("unknown", `${name} opens a raw or interactive connection whose traffic this review can't see, so the model holds it${via}.`, hostOf(args) ?? operands(args, "pswqiIOTWxX")[0] ?? "");
  }
  if (AWKS.has(name)) {
    const program = awkProgram(args);
    if (program.fromFile) return done("unknown", `${name} -f runs a program from a file the parser can't see, and awk programs can run commands or write files, so the model holds it${via}.`);
    const risks = program.programs.map(awkRisk);
    if (risks.includes("runs")) return done("external", `The ${name} program runs shell commands (system(), or a pipe to or from a command), an external-execution pattern${via}.`);
    if (program.inPlace) return done("write", `${name} -i inplace edits ${program.files.join(", ") || "its input files"} in place${via}.`, null, program.files);
    if (risks.includes("writes")) return done("unknown", `The ${name} program writes a file with print >, which this model can't place, so it holds it${via}.`);
    return done("read", `A ${name} program that only reads and prints${via}.`);
  }
  if (name === "sed") {
    if (words.some((w) => /^-[a-zA-Z]*i/.test(w) || w.startsWith("--in-place"))) return done("write", `sed -i edits files in place${via}.`);
    const { scripts, fromFile } = sedScripts(args);
    if (fromFile) return done("unknown", `sed -f reads its script from a file the parser can't see, and sed scripts can run commands (e) or write files (w), so the model holds it${via}.`);
    if (args.includes("--sandbox")) return done("read", `sed --sandbox refuses e, w and r, so without -i it only prints${via}.`);
    const risks = scripts.map(sedScriptRisk);
    if (risks.some((r) => r.runs)) return done("external", `The sed script runs a shell command (the e command or the s///e flag), an external-execution pattern${via}.`);
    if (risks.some((r) => r.unclear)) return done("unknown", `The sed script uses a command this model can't follow, so it holds it${via}.`);
    const targets = risks.flatMap((r) => r.writes);
    if (targets.length) return done("write", `The sed script's w command writes ${targets.join(", ")}${via}.`, null, targets);
    return done("read", `sed without -i only prints${via}.`);
  }
  if (READ_ONLY.has(name)) return done("read", `${name} is read-only${via}.`);
  if (DEV_TOOLS.has(name)) {
    const sub = args.find((a) => !a.startsWith("-")) ?? "";
    const net = (["npm", "pnpm", "yarn", "bun"].includes(name) && ["install", "i", "ci", "add"].includes(sub)) || (["pip", "pip3", "uv", "poetry"].includes(name) && ["install", "add", "sync"].includes(sub));
    if (["npx", "exec", "dlx", "x"].includes(sub)) return done("external", `${name} ${sub} downloads and runs a package${via}.`, "");
    return done("write", `${STAGE_WRITE_TOOLS.has(name) ? `${name} writes in the workspace` : `${name}${sub ? ` ${sub}` : ""} is an everyday build or test command`}${via}; the sandbox contains it.`, net ? (name.startsWith("pip") || name === "uv" || name === "poetry" ? "pypi.org" : "registry.npmjs.org") : null);
  }
  if (name === "npx" || name === "pnpx" || name === "bunx") return done("external", `${name} downloads and runs a package${via}.`, "registry.npmjs.org");
  if (name.startsWith("./") || words[0].includes("/")) return done("external", `${words[0]} runs a program or script whose contents the parser can't review${via}.`);
  return done("unknown", `${name} isn't on this model's list of recognized commands. Muse Code's own list decides; the model holds it to be safe.`);
}

// ---------------------------------------------------------------------------------------------------------------
// Policy

export type Profile = "ask-me" | "auto-review" | "unrestricted" | "read-only";
export type ApprovalMode = "on-request" | "untrusted" | "never";
export type NetworkMode = "proxy-only" | "restricted" | "unrestricted";

export interface Policy {
  profile: Profile;
  mode: ApprovalMode;
  /** The approval judge; --approval-judge off sends every review decision to you. */
  judge: boolean;
  network: NetworkMode;
  disableApproval: boolean;
  disableSandbox: boolean;
}

export interface Rules {
  /** "Always allow in this workspace" prefixes. */
  allow: string[];
  deny: string[];
}

export type Decision = "once" | "always" | "reject";

export type VerdictStatus = "pass" | "hold" | "allowed" | "denied" | "blocked" | "not-reached";

export interface StageVerdict {
  index: number;
  stage: Stage;
  info: Classified;
  status: VerdictStatus;
  /** Why this status, in the page's terms. */
  reason: string;
  /** For a held stage: who decides. */
  decider?: "you" | "judge";
}

export interface SandboxEffect {
  stage: number;
  text: string;
  tone: "ok" | "warn" | "bad";
}

export interface Evaluation {
  verdicts: StageVerdict[];
  /** The stage waiting for a decision, if any. */
  pending: number | null;
  outcome: "runs" | "waiting" | "rejected" | "blocked" | "unparsed" | "empty";
  summary: string;
  sandbox: SandboxEffect[];
  approvalOn: boolean;
  sandboxOn: boolean;
}

/** Whether a rule prefix covers a stage: the stage starts with the rule's words. */
export function ruleMatches(rule: string, stageText: string): boolean {
  const r = rule.trim().split(/\s+/).filter(Boolean);
  const s = stageText.trim().split(/\s+/).filter(Boolean);
  return r.length > 0 && r.length <= s.length && r.every((w, i) => w === s[i]);
}

/** The prefix "Always allow" saves for a stage, or why it can't: interpreter prefixes are never broad allows. */
export function alwaysAllowRule(stage: Stage): { rule: string | null; refused: string | null } {
  const first = base(stage.words.find((w) => !isAssignment(w)) ?? "");
  if (INTERPRETERS.has(first) || SHELLS.has(first)) {
    return { rule: null, refused: `You can't save an interpreter prefix such as ${first} as an allow rule: everything after the interpreter is arbitrary code. Allow it once instead.` };
  }
  return { rule: stage.text, refused: null };
}

export const WORKSPACE = "/home/you/project";

function pathZone(path: string): "workspace" | "protected" | "temp" | "outside" {
  let p = path.replace(/^\$HOME\b|^\$\{HOME\}|^~(?=\/|$)/, "/home/you");
  if (!p.startsWith("/")) p = `${WORKSPACE}/${p}`;
  const parts: string[] = [];
  for (const seg of p.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  const norm = `/${parts.join("/")}`;
  if (norm === "/tmp" || norm.startsWith("/tmp/")) return "temp";
  if (norm === WORKSPACE || norm.startsWith(`${WORKSPACE}/`)) {
    const rel = norm.slice(WORKSPACE.length + 1);
    return /^(\.git|\.muse|\.agents)(\/|$)/.test(rel) ? "protected" : "workspace";
  }
  return "outside";
}

function sandboxEffects(verdicts: StageVerdict[], policy: Policy, sandboxOn: boolean): SandboxEffect[] {
  const out: SandboxEffect[] = [];
  for (const v of verdicts) {
    if (v.status === "denied" || v.status === "blocked" || v.status === "not-reached") continue;
    for (const w of v.info.writes) {
      const zone = pathZone(w);
      if (!sandboxOn) out.push({ stage: v.index, text: `Writes ${w} with no sandbox: nothing confines it.`, tone: zone === "workspace" || zone === "temp" ? "warn" : "bad" });
      else if (zone === "workspace") out.push({ stage: v.index, text: `Writes ${w}: inside the workspace, allowed.`, tone: "ok" });
      else if (zone === "temp") out.push({ stage: v.index, text: `Writes ${w}: the temp directory is writable.`, tone: "ok" });
      else if (zone === "protected") out.push({ stage: v.index, text: `Writes ${w}: .git, .muse and .agents stay read-only inside the workspace, so this fails. Only --disable-sandbox or Unrestricted lets it through.`, tone: "bad" });
      else out.push({ stage: v.index, text: `Writes ${w}: outside the allowed roots, so it fails at the OS level ("Read-only file system").`, tone: "bad" });
    }
    if (v.info.network !== null) {
      const host = v.info.network || "its server";
      if (!sandboxOn) out.push({ stage: v.index, text: `Connects to ${host}: no sandbox, full network access.`, tone: "warn" });
      else if (policy.network === "restricted") out.push({ stage: v.index, text: `Connects to ${host}: --sandbox-network restricted allows no network, so it fails.`, tone: "bad" });
      else if (policy.network === "unrestricted") out.push({ stage: v.index, text: `Connects to ${host}: --sandbox-network unrestricted allows it.`, tone: "warn" });
      else out.push({ stage: v.index, text: `Connects to ${host}: with proxy-only (the default) the first connection to a new host, port or protocol stops for review.`, tone: "warn" });
    }
  }
  return out;
}

/** Runs the stages through approval, in order, applying the reader's decisions to held stages one by one. */
export function evaluate(command: string, policy: Policy, rules: Rules, decisions: Decision[] = []): Evaluation {
  const parsed = parseCommand(command);
  const unrestricted = policy.profile === "unrestricted";
  const approvalOn = !unrestricted && !policy.disableApproval && policy.profile !== "read-only";
  const sandboxOn = !unrestricted && !policy.disableSandbox;
  const effectiveNetwork: Policy = policy.disableSandbox ? { ...policy, network: "unrestricted" } : policy;

  if (!command.trim()) {
    return { verdicts: [], pending: null, outcome: "empty", summary: "Type a command to see how each stage is reviewed.", sandbox: [], approvalOn, sandboxOn };
  }
  if (parsed.problem) {
    const held = approvalOn && policy.mode !== "never";
    return {
      verdicts: [],
      pending: null,
      outcome: "unparsed",
      summary: held
        ? `${parsed.problem} A command like this can stop for review as a whole.`
        : `${parsed.problem} With approval off, the sandbox alone contains it.`,
      sandbox: [],
      approvalOn,
      sandboxOn,
    };
  }

  const verdicts: StageVerdict[] = [];
  let pending: number | null = null;
  let stopped: "rejected" | "blocked" | null = null;
  let d = 0;
  parsed.stages.forEach((stage, index) => {
    const info = classifyStage(stage);
    if (stopped || pending !== null) {
      verdicts.push({ index, stage, info, status: "not-reached", reason: stopped ? "Nothing runs: the command was stopped at an earlier stage." : "Waits for the stage before it." });
      return;
    }
    if (policy.profile === "read-only") {
      if (info.kind === "read") verdicts.push({ index, stage, info, status: "pass", reason: "Read-only profile: reading the workspace is allowed." });
      else {
        verdicts.push({ index, stage, info, status: "blocked", reason: `Read-only profile: the agent can't write files or run side-effecting commands. ${info.why}` });
        stopped = "blocked";
      }
      return;
    }
    if (!approvalOn) {
      verdicts.push({ index, stage, info, status: "pass", reason: unrestricted ? "Unrestricted: no approval and no sandbox." : "Approval is off (--disable-approval): the sandbox alone contains it." });
      return;
    }
    const denied = rules.deny.find((r) => ruleMatches(r, stage.text));
    if (denied) {
      verdicts.push({ index, stage, info, status: "denied", reason: `Matches your deny rule "${denied}". A deny rule always overrides an allow rule.` });
      stopped = "rejected";
      return;
    }
    const allowed = rules.allow.find((r) => ruleMatches(r, stage.text));
    if (allowed) {
      verdicts.push({ index, stage, info, status: "pass", reason: `Matches your Always allow rule "${allowed}" for this workspace.` });
      return;
    }
    let holds: boolean;
    let reason: string;
    if (policy.mode === "never") {
      holds = false;
      reason = "Approval mode never: nothing stops for approval; the sandbox alone contains it.";
    } else if (policy.mode === "untrusted") {
      holds = true;
      reason = `Approval mode untrusted: a shell stage with no matching allow rule stops for review. ${info.why}`;
    } else {
      holds = info.kind === "dangerous" || info.kind === "external" || info.kind === "unknown";
      reason = holds ? info.why : `${info.why} Recognized and not dangerous, so it passes without a prompt.`;
    }
    if (!holds) {
      verdicts.push({ index, stage, info, status: "pass", reason });
      return;
    }
    const decider: "you" | "judge" = policy.profile === "auto-review" && policy.judge ? "judge" : "you";
    const decision = decisions[d];
    if (!decision) {
      verdicts.push({ index, stage, info, status: "hold", reason, decider });
      pending = index;
      return;
    }
    d++;
    if (decision === "reject") {
      verdicts.push({ index, stage, info, status: "denied", reason: "You rejected it: the whole command is denied." });
      stopped = "rejected";
      return;
    }
    verdicts.push({ index, stage, info, status: "allowed", reason: decision === "always" ? "You allowed it always in this workspace: a prefix rule is saved for this workspace root." : "You allowed it once. Nothing is saved." });
  });

  const n = parsed.stages.length;
  const sandbox = sandboxEffects(verdicts, effectiveNetwork, sandboxOn);
  let outcome: Evaluation["outcome"];
  let summary: string;
  if (stopped === "rejected") {
    outcome = "rejected";
    summary = "Denied: nothing runs, not even the safe stages before the one that was rejected.";
  } else if (stopped === "blocked") {
    outcome = "blocked";
    summary = "Blocked by the Read-only profile: the command doesn't run.";
  } else if (pending !== null) {
    outcome = "waiting";
    const v = verdicts[pending];
    summary = `Held for review at stage ${pending + 1} of ${n}. ${v.decider === "judge" ? "The approval judge reviews it first and hands it to you if it can't clear it." : "You decide."} Nothing has run yet.`;
  } else {
    outcome = "runs";
    summary = n === 1 ? "Approved: the command runs." : `All ${n} stages approved: the command runs as one unit.`;
  }
  return { verdicts, pending, outcome, summary, sandbox, approvalOn, sandboxOn };
}

/**
 * The launch command for a posture, as the page spells it, or null where the docs give none. Ask me is Auto-review's
 * access with every review decision sent to you, which is what --approval-judge off does for a run (a new session
 * otherwise starts in Auto-review). Read-only has no documented flag or settings id: it's picked from the session's
 * permission profiles.
 */
export function launchFlags(policy: Policy): string | null {
  if (policy.profile === "unrestricted") return "muse --yolo";
  if (policy.profile === "read-only") return null;
  const parts = ["muse"];
  if (policy.mode !== "on-request") parts.push("--approval-mode", policy.mode);
  const reviews = !policy.disableApproval && policy.mode !== "never";
  if (reviews && (policy.profile === "ask-me" || !policy.judge)) parts.push("--approval-judge", "off");
  if (policy.disableApproval) parts.push("--disable-approval");
  if (policy.disableSandbox) parts.push("--disable-sandbox");
  else if (policy.network !== "proxy-only") parts.push("--sandbox-network", policy.network);
  return parts.join(" ");
}

/** The settings id for a profile, where the docs give one (the changelog's :ask-me, :auto-review, :unrestricted). */
export const PROFILE_IDS: Partial<Record<Profile, string>> = { "ask-me": ":ask-me", "auto-review": ":auto-review", unrestricted: ":unrestricted" };
