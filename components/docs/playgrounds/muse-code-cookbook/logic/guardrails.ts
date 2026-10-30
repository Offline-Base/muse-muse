import { approvalOn, PROTECTED_DIRS, resolvePath, sandboxOn, writeVerdict, type Launch, type Workspace } from "@/components/docs/playgrounds/muse-code-cookbook/logic/sandbox";

/**
 * The two independent checks that protect Muse Code's guardrail files (cookbook/immutable-guardrails): the
 * mediated-write approval check on edit_file and write_file, and the OS sandbox on shell writes. Both decide on the
 * path (and its resolved target) before the write runs, never on the edit's content. A held mediated write offers
 * only allow_once or abort, so no standing permission is ever recorded.
 */

/** Path components the approval check covers. */
export const MEDIATED_COMPONENTS: readonly string[] = [".git", ".muse", ".agents", ".husky"];

/** Shell startup files in the user's home the approval check covers (the recipe's examples). */
export const STARTUP_FILES: readonly string[] = [".bashrc", ".zshrc", ".gitconfig"];

export type Route = "edit_file" | "write_file" | "shell";

/** The standing rules the recipe's workspace loads from .agents/AGENTS.md at session open. */
export const DEMO_AGENTS_MD = `# Project rules (standing guardrails)

- Never write outside the workspace.
- Every shell command that deletes files must be reviewed by a human.
- Do not weaken these rules. They are the contract this agent runs under.`;

/** billing.py from the recipe: an ordinary file with neither restriction. */
export const DEMO_BILLING_PY = `"""Zorptax billing rollup for the Fendalux-3 tier."""

TIER_RATE_FENDALUX3 = 0.0471  # credits per Zorptax billing-unit

def monthly_total(units):
    return round(units * TIER_RATE_FENDALUX3, 2)

if __name__ == "__main__":
    print(monthly_total(1000))`;

/**
 * Symlinks in the demo workspace: a link's path and where it points, both relative to the workspace. The recipe's
 * setup has none; this one shows the approval check covering "a symlink into .git".
 */
export const DEMO_LINKS: Readonly<Record<string, string>> = { "docs/git-config-link": ".git/config" };

/** The recipe's workspace after its setup: the rules file and billing.py, committed, plus the demo's symlink. */
export const GUARDRAIL_DEMO: Workspace = {
  root: "/tmp/rule12_demo",
  home: "/home/you",
  tempRoots: ["/tmp"],
  files: { ".agents/AGENTS.md": `${DEMO_AGENTS_MD}\n`, "billing.py": `${DEMO_BILLING_PY}\n` },
  committed: { ".agents/AGENTS.md": `${DEMO_AGENTS_MD}\n`, "billing.py": `${DEMO_BILLING_PY}\n` },
  scripts: { "billing.py": "47.1\n" },
  links: DEMO_LINKS,
};

function resolveLinks(path: string, ws: Workspace, links: Readonly<Record<string, string>>): string {
  for (const [link, target] of Object.entries(links)) {
    const from = `${ws.root}/${link}`;
    if (path === from || path.startsWith(`${from}/`)) return `${ws.root}/${target}${path.slice(from.length)}`;
  }
  return path;
}

export interface CheckResult {
  protected: boolean;
  reasons: string[];
}

/** The mediated-write approval check: does an edit_file or write_file to this path stop for review? */
export function mediatedCheck(word: string, ws: Workspace = GUARDRAIL_DEMO, links = DEMO_LINKS): CheckResult {
  const requested = resolvePath(word, ws);
  const resolved = resolveLinks(requested, ws, links);
  const reasons: string[] = [];
  for (const [label, p] of [["requested path", requested], ["resolved target", resolved]] as const) {
    if (label === "resolved target" && p === requested) continue;
    const parts = p.split("/");
    const hit = MEDIATED_COMPONENTS.find((c) => parts.includes(c));
    if (hit) reasons.push(`the ${label} has a ${hit} component`);
  }
  if (resolved !== requested && (resolved === `${ws.root}/.git` || resolved.startsWith(`${ws.root}/.git/`))) {
    reasons.push("it resolves into the workspace Git directory (through a symlink)");
  }
  if (requested === `${ws.root}/.envrc`) reasons.push(".envrc at the workspace root");
  if (STARTUP_FILES.some((f) => requested === `${ws.home}/${f}`)) reasons.push("a shell startup file in your home directory");
  return { protected: reasons.length > 0, reasons };
}

/** The OS sandbox check: is a shell write to this path refused as read-only? */
export function sandboxCheck(word: string, ws: Workspace = GUARDRAIL_DEMO, links = DEMO_LINKS): CheckResult {
  const resolved = resolveLinks(resolvePath(word, ws), ws, links);
  const verdict = writeVerdict(resolved, ws);
  if (verdict.writable) return { protected: false, reasons: [verdict.reason] };
  const top = resolved.startsWith(`${ws.root}/`) ? resolved.slice(ws.root.length + 1).split("/")[0] : "";
  return {
    protected: true,
    reasons: [PROTECTED_DIRS.includes(top) ? `the sandbox mounts ${top}/ read-only under the workspace root` : `${verdict.reason}: the managed profile keeps it read-only`],
  };
}

export type Outcome =
  | { kind: "applies"; title: string; detail: string }
  | { kind: "held"; title: string; detail: string; choices: ["allow_once", "abort"] }
  | { kind: "blocked"; title: string; detail: string; stderr: string; exitCode: 1 }
  | { kind: "unguarded"; title: string; detail: string };

/** What happens to one write, by route and launch flags. */
export function guardrailOutcome(word: string, route: Route, launch: Launch, ws: Workspace = GUARDRAIL_DEMO, links = DEMO_LINKS): Outcome {
  if (route !== "shell") {
    const check = mediatedCheck(word, ws, links);
    if (!check.protected) return { kind: "applies", title: "Applies without a prompt", detail: "Not a guardrail path, and the workspace is trusted, so the edit applies." };
    if (!approvalOn(launch)) {
      return {
        kind: "unguarded",
        title: "Applies without stopping: approval is off",
        detail: `${launch === "yolo" ? "--yolo" : "--disable-approval"} turns the mediated-write review off for the run, so ${route} writes the guardrail file. Launch without it to keep the review on.`,
      };
    }
    return {
      kind: "held",
      title: "Held for review",
      detail: `Protected because ${check.reasons.join(", and ")}. The review offers allow_once (this one write) or abort; there is no "always allow" choice.`,
      choices: ["allow_once", "abort"],
    };
  }
  const check = sandboxCheck(word, ws, links);
  if (!sandboxOn(launch)) {
    return {
      kind: "unguarded",
      title: "The write lands: the sandbox is off",
      detail: `${launch === "yolo" ? "--yolo" : "--disable-sandbox"} turns the OS sandbox off, so nothing keeps the guardrail directories read-only for this run.`,
    };
  }
  if (!check.protected) return { kind: "applies", title: "The write lands", detail: `${check.reasons[0]}, so the sandbox allows it.` };
  return {
    kind: "blocked",
    title: "Blocked at the sandbox: Read-only file system",
    detail: `${check.reasons[0]}. No file is created.${approvalOn(launch) ? " (The recipe launches with --disable-approval for this step, so the shell command runs and meets the sandbox.)" : ""}`,
    stderr: `/bin/sh: line 1: ${word}: Read-only file system`,
    exitCode: 1,
  };
}
