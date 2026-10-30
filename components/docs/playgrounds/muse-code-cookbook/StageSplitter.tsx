"use client";

import { useCallback, useId, useRef, useState } from "react";
import { JsonTree } from "@/components/docs/kit/JsonTree";
import { PresetPills, Segmented, TextInput, runOnModEnter } from "@/components/docs/kit/Field";
import { AgentLoopPanel, AskPrompt } from "@/components/docs/playgrounds/muse-code-cookbook/AgentLoopPanel";
import type { AskRequest, Harness } from "@/components/docs/playgrounds/muse-code-cookbook/hooks";
import {
  answer,
  choicesFor,
  intentFor,
  jqOutput,
  policyFile,
  stageEvidence,
  STAGED_DEMO,
  startReview,
  toolOutcome,
  type Answer,
  type Mode,
  type Review,
  type Rule,
} from "@/components/docs/playgrounds/muse-code-cookbook/logic/approvals";
import { STAGED_WORKSPACE as WORKSPACE, stagedRequest } from "@/components/docs/playgrounds/muse-code-cookbook/logic/requests";
import { initialTree, runCommand, toolResult, type Tree } from "@/components/docs/playgrounds/muse-code-cookbook/logic/sandbox";
import { baseName, NO_PREFIX_COMMANDS, READ_ONLY_COMMANDS } from "@/components/docs/playgrounds/muse-code-cookbook/logic/shell";
import { Argv, Chip, FewPills, Section, Terminal, Verdict, type TermLine } from "@/components/docs/playgrounds/muse-code-cookbook/parts";
import styles from "@/components/docs/playgrounds/muse-code-cookbook/mcc.module.css";

/**
 * The staged-approvals recipe as a stage splitter: type a compound command, pick the approval mode and any rules
 * you've granted, and see it parsed into stages, each resolved on its own (known_safe, a policy allow, unresolved),
 * holding at the first stage that can't clear. Answer the prompt with the recipe's three scopes and watch the whole
 * command run once, or nothing run at all. "Ask the agent" sends the model's bash calls through the same stages.
 */

export interface StageSplitterProps {
  slug: string;
  command?: string;
}

const RECIPE_COMMAND = "wc -l report.log && echo cleaning && rm -rf report.log";

const COMMANDS: ReadonlyArray<{ label: string; command: string }> = [
  { label: "The recipe's command", command: RECIPE_COMMAND },
  { label: "sudo rm -f", command: "sudo rm -f build.log" },
  { label: "Read-only pipeline", command: "ls && cat quota_tool.py | grep RATE" },
  { label: "Assignment prefix", command: "FOO=1 make test" },
  { label: "Substitution + redirect", command: "echo $(whoami) > who.txt" },
  { label: "Interpreter", command: "python3 quota_tool.py; rm -rf dist" },
  { label: "Two grants", command: "cargo test && cargo test --release" },
];

const RULE_PRESETS: ReadonlyArray<{ label: string; rule: Rule }> = [
  { label: "allow cargo test", rule: { effect: "allow", prefix: ["cargo", "test"], origin: "preset" } },
  { label: "deny rm", rule: { effect: "deny", prefix: ["rm"], origin: "preset" } },
  { label: "prompt git push", rule: { effect: "prompt", prefix: ["git", "push"], origin: "preset" } },
];

const RES_TONE = { known_safe: "ok", policy_allow: "accent", unresolved: "warn", denied: "bad" } as const;

/** What each cleared stage prints, for the recipe's workspace (report.log holds one line). */
function stageOutput(argv: string[]): string {
  const cmd = argv.length ? baseName(argv[0]) : "";
  if (cmd === "wc" && argv.includes("report.log")) return "1 report.log";
  if (cmd === "echo") return argv.slice(1).join(" ");
  if (cmd === "ls") return "quota_tool.py  report.log";
  return "";
}

function whyNoPrefix(review: Review, at: number): string | null {
  const stage = review.stages[at]?.stage;
  if (!stage) return null;
  if (!stage.argvComplete) return "No workspace grant: the stage's argv isn't complete, so no persistent prefix is offered.";
  const cmd = baseName(stage.argv[0] ?? "");
  if (NO_PREFIX_COMMANDS.includes(cmd)) return `No workspace grant: ${cmd} is an interpreter or wrapper, so everything after it is arbitrary code.`;
  if (cmd === "git") return "No workspace grant for a bare git.";
  return null;
}

/** The prompt for the held stage: the full command, the stage counter and its argv, and the three scopes. */
function promptFor(review: Review): AskRequest | null {
  if (review.status !== "pending" || review.blocking === null) return null;
  const at = review.blocking;
  const stage = review.stages[at].stage;
  const prefix = choicesFor(stage).workspacePrefix;
  return {
    title: `Stage ${at + 1}/${review.stages.length} needs your answer`,
    subject: `${review.command}\n\nStage ${at + 1}/${review.stages.length}  ${JSON.stringify(stage.argv)}`,
    detail: review.stages[at].resolution.why,
    choices: [
      { value: "allow_once", label: "Allow once" },
      ...(prefix ? [{ value: "allow_workspace", label: `Always allow in this workspace: ${prefix.join(" ")} ...` }] : []),
      { value: "abort", label: "Abort the entire command", primary: true },
    ],
    note: whyNoPrefix(review, at) ?? (review.stages[at].resolution.dangerous ? "It's dangerous by policy, so a prefix grant would be a poor choice here; Allow once is the narrow answer." : undefined),
  };
}

function outcomeLines(review: Review): TermLine[] {
  const lines: TermLine[] = [];
  if (review.status === "ran") {
    lines.push({ text: `◆ Ran ${review.command}`, tone: "ok" });
    for (const s of review.stages) {
      const out = stageOutput(s.stage.argv);
      if (out) lines.push({ text: `  ${out}` });
    }
  } else if (review.status === "denied") {
    lines.push({ text: `◆ Ran ${review.command}`, tone: "muted" }, { text: `  └ ${toolOutcome(review)}`, tone: "err" });
  }
  if (review.status !== "pending" && /\brm -rf report\.log\b/.test(review.command)) {
    lines.push({ text: "ls -la report.log", tone: "cmd" });
    lines.push(review.status === "ran" ? { text: "ls: report.log: No such file or directory", tone: "warn" } : { text: "-rw-r--r-- 1 you you 16 ... report.log", tone: "ok" });
  }
  return lines;
}

export function StageSplitter(props: StageSplitterProps) {
  const id = useId();
  const [command, setCommand] = useState(props.command ?? RECIPE_COMMAND);
  const [mode, setMode] = useState<Mode>("on-request");
  const [rules, setRules] = useState<Rule[]>([]);
  const [review, setReview] = useState<Review>(() => startReview(props.command ?? RECIPE_COMMAND, "on-request", []));
  const rulesRef = useRef(rules);
  rulesRef.current = rules;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  // The recipe's workspace as the live agent's commands change it (an allowed rm -rf removes report.log), per run.
  const tree = useRef<Tree>(initialTree(STAGED_DEMO));

  const restart = (c = command, m = mode, r = rules) => setReview(startReview(c, m, r));
  const respond = (a: string) => {
    const next = answer(review, a as Answer);
    setReview(next);
    if (a === "allow_workspace") setRules(next.rules);
  };
  const editRules = (next: Rule[]) => {
    setRules(next);
    restart(command, mode, next);
  };

  const prompt = promptFor(review);
  const jq = jqOutput(review);
  const intent = intentFor(review);
  const evidence = stageEvidence(review);
  const granted = rules.filter((r) => r.origin === "granted");

  const harness = useCallback<Harness>(async (call, ask) => {
    const cmd = typeof call.args?.command === "string" ? call.args.command : "";
    if (call.name !== "bash" || !cmd) return { output: "unknown tool", lines: [{ text: `Unknown call: ${call.name}`, tone: "err" }] };
    let r = startReview(cmd, modeRef.current, rulesRef.current);
    while (r.status === "pending") {
      const p = promptFor(r);
      const choice = p ? await ask(p) : "abort";
      r = answer(r, (choice ?? "abort") as Answer);
      if (choice === "allow_workspace") setRules(r.rules);
    }
    setCommand(cmd);
    setReview(r);
    const stageLines: TermLine[] = r.stages.map((s, i) => ({ text: `stage ${i + 1}: ${JSON.stringify(s.stage.argv)} ${s.resolution.kind}${s.answer ? `, then ${s.answer}` : ""}`, tone: "muted" as const }));
    if (r.status !== "ran") {
      return { output: toolOutcome(r), lines: [{ text: cmd, tone: "cmd" }, ...stageLines, ...outcomeLines(r)], title: "bash, through the staged review" };
    }
    // Every stage cleared: the original text runs once, in the recipe's workspace (sandbox on, as muse launches).
    const run = runCommand(cmd, "default", "enforcing", STAGED_DEMO, tree.current);
    const lines: TermLine[] = [
      { text: cmd, tone: "cmd" },
      ...stageLines,
      { text: `◆ Ran ${cmd}`, tone: "ok" },
      ...(run.stdout ? run.stdout.split("\n").map((t) => ({ text: `  ${t}` })) : []),
      ...(run.stderr ? run.stderr.split("\n").map((t) => ({ text: `  ${t}`, tone: "err" as const })) : []),
      ...run.notes.map((t) => ({ text: t, tone: "muted" as const })),
    ];
    return { output: toolResult(run), lines, title: "bash, through the staged review" };
  }, []);

  return (
    <div className={`pg ${styles.stack}`}>
      <div className={`${styles.row} pg-advanced`}>
        <Segmented<Mode>
          label="Approval mode"
          size="sm"
          options={[
            { value: "on-request", label: "on-request (default)" },
            { value: "untrusted", label: "untrusted" },
          ]}
          value={mode}
          onChange={(m) => {
            setMode(m);
            restart(command, m, rules);
          }}
        />
        <code className={styles.mono}>{mode === "untrusted" ? "muse --approval-mode untrusted" : "muse"}</code>
      </div>
      <FewPills show={5} presets={COMMANDS} active={COMMANDS.findIndex((c) => c.command === command)} onPick={(i) => { setCommand(COMMANDS[i].command); restart(COMMANDS[i].command); }} />
      <div className={styles.row}>
        <label className="sr-only" htmlFor={`${id}-cmd`}>
          Compound command
        </label>
        <TextInput id={`${id}-cmd`} className={`pg-code-input ${styles.grow}`} value={command} onChange={(e) => setCommand(e.target.value)} onKeyDown={runOnModEnter(() => restart())} spellCheck={false} />
        <button type="button" className="btn btn-sm btn-outline" onClick={() => restart()}>
          Stage it
        </button>
      </div>

      <div className={`${styles.tight} pg-advanced`}>
        <div className={styles.spread}>
          <p className="pg-section-label">Rules you&apos;ve granted (approval-policy.json)</p>
          <PresetPills label="Add" presets={RULE_PRESETS} onPick={(i) => editRules([...rules, RULE_PRESETS[i].rule])} />
        </div>
        {rules.length ? (
          <ul className={styles.ruleList} aria-label="Rules">
            {rules.map((r, i) => (
              <li key={`${r.effect}-${r.prefix.join(" ")}-${i}`}>
                <span className={styles.chip}>
                  {r.effect} <code>{r.prefix.join(" ")}</code>
                  {r.origin === "granted" ? " (granted)" : ""}
                  <button type="button" className="icon-btn icon-btn-plain icon-btn-sm" aria-label={`Remove the rule ${r.effect} ${r.prefix.join(" ")}`} onClick={() => editRules(rules.filter((_, j) => j !== i))}>
                    ×
                  </button>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className={styles.note}>None yet. A deny beats a prompt and a prompt beats an allow, whatever their specificity; within one effect the most specific prefix wins.</p>
        )}
      </div>

      {review.parsed.error ? <div className="pg-hint pg-bad">{review.parsed.error}</div> : null}
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <caption className="sr-only">Stages and how each one resolved</caption>
          <thead>
            <tr>
              <th scope="col">Stage</th>
              <th scope="col">argv</th>
              <th scope="col">argv_complete</th>
              <th scope="col">Resolution</th>
            </tr>
          </thead>
          <tbody>
            {review.stages.map((s, i) => (
              <tr key={i} aria-current={review.blocking === i ? "step" : undefined}>
                <td>
                  {i + 1}
                  {s.stage.next ? <span className="pg-muted"> {s.stage.next}</span> : null}
                </td>
                <td>
                  <Argv argv={s.stage.argv} />
                  {s.stage.assignments.length ? <span className="pg-muted"> after {s.stage.assignments.join(" ")}</span> : null}
                </td>
                <td>{s.stage.argvComplete ? "true" : <>false <span className="pg-muted">({s.stage.incompleteReasons.join(", ")})</span></>}</td>
                <td>
                  <Chip tone={RES_TONE[s.resolution.kind]}>{s.resolution.kind}</Chip>
                  {s.answer ? <Chip tone={s.answer === "abort" ? "bad" : "ok"}>{s.answer}</Chip> : null}
                  <span className={styles.note}> {s.resolution.why}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className={`${styles.note} pg-advanced`}>
        Read-only set in this simulator: {READ_ONLY_COMMANDS.slice(0, 8).join(", ")} and a few more (the recipe names ls, cat, wc, grep and &quot;a small fixed set&quot;). Labels other than known_safe and unresolved are this demo&apos;s.
      </p>

      {prompt ? <AskPrompt request={prompt} onAnswer={respond} /> : null}
      {review.status !== "pending" ? (
        <>
          <Verdict tone={review.status === "ran" ? (review.reviewed ? "ok" : "info") : "bad"} title={review.status === "ran" ? (review.reviewed ? "Every stage cleared: the original text ran once" : "Every stage cleared on its own: no prompt") : "Denied: nothing ran, not even the safe stages"}>
            <p className={`${styles.note} pg-advanced`}>
              {review.status === "ran"
                ? "Muse Code executes the original command, unchanged, only after every stage is satisfied."
                : "Fail-closed: one rejected (or denied) stage denies the whole action, because the command runs as one unit."}
            </p>
          </Verdict>
          <Terminal title="Muse Code" lines={outcomeLines(review)} live />
          <button type="button" className="btn btn-sm btn-outline" onClick={() => restart()}>
            Run the same command again
          </button>
        </>
      ) : null}

      {review.reviewed && review.status !== "pending" ? (
        <Section title="Read the event log" className="pg-advanced">
          <Terminal
            title="The requested record's stages"
            lines={[{ text: `F=~/.local/share/muse/sessions/$(date +%Y/%m/%d)/*/session.jsonl`, tone: "cmd" }, { text: `jq -c 'select(.payload.event.kind=="requested" and (.payload.event.approval_subject.kind=="shell_command")) | ...' $F`, tone: "cmd" }, { text: jq.stages ?? "" }]}
          />
          <Terminal
            title="The decision that closed it"
            lines={[{ text: `jq -c 'select(.payload.event.kind=="decision_applied") | {decision:..., policy_result:...}' $F`, tone: "cmd" }, ...(jq.decision ?? "(still pending)").split("\n").map((t) => ({ text: t }))]}
          />
          {review.status === "ran" ? (
            <p className={styles.note}>
              The recipe prints only the rejected run&apos;s decision. For an allowed stage this shows <code>approved</code>, the value the audit recipe&apos;s log records when an action is allowed.
            </p>
          ) : null}
          {intent ? (
            <>
              <div className={styles.tight}>
                <p className="pg-section-label">The command-level side_effect_intent</p>
                <JsonTree value={intent} />
                <p className={styles.note}>It carries the authorization, policy_decision: allow:approved, and nothing about the stages.</p>
              </div>
              {evidence ? (
                <div className={styles.tight}>
                  <p className="pg-section-label">The approval event&apos;s stage_evidence</p>
                  <JsonTree value={{ stage_evidence: evidence }} openDepth={4} />
                  <p className={styles.note}>
                    Stage-level provenance stays here, where the auto-cleared stages show their own resolutions. The recipe names stage_evidence but doesn&apos;t print it, so these fields are this demo&apos;s.
                  </p>
                </div>
              ) : null}
            </>
          ) : (
            <p className={styles.note}>The review aborted, so there is no side_effect_intent with a tool:bash operation: the effect was never authorized, so it was never recorded as about to run.</p>
          )}
        </Section>
      ) : null}
      {granted.length ? <Terminal title="approval-policy.json (shape illustrative)" lines={policyFile(WORKSPACE, rules).split("\n").map((t) => ({ text: t }))} /> : null}

      <Section title="Ask the agent (live)">
        <AgentLoopPanel
          intro="The model gets a bash tool. Its command goes through the stages above, in the mode and with the rules you set, and stops for your answer at a held stage. The tool result tells the model whether the command ran. Under a cent."
          presets={[
            { label: "The recipe's prompt", prompt: `Run exactly this one bash command, verbatim, in a single tool call. Do not split it, do not reorder it, do not inspect first:\n${RECIPE_COMMAND}` },
            { label: "Clean up dist", prompt: "Delete the dist folder and the build.log file in this project with one bash command, then tell me what happened." },
          ]}
          defaultPrompt={`Run exactly this one bash command, verbatim, in a single tool call. Do not split it, do not reorder it, do not inspect first:\n${RECIPE_COMMAND}`}
          request={stagedRequest}
          harness={harness}
          onStart={() => {
            tree.current = initialTree(STAGED_DEMO);
          }}
        />
      </Section>
    </div>
  );
}
