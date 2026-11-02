/**
 * The case agent's loop. Copy this file to lib/case/loop.ts unchanged. Pure TypeScript with no imports: the route passes
 * in the model call and the tools. It holds three promises a product must keep:
 *   - A tool that returns `stop` ends the run's stretch before any further model call, and runStretch makes no model call
 *     while a person is awaited, whoever POSTs.
 *   - answerPerson hands the person's answer to the model as the output of the call that asked, so the run resumes where
 *     it stopped.
 *   - A failed call never becomes a stand-in result. The run stops with the status, code and message the call returned.
 */

export type RunStatus =
  | "running"
  | "waiting_on_person"
  | "waiting_on_signoff"
  | "paused_run_limit"
  | "paused_budget"
  | "paused_ceiling"
  | "failed"
  | "done";

export interface TurnRow {
  n: number;
  /** The tool this turn called, or null when the model answered in words. */
  tool: string | null;
  summary: string;
  inputTokens: number;
  outputTokens: number;
  usd: number;
  /** The id the model's reply came back with: what shows this turn really ran. */
  responseId: string;
  model: string;
  at: string;
}

export interface EvidenceRequest {
  callId: string;
  itemId: string;
  ask: string;
  answer?: string;
  answeredAt?: string;
}

export interface LoopRecord {
  id: string;
  status: RunStatus;
  lastResponseId: string | null;
  /** What the next model call must carry: the output of the last tool call. */
  pending: { callId: string; output: string } | null;
  /** The open request while status is waiting_on_person. */
  waiting: EvidenceRequest | null;
  requests: EvidenceRequest[];
  turns: TurnRow[];
  costUsd: number;
  nudges: number;
  /** Exactly what the failed call said, for the screen. */
  error: string | null;
}

export interface ModelReply {
  id: string;
  model?: string;
  output: Array<{ type: string; name?: string; call_id?: string; arguments?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number } | null;
}

export interface ToolResult {
  /** What the model reads. A refusal is a normal result. */
  output: string;
  /** Plain words for the timeline. */
  summary: string;
  stop?: "waiting_on_person" | "waiting_on_signoff";
  /** With waiting_on_person: what the card asks for. */
  request?: { itemId: string; ask: string };
}

export interface LoopDeps<R extends LoopRecord> {
  /** responses.create with the x-musemuse-run-id header. Always previous_response_id when given, one tool per turn. */
  callModel(args: { input: unknown[]; previousResponseId: string | null; wrapUp: boolean; record: R }): Promise<ModelReply>;
  runTool(name: string, args: Record<string, unknown>, record: R, callId: string): Promise<ToolResult>;
  /** The first message of a run, and the whole state as one message when Meta refuses previous_response_id. */
  firstInput(record: R): unknown[];
  rebuildInput(record: R): unknown[];
  priceUsd(usage: ModelReply["usage"]): number;
  now(): number;
  /** One for Step through. */
  maxTurnsThisStretch: number;
  /** Starts no new turn after this long. About 200 s under a 300 s route. */
  maxStretchMs: number;
  turnLimit: number;
  ceilingUsd: number;
}

const MAX_NUDGES = 2;
const NUDGE =
  "Use one tool now. If a checklist item has no evidence in the file, ask the person for it with the tool for that. If every item is settled, file the memo.";

export function newRecord<R extends LoopRecord>(id: string, extra: Omit<R, keyof LoopRecord>): R {
  return {
    id,
    status: "running",
    lastResponseId: null,
    pending: null,
    waiting: null,
    requests: [],
    turns: [],
    costUsd: 0,
    nudges: 0,
    error: null,
    ...extra,
  } as unknown as R;
}

function errorField(err: unknown, key: string): string | number | undefined {
  const value = (err as Record<string, unknown> | null)?.[key];
  return typeof value === "string" || typeof value === "number" ? value : undefined;
}

function isRefusedPrevious(err: unknown): boolean {
  const text = `${errorField(err, "code") ?? ""} ${errorField(err, "param") ?? ""} ${errorField(err, "message") ?? ""}`;
  return errorField(err, "status") === 400 && /previous_response/i.test(text);
}

/** What a failed model call says, with nothing guessed. */
export function describeCallError(err: unknown): string {
  const status = errorField(err, "status");
  const code = errorField(err, "code");
  const message = errorField(err, "message") ?? String(err);
  return `${status ? `HTTP ${status}` : "No reply"}${code ? ` ${code}` : ""}: ${message}`.slice(0, 500);
}

function parseArgs(raw: string | undefined): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw ?? "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Runs turns until a stop, a limit or the end of the stretch. Returns the same record, changed. */
export async function runStretch<R extends LoopRecord>(record: R, deps: LoopDeps<R>): Promise<R> {
  if (record.status !== "running") return record;
  const started = deps.now();
  let rebuilt = false;

  for (let done = 0; done < deps.maxTurnsThisStretch && deps.now() - started < deps.maxStretchMs; done += 1) {
    if (record.costUsd >= deps.ceilingUsd) {
      record.status = "paused_ceiling";
      return record;
    }
    const wrapUp = record.turns.length >= deps.turnLimit - 1;
    let input: unknown[];
    if (rebuilt) input = deps.rebuildInput(record);
    else if (record.pending) input = [{ type: "function_call_output", call_id: record.pending.callId, output: record.pending.output }];
    else if (record.lastResponseId) input = [{ role: "user", content: NUDGE }];
    else input = deps.firstInput(record);

    let reply: ModelReply;
    try {
      reply = await deps.callModel({ input, previousResponseId: rebuilt ? null : record.lastResponseId, wrapUp, record });
    } catch (err) {
      if (!rebuilt && isRefusedPrevious(err)) {
        rebuilt = true;
        done -= 1;
        continue;
      }
      const code = errorField(err, "code");
      if (errorField(err, "status") === 429 && code === "run_limit") record.status = "paused_run_limit";
      else if (typeof code === "string" && /budget/i.test(code)) record.status = "paused_budget";
      else record.status = "failed";
      record.error = describeCallError(err);
      return record;
    }
    rebuilt = false;

    const usd = deps.priceUsd(reply.usage);
    record.costUsd += usd;
    record.lastResponseId = reply.id;
    record.pending = null;
    const call = reply.output.find((o) => o.type === "function_call");
    const row: TurnRow = {
      n: record.turns.length + 1,
      tool: call?.name ?? null,
      summary: "",
      inputTokens: reply.usage?.input_tokens ?? 0,
      outputTokens: reply.usage?.output_tokens ?? 0,
      usd,
      responseId: reply.id,
      model: reply.model ?? "",
      at: new Date(deps.now()).toISOString(),
    };
    record.turns.push(row);

    if (!call?.name || !call.call_id) {
      row.summary = "The agent answered in words without using a tool.";
      record.nudges += 1;
      if (record.nudges > MAX_NUDGES) {
        record.status = "failed";
        record.error = "The agent kept answering in words instead of using its tools.";
        return record;
      }
      continue;
    }

    const result = await deps.runTool(call.name, parseArgs(call.arguments), record, call.call_id);
    row.summary = result.summary;
    record.pending = { callId: call.call_id, output: result.output };
    // A tool may have finished the run, and a stop ends the stretch here: no model call follows it.
    if (result.stop) {
      record.status = result.stop;
      if (result.stop === "waiting_on_person" && result.request) {
        record.waiting = { callId: call.call_id, ...result.request };
        record.requests.push(record.waiting);
      }
      return record;
    }
    if ((record.status as RunStatus) !== "running") return record;
  }
  return record;
}

/**
 * The person answered, in words or by releasing a document. The answer becomes the output of the call that asked, so the
 * next stretch resumes there. Throws unless a person is awaited, so a replay can't answer twice.
 */
export function answerPerson<R extends LoopRecord>(record: R, answer: string, atIso: string, released: string[] = []): R {
  if (record.status !== "waiting_on_person" || !record.waiting) throw new Error("This run isn't waiting for an answer.");
  record.waiting.answer = answer;
  record.waiting.answeredAt = atIso;
  record.pending = {
    callId: record.waiting.callId,
    output: JSON.stringify({ status: "answered", item: record.waiting.itemId, person_said: answer, released_documents: released }),
  };
  record.waiting = null;
  record.status = "running";
  return record;
}
