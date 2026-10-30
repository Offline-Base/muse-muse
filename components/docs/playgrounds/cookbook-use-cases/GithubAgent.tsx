"use client";

import { useId, useMemo, useRef, useState, type ReactNode } from "react";
import { CodeView, ErrorBox, ModelSelect, RunButton, DEFAULT_TEXT_MODEL } from "@/components/docs/kit";
import { EffortSelect, PresetPills, Toggle } from "@/components/docs/kit/Field";
import type { Effort } from "@/lib/docs/client/models";
import styles from "@/components/docs/playgrounds/cookbook-use-cases/cuc.module.css";
import { Diff } from "@/components/docs/playgrounds/cookbook-use-cases/SandboxExec";
import { AgentBadge, RunBar, Timeline } from "@/components/docs/playgrounds/cookbook-use-cases/Timeline";
import { useAgentRun, type ToolEntry, type ToolExecutor } from "@/components/docs/playgrounds/cookbook-use-cases/useAgentRun";
import { agentBase, type AgentDef } from "@/components/docs/playgrounds/cookbook-use-cases/lib/agent";
import { parseArguments } from "@/components/docs/playgrounds/cookbook-use-cases/lib/responses";
import { runRepoTool } from "@/components/docs/playgrounds/cookbook-use-cases/lib/repo-tools";
import { AGENTS, agentInstructions, bashDecision, toolDefsFor, type AgentSpec, type Tracker } from "@/components/docs/playgrounds/cookbook-use-cases/lib/github";
import { GH_SCENARIOS, REPO, SUBAGENTS, WORKFLOWS, eventPrompt, fakeShell, gateFor, ghScenario, startState } from "@/components/docs/playgrounds/cookbook-use-cases/lib/github-sim";

/**
 * cookbook/github-agent: the recipe's bot, run against a sample repo the way the recipe validated it, with a fake gh
 * on PATH. Pick a GitHub event; its workflow decides the agent (event-first routing) or blocks the run (the /oc
 * author gate, the agent-fix label); the agent runs with its own tools, AGENTS.md and bash allow-list, and every
 * bash command shows the rule that allowed or denied it. The agent's final message is posted back as a comment.
 */

export interface GithubAgentProps {
  slug: string;
  scenario?: string;
}

const ORDER = ["triage", "review", "repo-agent", "qa", "rfc", "bugfix", "stale"];
/** The events the simple view shows; the rest wait behind Options. */
const FIRST_ROW = 5;

function agentDef(spec: AgentSpec, model: string, effort: Effort | null, depth: number): AgentDef {
  return {
    name: spec.name,
    model,
    instructions: agentInstructions(spec),
    tools: toolDefsFor(spec, SUBAGENTS),
    effort,
    maxOutputTokens: 4000,
    maxCalls: depth ? 8 : 12,
    parallelToolCalls: false,
    // Full history every call (store: false), the way OpenCode itself sends a session; no stored-response lookups.
    state: "replay",
  };
}

export function GithubAgent({ scenario: initialScenario = "triage-bug" }: GithubAgentProps) {
  const id = useId();
  const run = useAgentRun();
  const [scenarioId, setScenarioId] = useState(initialScenario);
  const [model, setModel] = useState(DEFAULT_TEXT_MODEL);
  const [effort, setEffort] = useState<Effort | null>("low");
  const s = ghScenario(scenarioId);
  const [tracker, setTracker] = useState<Tracker>(() => startState(s));
  const trackerRef = useRef<Tracker>(tracker);
  const [matched, setMatched] = useState<Record<string, Set<string>>>({});
  const [showCode, setShowCode] = useState(false);
  const diffs = useRef(new Map<string, string>());
  const branch = useRef({ name: "main" });

  const wf = WORKFLOWS[s.workflow];
  const spec = AGENTS[wf.agent];
  const gate = gateFor(s);

  const commit = (t: Tracker) => {
    trackerRef.current = t;
    setTracker(t);
  };

  const pick = (sid: string) => {
    setScenarioId(sid);
    run.reset();
    const t = startState(ghScenario(sid));
    commit(t);
    setMatched({});
    diffs.current.clear();
  };

  const exec: ToolExecutor = async (agent, call, rt, depth) => {
    const { value, error } = parseArguments(call.arguments);
    if (error) return { output: error, status: "error" };
    const sp = AGENTS[agent.name];
    if (call.name === "bash") {
      const command = String(value.command ?? "");
      const d = bashDecision(sp.bash, command);
      setMatched((m) => ({ ...m, [sp.name]: new Set([...(m[sp.name] ?? []), d.rule ?? "(no rule)"]) }));
      if (d.decision === "deny") {
        return { output: `Permission denied: \`${command}\` is not on the ${sp.name} agent's bash allow-list${d.rule && d.rule !== "*" ? ` (matched "${d.rule}": deny)` : ""}.`, status: "denied", note: `denied by "${d.rule ?? "*"}"` };
      }
      const r = fakeShell(command, trackerRef.current, s, branch.current);
      commit(r.tracker);
      return { output: r.out || "(no output)", status: r.code === 0 ? "done" : "error", note: `allowed by "${d.rule}"${r.code ? `, exit ${r.code}` : ""}` };
    }
    if (call.name === "task") {
      const sub = String(value.subagent_type ?? "");
      const target = AGENTS[sub];
      if (!target || !SUBAGENTS.includes(sub)) return { output: `Unknown agent ${sub}. Use one of: ${SUBAGENTS.join(", ")}.`, status: "error" };
      rt.note(`task: ${String(value.description ?? sub)}`, "info", sp.name, depth);
      const res = await rt.run(agentDef(target, model, effort, depth + 1), String(value.prompt ?? ""), depth + 1);
      return { output: res.text || `(${sub} returned no message: ${res.stoppedBy})`, note: `ran ${sub}` };
    }
    if ((call.name === "edit" || call.name === "write") && !sp.tools.includes(call.name)) {
      return { output: `Permission denied: the ${sp.name} agent has ${call.name}: false.`, status: "denied" };
    }
    const r = runRepoTool(call.name, value, trackerRef.current.files);
    if (!r) return { output: `Unknown tool ${call.name}.`, status: "error" };
    if (r.diff) {
      commit({ ...trackerRef.current, files: r.files });
      diffs.current.set(call.callId, r.diff);
    }
    return { output: r.output, status: r.ok ? "done" : "error" };
  };

  const start = () => {
    const t0 = startState(s);
    commit(t0);
    setMatched({});
    diffs.current.clear();
    branch.current = { name: "main" };
    void run.start(async (rt) => {
      rt.note(`Workflow ${wf.name} (${wf.on}) fired by ${s.event}. Job permissions: ${wf.permissions.join(", ")}.`);
      if (!gate.runs) return rt.note(gate.reason, "warn");
      rt.note(`${gate.reason} Agent: ${wf.agent}.`, "good");
      const res = await rt.run(agentDef(spec, model, effort, 0), eventPrompt(s, t0));
      if (res.stoppedBy !== "answer" || !res.text) return rt.note(`The run ended without a final message (${res.stoppedBy}). The workflow is safe to re-run.`, "warn");
      const t = trackerRef.current;
      const comment = { author: "opencode-agent[bot]", body: res.text, bot: true };
      if (s.target?.kind === "issue") commit({ ...t, issues: t.issues.map((i) => (i.number === s.target!.number ? { ...i, comments: [...i.comments, comment] } : i)) });
      else if (s.target?.kind === "pr") commit({ ...t, prs: t.prs.map((p) => (p.number === s.target!.number ? { ...p, comments: [...p.comments, comment] } : p)) });
      rt.note(s.target ? `The final message was posted as a comment on ${s.target.kind === "pr" ? "PR" : "issue"} #${s.target.number}.` : "The summary went to the workflow log.", "good");
    }, exec);
  };

  const renderTool = (e: ToolEntry): ReactNode => {
    const d = diffs.current.get(e.callId);
    return d ? <Diff patch={d} /> : undefined;
  };

  const issue = s.target?.kind === "issue" ? tracker.issues.find((i) => i.number === s.target!.number) : null;
  const pr = s.target?.kind === "pr" ? tracker.prs.find((p) => p.number === s.target!.number) : null;
  const firstBody = useMemo(() => ({ ...agentBase(agentDef(spec, model, effort, 0)), input: eventPrompt(s, startState(s)) }), [spec, model, effort, s]);
  const used = matched[spec.name] ?? new Set<string>();

  return (
    <div className="pg">
      <PresetPills presets={GH_SCENARIOS.slice(0, FIRST_ROW).map((x) => ({ label: x.label }))} active={GH_SCENARIOS.findIndex((x) => x.id === scenarioId)} onPick={(i) => pick(GH_SCENARIOS[i].id)} disabled={run.busy} />
      <div className="pg-advanced">
        <PresetPills presets={GH_SCENARIOS.slice(FIRST_ROW).map((x) => ({ label: x.label }))} active={GH_SCENARIOS.findIndex((x) => x.id === scenarioId) - FIRST_ROW} onPick={(i) => pick(GH_SCENARIOS[FIRST_ROW + i].id)} disabled={run.busy} />
      </div>

      <div className={styles.grid2}>
        <div className={styles.card}>
          <p className={styles.cardTitle}>
            {REPO}: {s.event}
          </p>
          {issue ? (
            <>
              <p>
                <strong>
                  #{issue.number} {issue.title}
                </strong>
              </p>
              <p className="pg-hint">
                @{issue.author} ({issue.association}) {issue.labels.length ? "· labels:" : ""}{" "}
                {issue.labels.map((l) => (
                  <span key={l} className={styles.chip} data-tone={l === "agent-fix" ? "warn" : "accent"} style={{ marginRight: 4 }}>
                    {l}
                  </span>
                ))}
              </p>
              <p className={styles.answer}>{issue.body}</p>
            </>
          ) : pr ? (
            <>
              <p>
                <strong>
                  PR #{pr.number} {pr.title}
                </strong>
              </p>
              <p className="pg-hint">
                @{pr.author} ({pr.association}) · {pr.head} into {pr.base}
              </p>
              <p className={styles.answer}>{pr.body}</p>
              <details>
                <summary className="pg-small">The diff</summary>
                <Diff patch={pr.diff} />
              </details>
            </>
          ) : (
            <p className="pg-hint">
              A scheduled run over the open issues: {tracker.issues.filter((i) => i.state === "open").map((i) => `#${i.number}`).join(", ")}.
            </p>
          )}
          {s.comment ? (
            <p className="pg-small">
              <strong>
                @{s.comment.author} ({s.comment.association}):
              </strong>{" "}
              {s.comment.body}
            </p>
          ) : null}
        </div>

        <div className={`${styles.card} pg-advanced`}>
          <p className={styles.cardTitle}>.github/workflows/{wf.name}.yml</p>
          <pre className="pg-pre" style={{ maxHeight: 150 }}>
            {[`on: ${wf.on}`, `permissions: ${wf.permissions.join(", ")}`, ...(wf.gate ? [`if: ${wf.gate}`] : []), `agent: ${wf.agent}`, "model: model_api/muse-spark-1.3-contributor"].join("\n")}
          </pre>
          <p className={`pg-small ${gate.runs ? "" : "pg-bad"}`}>{gate.reason}</p>
          <p className="pg-small">
            <AgentBadge name={spec.name} order={ORDER} /> mode {spec.mode} · tools {spec.tools.join(", ")}
          </p>
          {spec.bash.length ? (
            <details>
              <summary className="pg-small">bash allow-list ({spec.bash.length} rules, first match wins)</summary>
              <ul className="pg-checks">
                {spec.bash.map(([p, d]) => (
                  <li key={p} className={d === "allow" ? "pg-check-ok" : ""} style={used.has(p) ? { fontWeight: 700 } : undefined}>
                    <span className="pg-check-mark">{d === "allow" ? "✓" : "✗"}</span> <span className={styles.mono}>&quot;{p}&quot;: {d}</span>
                    {used.has(p) ? " (used in this run)" : ""}
                  </li>
                ))}
              </ul>
            </details>
          ) : (
            <p className="pg-hint">No bash for this agent.</p>
          )}
        </div>
      </div>

      <div className="pg-bar">
        <ModelSelect kind="text" value={model} onChange={setModel} disabled={run.busy} />
        <EffortSelect id={`${id}-effort`} model={model} value={effort} onChange={setEffort} disabled={run.busy} />
        <Toggle id={`${id}-step`} label="Pause after each step" checked={run.stepMode} onChange={run.setStepMode} />
      </div>
      <div className="pg-actions">
        <RunButton running={run.busy} onRun={start} onStop={run.stop} label={gate.runs ? `Fire the event` : "Fire the event (the gate blocks it)"} />
        <span className="pg-hint pg-advanced">Nothing reaches GitHub: gh and git are fakes over the sample data. A run is a few model calls, well under a cent on Spark Contributor; Muse Wonder costs 40 to 100 times as much per token.</span>
      </div>
      <RunBar busy={run.busy} modelCalls={run.modelCalls} totalUsd={run.totalUsd} waitingStep={run.waitingStep} onAdvance={run.advance} />
      <ErrorBox error={run.error} />
      <Timeline entries={run.entries} onAnswer={run.answer} renderTool={renderTool} order={ORDER} label="Agent run" />

      {(issue?.comments.length || pr?.comments.length || tracker.opened.length) && !run.busy ? (
        <div className={styles.card}>
          <p className={styles.cardTitle}>On GitHub now</p>
          {issue ? (
            <p className="pg-hint">
              #{issue.number} labels: {issue.labels.join(", ") || "none"}
            </p>
          ) : null}
          {[...(issue?.comments ?? []), ...(pr?.comments ?? [])].map((c, i) => (
            <div key={i} className={styles.stack}>
              <p className="pg-small">
                <strong>{c.author}</strong> commented
              </p>
              <p className={styles.answer}>{c.body}</p>
            </div>
          ))}
          {tracker.opened.map((o) => (
            <div key={o.number} className={styles.stack}>
              <p className="pg-small">
                <strong>PR #{o.number} opened: {o.title}</strong> ({o.head} into main, awaiting human review; the agent can&apos;t merge)
              </p>
              <p className={styles.answer}>{o.body}</p>
              <Diff patch={o.diff} />
            </div>
          ))}
        </div>
      ) : null}
      {!run.busy && s.id === "stale" ? (
        <p className="pg-hint">
          Labels now:{" "}
          {tracker.issues
            .filter((i) => i.state === "open")
            .map((i) => `#${i.number} ${i.labels.join("+") || "none"}`)
            .join(" · ")}
        </p>
      ) : null}

      <div className="pg-actions">
        <Toggle id={`${id}-code`} label="Show code" checked={showCode} onChange={setShowCode} />
      </div>
      {showCode ? <CodeView method="POST" path="responses" body={firstBody} caption={`The ${spec.name} agent's first call: AGENTS.md plus its prompt, its tools, and the event`} /> : null}
    </div>
  );
}
