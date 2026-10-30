"use client";

import { useCallback, useId, useMemo, useRef, useState } from "react";
import { Segmented, TextInput, runOnModEnter } from "@/components/docs/kit/Field";
import { AgentLoopPanel } from "@/components/docs/playgrounds/muse-code-cookbook/AgentLoopPanel";
import type { Harness } from "@/components/docs/playgrounds/muse-code-cookbook/hooks";
import { containmentRequest } from "@/components/docs/playgrounds/muse-code-cookbook/logic/requests";
import {
  contractSteps,
  HOST_LABEL,
  initialTree,
  LAUNCH_FLAGS,
  PROTECTED_DIRS,
  runCommand,
  SANDBOX_DEMO,
  startupLine,
  toolResult,
  type Host,
  type Launch,
  type SandboxRun,
  type Tree,
} from "@/components/docs/playgrounds/muse-code-cookbook/logic/sandbox";
import { FewPills, Section, Steps, Terminal, Verdict, type TermLine } from "@/components/docs/playgrounds/muse-code-cookbook/parts";
import styles from "@/components/docs/playgrounds/muse-code-cookbook/mcc.module.css";

/**
 * The contained-execution recipe as a containment checker: pick the launch flags and what the probe finds on the
 * host, then run a command and watch the contract's five steps (policy, probe, run, enforce, refuse) and the exact
 * denial the OS returns at each boundary. "Ask the agent" gives the real model a bash tool whose calls run in this
 * simulated sandbox, so it meets the same boundaries and reports them, as in the recipe's screenshots.
 */

export interface ContainmentCheckerProps {
  slug: string;
  command?: string;
}

const COMMANDS: ReadonlyArray<{ label: string; command: string }> = [
  { label: "Run the script", command: "./build_info.sh" },
  { label: "Write to $HOME", command: "echo pwned > $HOME/sandbox_escape_probe.txt" },
  { label: "Overwrite .git/config", command: "echo hacked > .git/config" },
  { label: "Reach the network", command: "curl -sS --max-time 8 https://example.com" },
  { label: "Write in the workspace", command: "echo ok > notes.txt" },
  { label: "Write to /tmp", command: "touch /tmp/scratch.txt" },
  { label: "git commit", command: "git commit -am wip" },
];

const AGENT_PRESETS = [
  { label: "Fingerprint", prompt: "Run the bash command ./build_info.sh in this project and tell me the exact build fingerprint it prints." },
  { label: "Boundary 1: $HOME", prompt: "Run this exact bash command and report exactly what happens, including any error message verbatim: echo pwned > $HOME/sandbox_escape_probe.txt" },
  { label: "Boundary 2: .git", prompt: "Run this exact bash command in this project and report exactly what happens, including any error verbatim: echo hacked > .git/config" },
  { label: "Boundary 3: network", prompt: "Run this exact bash command and report exactly what happens, including any error verbatim: curl -sS --max-time 8 https://example.com" },
];

function runLines(command: string, run: SandboxRun): TermLine[] {
  const lines: TermLine[] = [{ text: command, tone: "cmd" }];
  if (run.refused) {
    lines.push({ text: "tool call failed before the command started: sandbox enforcement unavailable", tone: "err" });
    return lines;
  }
  if (run.stdout) lines.push({ text: run.stdout });
  if (run.stderr) lines.push(...run.stderr.split("\n").map((t) => ({ text: t, tone: "err" as const })));
  for (const s of run.stages) if (s.note) lines.push({ text: s.note, tone: "muted" });
  if (run.exitCode !== null) lines.push({ text: `Exit code: ${run.exitCode}`, tone: run.exitCode ? "err" : "ok" });
  for (const d of run.denials) lines.push({ text: `recorded in the session event log: ${d.op === "network" ? `blocked connection (${d.command} ${d.target})` : `denied write ${d.path}`}`, tone: "muted" });
  for (const l of run.landed) lines.push({ text: l.op === "write" ? `wrote ${l.path}` : `connection went out (${l.command})`, tone: run.probe === "skipped" ? "warn" : "muted" });
  return lines;
}

export function ContainmentChecker(props: ContainmentCheckerProps) {
  const id = useId();
  const [launch, setLaunch] = useState<Launch>("disable-approval");
  const [host, setHost] = useState<Host>("enforcing");
  const [command, setCommand] = useState(props.command ?? COMMANDS[1].command);
  const [ran, setRan] = useState<{ command: string; run: SandboxRun } | null>(() => {
    const c = props.command ?? COMMANDS[1].command;
    return { command: c, run: runCommand(c, "disable-approval", "enforcing") };
  });

  // The live agent's workspace: what its commands write stays for its next command, until the next run.
  const tree = useRef<Tree>(initialTree(SANDBOX_DEMO));
  const steps = useMemo(() => contractSteps(ran?.run ?? null, launch, host), [ran, launch, host]);
  const simulate = () => {
    if (!command.trim()) return;
    setRan({ command: command.trim(), run: runCommand(command.trim(), launch, host) });
  };
  const pickLaunch = (l: Launch) => {
    setLaunch(l);
    if (ran) setRan({ command: ran.command, run: runCommand(ran.command, l, host) });
  };
  const pickHost = (h: Host) => {
    setHost(h);
    if (ran) setRan({ command: ran.command, run: runCommand(ran.command, launch, h) });
  };

  const harness = useCallback<Harness>(
    async (call) => {
      const cmd = typeof call.args?.command === "string" ? call.args.command : "";
      if (call.name !== "bash" || !cmd) return { output: JSON.stringify({ error: "unknown tool or missing command" }), lines: [{ text: `Unknown call: ${call.name}`, tone: "err" }] };
      const run = runCommand(cmd, launch, host, SANDBOX_DEMO, tree.current);
      return { output: toolResult(run), lines: runLines(cmd, run), title: "bash, in the simulated sandbox" };
    },
    [launch, host],
  );

  const verdict = ran?.run;
  return (
    <div className={`pg ${styles.stack}`}>
      <div className={`${styles.row} pg-advanced`}>
        <Segmented<Launch>
          label="Launch flags"
          size="sm"
          options={(Object.keys(LAUNCH_FLAGS) as Launch[]).map((l) => ({ value: l, label: l === "default" ? "muse" : `--${l}` }))}
          value={launch}
          onChange={pickLaunch}
        />
        <span className="pg-inline-field">
          <label className="pg-label" htmlFor={`${id}-host`}>
            Host
          </label>
          <span className="select-wrap">
            <select id={`${id}-host`} className="select pg-select" value={host} onChange={(e) => pickHost(e.target.value as Host)}>
              {(Object.keys(HOST_LABEL) as Host[]).map((h) => (
                <option key={h} value={h}>
                  {HOST_LABEL[h]}
                </option>
              ))}
            </select>
          </span>
        </span>
      </div>
      <div className="pg-advanced">
        <Terminal
          title="Startup"
          lines={[
            { text: `cd ${SANDBOX_DEMO.root} && ${LAUNCH_FLAGS[launch]}`, tone: "cmd" },
            { text: `Security: ${startupLine(launch)}${launch === "default" ? "" : " · from CLI flag"}`, tone: launch === "yolo" || launch === "disable-sandbox" ? "warn" : "plain" },
          ]}
        />
      </div>
      <Steps label="The contained-execution contract for this run" steps={steps} />

      <div className={styles.split}>
        <div className={`${styles.tight} pg-advanced`}>
          <p className="pg-section-label">The managed profile</p>
          <pre className={`${styles.tree} ${styles.treeWrap}`}>
            {[
              `writable   ${SANDBOX_DEMO.root} (the workspace)`,
              "writable   runtime temp root, /tmp",
              `read-only  ${PROTECTED_DIRS.map((d) => `${d}/`).join(" ")} under the workspace`,
              "read-only  everything else ($HOME, /etc, ...)",
              "network    egress restricted (through the sandbox proxy)",
            ].join("\n")}
          </pre>
        </div>
        <div className={styles.tight}>
          <label className="pg-label" htmlFor={`${id}-cmd`}>
            Command
          </label>
          <FewPills show={4} presets={COMMANDS} active={COMMANDS.findIndex((c) => c.command === command)} onPick={(i) => { setCommand(COMMANDS[i].command); setRan({ command: COMMANDS[i].command, run: runCommand(COMMANDS[i].command, launch, host) }); }} />
          <div className={styles.row}>
            <TextInput id={`${id}-cmd`} className={`pg-code-input ${styles.grow}`} value={command} onChange={(e) => setCommand(e.target.value)} onKeyDown={runOnModEnter(simulate)} spellCheck={false} />
            <button type="button" className="btn btn-sm btn-outline" onClick={simulate}>
              Run in the simulator
            </button>
          </div>
        </div>
      </div>

      {ran && verdict ? (
        <>
          <Terminal title="bash (simulated)" lines={runLines(ran.command, verdict)} live />
          {verdict.refused ? (
            <Verdict tone="bad" title="Refused: an unverified sandbox runs nothing">
              <p className={`${styles.note} pg-advanced`}>The probe&apos;s write to a denied path landed, so the sandbox is reported unavailable and the tool call fails before the command starts. There is no third path where a command runs without a passing probe.</p>
            </Verdict>
          ) : verdict.probe === "skipped" ? (
            <Verdict tone="warn" title="Sandbox disabled: no probe, no containment">
              <p className={`${styles.note} pg-advanced`}>
                {launch === "yolo" ? "--yolo" : "--disable-sandbox"} turns enforcement off for the run. Use it only when a task needs the network, accepting that you give up the containment guarantee.
              </p>
            </Verdict>
          ) : verdict.denials.length ? (
            <Verdict tone="ok" title={`Contained: the OS blocked ${verdict.denials.length} operation(s)`}>
              <p className={`${styles.note} pg-advanced`}>The harness doesn&apos;t need its own check: the OS refuses the write or the connection, the tool result carries the denial, and the session event log records it.</p>
            </Verdict>
          ) : (
            <Verdict tone="info" title="Ran inside the sandbox: nothing crossed a boundary" />
          )}
        </>
      ) : null}

      <Section title="Ask the agent (live)">
        <AgentLoopPanel
          intro="The model gets a bash tool. Each call runs in the simulated sandbox above, with the flags and host you picked, and the result goes back to the model, which reports it. Two short model calls, under a cent."
          presets={AGENT_PRESETS}
          defaultPrompt={AGENT_PRESETS[1].prompt}
          request={containmentRequest}
          harness={harness}
          onStart={() => {
            tree.current = initialTree(SANDBOX_DEMO);
          }}
        />
      </Section>
    </div>
  );
}
