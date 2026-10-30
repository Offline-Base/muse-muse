/**
 * The workflows page as rules (content/meta-docs/pages/muse-code/workflows.md): a workflow request built the way the
 * page structures one (bounded children, stages, a verifier, a final deliverable, read-only or isolated worktrees),
 * the saved workflow's name and file rules and its `muse workflows save` command, and the child limits (1,000 over a
 * workflow's lifetime, at most 16 active, wider batches queued).
 */

export type Writes = "read-only" | "worktrees" | "shared";

export interface WorkflowStage {
  /** One bounded responsibility per child. Two or more run in parallel. */
  children: string[];
}

export interface RequestInput {
  goal: string;
  stages: WorkflowStage[];
  verify: boolean;
  /** The final deliverable, such as "one prioritized report". Empty for none. */
  deliverable: string;
  writes: Writes;
  /** For writers in worktrees: run the tests and commit. */
  runTests: boolean;
  commit: boolean;
}

function listOf(items: string[]): string {
  if (items.length <= 1) return items.join("");
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

function sentence(text: string): string {
  const t = text.trim().replace(/[.\s]+$/, "");
  return t ? `${t.charAt(0).toUpperCase()}${t.slice(1)}.` : "";
}

function lowerFirst(text: string): string {
  const t = text.trim().replace(/[.\s]+$/, "");
  return t ? `${t.charAt(0).toLowerCase()}${t.slice(1)}` : "";
}

/** The request to type into a session, in the page's structure: numbered steps, then the run's constraint. */
export function workflowRequest(input: RequestInput): string {
  const goal = lowerFirst(input.goal) || "do this task";
  const steps: string[] = [];
  for (const stage of input.stages) {
    const children = stage.children.map(lowerFirst).filter(Boolean);
    if (!children.length) continue;
    steps.push(children.length === 1 ? sentence(children[0]) : `In parallel, have separate agents ${listOf(children)}.`);
  }
  if (input.verify) steps.push("Have a verifier challenge every high-risk finding.");
  if (input.deliverable.trim()) steps.push(`Synthesize ${lowerFirst(input.deliverable)}.`);
  const constraint =
    input.writes === "read-only"
      ? "Keep this run read-only."
      : input.writes === "worktrees"
        ? `Give each writing agent an isolated worktree${input.runTests ? ", run the package tests" : ""}${input.commit ? ", ask each writer to commit its changes, then summarize the commits for review" : ""}. Keep read-only children in the shared workspace.`
        : "Writers share one checkout.";
  return [`Use a workflow to ${goal}.`, "", ...steps.map((s, i) => `${i + 1}. ${s}`), "", constraint].join("\n");
}

export function requestWarnings(input: RequestInput): string[] {
  const out: string[] = [];
  const children = input.stages.reduce((n, s) => n + s.children.filter((c) => c.trim()).length, 0);
  const parallel = input.stages.some((s) => s.children.filter((c) => c.trim()).length > 1);
  if (children <= 1 || (!parallel && input.stages.filter((s) => s.children.some((c) => c.trim())).length <= 1)) {
    out.push("Keep small edits, short explanations and tightly coupled changes on the main agent: a workflow adds time and tokens.");
  }
  if (input.writes === "shared") {
    out.push("Parallel writers in one checkout can collide. Ask for isolated worktrees: each writer gets its own Git worktree.");
  }
  if (input.writes === "worktrees") {
    out.push("Worktree isolation needs a Git repository and is never applied as a silent fallback.");
  }
  if (!input.deliverable.trim()) out.push("Define the final deliverable, so the workflow ends with one synthesized result.");
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Saving

export type Scope = "project" | "user";

const NAME = /^[a-z0-9][a-z0-9._-]*$/;
export const MAX_NAME = 64;
export const MAX_SCRIPT_BYTES = 512 * 1024;

export function nameProblems(name: string): string[] {
  const out: string[] = [];
  if (!name) return ["Give the workflow a name."];
  if (name.length > MAX_NAME) out.push(`Names can be up to ${MAX_NAME} characters; this one has ${name.length}.`);
  if (!/^[a-z0-9]/.test(name)) out.push("The first character must be a lowercase letter or a digit.");
  if (!NAME.test(name)) {
    const bad = [...new Set(name.replace(/[a-z0-9._-]/g, ""))].map((c) => (c === " " ? "a space" : `"${c}"`));
    if (bad.length) out.push(`Only lowercase letters, digits, periods, underscores and hyphens are allowed; found ${bad.join(", ")}.`);
  }
  return out;
}

export function saveCommand(name: string, file: string, scope: Scope, overwrite: boolean): string {
  const from = file.trim() || `./${name || "workflow"}.js`;
  return ["muse workflows save", name || "<name>", "--from", from, "--scope", scope, ...(overwrite ? ["--overwrite"] : [])].join(" ");
}

export function destination(name: string, scope: Scope): string {
  return scope === "project" ? `.agents/workflows/${name || "<name>"}.js` : "your Muse Code configuration directory (local to your account)";
}

/** What saving would say about a script file: regular, nonempty UTF-8, at most 512 KiB. It never parses the JavaScript. */
export function scriptProblems(bytes: Uint8Array): string[] {
  const out: string[] = [];
  if (!bytes.length) out.push("The file is empty: the source must be nonempty.");
  if (bytes.length > MAX_SCRIPT_BYTES) out.push(`The file is ${(bytes.length / 1024).toFixed(0)} KiB: the limit is 512 KiB.`);
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    out.push("The file isn't valid UTF-8.");
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Capacity

export const LIFETIME_CHILDREN = 1000;
export const ACTIVE_CAP = 16;

export interface CapacityInput {
  /** The machine's CPU-derived active-child limit before the cap. */
  cpuLimit: number;
  /** Children per stage, in order; each stage waits for the one before it. */
  stages: number[];
  /** Tokens one child spends, to compare with a single turn. */
  tokensPerChild: number;
}

export interface CapacityResult {
  activeLimit: number;
  waves: number[];
  queued: number[];
  total: number;
  /** The child number that fails the workflow, when the total passes 1,000. */
  failsAt: number | null;
  tokens: number;
}

export function capacity(input: CapacityInput): CapacityResult {
  const activeLimit = Math.max(1, Math.min(ACTIVE_CAP, Math.floor(input.cpuLimit) || 1));
  const stages = input.stages.map((n) => Math.max(0, Math.floor(n) || 0));
  const total = stages.reduce((a, b) => a + b, 0);
  return {
    activeLimit,
    waves: stages.map((n) => Math.ceil(n / activeLimit)),
    queued: stages.map((n) => Math.max(0, n - activeLimit)),
    total,
    failsAt: total > LIFETIME_CHILDREN ? LIFETIME_CHILDREN + 1 : null,
    tokens: Math.min(total, LIFETIME_CHILDREN) * Math.max(0, input.tokensPerChild || 0),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The live mini workflow: child calls in parallel, then one synthesis call

export interface MiniChild {
  title: string;
  task: string;
}

/** The code with line numbers, so findings can cite lines. */
export function numbered(code: string): string {
  return code
    .replace(/\s+$/, "")
    .split("\n")
    .map((line, i) => `${String(i + 1).padStart(2, " ")}  ${line}`)
    .join("\n");
}

export function childBody(model: string, child: MiniChild, code: string, maxOutputTokens = 1200): Record<string, unknown> {
  return {
    model,
    instructions: `You are one child agent in a workflow, with one bounded responsibility: ${lowerFirst(child.task)}. Read the code and report at most 3 findings, each with its line reference and why it matters. Stay inside your responsibility. Under 120 words.`,
    input: numbered(code),
    reasoning: { effort: "low" },
    max_output_tokens: maxOutputTokens,
  };
}

export function synthesisBody(model: string, instruction: string, code: string, findings: Array<{ title: string; text: string }>, maxOutputTokens = 1500): Record<string, unknown> {
  return {
    model,
    instructions: `You are the synthesis step of a workflow. ${sentence(instruction)} Check each finding against the code and drop any it doesn't support. Under 200 words.`,
    input: [`Code:\n${numbered(code)}`, ...findings.map((f, i) => `Child ${i + 1} (${f.title}):\n${f.text.trim() || "(no findings)"}`)].join("\n\n"),
    reasoning: { effort: "low" },
    max_output_tokens: maxOutputTokens,
  };
}
