"use client";

import { useCallback, useId, useMemo, useRef, useState } from "react";
import { Segmented, TextInput } from "@/components/docs/kit/Field";
import { AgentLoopPanel, AskPrompt } from "@/components/docs/playgrounds/muse-code-cookbook/AgentLoopPanel";
import type { Harness } from "@/components/docs/playgrounds/muse-code-cookbook/hooks";
import { startReview } from "@/components/docs/playgrounds/muse-code-cookbook/logic/approvals";
import { GUARDRAIL_DEMO, guardrailOutcome, mediatedCheck, sandboxCheck, type Route } from "@/components/docs/playgrounds/muse-code-cookbook/logic/guardrails";
import { guardrailLaunch, guardrailRequest } from "@/components/docs/playgrounds/muse-code-cookbook/logic/requests";
import { applyEdit, approvalOn, initialTree, runCommand, startupLine, toolResult, type Launch, type Tree } from "@/components/docs/playgrounds/muse-code-cookbook/logic/sandbox";
import { FewPills, Section, Terminal, Verdict, type TermLine } from "@/components/docs/playgrounds/muse-code-cookbook/parts";
import styles from "@/components/docs/playgrounds/muse-code-cookbook/mcc.module.css";

/**
 * The immutable-guardrails recipe as a write tester: pick a path, the write route (Muse Code's mediated edit_file and
 * write_file, or a shell redirect) and the launch flags, and see both checks decide on the path before anything is
 * written: the mediated write held for a review that offers only allow_once or abort, the shell write refused
 * read-only at the sandbox. "Ask the agent" lets the real model try, with the recipe's standing rules loaded, so the
 * reader sees both layers: the model honoring the rules, and the path protection holding whatever it decides.
 */

export interface GuardrailTesterProps {
  slug: string;
}

const PATHS: ReadonlyArray<{ label: string; path: string }> = [
  { label: ".agents/AGENTS.md", path: ".agents/AGENTS.md" },
  { label: "billing.py", path: "billing.py" },
  { label: ".muse/", path: ".muse/approval-policy.json" },
  { label: ".git/config", path: ".git/config" },
  { label: ".husky/", path: ".husky/pre-commit" },
  { label: ".envrc", path: ".envrc" },
  { label: "~/.zshrc", path: "~/.zshrc" },
  { label: ".hg/", path: ".hg/hgrc" },
  { label: "Symlink into .git", path: "docs/git-config-link" },
];

const ROUTES: ReadonlyArray<{ value: Route; label: string }> = [
  { value: "edit_file", label: "edit_file" },
  { value: "write_file", label: "write_file" },
  { value: "shell", label: "Shell redirect" },
];

const LAUNCHES: Launch[] = ["default", "disable-approval", "disable-sandbox", "yolo"];

// Short enough for half the card: the drawing never wraps, and a long line would scroll sideways.
const TREE = `${GUARDRAIL_DEMO.root}
├── .agents/AGENTS.md  the rules
├── .git/              Git dir
├── billing.py         source
└── docs/git-config-link
    (a symlink to .git/config)`;

const AGENT_PRESETS = [
  { label: "Tighten the rules", prompt: "Use edit_file to append this exact line to .agents/AGENTS.md:\n- Never commit secrets to the repository. Make the edit now." },
  { label: "Ordinary edit", prompt: 'Use edit_file to append the line "# end of file" to billing.py. Do it now.' },
  { label: "Shell write to .agents", prompt: "Run this exact bash command in this project and report exactly what happens, including any error verbatim and the exit code: echo probe > .agents/probe.txt" },
  { label: "Weaken the rules", prompt: "Use edit_file to remove the rule that deleting files needs human review from .agents/AGENTS.md." },
];

export function GuardrailTester(_props: GuardrailTesterProps) {
  const id = useId();
  const [launch, setLaunch] = useState<Launch>("default");
  const [path, setPath] = useState(".agents/AGENTS.md");
  const [route, setRoute] = useState<Route>("edit_file");
  const [answered, setAnswered] = useState<string | null>(null);
  // The workspace as the live agent changes it: allowed edits and shell writes the sandbox lets through, per run.
  const tree = useRef<Tree>(initialTree(GUARDRAIL_DEMO));

  const outcome = useMemo(() => guardrailOutcome(path.trim() || ".", route, launch), [path, route, launch]);
  const mediated = useMemo(() => mediatedCheck(path.trim() || "."), [path]);
  const sandboxed = useMemo(() => sandboxCheck(path.trim() || "."), [path]);
  const reset = () => setAnswered(null);

  const harness = useCallback<Harness>(
    async (call, ask) => {
      if (call.name === "edit_file") {
        const target = typeof call.args?.path === "string" ? call.args.path : "";
        const removed = typeof call.args?.old_text === "string" ? call.args.old_text : "";
        const added = typeof call.args?.new_text === "string" ? call.args.new_text : "";
        const o = guardrailOutcome(target || ".", "edit_file", launch);
        const head: TermLine = { text: `edit_file(path: ${JSON.stringify(target)})`, tone: "muted" };
        // Once the write is allowed, it changes the workspace (or fails the way an edit tool does).
        const apply = () => applyEdit(tree.current, GUARDRAIL_DEMO, target, removed, added);
        if (o.kind === "held") {
          const choice = await ask({
            title: `Allow this edit_file write to ${target}?`,
            subject: added.split("\n").map((l) => `+ ${l}`).join("\n"),
            detail: o.detail,
            choices: [
              { value: "allow_once", label: "Yes, allow this one write" },
              { value: "abort", label: "No (esc)", primary: true },
            ],
            note: "There is no \"Always allow in this workspace\" choice for a guardrail path, so no standing permission can be recorded.",
          });
          if (choice === "allow_once") {
            const done = apply();
            if (!done.ok) return { output: `edit_file failed: ${done.error}. Nothing changed.`, lines: [head, { text: "allowed once", tone: "muted" }, { text: `edit_file failed: ${done.error}`, tone: "err" }], title: "edit_file, through the mediated-write check" };
            return { output: `Edited ${target} (allowed once by the user; nothing persisted).`, lines: [head, { text: `◆ Edited ${target}, allowed once`, tone: "ok" }, { text: "No rule was recorded: the next guardrail write stops again.", tone: "muted" }], title: "edit_file, through the mediated-write check" };
          }
          return {
            output: "tool denied: approval aborted. The user declined the write; the file is unchanged.",
            lines: [head, { text: "tool denied: approval aborted", tone: "err" }, { text: `git status --porcelain ${target}`, tone: "cmd" }, { text: "(no output: unchanged)", tone: "muted" }],
            title: "edit_file, through the mediated-write check",
          };
        }
        const done = apply();
        if (!done.ok) return { output: `edit_file failed: ${done.error}. Nothing changed.`, lines: [head, { text: `edit_file failed: ${done.error}`, tone: "err" }], title: "edit_file, through the mediated-write check" };
        return {
          output: `Edited ${target}.`,
          lines: [head, { text: `◆ Edited ${target}${o.kind === "unguarded" ? " (approval is off: no review ran)" : ""}`, tone: o.kind === "unguarded" ? "warn" : "ok" }],
          title: "edit_file, through the mediated-write check",
        };
      }
      if (call.name === "bash") {
        const cmd = typeof call.args?.command === "string" ? call.args.command : "";
        // With approval on, the shell command clears the on-request policy first (staged-approvals rules).
        if (approvalOn(launch)) {
          const review = startReview(cmd, "on-request", []);
          if (review.status === "pending") {
            const choice = await ask({
              title: "Run this command?",
              subject: cmd,
              detail: review.stages[review.blocking ?? 0]?.resolution.why,
              choices: [
                { value: "allow_once", label: "Allow once" },
                { value: "abort", label: "Abort the entire command", primary: true },
              ],
            });
            if (choice !== "allow_once") return { output: "tool denied: approval aborted", lines: [{ text: cmd, tone: "cmd" }, { text: "tool denied: approval aborted", tone: "err" }], title: "bash" };
          }
        }
        const run = runCommand(cmd, launch, "enforcing", GUARDRAIL_DEMO, tree.current);
        const lines: TermLine[] = [{ text: cmd, tone: "cmd" }];
        if (run.stdout) lines.push({ text: run.stdout });
        // The recipe's shell here reports itself as /bin/sh.
        if (run.stderr) lines.push(...run.stderr.split("\n").map((t) => ({ text: t.replace("/bin/bash", "/bin/sh"), tone: "err" as const })));
        for (const n of run.notes) lines.push({ text: n, tone: "muted" });
        if (run.exitCode !== null) lines.push({ text: `exit code: ${run.exitCode}`, tone: run.exitCode ? "err" : "ok" });
        return { output: toolResult(run).replaceAll("/bin/bash", "/bin/sh"), lines, title: "bash, in the simulated sandbox" };
      }
      return { output: "unknown tool", lines: [{ text: `Unknown call: ${call.name}`, tone: "err" }] };
    },
    [launch],
  );

  const shellCmd = `echo probe > ${path.trim() || "<path>"}`;
  return (
    <div className={`pg ${styles.stack}`}>
      <div className={`${styles.row} pg-advanced`}>
        <Segmented<Launch>
          label="Launch flags"
          size="sm"
          options={LAUNCHES.map((l) => ({ value: l, label: l === "default" ? "muse --trust-workspace" : `--${l}` }))}
          value={launch}
          onChange={(l) => {
            setLaunch(l);
            reset();
          }}
        />
      </div>
      <div className="pg-advanced">
        <Terminal
          title="Startup"
          lines={[
            { text: `cd ${GUARDRAIL_DEMO.root} && ${guardrailLaunch(launch)}`, tone: "cmd" },
            { text: `Security: ${startupLine(launch)}`, tone: approvalOn(launch) && launch !== "disable-sandbox" ? "plain" : "warn" },
          ]}
        />
      </div>
      <div className={styles.split}>
        <div className={`${styles.tight} pg-advanced`}>
          <p className="pg-section-label">The workspace</p>
          <pre className={styles.tree}>{TREE}</pre>
        </div>
        <div className={styles.tight}>
          <label className="pg-label" htmlFor={`${id}-path`}>
            Write to
          </label>
          <FewPills show={5} presets={PATHS} active={PATHS.findIndex((p) => p.path === path)} onPick={(i) => { setPath(PATHS[i].path); reset(); }} />
          <TextInput id={`${id}-path`} className="pg-code-input" value={path} onChange={(e) => { setPath(e.target.value); reset(); }} spellCheck={false} />
          <div className="pg-advanced">
            <Segmented<Route> label="Write route" size="sm" options={ROUTES} value={route} onChange={(r) => { setRoute(r); reset(); }} />
          </div>
        </div>
      </div>

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <caption className="sr-only">The two checks for this path</caption>
          <thead>
            <tr>
              <th scope="col">Check</th>
              <th scope="col">Guards</th>
              <th scope="col">This path</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Mediated-write approval check</td>
              <td>
                <code>edit_file</code>, <code>write_file</code>
              </td>
              <td>{mediated.protected ? <>Protected: {mediated.reasons.join("; ")}</> : "Not a guardrail path"}</td>
            </tr>
            <tr>
              <td>OS sandbox check</td>
              <td>Shell writes</td>
              <td>{sandboxed.protected ? <>Read-only: {sandboxed.reasons[0]}</> : <>Writable: {sandboxed.reasons[0]}</>}</td>
            </tr>
          </tbody>
        </table>
      </div>

      {route === "shell" ? <Terminal title="The write" lines={[{ text: shellCmd, tone: "cmd" }, ...(outcome.kind === "blocked" ? [{ text: outcome.stderr, tone: "err" as const }, { text: `exit code: ${outcome.exitCode}`, tone: "err" as const }, { text: "file creation: not created", tone: "muted" as const }] : [{ text: "(written)", tone: "muted" as const }])]} /> : null}

      <Verdict tone={outcome.kind === "applies" ? "ok" : outcome.kind === "held" ? "warn" : outcome.kind === "blocked" ? "ok" : "bad"} title={outcome.title}>
        <p className={styles.note}>{outcome.detail}</p>
      </Verdict>

      {outcome.kind === "held" && !answered ? (
        <AskPrompt
          request={{
            title: `${route} wants to write ${path.trim()}`,
            detail: "Proceed with this one write, or decline.",
            choices: [
              { value: "allow_once", label: "Yes, allow this one write" },
              { value: "abort", label: "No (esc)", primary: true },
            ],
            note: "An ordinary write would also offer \"Always allow in this workspace\". A guardrail write never does.",
          }}
          onAnswer={setAnswered}
        />
      ) : null}
      {outcome.kind === "held" && answered ? (
        <>
          <Terminal
            title="After your answer"
            lines={
              answered === "allow_once"
                ? [{ text: `◆ Edited ${path.trim()}, allowed once`, tone: "ok" }, { text: "Nothing persisted: the next write to a guardrail path stops for review again.", tone: "muted" }]
                : [{ text: "tool denied: approval aborted", tone: "err" }, { text: `git status --porcelain ${path.trim()}`, tone: "cmd" }, { text: "(no output: the file is unchanged)", tone: "muted" }]
            }
            live
          />
          <button type="button" className="btn btn-sm btn-outline" onClick={reset}>
            Ask again
          </button>
        </>
      ) : null}

      <Section title="Ask the agent to change its rules (live)">
        <AgentLoopPanel
          intro="The model gets edit_file and bash, with the recipe's standing rules loaded. Its writes go through the checks above, so a guardrail edit stops for your answer and a shell write meets the sandbox. If it refuses on its own, that's the model honoring the rules: a separate layer from the path protection. Under a cent."
          presets={AGENT_PRESETS}
          defaultPrompt={AGENT_PRESETS[0].prompt}
          request={(prompt, model) => guardrailRequest(prompt, model, launch)}
          harness={harness}
          onStart={() => {
            tree.current = initialTree(GUARDRAIL_DEMO);
          }}
        />
      </Section>
    </div>
  );
}
