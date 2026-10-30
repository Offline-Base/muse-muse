"use client";

import { useCallback, useRef, useState } from "react";
import { isAborted, useDocsRun } from "@/components/docs/kit/useDocsRun";
import type { DocsResult, SseEvent } from "@/lib/docs/client/api";
import { mergeBody, PROTOCOL_PATH, type NeutralRequest } from "@/lib/docs/client/body";
import { collectorFor, collectReply, type Collected } from "@/lib/docs/client/stream";
import { nextAction, nextModelBody, requestedCalls, type LoopProtocol, type LoopStep, type ModelStep, type NextAction } from "@/lib/docs/client/toolloop";
import { runToolCall, type ResolvedTool, type ToolRun } from "@/lib/docs/client/tools";

/**
 * The tool loop the cookbook demos share, as a hook: call the model, run the tools it asks for here in the page, send
 * the results back, until it answers. It is the kit's ToolLoopPlayground sequence (lib/docs/client/toolloop) with the
 * three things these recipes add: tools that act on a project (any ResolvedTool), guards that stop a run (a token
 * budget, a repeated call), and a hook on each request body (the tool-calling demo sends a broken history on purpose,
 * to show the API's 400). Every model call goes through useDocsRun, so it is recorded for the copy prompt.
 */

export interface ToolLoopOptions {
  protocol: LoopProtocol;
  /** The model, instructions, the user's message and the tool definitions. */
  base: NeutralRequest;
  tools: ResolvedTool[];
  /** Most model calls in one run (the iteration cap). */
  maxCalls: number;
  /** Merged into every model call's body. */
  extraBody?: Record<string, unknown>;
  /** Changes a model call's body before it's sent. */
  transform?: (body: Record<string, unknown>, steps: readonly LoopStep[]) => Record<string, unknown>;
  /** A reason to stop before the next model call, or null to go on. */
  guard?: (steps: readonly LoopStep[]) => string | null;
  /** Stream each model call. */
  stream?: boolean;
}

/** What the loop does next: the kit's actions, plus "stopped" when a guard ends the run. */
export type LoopAction = NextAction | "stopped";

function failed(protocol: LoopProtocol, res: DocsResult): Collected {
  const c = collectReply(protocol, null);
  return { ...c, done: true, error: { code: res.error?.code ?? null, message: res.error?.message ?? "The request failed." } };
}

/**
 * The pauses before each retry shouldRetryReference allows. The kit's ToolLoopPlayground retries once after 1.2 s; a
 * live migration run here still failed after one, so this keeps trying a little longer before giving up.
 */
export const REFERENCE_RETRY_MS = [1200, 2500, 5000] as const;

/**
 * Meta now and then answers a previous_response_id it has only just finished with HTTP 400 "referenced response not
 * found or expired": the tools here run instantly, so the next call goes out at once. That exact error, on a call that
 * carries previous_response_id, is worth retrying after a pause; any other failure is the reader's to see.
 */
export function shouldRetryReference(res: Pick<DocsResult, "status" | "error">, body: Record<string, unknown>): boolean {
  return res.status === 400 && !!body.previous_response_id && /referenced response not found/i.test(res.error?.message ?? "");
}

/** The next action for these steps under these options, with the guard applied before any further model call. */
export function loopAction(steps: readonly LoopStep[], options: Pick<ToolLoopOptions, "maxCalls" | "guard">): LoopAction {
  const next = nextAction(steps, options.maxCalls);
  if (next === "model" && steps.length && options.guard?.(steps)) return "stopped";
  return next;
}

export function useToolLoop(options: ToolLoopOptions) {
  const { run, abort, reset: resetRun, error, elapsedMs } = useDocsRun();
  const latest = useRef(options);
  latest.current = options;
  const [steps, setSteps] = useState<LoopStep[]>([]);
  const [busy, setBusy] = useState(false);
  const [stopped, setStopped] = useState<string | null>(null);
  const stepsRef = useRef<LoopStep[]>([]);
  const stopRef = useRef(false);
  const busyRef = useRef(false);

  const commit = (next: LoopStep[]) => {
    stepsRef.current = next;
    setSteps(next);
  };

  /** Runs the next action: one model call, or the tools the last call asked for. Returns false when there was none. */
  const step = useCallback(async (): Promise<boolean> => {
    const opts = latest.current;
    const current = stepsRef.current;
    const next = loopAction(current, opts);
    if (next === "stopped") {
      setStopped(opts.guard?.(current) ?? "Stopped.");
      return false;
    }
    if (next === "model") {
      let body = mergeBody(nextModelBody(opts.protocol, opts.base, current), opts.extraBody);
      if (opts.transform) body = opts.transform(body, current);
      const pending: ModelStep = { kind: "model", call: current.filter((s) => s.kind === "model").length + 1, body, collected: null };
      commit([...current, pending]);
      let collector = collectorFor(opts.protocol);
      const stream = !!opts.stream;
      const onEvent = (e: SseEvent) => {
        collector.push(e);
        commit([...current, { ...pending, collected: { ...collector.snapshot(), done: false } }]);
      };
      const send = () => run(PROTOCOL_PATH[opts.protocol], { method: "POST", body, stream, onEvent: stream ? onEvent : undefined });
      let res = await send();
      for (const pause of REFERENCE_RETRY_MS) {
        if (!shouldRetryReference(res, body)) break;
        await new Promise((resolve) => setTimeout(resolve, pause));
        if (stopRef.current) break;
        collector = collectorFor(opts.protocol);
        res = await send();
      }
      const got = !res.ok ? failed(opts.protocol, res) : stream ? collector.snapshot() : collectReply(opts.protocol, res.json);
      // Stop pressed while waiting to retry counts as stopped, not as the 400 it was waiting out.
      const aborted = isAborted(res) || (stopRef.current && shouldRetryReference(res, body));
      const collected: Collected = aborted ? { ...got, done: true, error: { code: "aborted", message: "Stopped." } } : { ...got, done: true };
      if (aborted) stopRef.current = true;
      commit([...current, { ...pending, collected, status: res.status, model: res.model, elapsedMs: res.elapsedMs }]);
      return true;
    }
    if (next === "tools") {
      const last = current[current.length - 1] as ModelStep;
      const calls = requestedCalls(last);
      commit([...current, { kind: "tools", results: calls.map((call) => ({ call, run: null })) }]);
      // One at a time, in the order the model asked: these tools change the project, so the order matters.
      const runs: ToolRun[] = [];
      for (const c of calls) runs.push(await runToolCall(opts.tools, c.name, c.arguments));
      commit([...current, { kind: "tools", results: calls.map((call, i) => ({ call, run: runs[i] })) }]);
      return true;
    }
    return false;
  }, [run]);

  const runAll = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    stopRef.current = false;
    setBusy(true);
    setStopped(null);
    try {
      for (;;) {
        const next = loopAction(stepsRef.current, latest.current);
        if (next === "stopped") {
          setStopped(latest.current.guard?.(stepsRef.current) ?? "Stopped.");
          break;
        }
        if (next !== "model" && next !== "tools") break;
        await step();
        if (stopRef.current) {
          setStopped("Stopped by you.");
          break;
        }
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [step]);

  const stepOnce = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    stopRef.current = false;
    setBusy(true);
    try {
      await step();
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [step]);

  const stop = useCallback(() => {
    stopRef.current = true;
    abort();
  }, [abort]);

  const reset = useCallback(() => {
    stopRef.current = true;
    resetRun();
    setStopped(null);
    commit([]);
  }, [resetRun]);

  return {
    steps,
    busy,
    /** Why the run stopped early (a guard, or you), or null. */
    stopped,
    /** What the next step would do. */
    next: loopAction(steps, options),
    error,
    elapsedMs,
    runAll,
    stepOnce,
    stop,
    reset,
  };
}
