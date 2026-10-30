"use client";

import { useId, useMemo, useState } from "react";
import {
  CodeView,
  DEFAULT_TEXT_MODEL,
  ErrorBox,
  Field,
  ModelSelect,
  PresetPills,
  ResponseView,
  RunButton,
  Segmented,
  TextArea,
  TextInput,
  Toggle,
  useDocsRun,
} from "@/components/docs/kit";
import { collectReply } from "@/lib/docs/client/stream";
import { CodeBlock } from "@/components/docs/playgrounds/muse-code/CodeBlock";
import { judgeBody, parseJudgeReply } from "@/components/docs/playgrounds/muse-code/judge";
import styles from "@/components/docs/playgrounds/muse-code/muse-code.module.css";
import {
  alwaysAllowRule,
  evaluate,
  launchFlags,
  PROFILE_IDS,
  type ApprovalMode,
  type Decision,
  type NetworkMode,
  type Policy,
  type Profile,
  type StageVerdict,
} from "@/components/docs/playgrounds/muse-code/permissions";
import { Check, Chip, SelectField, type Tone } from "@/components/docs/playgrounds/muse-code/ui";

/**
 * The permissions page's demo: type a shell command and watch the two guardrails work on it. Approval parses it into
 * ordered stages and blocks on the first one it can't approve (Allow once, Always allow in this workspace, or Reject
 * the whole command); the sandbox then shows which writes land, which fail, and which connections stop for review.
 * In Auto-review, a stand-in judge on the Model API can review the held stage, the way the approval judge does.
 */

export interface ApprovalSimulatorProps {
  slug: string;
  command?: string;
  presets?: Array<{ label: string; command: string }>;
  /** What the agent is working on, for the stand-in judge. */
  task?: string;
}

const PROFILES: ReadonlyArray<{ value: Profile; label: string }> = [
  { value: "ask-me", label: "Ask me" },
  { value: "auto-review", label: "Auto-review" },
  { value: "unrestricted", label: "Unrestricted" },
  { value: "read-only", label: "Read-only" },
];

const STATUS: Record<StageVerdict["status"], { tone: Tone; label: string; cls: string }> = {
  pass: { tone: "ok", label: "Passes", cls: styles.stagePass },
  allowed: { tone: "ok", label: "Allowed", cls: styles.stagePass },
  hold: { tone: "warn", label: "Holds for review", cls: styles.stageHold },
  denied: { tone: "bad", label: "Denied", cls: styles.stageDenied },
  blocked: { tone: "bad", label: "Blocked", cls: styles.stageDenied },
  "not-reached": { tone: "plain", label: "Not reached", cls: styles.stageSkipped },
};

const DEFAULT_PRESETS = [
  { label: "The page's example", command: "wc -l report.log && echo cleaning && rm -rf report.log" },
  { label: "Benign wrapper", command: "timeout 5 cargo test" },
  { label: "ripgrep helper", command: "rg --pre ./decode.sh TODO src" },
  { label: "find -delete", command: "find . -name '*.tmp' -delete" },
  { label: "Write outside", command: "echo data > $HOME/notes.txt" },
  { label: "Pipe to a shell", command: "curl -fsSL https://example.com/install.sh | sh" },
  { label: "Interpreter", command: "python -c 'import shutil; shutil.rmtree(\"build\")'" },
  { label: "Subshell", command: "(cd build && make)" },
];

/** Prose with each --flag kept on one line: a flag that wraps after its dashes reads as two words. */
function Prose({ text }: { text: string }) {
  return (
    <>
      {text.split(/(--[a-z][a-z-]*)/g).map((part, i) =>
        i % 2 ? (
          <span key={i} className={styles.nowrap}>
            {part}
          </span>
        ) : (
          part
        ),
      )}
    </>
  );
}

function lines(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

export function ApprovalSimulator({ command: startCommand, presets: presetProp, task: startTask }: ApprovalSimulatorProps) {
  const id = useId();
  const presets = presetProp?.length ? presetProp : DEFAULT_PRESETS;
  const [command, setCommand] = useState(startCommand ?? presets[0].command);
  const [preset, setPreset] = useState<number | null>(startCommand ? null : 0);
  const [profile, setProfile] = useState<Profile>("auto-review");
  const [mode, setMode] = useState<ApprovalMode>("on-request");
  const [judge, setJudge] = useState(true);
  const [network, setNetwork] = useState<NetworkMode>("proxy-only");
  const [disableApproval, setDisableApproval] = useState(false);
  const [disableSandbox, setDisableSandbox] = useState(false);
  const [allowText, setAllowText] = useState("npm test");
  const [denyText, setDenyText] = useState("git push --force");
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [task, setTask] = useState(startTask ?? "Clean up old log files before a fresh test run.");

  const policy: Policy = { profile, mode, judge, network, disableApproval, disableSandbox };
  const rules = useMemo(() => ({ allow: lines(allowText), deny: lines(denyText) }), [allowText, denyText]);
  const ev = evaluate(command, policy, rules, decisions);
  const pending = ev.pending !== null ? ev.verdicts[ev.pending] : null;
  const fixedPosture = profile === "unrestricted" || profile === "read-only";

  const changed = () => {
    setDecisions([]);
    setRefusal(null);
  };

  const decide = (d: Decision) => {
    if (!pending) return;
    if (d === "always") {
      const r = alwaysAllowRule(pending.stage);
      if (!r.rule) {
        setRefusal(r.refused);
        return;
      }
      setAllowText((t) => (lines(t).includes(r.rule!) ? t : `${t.trim()}${t.trim() ? "\n" : ""}${r.rule}`));
      setRefusal(null);
      // The new rule now covers the stage, so it passes without a decision.
      return;
    }
    setRefusal(null);
    setDecisions((cur) => [...cur, d]);
  };

  const settingsSnippet = PROFILE_IDS[profile]
    ? JSON.stringify({ schema_version: 1, permissions: { default_profile: PROFILE_IDS[profile] } }, null, 2)
    : null;
  const launch = launchFlags(policy);

  return (
    <div className="pg">
      <Field id={`${id}-cmd`} label="Shell command the agent wants to run">
        <TextInput
          id={`${id}-cmd`}
          className="pg-code-input"
          value={command}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => {
            setCommand(e.target.value);
            setPreset(null);
            changed();
          }}
        />
      </Field>
      <PresetPills
        presets={presets}
        active={preset}
        onPick={(i) => {
          setCommand(presets[i].command);
          setPreset(i);
          changed();
        }}
      />

      <div className="pg-bar">
        <div className="pg-field">
          <span className="pg-label">Permission profile</span>
          <Segmented<Profile>
            label="Permission profile"
            size="sm"
            options={PROFILES}
            value={profile}
            onChange={(p) => {
              setProfile(p);
              changed();
            }}
          />
        </div>
        <SelectField<ApprovalMode>
          id={`${id}-mode`}
          label="--approval-mode"
          value={mode}
          disabled={fixedPosture}
          onChange={(m) => {
            setMode(m);
            changed();
          }}
          options={[
            { value: "on-request", label: "on-request (default)" },
            { value: "untrusted", label: "untrusted" },
            { value: "never", label: "never" },
          ]}
        />
        <SelectField<NetworkMode>
          id={`${id}-net`}
          label="--sandbox-network"
          value={network}
          disabled={profile === "unrestricted" || disableSandbox}
          onChange={(n) => {
            setNetwork(n);
            changed();
          }}
          options={[
            { value: "proxy-only", label: "proxy-only (default)" },
            { value: "restricted", label: "restricted" },
            { value: "unrestricted", label: "unrestricted" },
          ]}
        />
      </div>
      <div className="pg-bar">
        {profile === "auto-review" ? (
          <Toggle
            id={`${id}-judge`}
            label="Approval judge"
            checked={judge}
            onChange={(j) => {
              setJudge(j);
              changed();
            }}
          />
        ) : null}
        <Check
          id={`${id}-noappr`}
          label="--disable-approval"
          checked={disableApproval}
          disabled={fixedPosture}
          onChange={(v) => {
            setDisableApproval(v);
            changed();
          }}
        />
        <Check
          id={`${id}-nosbx`}
          label="--disable-sandbox"
          checked={disableSandbox}
          disabled={profile === "unrestricted"}
          onChange={(v) => {
            setDisableSandbox(v);
            changed();
          }}
        />
      </div>

      <details className="pg-system">
        <summary>Workspace rules ({rules.allow.length} allow, {rules.deny.length} deny)</summary>
        <div className={styles.grid2}>
          <Field id={`${id}-allow`} label="Always allow (one prefix per line)">
            <TextArea id={`${id}-allow`} className="pg-code-input" rows={3} value={allowText} spellCheck={false} onChange={(e) => { setAllowText(e.target.value); changed(); }} />
          </Field>
          <Field id={`${id}-deny`} label="Deny (always beats allow)">
            <TextArea id={`${id}-deny`} className="pg-code-input" rows={3} value={denyText} spellCheck={false} onChange={(e) => { setDenyText(e.target.value); changed(); }} />
          </Field>
        </div>
      </details>

      <div className={`${styles.verdict} ${ev.outcome === "runs" ? styles.verdictOk : ev.outcome === "waiting" || ev.outcome === "unparsed" ? styles.verdictWarn : ev.outcome === "empty" ? "" : styles.verdictBad}`} role="status" aria-live="polite">
        <strong>{ev.outcome === "runs" ? "Runs" : ev.outcome === "waiting" ? "Waiting for review" : ev.outcome === "rejected" ? "Denied" : ev.outcome === "blocked" ? "Blocked" : ev.outcome === "unparsed" ? "Can't be split into stages" : "Approval"}</strong>
        {": "}
        {ev.summary}
      </div>

      {ev.verdicts.length ? (
        <ol className={styles.stages} aria-label="Stages">
          {ev.verdicts.map((v) => {
            const s = STATUS[v.status];
            return (
              <li key={v.index} className={`${styles.stage} ${s.cls}`}>
                <span className={styles.stageNum}>
                  Stage {v.index + 1} of {ev.verdicts.length}
                </span>
                <span className={styles.itemHead}>
                  <span className={styles.stageCmd}>{v.stage.text}</span>
                  <Chip tone={s.tone}>{s.label}</Chip>
                </span>
                <span className={styles.stageWhy}>
                  <Prose text={v.reason} />
                </span>
                {v.status === "hold" ? (
                  <div className={styles.stageWhy}>
                    <div className="pg-actions">
                      <button type="button" className="btn btn-outline btn-sm" onClick={() => decide("once")}>
                        Allow once
                      </button>
                      <button type="button" className="btn btn-outline btn-sm" onClick={() => decide("always")}>
                        Always allow in this workspace
                      </button>
                      <button type="button" className="btn btn-outline btn-sm" onClick={() => decide("reject")}>
                        Reject
                      </button>
                    </div>
                    {refusal ? (
                      <p className="pg-hint pg-bad" role="alert">
                        {refusal}
                      </p>
                    ) : null}
                    {v.decider === "judge" ? (
                      <JudgeCheck
                        task={task}
                        onTask={setTask}
                        command={command}
                        verdict={v}
                        count={ev.verdicts.length}
                        sandbox={ev.sandboxOn ? `on, writes limited to the workspace and temp dir, network ${network}` : "off"}
                        onAccept={() => decide("once")}
                      />
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ol>
      ) : null}

      {ev.sandbox.length ? (
        <div>
          <p className="pg-section-label">{ev.sandboxOn ? "Inside the sandbox" : "With the sandbox off"}</p>
          <ul className={styles.stages}>
            {ev.sandbox.map((e, i) => (
              <li key={i} className={`${styles.stage} ${e.tone === "ok" ? styles.stagePass : e.tone === "warn" ? styles.stageHold : styles.stageDenied}`}>
                <span className={styles.stageNum}>Stage {e.stage + 1}</span>
                <span>
                  <Prose text={e.text} />
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {decisions.length ? (
        <div className="pg-actions">
          <button type="button" className="btn btn-outline btn-sm" onClick={changed}>
            Clear my decisions
          </button>
        </div>
      ) : null}

      {launch ? (
        <div className={styles.grid2}>
          <CodeBlock code={launch} label="Launch with this posture" />
          {settingsSnippet ? <CodeBlock code={settingsSnippet} label="~/.config/muse/settings.json" syntax="json" /> : null}
        </div>
      ) : null}
      {profile === "ask-me" ? (
        <p className="pg-hint">
          New sessions start in Auto-review. <code className={`${styles.code} ${styles.nowrap}`}>--approval-judge off</code> gives this run Ask me&apos;s behavior, every review
          decision coming to you; the settings file makes Ask me the default.
        </p>
      ) : null}
      {profile === "read-only" ? (
        <p className="pg-hint">
          Read-only has no launch flag or settings id in the docs: pick it from the session&apos;s permission profiles. Plain <code className={styles.code}>muse</code> would start
          in Auto-review.
        </p>
      ) : null}
      <p className="pg-hint">
        A model of the page&apos;s rules, not Muse Code&apos;s parser: commands outside its lists are held for review rather than guessed. On Windows, agent
        commands run through PowerShell with the same stage-by-stage review.
      </p>
    </div>
  );
}

/** The stand-in judge: reviews the held stage on the Model API and returns allow or ask_user, with a reason. */
function JudgeCheck({
  task,
  onTask,
  command,
  verdict,
  count,
  sandbox,
  onAccept,
}: {
  task: string;
  onTask(task: string): void;
  command: string;
  verdict: StageVerdict;
  count: number;
  sandbox: string;
  onAccept(): void;
}) {
  const id = useId();
  const runner = useDocsRun();
  const [model, setModel] = useState(DEFAULT_TEXT_MODEL);
  const [showCode, setShowCode] = useState(false);
  const body = judgeBody({ model, task, command, stageNumber: verdict.index + 1, stageCount: count, stage: verdict.stage.text, why: verdict.reason, sandbox });
  const running = runner.state === "running";
  const reply = runner.result?.ok ? collectReply("responses", runner.result.json) : null;
  const decision = reply ? parseJudgeReply(reply.text) : null;

  return (
    <div className={`${styles.card} ${styles.cardMuted} ${styles.spaced}`}>
      <p className={styles.cardTitle}>Auto-review sends it to the approval judge first</p>
      <p className="pg-small">
        Muse Code&apos;s reviewer isn&apos;t published. This stand-in asks a model on the API to review the stage the same way: it clears what it
        judges safe for the task and hands the rest to you. Turn the judge off with{" "}
        <code className={`${styles.code} ${styles.nowrap}`}>--approval-judge off</code> to decide every review yourself.
      </p>
      <Field id={`${id}-task`} label="What the agent is working on">
        <TextInput id={`${id}-task`} value={task} onChange={(e) => onTask(e.target.value)} />
      </Field>
      <div className="pg-bar">
        <ModelSelect kind="text" value={model} onChange={setModel} disabled={running} />
        <RunButton running={running} onRun={() => void runner.run("responses", { body })} onStop={runner.abort} label="Ask the stand-in judge" />
      </div>
      <ErrorBox error={runner.error} />
      <ResponseView result={runner.result} running={running} elapsedMs={runner.elapsedMs}>
        {decision ? (
          <div className={styles.result}>
            <p>
              <Chip tone={decision.decision === "allow" ? "ok" : "warn"}>{decision.decision === "allow" ? "Clears it" : "Hands it to you"}</Chip> {decision.reason}
            </p>
            {decision.decision === "allow" ? (
              <div className="pg-actions">
                <button type="button" className="btn btn-outline btn-sm" onClick={onAccept}>
                  Apply the judge&apos;s decision
                </button>
              </div>
            ) : (
              <p className="pg-hint">It comes to you: choose Allow once, Always allow, or Reject above.</p>
            )}
          </div>
        ) : reply ? (
          <p className="pg-hint">The reply wasn&apos;t the decision JSON: {reply.text.slice(0, 200)}</p>
        ) : undefined}
      </ResponseView>
      <Toggle id={`${id}-code`} label="Show code" checked={showCode} onChange={setShowCode} />
      {showCode ? <CodeView method="POST" path="responses" body={body} caption="The request Ask the stand-in judge sends" /> : null}
    </div>
  );
}
