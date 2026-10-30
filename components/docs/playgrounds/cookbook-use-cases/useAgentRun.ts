"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { isAborted, useDocsRun } from "@/components/docs/kit/useDocsRun";
import type { RecordedRequest } from "@/components/docs/kit/DocsPageContext";
import type { DocsError } from "@/lib/docs/client/api";
import { runAgentLoop, type AgentDef, type LoopOptions, type LoopResult, type LoopRuntime, type ModelReply, type ToolOutcome } from "@/components/docs/playgrounds/cookbook-use-cases/lib/agent";
import { replyUsd, type FnCall } from "@/components/docs/playgrounds/cookbook-use-cases/lib/responses";
import { retryText, withRetries } from "@/components/docs/playgrounds/cookbook-use-cases/lib/retry";

/**
 * Runs the recipe demos' agents in the page and keeps a timeline of everything they did: each model call (through
 * the docs proxy with useDocsRun, so it is recorded for the copy prompt), each tool the page ran for it, notes from
 * the harness (a workflow routing an event, a dispatcher releasing a task), and questions that wait for the reader
 * (a clarify question, a fix-scope choice, an approval). "Pause after each step" holds the run before every model
 * call and tool run until the reader presses Next step. Model calls are spaced to the live demos' per-minute limit
 * and sit out its 429s with a note in the timeline (lib/retry.ts), so a long run doesn't stop halfway.
 */

type Json = Record<string, unknown>;

export type Tone = "info" | "good" | "bad" | "warn";

export interface ModelEntry {
  id: number;
  kind: "model";
  agent: string;
  depth: number;
  call: number;
  body: Json;
  status: "running" | "done" | "error" | "stopped";
  response?: Json | null;
  httpStatus?: number;
  model?: string | null;
  elapsedMs?: number;
  error?: DocsError | null;
  usd?: number;
}

export interface ToolEntry {
  id: number;
  kind: "tool";
  agent: string;
  depth: number;
  name: string;
  callId: string;
  args: string;
  status: "running" | "done" | "error" | "denied";
  output?: string;
  note?: string;
  ms?: number;
}

export interface NoteEntry {
  id: number;
  kind: "note";
  agent?: string;
  depth: number;
  text: string;
  tone: Tone;
}

export interface HumanOption {
  value: string;
  label: string;
  hint?: string;
}

export interface HumanEntry {
  id: number;
  kind: "human";
  agent: string;
  depth: number;
  title?: string;
  prompt: string;
  options: HumanOption[];
  allowText?: boolean;
  textLabel?: string;
  answer?: string;
  status: "waiting" | "done" | "stopped";
}

export type Entry = ModelEntry | ToolEntry | NoteEntry | HumanEntry;

/** What a page's script and tool code can do while a run is going. */
export interface PageRuntime extends LoopRuntime {
  /** Runs one agent to its answer with this runtime. */
  run(agent: AgentDef, input: string | Json[], depth?: number, opts?: LoopOptions): Promise<LoopResult>;
  note(text: string, tone?: Tone, agent?: string, depth?: number): void;
  /** Waits for the reader to pick an option (or type, when allowText). Null when the run was stopped. */
  ask(agent: string, prompt: string, options: HumanOption[], opts?: { title?: string; allowText?: boolean; textLabel?: string; depth?: number }): Promise<string | null>;
  /** Waits for Next step when pausing is on. */
  checkpoint(): Promise<void>;
}

export type ToolExecutor = (agent: AgentDef, call: FnCall, rt: PageRuntime, depth: number) => Promise<ToolOutcome>;

export interface AgentRun {
  entries: Entry[];
  busy: boolean;
  error: DocsError | null;
  stepMode: boolean;
  setStepMode(on: boolean): void;
  /** True while the run waits for Next step. */
  waitingStep: boolean;
  advance(): void;
  start(script: (rt: PageRuntime) => Promise<void>, exec: ToolExecutor, record?: (agent: AgentDef, body: Json) => Partial<RecordedRequest> | false | undefined): Promise<void>;
  stop(): void;
  reset(): void;
  answer(id: number, value: string): void;
  totalUsd: number;
  modelCalls: number;
}

export function useAgentRun(): AgentRun {
  const runner = useDocsRun();
  const runnerRef = useRef(runner);
  runnerRef.current = runner;
  const [entries, setEntries] = useState<Entry[]>([]);
  const entriesRef = useRef<Entry[]>([]);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<DocsError | null>(null);
  const [stepMode, setStepModeState] = useState(false);
  const stepModeRef = useRef(false);
  const [waitingStep, setWaitingStep] = useState(false);
  const stepGate = useRef<(() => void) | null>(null);
  const humans = useRef(new Map<number, (v: string | null) => void>());
  const stopRef = useRef(false);
  const nextId = useRef(1);

  const commit = useCallback((next: Entry[]) => {
    entriesRef.current = next;
    setEntries(next);
  }, []);

  const add = useCallback(
    <E extends Entry>(entry: Omit<E, "id">): number => {
      const id = nextId.current++;
      commit([...entriesRef.current, { ...entry, id } as unknown as Entry]);
      return id;
    },
    [commit],
  );

  const update = useCallback(
    (id: number, patch: Partial<Entry>) => {
      commit(entriesRef.current.map((e) => (e.id === id ? ({ ...e, ...patch } as Entry) : e)));
    },
    [commit],
  );

  const releaseStep = () => {
    const gate = stepGate.current;
    stepGate.current = null;
    setWaitingStep(false);
    gate?.();
  };

  const setStepMode = useCallback((on: boolean) => {
    stepModeRef.current = on;
    setStepModeState(on);
    if (!on) releaseStep();
  }, []);

  const advance = useCallback(() => releaseStep(), []);

  const stop = useCallback(() => {
    stopRef.current = true;
    runnerRef.current.abort();
    for (const [, resolve] of humans.current) resolve(null);
    humans.current.clear();
    releaseStep();
  }, []);

  const reset = useCallback(() => {
    stop();
    runnerRef.current.reset();
    setError(null);
    commit([]);
  }, [stop, commit]);

  const answer = useCallback((id: number, value: string) => {
    const resolve = humans.current.get(id);
    humans.current.delete(id);
    resolve?.(value);
  }, []);

  const start = useCallback(
    async (
      script: (rt: PageRuntime) => Promise<void>,
      exec: ToolExecutor,
      record?: (agent: AgentDef, body: Json) => Partial<RecordedRequest> | false | undefined,
    ) => {
      if (busyRef.current) return;
      busyRef.current = true;
      stopRef.current = false;
      setBusy(true);
      setError(null);

      const checkpoint = async () => {
        if (!stepModeRef.current || stopRef.current) return;
        await new Promise<void>((resolve) => {
          stepGate.current = resolve;
          setWaitingStep(true);
        });
      };

      const rt: PageRuntime = {
        stopped: () => stopRef.current,
        checkpoint,
        note(text, tone = "info", agent, depth = 0) {
          add<NoteEntry>({ kind: "note", text, tone, agent, depth });
        },
        ask(agent, prompt, options, opts = {}) {
          if (stopRef.current) return Promise.resolve(null);
          return new Promise<string | null>((resolve) => {
            const id = add<HumanEntry>({
              kind: "human",
              agent,
              depth: opts.depth ?? 0,
              title: opts.title,
              prompt,
              options,
              allowText: opts.allowText,
              textLabel: opts.textLabel,
              status: "waiting",
            });
            humans.current.set(id, (value) => {
              update(id, value === null ? { status: "stopped" } : { status: "done", answer: value });
              resolve(value);
            });
          });
        },
        async callModel(agent, body, info): Promise<ModelReply> {
          await checkpoint();
          if (stopRef.current) return { ok: false, json: null, error: null, aborted: true };
          const id = add<ModelEntry>({ kind: "model", agent: agent.name, depth: info.depth, call: info.call, body, status: "running" });
          const rec = record?.(agent, body);
          const res = await withRetries(() => runnerRef.current.run("responses", { method: "POST", body, ...(rec !== undefined ? { record: rec } : {}) }), {
            stopped: () => stopRef.current,
            onRetry: (r) => add<NoteEntry>({ kind: "note", text: retryText(r), tone: "warn", agent: agent.name, depth: info.depth }),
          });
          const aborted = isAborted(res);
          const json = (res.json as Json | null) ?? null;
          update(id, {
            status: aborted ? "stopped" : res.ok ? "done" : "error",
            response: json,
            httpStatus: res.status,
            model: res.model,
            elapsedMs: res.elapsedMs,
            error: aborted ? null : res.error,
            usd: res.ok ? replyUsd(res.model ?? agent.model, json) : 0,
          });
          if (!res.ok && !aborted) setError(res.error);
          return { ok: res.ok, json, error: res.error, aborted };
        },
        async runTool(agent, call, info): Promise<ToolOutcome> {
          await checkpoint();
          if (stopRef.current) return { output: "Stopped before this tool ran.", status: "error" };
          const id = add<ToolEntry>({ kind: "tool", agent: agent.name, depth: info.depth, name: call.name, callId: call.callId, args: call.arguments, status: "running" });
          const started = performance.now();
          let outcome: ToolOutcome;
          try {
            outcome = await exec(agent, call, rt, info.depth);
          } catch (err) {
            outcome = { output: `Error: ${err instanceof Error ? err.message : String(err)}`, status: "error" };
          }
          const shown = outcome.display ?? (typeof outcome.output === "string" ? outcome.output : "(content parts, see the next request)");
          update(id, { status: outcome.status ?? "done", output: shown, note: outcome.note, ms: Math.round(performance.now() - started) });
          return outcome;
        },
        run(agent, input, depth = 0, opts) {
          return runAgentLoop(agent, input, rt, depth, opts);
        },
      };

      try {
        await script(rt);
      } catch (err) {
        add<NoteEntry>({ kind: "note", text: `The run stopped: ${err instanceof Error ? err.message : String(err)}`, tone: "bad", depth: 0 });
      } finally {
        busyRef.current = false;
        setBusy(false);
        setWaitingStep(false);
        stepGate.current = null;
      }
    },
    [add, update],
  );

  const totals = useMemo(() => {
    let usd = 0;
    let calls = 0;
    for (const e of entries) {
      if (e.kind === "model") {
        calls++;
        usd += e.usd ?? 0;
      }
    }
    return { usd, calls };
  }, [entries]);

  return {
    entries,
    busy,
    error,
    stepMode,
    setStepMode,
    waitingStep,
    advance,
    start,
    stop,
    reset,
    answer,
    totalUsd: totals.usd,
    modelCalls: totals.calls,
  };
}
