/**
 * Splits a compound shell command into stages and judges each one, the way Meta's staged-approvals recipe (04/03)
 * describes Muse Code's parser, for a labeled simulator (recipe-code-sessions, Part 2). Copy it to lib/sim/stages.ts.
 * It imports nothing.
 *
 * A small reader, not a shell: quotes, escapes, $(...) and backticks, the separators && || ; | & and newlines, and
 * redirects. What it can't follow (an unclosed quote, a subshell, a heredoc) is an error, and an error never auto-allows.
 * It models the recipe's untrusted mode: an incomplete stage always goes to review.
 */

export interface Stage {
  index: number;
  /** The stage's own text, trimmed. */
  text: string;
  /** Words with quotes removed. A substitution stays as written. */
  argv: string[];
  argvComplete: boolean;
  /** Why argvComplete is false, in plain words. */
  reasons: string[];
  /** The separator after this stage, or null for the last. */
  next: string | null;
}

export interface Split {
  raw: string;
  stages: Stage[];
  error: string | null;
}

const SEPARATORS = ["&&", "||", ";", "|", "&", "\n"] as const;

function words(text: string): { argv: string[]; substitution: boolean; writeRedirect: boolean; assignment: boolean } {
  const argv: string[] = [];
  let cur = "";
  let has = false;
  let substitution = false;
  let writeRedirect = false;
  let quote: "'" | '"' | null = null;
  const push = () => {
    if (has) argv.push(cur);
    cur = "";
    has = false;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = null;
      else {
        if (quote === '"' && (c === "`" || (c === "$" && text[i + 1] === "("))) substitution = true;
        cur += c;
      }
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      has = true;
    } else if (c === "\\" && i + 1 < text.length) {
      cur += text[++i];
      has = true;
    } else if (c === " " || c === "\t") push();
    else {
      if (c === "`" || (c === "$" && text[i + 1] === "(")) substitution = true;
      if (c === ">") {
        const target = /^>{1,2}\|?\s*(\S+)/.exec(text.slice(i))?.[1] ?? "";
        if (!/^&?\d$/.test(target) && target !== "/dev/null" && target !== "&2" && target !== "&1") writeRedirect = true;
      }
      cur += c;
      has = true;
    }
  }
  push();
  const assignment = argv.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[0]);
  return { argv, substitution, writeRedirect, assignment };
}

/** Splits the command into ordered stages. Never throws. */
export function splitStages(raw: string): Split {
  const parts: Array<{ text: string; next: string | null }> = [];
  let start = 0;
  let quote: "'" | '"' | null = null;
  let depth = 0;
  let backtick = false;
  let error: string | null = null;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === "\\" && quote !== "'") {
      i++;
      continue;
    }
    if (quote) {
      if (c === quote) quote = null;
      else if (quote === '"' && c === "$" && raw[i + 1] === "(") (depth++, i++);
      else if (quote === '"' && c === ")" && depth > 0) depth--;
      continue;
    }
    if (c === "'" || c === '"') quote = c;
    else if (c === "`") backtick = !backtick;
    else if (c === "$" && raw[i + 1] === "(") (depth++, i++);
    else if (c === ")" && depth > 0) depth--;
    else if (depth === 0 && !backtick) {
      if (c === "(" || c === ")") {
        error = "Subshells and command groups aren't supported, so nothing is allowed.";
        break;
      }
      if (raw.startsWith("<<", i) && raw[i + 2] !== "<") {
        error = "Heredocs aren't supported, so nothing is allowed.";
        break;
      }
      const sep = SEPARATORS.find((s) => raw.startsWith(s, i));
      // `&>` and `2>&1` are redirects, not the background separator.
      if (sep && !(sep === "&" && (raw[i + 1] === ">" || raw[i - 1] === ">"))) {
        const text = raw.slice(start, i).trim();
        if (text) parts.push({ text, next: sep === "\n" ? ";" : sep });
        else if (sep !== "\n" && sep !== ";") {
          error = `Nothing comes before "${sep}".`;
          break;
        }
        start = i + sep.length;
        i += sep.length - 1;
      }
    }
  }
  if (!error && quote) error = "A quote is never closed, so nothing is allowed.";
  if (!error && (depth > 0 || backtick)) error = "A command substitution is never closed, so nothing is allowed.";
  const tail = raw.slice(start).trim();
  if (!error && tail) parts.push({ text: tail, next: null });
  if (parts.length) parts[parts.length - 1].next = null;
  const stages = parts.map((p, index): Stage => {
    const w = words(p.text);
    const reasons = [
      ...(w.assignment ? ["It starts with a variable assignment."] : []),
      ...(w.substitution ? ["It holds a command substitution."] : []),
      ...(w.writeRedirect ? ["It redirects output into a file."] : []),
    ];
    return { index, text: p.text, argv: w.argv, argvComplete: reasons.length === 0, reasons, next: p.next };
  });
  return { raw, stages, error };
}

/** Read-only commands that clear on their own. */
export const KNOWN_SAFE: readonly string[] = ["wc", "echo", "cat", "ls", "head", "tail", "grep", "pwd", "date", "true", "sort", "uniq", "diff", "stat", "du"];
/** Prefixes that are everything after them, so a workspace grant is never offered for them (a bare `git` too). */
export const INTERPRETERS: readonly string[] = ["python", "python3", "bash", "sh", "zsh", "node", "perl", "ruby", "php", "env", "sudo", "xargs", "eval", "exec"];

/** True for a stage on the dangerous list: recursive or forced deletes, hard resets, force pushes, disk tools. */
export function isDangerous(argv: readonly string[]): boolean {
  const [cmd, ...rest] = argv;
  const flags = rest.filter((a) => a.startsWith("-")).join(" ");
  if (cmd === "rm") return /(^|\s)-[a-zA-Z]*[rRf]|--recursive|--force/.test(flags);
  if (cmd === "git") return (rest[0] === "push" && /--force|-f\b/.test(flags)) || (rest[0] === "reset" && /--hard/.test(flags)) || (rest[0] === "clean" && /-[a-z]*f/.test(flags));
  if (cmd === "chmod" || cmd === "chown") return /-R/.test(flags);
  return ["dd", "mkfs", "shred", "sudo", "truncate"].includes(cmd ?? "");
}

export interface WorkspaceRule {
  prefix: readonly string[];
  effect: "allow" | "deny";
}

export type Resolution = "known_safe" | "allowed_by_rule" | "denied_by_rule" | "unresolved";

function matches(rule: WorkspaceRule, argv: readonly string[]): boolean {
  return rule.prefix.length > 0 && rule.prefix.every((p, i) => argv[i] === p);
}

/** Judges one stage. A deny beats an allow; an incomplete or dangerous stage never clears on its own. */
export function resolveStage(stage: Stage, rules: readonly WorkspaceRule[] = []): { resolution: Resolution; why: string } {
  if (rules.some((r) => r.effect === "deny" && matches(r, stage.argv))) return { resolution: "denied_by_rule", why: "A workspace rule denies it." };
  if (!stage.argvComplete) return { resolution: "unresolved", why: stage.reasons.join(" ") };
  if (rules.some((r) => r.effect === "allow" && matches(r, stage.argv))) return { resolution: "allowed_by_rule", why: "A workspace rule you granted allows it." };
  if (isDangerous(stage.argv)) return { resolution: "unresolved", why: "It's on the dangerous list." };
  if (KNOWN_SAFE.includes(stage.argv[0] ?? "")) return { resolution: "known_safe", why: "It only reads." };
  return { resolution: "unresolved", why: "No rule covers it." };
}

/** The workspace grant offered for a held stage, or null: none for interpreters, dangerous or incomplete stages. */
export function grantPrefix(stage: Stage): string[] | null {
  const [cmd, sub] = stage.argv;
  if (!cmd || !stage.argvComplete || INTERPRETERS.includes(cmd) || isDangerous(stage.argv)) return null;
  if (cmd === "git" && (!sub || sub.startsWith("-"))) return null;
  return sub && !sub.startsWith("-") && !sub.includes("/") && !sub.includes(".") ? [cmd, sub] : [cmd];
}

/** The index of the first stage that holds the command, or -1 when every stage clears. A denied stage holds too. */
export function firstHeld(split: Split, rules: readonly WorkspaceRule[] = []): number {
  if (split.error) return 0;
  return split.stages.findIndex((s) => resolveStage(s, rules).resolution !== "known_safe" && resolveStage(s, rules).resolution !== "allowed_by_rule");
}
