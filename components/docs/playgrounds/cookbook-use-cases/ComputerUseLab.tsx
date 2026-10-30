"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { CodeView, ContributorNotice, ErrorBox, ModelSelect, RunButton, DEFAULT_TEXT_MODEL } from "@/components/docs/kit";
import { useDocsRun } from "@/components/docs/kit/useDocsRun";
import { EffortSelect, PresetPills, Segmented, TextArea, Toggle } from "@/components/docs/kit/Field";
import { UsageLine } from "@/components/docs/kit/UsageLine";
import { latencyLabel } from "@/components/docs/kit/ResponseView";
import type { DocsError } from "@/lib/docs/client/api";
import { formatUsd } from "@/lib/docs/client/cost";
import type { Effort } from "@/lib/docs/client/models";
import styles from "@/components/docs/playgrounds/cookbook-use-cases/cuc.module.css";
import { replayItems } from "@/components/docs/playgrounds/cookbook-use-cases/lib/agent";
import { replyUsd, responseStatus, responseText, type FnCall } from "@/components/docs/playgrounds/cookbook-use-cases/lib/responses";
import { SCREEN_H, SCREEN_W, applyAction, initialState, minesShell, render, sceneDone, type Action, type SceneId, type SimState } from "@/components/docs/playgrounds/cookbook-use-cases/lib/cu-sim";
import { retryText, withRetries } from "@/components/docs/playgrounds/cookbook-use-cases/lib/retry";
import { DEFAULT_BUDGET, REPLAY_MAX_PAIRS, budgetsFor, cutOffText, outputCap, raisedBudget, stepCap, stepOptionsUnder } from "@/components/docs/playgrounds/cookbook-use-cases/lib/cu-budget";
import {
  CUA_TOOLS,
  METACUA_SYSTEM,
  TASKS,
  actionLabel,
  cuaPrompt,
  cuaStep,
  fnCalls,
  fnOutput,
  metacuaStep,
  metacuaTools,
  nativeBase,
  readNativeTurn,
  screenshotOutput,
  userTurn,
  type FnStep,
  type Protocol,
  type SafetyCheck,
} from "@/components/docs/playgrounds/cookbook-use-cases/lib/cu-protocols";

/**
 * The computer-use loop against a simulated screen (lib/cu-sim.ts): send the task and a screenshot, get actions back,
 * draw them on the screenshot, run them in the simulator, send the new screenshot, repeat until the model answers in
 * text. Nothing touches the reader's machine. Three protocols, one per page: the native computer tool (the guide),
 * the Cua MCP bridge's cua_* function tools (the Linux recipe), and metacua's computer.computer and computer.stop on
 * 0 to 1000 coordinates (the macOS recipe). Safety checks are a decision point: each one waits for Acknowledge.
 *
 * A reply that runs out of output tokens before it picks an action (HTTP 200, status incomplete, no call) isn't the end
 * of the task: the step is marked cut off and the same turn goes again with a bigger budget, once on its own and then
 * when the reader presses Run, as the guide's "Handle done and incomplete" says. Calls are paced to the live demos'
 * per-minute limit and sit out its 429s (lib/retry.ts).
 */

export interface ComputerUseLabProps {
  slug: string;
  protocol: Protocol;
  scene?: SceneId;
  scenes?: SceneId[];
  maxSteps?: number;
  /** Conversation state: previous_response_id ("server") or store: false with the full history ("replay"). */
  state?: "server" | "replay";
  /** Cua: hand off to a fresh sub-agent after this many screenshots (the recipe's way around 50 images a request). 0 is off. */
  handoffEvery?: number;
}

type Json = Record<string, unknown>;

interface CallView {
  call: FnCall;
  step: FnStep;
  result?: string;
}

interface Step {
  n: number;
  agent: number;
  shot: string | null;
  body: Json;
  response: Json | null;
  /** "cutoff": the reply ran out of output tokens before it chose an action, so the same turn goes again. */
  status: "running" | "done" | "error" | "cutoff";
  error?: DocsError | null;
  /** Why the step ended the way it did, when that needs saying (a cut-off, an incomplete reply). */
  note?: string;
  commentary: string;
  final: string;
  actions: Action[];
  calls: CallView[];
  checks: SafetyCheck[];
  ack: "none" | "pending" | "acknowledged" | "declined";
  effects: string[];
  usd: number;
  model: string | null;
  ms: number;
}

const SCENE_LABEL: Record<SceneId, string> = { signup: "Sign-up form", tictactoe: "Tic-tac-toe", mines: "Desktop with Mines" };
const SPARK_ONLY = ["muse-spark-1.3-contributor", "muse-spark-1.2", "muse-spark-1.2-contributor", "muse-spark-1.1"];

/** Numbered markers for a step's actions, drawn over the screenshot it acted on. */
function Markers({ actions }: { actions: Action[] }) {
  let last: { x: number; y: number } | null = null;
  let n = 0;
  const marks = actions.map((a, i) => {
    if (a.type === "click" || a.type === "double_click" || a.type === "move") {
      n++;
      last = { x: a.x, y: a.y };
      const color = a.type === "double_click" ? "#8e44ad" : a.type === "move" ? "#2980b9" : a.button === "right" ? "#d93025" : "#e8710a";
      return (
        <g key={i}>
          <circle cx={a.x} cy={a.y} r={22} fill="none" stroke={color} strokeWidth={5} strokeDasharray={a.type === "move" ? "6 5" : undefined} />
          <circle cx={a.x} cy={a.y} r={4} fill={color} />
          <rect x={a.x + 18} y={a.y - 40} width={30} height={26} rx={13} fill={color} />
          <text x={a.x + 33} y={a.y - 21} fontSize={16} fontWeight={700} fill="#fff" textAnchor="middle">
            {n}
          </text>
        </g>
      );
    }
    if (a.type === "type" || a.type === "keypress") {
      n++;
      const at: { x: number; y: number } = last ?? { x: 40, y: 60 };
      const label = a.type === "type" ? `"${a.text.slice(0, 28)}${a.text.length > 28 ? "..." : ""}"` : a.keys.join("+");
      const w = Math.min(560, 26 + label.length * 9.5);
      return (
        <g key={i}>
          <rect x={at.x + 26} y={at.y + 8 + (i % 3) * 30} width={w} height={26} rx={6} fill="rgba(17,17,18,0.86)" />
          <text x={at.x + 36} y={at.y + 26 + (i % 3) * 30} fontSize={15} fill="#fff" fontFamily="monospace">
            {n}. {label}
          </text>
        </g>
      );
    }
    if (a.type === "scroll") {
      n++;
      const dy = (a.scroll_y ?? 0) > 0 ? 50 : -50;
      return (
        <g key={i}>
          <line x1={a.x} y1={a.y} x2={a.x} y2={a.y + dy} stroke="#16a085" strokeWidth={6} markerEnd="url(#cuarrow)" />
        </g>
      );
    }
    if (a.type === "drag" && a.path.length > 1) {
      n++;
      return <polyline key={i} points={a.path.map((p) => `${p.x},${p.y}`).join(" ")} fill="none" stroke="#c0392b" strokeWidth={5} />;
    }
    return null;
  });
  return (
    <svg viewBox={`0 0 ${SCREEN_W} ${SCREEN_H}`} className={styles.overlay} style={{ width: "100%", height: "100%" }} aria-hidden>
      <defs>
        <marker id="cuarrow" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="4" markerHeight="4" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="#16a085" />
        </marker>
      </defs>
      {marks}
    </svg>
  );
}

export function ComputerUseLab({ protocol, scene: initialScene, scenes, maxSteps: initialMax = 12, state: initialState_, handoffEvery = 0 }: ComputerUseLabProps) {
  const id = useId();
  const runner = useDocsRun();
  const offered: SceneId[] = scenes?.length ? scenes : [initialScene ?? "signup"];
  const [scene, setScene] = useState<SceneId>(initialScene ?? offered[0]);
  const [task, setTask] = useState(TASKS[initialScene ?? offered[0]][0]);
  const [model, setModel] = useState(DEFAULT_TEXT_MODEL);
  const [effort, setEffort] = useState<Effort | null>("low");
  // The guide's loop chains previous_response_id; metacua sends store: false, and OpenCode (the Cua recipe's harness)
  // sends the whole session itself, so those two replay the history.
  const [mode, setMode] = useState<"server" | "replay">(initialState_ ?? (protocol === "computer" ? "server" : "replay"));
  const [truncation, setTruncation] = useState(false);
  const [batched, setBatched] = useState(false);
  const [autoAck, setAutoAck] = useState(false);
  const [maxSteps, setMaxSteps] = useState(initialMax);
  const [budget, setBudgetState] = useState(DEFAULT_BUDGET);
  const budgetRef = useRef(DEFAULT_BUDGET);
  const cutStreak = useRef(0);
  const [paused, setPaused] = useState<string | null>(null);
  const [waitNote, setWaitNote] = useState<string | null>(null);
  const [handoff, setHandoff] = useState(handoffEvery);
  const [sim, setSim] = useState<SimState>(() => initialState(initialScene ?? offered[0]));
  const simRef = useRef<SimState>(sim);
  const [steps, setSteps] = useState<Step[]>([]);
  const stepsRef = useRef<Step[]>([]);
  const [busy, setBusy] = useState(false);
  const [finished, setFinished] = useState<string | null>(null);
  const [showCode, setShowCode] = useState(false);
  const [lastBody, setLastBody] = useState<Json | null>(null);
  const bg = useRef<HTMLImageElement | null>(null);
  const [bgReady, setBgReady] = useState(false);
  const screen = useRef<HTMLCanvasElement | null>(null);
  const chain = useRef<{ prevId: string | null; history: Json[]; pending: Json[] | null; agent: number; images: number; lastShot: string | null }>({
    prevId: null,
    history: [],
    pending: null,
    agent: 1,
    images: 0,
    lastShot: null,
  });
  const decision = useRef<((ok: boolean) => void) | null>(null);
  const stopped = useRef(false);

  useEffect(() => {
    const img = new Image();
    img.onload = () => {
      bg.current = img;
      setBgReady(true);
    };
    img.src = "/docs-samples/signup-screen.png";
  }, []);

  useEffect(() => {
    const ctx = screen.current?.getContext("2d");
    if (ctx) render(ctx, sim, bg.current);
  }, [sim, bgReady]);

  const commitSim = (s: SimState) => {
    simRef.current = s;
    setSim(s);
  };
  const commitSteps = (s: Step[]) => {
    stepsRef.current = s;
    setSteps(s);
  };
  const patchStep = (n: number, patch: Partial<Step>) => commitSteps(stepsRef.current.map((s) => (s.n === n ? { ...s, ...patch } : s)));
  const setBudget = (b: number) => {
    budgetRef.current = b;
    setBudgetState(b);
  };
  // Direct stateless replay of the computer tool holds up to 29 call/output pairs, so that mode stops at 29 calls.
  const cap = stepCap(protocol, mode);
  const stepBudget = Math.min(maxSteps, cap);
  const budgets = budgetsFor(model);

  /** The current screen as a JPEG data URL, drawn fresh from the simulator's state. */
  const capture = useCallback((): string => {
    const c = document.createElement("canvas");
    c.width = SCREEN_W;
    c.height = SCREEN_H;
    const ctx = c.getContext("2d")!;
    render(ctx, simRef.current, bg.current);
    return c.toDataURL("image/jpeg", 0.9);
  }, []);

  const base = (): Json => {
    const maxTokens = budgetRef.current;
    if (protocol === "computer") return nativeBase({ model, effort, maxTokens, truncation });
    const tools = (protocol === "cua" ? CUA_TOOLS : metacuaTools(batched)).map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.parameters }));
    return {
      model,
      ...(protocol === "metacua" ? { instructions: METACUA_SYSTEM } : {}),
      tools,
      parallel_tool_calls: false,
      ...(effort ? { reasoning: { effort } } : {}),
      max_output_tokens: maxTokens,
    };
  };

  /** One model call, paced to the live demos' per-minute limit and sitting out its 429s with a status line. */
  const callModel = async (body: Json) => {
    const res = await withRetries(() => runner.run("responses", { method: "POST", body }), {
      stopped: () => stopped.current,
      onRetry: (r) => setWaitNote(retryText(r)),
      onResume: () => setWaitNote(null),
    });
    setWaitNote(null);
    return res;
  };

  const firstInput = (): Json[] => {
    if (protocol === "cua") return [userTurn(cuaPrompt(scene, task.trim()))];
    const goal = protocol === "metacua" ? `Goal: ${task.trim()}` : task.trim();
    const shot = capture();
    chain.current.images++;
    return [userTurn(goal, shot)];
  };

  const bodyFor = (input: Json[]): Json => {
    const b = base();
    if (mode === "replay") return { ...b, store: false, include: ["reasoning.encrypted_content"], input: [...chain.current.history, ...input] };
    return { ...b, ...(chain.current.prevId ? { previous_response_id: chain.current.prevId } : {}), input };
  };

  const waitDecision = (n: number) =>
    new Promise<boolean>((resolve) => {
      patchStep(n, { ack: "pending" });
      decision.current = (ok) => {
        decision.current = null;
        patchStep(n, { ack: ok ? "acknowledged" : "declined" });
        resolve(ok);
      };
    });

  /** The Cua recipe's sub-agent handoff: get a text report on the old chain, start a fresh one with it. */
  const handOff = async () => {
    const n = stepsRef.current.length + 1;
    // A text-only report: the request goes without tools, since the API takes only tool_choice "auto".
    const { tools: _tools, parallel_tool_calls: _parallel, ...noTools } = base();
    void _tools;
    void _parallel;
    const ask = userTurn("You're about to hand off to a fresh sub-agent with a clean context (each request holds at most 50 images). In plain text, report the board state and what you've learned so the next sub-agent can continue.");
    const body =
      mode === "replay"
        ? { ...noTools, store: false, include: ["reasoning.encrypted_content"], input: [...chain.current.history, ...(chain.current.pending ?? []), ask] }
        : { ...noTools, previous_response_id: chain.current.prevId, input: [...(chain.current.pending ?? []), ask] };
    commitSteps([...stepsRef.current, { n, agent: chain.current.agent, shot: null, body, response: null, status: "running", commentary: "Handoff report", final: "", actions: [], calls: [], checks: [], ack: "none", effects: [], usd: 0, model: null, ms: 0 }]);
    const res = await callModel(body);
    const report = res.ok ? responseText(res.json) : "";
    const cut = res.ok && responseStatus(res.json).status === "incomplete";
    patchStep(n, {
      response: res.json as Json | null,
      status: res.ok ? "done" : "error",
      error: res.error,
      final: report,
      note: cut ? "The report came back incomplete; the next sub-agent gets what it has." : undefined,
      usd: replyUsd(res.model ?? model, res.json),
      model: res.model,
      ms: res.elapsedMs,
    });
    chain.current = {
      prevId: null,
      history: [],
      pending: [userTurn(`${cuaPrompt(scene, task.trim())}\n\nYou are sub-agent ${chain.current.agent + 1}, continuing a task another sub-agent started. Its report:\n${report || "(no report)"}`)],
      agent: chain.current.agent + 1,
      images: 0,
      lastShot: chain.current.lastShot,
    };
  };

  /**
   * One turn: a model call, then (when it asks for actions) running them in the simulator. A reply that comes back
   * status "incomplete" with nothing to run leaves the conversation where it was (no previous_response_id or history
   * change), so the next turn sends the same input again.
   */
  const turn = async (): Promise<"continue" | "done" | "stopped" | "error" | "cutoff" | "incomplete"> => {
    if (protocol === "cua" && handoff > 0 && chain.current.images >= handoff && chain.current.pending) await handOff();
    const input = chain.current.pending ?? firstInput();
    chain.current.pending = input;
    // The screen the model acts on in this turn: the newest screenshot it has been sent.
    const shot = lastImage(input) ?? chain.current.lastShot;
    chain.current.lastShot = shot;
    const body = bodyFor(input);
    setLastBody(body);
    const n = stepsRef.current.length + 1;
    commitSteps([...stepsRef.current, { n, agent: chain.current.agent, shot, body, response: null, status: "running", commentary: "", final: "", actions: [], calls: [], checks: [], ack: "none", effects: [], usd: 0, model: null, ms: 0 }]);
    const res = await callModel(body);
    if (stopped.current) return "stopped";
    const json = (res.json as Json | null) ?? null;
    const usd = res.ok ? replyUsd(res.model ?? model, json) : 0;
    if (!res.ok || !json) {
      patchStep(n, { status: "error", error: res.error, response: json, ms: res.elapsedMs });
      return "error";
    }

    const { status, reason } = responseStatus(json);
    const native = protocol === "computer" ? readNativeTurn(json) : null;
    const asksForActions = native ? native.callId !== null : fnCalls(json).length > 0;
    if (status === "incomplete" && !asksForActions) {
      const cut = reason === "max_output_tokens";
      patchStep(n, {
        status: cut ? "cutoff" : "done",
        response: json,
        usd,
        model: res.model,
        ms: res.elapsedMs,
        commentary: native ? native.commentary : responseText(json),
        note: cut ? cutOffText(json.usage, budgetRef.current) : `The reply came back status "incomplete"${reason ? ` (${reason})` : ""} with nothing to run.`,
      });
      return cut ? "cutoff" : "incomplete";
    }

    chain.current.prevId = typeof json.id === "string" ? json.id : chain.current.prevId;
    if (mode === "replay") chain.current.history = [...chain.current.history, ...input, ...replayItems(json)];
    chain.current.pending = null;

    if (native) {
      const t = native;
      patchStep(n, { status: "done", response: json, usd, model: res.model, ms: res.elapsedMs, commentary: t.commentary, final: t.final, actions: t.actions, checks: t.checks });
      if (!t.callId) return "done";
      let acked: SafetyCheck[] = [];
      if (t.checks.length) {
        const ok = autoAck ? (patchStep(n, { ack: "acknowledged" }), true) : await waitDecision(n);
        if (!ok || stopped.current) return "stopped";
        acked = t.checks;
      }
      const effects: string[] = [];
      for (const a of t.actions) {
        const [next, effect] = applyAction(simRef.current, a);
        commitSim(next);
        effects.push(effect);
      }
      patchStep(n, { effects });
      const img = capture();
      chain.current.images++;
      chain.current.pending = [screenshotOutput(t.callId, img, acked)];
      return "continue";
    }

    const calls = fnCalls(json);
    const commentary = responseText(json);
    patchStep(n, { status: "done", response: json, usd, model: res.model, ms: res.elapsedMs, commentary: calls.length ? commentary : "", final: calls.length ? "" : commentary });
    if (!calls.length) return "done";
    const views: CallView[] = [];
    const outputs: Json[] = [];
    const actions: Action[] = [];
    const effects: string[] = [];
    let stop: string | null = null;
    for (const call of calls) {
      const step = protocol === "cua" ? cuaStep(call) : metacuaStep(call);
      let result = "";
      let image: string | undefined;
      if (step.kind === "actions") {
        for (const a of step.actions) {
          const [next, effect] = applyAction(simRef.current, a);
          commitSim(next);
          effects.push(effect);
          actions.push(a);
        }
        if (step.screenshotAfter) {
          image = capture();
          chain.current.images++;
        }
        result = protocol === "cua" ? `${step.actions.map(actionLabel).join("; ")}: done.` : `Done: ${step.actions.map(actionLabel).join("; ")}. Fresh screenshot attached.`;
      } else if (step.kind === "screenshot") {
        image = capture();
        chain.current.images++;
        result = `Screenshot of the screen, ${SCREEN_W} x ${SCREEN_H} pixels.`;
      } else if (step.kind === "shell") {
        const cur = simRef.current;
        if (cur.kind === "mines") {
          const [next, out] = minesShell(cur, step.command);
          commitSim(next);
          result = out || "(no output)";
          effects.push(`$ ${step.command}${next.kind === "mines" && next.open && !cur.open ? ": Mines opened" : ""}`);
        } else {
          result = `bash: ${step.command.split(/\s+/)[0]}: command not found (nothing on this screen needs the shell)`;
          effects.push(`$ ${step.command}`);
        }
      } else if (step.kind === "stop") {
        stop = step.answer;
        result = "Session ended.";
      } else result = `Error: ${step.message}`;
      views.push({ call, step, result });
      outputs.push(fnOutput(call.callId, result, image));
    }
    patchStep(n, { calls: views, actions, effects });
    if (stop !== null) {
      patchStep(n, { final: stop });
      return "done";
    }
    chain.current.pending = outputs;
    return "continue";
  };

  const loop = async (once: boolean) => {
    if (busy) return;
    stopped.current = false;
    setBusy(true);
    setPaused(null);
    try {
      for (;;) {
        const r = await turn();
        if (r === "done") {
          const last = stepsRef.current[stepsRef.current.length - 1];
          setFinished(`${last?.final ? "The model finished." : "The model stopped asking for actions."} ${sceneDone(simRef.current) ?? "The goal isn't visibly complete on screen."}`);
          break;
        }
        if (r === "cutoff") {
          // The guide: raise the budget and continue from the same state. Once on its own, then the reader decides.
          cutStreak.current++;
          const n = stepsRef.current.length;
          const before = budgetRef.current;
          const next = raisedBudget(before, model);
          if (next) setBudget(next);
          const step = stepsRef.current[n - 1];
          if (next && cutStreak.current < 2) {
            patchStep(n, { note: `${step?.note ?? ""} The same turn goes again with ${next.toLocaleString("en-US")} output tokens.` });
          } else {
            const tokens = budgetRef.current.toLocaleString("en-US");
            const again = next
              ? `Run to the end or Next step sends the same turn again with ${tokens} output tokens.`
              : `${tokens} output tokens is the most this model takes here. Run sends the same turn again, or Reset and pick a lower reasoning effort.`;
            setPaused(`The model ran out of output tokens ${cutStreak.current > 1 ? "twice in a row " : ""}before choosing an action, so the run is paused, not finished. ${again}`);
            break;
          }
        } else if (r === "incomplete") {
          setPaused(`The last reply came back incomplete with nothing to run, so the run is paused, not finished. ${stepsRef.current[stepsRef.current.length - 1]?.note ?? ""} Run sends the same turn again.`);
          break;
        } else {
          cutStreak.current = 0;
          if (r !== "continue") break;
        }
        if (stepsRef.current.length >= stepBudget) {
          setFinished(`Stopped at ${stepBudget} model calls, the step budget. ${sceneDone(simRef.current) ?? ""}`);
          break;
        }
        if (once) break;
      }
    } finally {
      setBusy(false);
      setWaitNote(null);
    }
  };

  const reset = (nextScene = scene) => {
    stopped.current = true;
    runner.reset();
    decision.current?.(false);
    chain.current = { prevId: null, history: [], pending: null, agent: 1, images: 0, lastShot: null };
    cutStreak.current = 0;
    commitSteps([]);
    commitSim(initialState(nextScene, Math.floor(Math.random() * 1000) + 1));
    setFinished(null);
    setPaused(null);
    setWaitNote(null);
    setLastBody(null);
  };

  const pickScene = (s: SceneId) => {
    setScene(s);
    setTask(TASKS[s][0]);
    reset(s);
  };

  const total = steps.reduce((sum, s) => sum + s.usd, 0);
  const started = steps.length > 0;
  const codeBody = useMemo(() => lastBody ?? { ...base(), input: protocol === "cua" ? [userTurn(cuaPrompt(scene, task))] : [userTurn(task, "data:image/jpeg;base64,<SCREENSHOT>")] }, [lastBody, protocol, scene, task, model, effort, truncation, batched, budget]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="pg">
      {offered.length > 1 ? (
        <div className="pg-bar">
          <span className="pg-label">Screen</span>
          <Segmented<SceneId> label="Simulated screen" options={offered.map((s) => ({ value: s, label: SCENE_LABEL[s] }))} value={scene} onChange={pickScene} disabled={busy} />
        </div>
      ) : null}
      {TASKS[scene].length > 1 ? <PresetPills presets={TASKS[scene].map((t, i) => ({ label: i === 0 ? "The task" : "Ask before agreeing" }))} active={TASKS[scene].indexOf(task)} onPick={(i) => setTask(TASKS[scene][i])} disabled={busy || started} /> : null}
      <label className="pg-label" htmlFor={`${id}-task`}>
        {protocol === "metacua" ? "Goal" : "Task"}
      </label>
      <TextArea id={`${id}-task`} rows={protocol === "cua" && scene === "mines" ? 5 : 2} value={task} onChange={(e) => setTask(e.target.value)} disabled={busy || started} />

      <div className="pg-bar">
        <ModelSelect
          kind="vision"
          value={model}
          onChange={(m) => {
            setModel(m);
            if (budgetRef.current > outputCap(m)) setBudget(budgetsFor(m)[budgetsFor(m).length - 1]);
          }}
          allow={SPARK_ONLY}
          disabled={busy || started}
          notice={false}
        />
        <EffortSelect id={`${id}-effort`} model={model} value={effort} onChange={setEffort} disabled={busy || started} />
        {protocol !== "cua" ? (
          <Segmented<"server" | "replay">
            label="Conversation state"
            size="sm"
            options={[
              { value: "server", label: "previous_response_id" },
              { value: "replay", label: "store: false, replay" },
            ]}
            value={mode}
            onChange={setMode}
            disabled={busy || started}
          />
        ) : null}
      </div>
      <ContributorNotice model={model} />
      <div className="pg-bar">
        {protocol === "computer" ? <Toggle id={`${id}-trunc`} label='truncation: "auto"' checked={truncation} onChange={setTruncation} disabled={busy || started} /> : null}
        {protocol === "metacua" ? <Toggle id={`${id}-batch`} label="Batched actions (--batched-actions)" checked={batched} onChange={setBatched} disabled={busy || started} /> : null}
        {protocol === "cua" ? (
          <Toggle id={`${id}-handoff`} label="Fresh sub-agent every 12 screenshots" checked={handoff > 0} onChange={(on) => setHandoff(on ? 12 : 0)} disabled={busy || started} />
        ) : null}
        {protocol === "computer" ? <Toggle id={`${id}-ack`} label="Acknowledge safety checks for me (simulator only)" checked={autoAck} onChange={setAutoAck} /> : null}
        <span className="pg-inline-field">
          <label className="pg-label" htmlFor={`${id}-max`}>
            Step budget
          </label>
          <span className="select-wrap">
            <select id={`${id}-max`} className="select pg-select" value={stepBudget} onChange={(e) => setMaxSteps(Number(e.target.value))} disabled={busy}>
              {[...new Set([...stepOptionsUnder(cap), stepBudget])].sort((a, b) => a - b).map((v) => (
                <option key={v} value={v}>
                  {v} calls
                </option>
              ))}
            </select>
          </span>
        </span>
        <span className="pg-inline-field">
          <label className="pg-label" htmlFor={`${id}-budget`}>
            max_output_tokens
          </label>
          <span className="select-wrap">
            <select id={`${id}-budget`} className="select pg-select" value={budget} onChange={(e) => setBudget(Number(e.target.value))} disabled={busy}>
              {budgets.map((v) => (
                <option key={v} value={v}>
                  {v.toLocaleString("en-US")}
                </option>
              ))}
            </select>
          </span>
        </span>
      </div>
      <p className="pg-hint">
        For Standard mode, pick Muse Spark 1.2 or 1.1.{" "}
        {protocol === "computer"
          ? "Muse Wonder isn't in the menu: when this demo was built it answered 400 Unsupported tool type 'computer', and the guide says Muse Spark runs the same loop for less. "
          : ""}
        Each step sends a 1280 x 800 screenshot (about 1,500 to 3,500 input tokens): roughly $0.0005 a step on Spark Contributor, more as the history grows.{" "}
        {protocol === "computer" && mode === "replay"
          ? `Stateless replay holds up to ${REPLAY_MAX_PAIRS} call/output pairs, so this mode stops at ${REPLAY_MAX_PAIRS} calls. `
          : ""}
        A reply that spends its whole output budget reasoning comes back status &quot;incomplete&quot; with no action: the lab sends the same turn again with a bigger budget instead of calling it done.
      </p>

      <div className="pg-actions">
        <RunButton running={busy} onRun={() => void loop(false)} onStop={() => {
          stopped.current = true;
          runner.abort();
          decision.current?.(false);
        }} label={started ? "Run to the end" : "Start and run"} disabled={!!finished || !task.trim()} />
        <button type="button" className="btn btn-sm btn-outline" onClick={() => void loop(true)} disabled={busy || !!finished || !task.trim()}>
          {started ? "Next step" : "First step only"}
        </button>
        <button type="button" className="btn btn-sm" onClick={() => reset()} disabled={busy && !stopped.current}>
          Reset
        </button>
        {started ? (
          <span className="pg-hint" role="status" aria-live="polite">
            {steps.length} call{steps.length === 1 ? "" : "s"}, {formatUsd(total)} est.{busy ? " Running..." : ""}
          </span>
        ) : null}
      </div>
      {waitNote ? (
        <p className="pg-hint" role="status">
          {waitNote}
        </p>
      ) : null}

      <div className={styles.screenWrap} aria-label={`Simulated screen: ${SCENE_LABEL[scene]}`} role="img">
        <canvas ref={screen} width={SCREEN_W} height={SCREEN_H} />
      </div>
      <p className="pg-hint">The simulated screen, live. Actions change it; nothing runs on your computer.</p>
      {finished ? (
        <p className="pg-final" role="status">
          {finished}
        </p>
      ) : paused && !busy ? (
        <p className="pg-warn" role="status">
          {paused}
        </p>
      ) : null}
      <ErrorBox error={waitNote ? null : runner.error} />

      {steps.length ? (
        <ol className={styles.timeline} aria-label="Computer-use steps">
          {[...steps].reverse().map((s) => (
            <li key={s.n} className={styles.entry}>
              <p className={styles.entryHead}>
                <span className="pg-step-num">{s.n}</span>
                {protocol === "cua" && handoff ? <span className={styles.agent}>sub-agent {s.agent}</span> : null}
                <span>
                  {s.status === "running"
                    ? "Waiting for the model"
                    : s.status === "cutoff"
                      ? "Cut off (status incomplete)"
                      : s.commentary === "Handoff report"
                        ? "Handoff report"
                        : s.final
                          ? "Final message"
                          : "Model call"}
                </span>
                <span className={styles.entryMeta}>
                  {s.model ? <span>{s.model}</span> : null}
                  {s.ms ? <span>{latencyLabel(s.ms)}</span> : null}
                  {s.response?.usage ? <UsageLine model={s.model ?? model} usage={s.response.usage} /> : null}
                </span>
              </p>
              {s.error ? <p className="pg-hint pg-bad">{s.error.message}</p> : null}
              {s.note ? <p className={s.status === "cutoff" ? "pg-hint pg-bad" : "pg-hint"}>{s.note}</p> : null}
              {s.commentary && s.commentary !== "Handoff report" ? <p className={styles.commentary}>{s.commentary}</p> : null}
              {s.final ? <p className={styles.answer}>{s.final}</p> : null}
              {s.shot && s.actions.length ? (
                <div className={styles.screenWrap} style={{ position: "relative" }}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={s.shot} alt={`The screenshot the model acted on in step ${s.n}`} style={{ display: "block", width: "100%" }} />
                  <Markers actions={s.actions} />
                </div>
              ) : null}
              {s.calls.length ? (
                <ul className={styles.actionList}>
                  {s.calls.map((c, i) => (
                    <li key={i}>
                      <span className={styles.actionNum}>{i + 1}</span>
                      <span>
                        <code>{c.call.name}</code> <code className="pg-muted">{c.call.arguments}</code>
                        {c.result ? <span className="pg-muted"> {"→"} {c.result.slice(0, 220)}</span> : null}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : s.actions.length ? (
                <ul className={styles.actionList}>
                  {s.actions.map((a, i) => (
                    <li key={i}>
                      <span className={styles.actionNum}>{i + 1}</span>
                      <span>{actionLabel(a)}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
              {s.checks.length ? (
                <div className={styles.check} role={s.ack === "pending" ? "alert" : undefined}>
                  {s.checks.map((c, i) => (
                    <p key={i}>
                      <strong>Safety check {c.code}:</strong> {c.message}
                    </p>
                  ))}
                  {s.ack === "pending" ? (
                    <div className={styles.row}>
                      <button type="button" className="btn btn-sm btn-primary" onClick={() => decision.current?.(true)}>
                        Acknowledge and run
                      </button>
                      <button type="button" className="btn btn-sm" onClick={() => decision.current?.(false)}>
                        Decline and stop
                      </button>
                      <span className="pg-hint">Acknowledging asserts you reviewed these actions. It goes back in acknowledged_safety_checks.</span>
                    </div>
                  ) : (
                    <p className="pg-hint">{s.ack === "acknowledged" ? "Acknowledged: echoed in acknowledged_safety_checks with the next screenshot." : s.ack === "declined" ? "Declined: nothing ran." : ""}</p>
                  )}
                </div>
              ) : null}
              {s.effects.length ? (
                <p className="pg-small">
                  <span className="pg-muted">In the simulator: </span>
                  {s.effects.join("; ")}
                </p>
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}

      <div className="pg-actions">
        <Toggle id={`${id}-code`} label="Show code" checked={showCode} onChange={setShowCode} />
      </div>
      {showCode ? <CodeView method="POST" path="responses" body={codeBody} caption={lastBody ? "The last request sent" : "The first request"} /> : null}
    </div>
  );
}

/** The screenshot an input carries (the image the model is about to see), if any. */
function lastImage(input: Json[]): string | null {
  for (let i = input.length - 1; i >= 0; i--) {
    const item = input[i];
    const out = item.output as Json | Json[] | undefined;
    if (out && !Array.isArray(out) && typeof out.image_url === "string") return out.image_url;
    if (Array.isArray(out)) {
      const img = out.find((p) => p.type === "input_image");
      if (img && typeof img.image_url === "string") return img.image_url;
    }
    if (Array.isArray(item.content)) {
      const img = (item.content as Json[]).find((p) => p.type === "input_image");
      if (img && typeof img.image_url === "string") return img.image_url;
    }
  }
  return null;
}
