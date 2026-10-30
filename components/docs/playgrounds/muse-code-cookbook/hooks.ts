"use client";

import { useCallback, useRef, useState } from "react";
import { useDocsRun } from "@/components/docs/kit/useDocsRun";
import type { RecordedRequest } from "@/components/docs/kit/DocsPageContext";
import type { DocsError, DocsResult } from "@/lib/docs/client/api";
import { collectReply, type Collected } from "@/lib/docs/client/stream";
import {
  functionCalls,
  parseStrictReply,
  toolLoopFirstBody,
  toolLoopNextBody,
  unfinishedReply,
  withChainRetry,
  type Json,
  type ToolLoopRequest,
} from "@/components/docs/playgrounds/muse-code-cookbook/logic/live";
import type { TermLine } from "@/components/docs/playgrounds/muse-code-cookbook/parts";

/**
 * The two ways the Muse Code recipe demos call the model, both through the kit's useDocsRun (so every request goes
 * through the docs proxy and is recorded for the copy prompt):
 *
 * - useStrictJson: one Responses call whose answer is strict JSON, parsed for the demo to render.
 * - useAgentLoop: the model plus a simulated Muse Code harness. Each function call the model makes goes to the
 *   page's harness, which may stop and ask the reader (an approval prompt), then the result goes back as
 *   function_call_output on the stored response, until the model answers or the call budget is spent. A reply that
 *   stopped short (the output-token limit, or a failure) ends the run with a notice on its step, not as a report.
 */

export function useStrictJson<T>() {
  const runner = useDocsRun();
  const [value, setValue] = useState<T | null>(null);
  const [reply, setReply] = useState<Collected | null>(null);
  const [problem, setProblem] = useState<DocsError | null>(null);
  const [body, setBody] = useState<Json | null>(null);
  const [retrying, setRetrying] = useState(false);
  const { run: send } = runner;

  const run = useCallback(
    /** Sends the body and parses the reply. Resolves with the value (null on any failure) and the reply read. */
    async (next: Json, record?: Partial<RecordedRequest>): Promise<{ value: T | null; reply: Collected | null }> => {
      setBody(next);
      setValue(null);
      setReply(null);
      setProblem(null);
      const res = await withChainRetry(() => send("responses", { method: "POST", body: next, ...(record ? { record } : {}) }), next, { onRetry: () => setRetrying(true) });
      setRetrying(false);
      if (!res.ok) return { value: null, reply: null };
      const parsed = parseStrictReply<T>(res.json);
      setReply(parsed.reply);
      if (!parsed.ok) {
        setProblem({ code: "invalid_reply", message: parsed.message });
        return { value: null, reply: parsed.reply };
      }
      setValue(parsed.value);
      return { value: parsed.value, reply: parsed.reply };
    },
    [send],
  );

  const clear = useCallback(() => {
    runner.reset();
    setValue(null);
    setReply(null);
    setProblem(null);
  }, [runner]);

  return {
    state: runner.state,
    result: runner.result,
    elapsedMs: runner.elapsedMs,
    abort: runner.abort,
    /** The HTTP error, else a reply that didn't parse. Hidden while a chained turn waits to retry. */
    error: retrying ? null : (runner.error ?? problem),
    /** True while a chained turn waits for Meta to find the response it continues. */
    retrying,
    value,
    reply,
    body,
    run,
    clear,
  };
}

export interface AskChoice {
  value: string;
  label: string;
  primary?: boolean;
}

export interface AskRequest {
  title: string;
  detail?: string;
  /** Monospace lines under the title: the command or path under review. */
  subject?: string;
  choices: AskChoice[];
  note?: string;
}

/** Asks the reader and waits; null when the run was stopped. */
export type Ask = (request: AskRequest) => Promise<string | null>;

export interface HarnessResult {
  /** What goes back to the model as function_call_output. */
  output: string;
  /** What the harness shows for the call, terminal style. */
  lines: TermLine[];
  title?: string;
}

export type Harness = (call: ReturnType<typeof functionCalls>[number], ask: Ask) => Promise<HarnessResult>;

export type LoopStep =
  /** notice: why this reply ends the run without a report (cut off at the token limit, or failed). */
  | { kind: "model"; n: number; body: Json; reply: Collected | null; result: DocsResult | null; notice?: string }
  | { kind: "tool"; name: string; args: Json | null; rawArgs: string; status: "running" | "waiting" | "done"; result: HarnessResult | null };

export function useAgentLoop(maxCalls = 3) {
  const runner = useDocsRun();
  const [steps, setSteps] = useState<LoopStep[]>([]);
  const [asking, setAsking] = useState<AskRequest | null>(null);
  const [running, setRunning] = useState(false);
  const [final, setFinal] = useState<string | null>(null);
  const [lastBody, setLastBody] = useState<Json | null>(null);
  const resolver = useRef<((value: string | null) => void) | null>(null);
  const stopped = useRef(false);
  const [retrying, setRetrying] = useState(false);
  const { run: send, abort: abortCall } = runner;

  const answer = useCallback((value: string | null) => {
    const resolve = resolver.current;
    resolver.current = null;
    setAsking(null);
    resolve?.(value);
  }, []);

  const start = useCallback(
    async (request: ToolLoopRequest, harness: Harness) => {
      stopped.current = false;
      setSteps([]);
      setFinal(null);
      setRunning(true);
      const ask: Ask = (req) =>
        new Promise((resolve) => {
          resolver.current = resolve;
          setAsking(req);
          setSteps((s) => s.map((x, i) => (i === s.length - 1 && x.kind === "tool" ? { ...x, status: "waiting" } : x)));
        });
      let body = toolLoopFirstBody(request);
      try {
        for (let n = 1; n <= maxCalls; n++) {
          setLastBody(body);
          setSteps((s) => [...s, { kind: "model", n, body, reply: null, result: null }]);
          const sent = body;
          const res = await withChainRetry(() => send("responses", { method: "POST", body: sent }), sent, { onRetry: () => setRetrying(true) });
          setRetrying(false);
          if (stopped.current) return;
          const reply = res.ok ? collectReply("responses", res.json) : null;
          // A reply cut off at max_output_tokens (or failed) is not the agent's report: say so on its step instead.
          const notice = reply ? unfinishedReply(reply) : null;
          setSteps((s) => s.map((x) => (x.kind === "model" && x.n === n ? { ...x, reply, result: res, ...(notice ? { notice } : {}) } : x)));
          if (!res.ok || !reply || notice) return;
          const calls = functionCalls(reply);
          if (!calls.length) {
            setFinal(reply.text);
            return;
          }
          if (n === maxCalls || !reply.id) {
            setFinal(`${reply.text ? `${reply.text}\n\n` : ""}(The demo stops after ${maxCalls} model calls.)`);
            return;
          }
          const outputs: Array<{ callId: string; output: string }> = [];
          for (const call of calls) {
            setSteps((s) => [...s, { kind: "tool", name: call.name, args: call.args, rawArgs: call.arguments, status: "running", result: null }]);
            const result = await harness(call, ask);
            if (stopped.current) return;
            setSteps((s) => s.map((x, i) => (i === s.length - 1 && x.kind === "tool" ? { ...x, status: "done", result } : x)));
            outputs.push({ callId: call.callId, output: result.output });
          }
          body = toolLoopNextBody(request, reply.id, outputs);
        }
      } finally {
        if (!stopped.current) setRunning(false);
      }
    },
    [send, maxCalls],
  );

  const stop = useCallback(() => {
    stopped.current = true;
    abortCall();
    answer(null);
    setRunning(false);
  }, [abortCall, answer]);

  const reset = useCallback(() => {
    stop();
    runner.reset();
    setSteps([]);
    setFinal(null);
  }, [stop, runner]);

  return {
    steps,
    asking,
    answer,
    running,
    final,
    lastBody,
    start,
    stop,
    reset,
    retrying,
    error: retrying ? null : runner.error,
    elapsedMs: runner.elapsedMs,
    callRunning: runner.state === "running",
  };
}
