import { EXEC_SAMPLE_LINES } from "@/components/docs/playgrounds/muse-code-cookbook/logic/exec-sample";

/**
 * The logs the audit demo opens. One is a real Muse Code stream; the other two are excerpts rebuilt from the records
 * the audit recipe quotes (its approval window, sequences 193 to 202, and its crash-and-resume spine, 478 to 552).
 * Where the recipe shows a record, its sequence, kind and fields are the recipe's; the bookkeeping between them
 * (proposed, started) is filled in with the shape the real log uses, and sequences the recipe doesn't show are left
 * out, so an excerpt has gaps a real log wouldn't.
 */

export type SampleId = "exec" | "approval" | "crash";

export interface LogSample {
  id: SampleId;
  label: string;
  description: string;
  /** True for an excerpt rebuilt from the recipe: diagnostics such as gaps don't apply. */
  excerpt: boolean;
  lines: readonly string[];
}

type Json = Record<string, unknown>;

/** Envelope lines for one session stream, `recorded_at` in microseconds from a base. */
function envelopes(sessionId: string, base: number, rows: ReadonlyArray<[number, number, string, Json]>): string[] {
  return rows.map(([sequence, seconds, payloadType, payload]) =>
    JSON.stringify({
      schema_version: 1,
      id: `018f0000-0000-7000-8000-${String(sequence).padStart(12, "0")}`,
      stream: { kind: "session", id: sessionId },
      sequence,
      recorded_at: base + Math.round(seconds * 1e6),
      record_type: "event",
      durability: "durable",
      payload_type: payloadType,
      payload_schema_version: 1,
      payload,
    }),
  );
}

const task = (taskId: string, event: Json): Json => ({ kind: "task_lifecycle", task_id: taskId, event: { task_id: taskId, ...event } });

const APPROVAL_SESSION = "c7dfaecc-adf6-4348-87df-95576e15136e";
const PENDING = "pa_01a1-rm-stale-cache";
const T_BASH = "task-bash-run-check-costs";
const T_EDIT = "task-edit-check-costs";
const T_RM = "task-bash-rm-stale-cache";

const APPROVAL_LINES = envelopes(APPROVAL_SESSION, 1785657600000000, [
  [1, 0, "run.lifecycle.started", { kind: "run_started", prompt: "In check_costs.py, add a second tier named Frobnitz-12 with rate 0.0625 per compute-unit..." }],
  [40, 16.8, "task.lifecycle.proposed", task(T_BASH, { kind: "proposed", task_kind: "tool.bash" })],
  [41, 16.8, "task.lifecycle.accepted", task(T_BASH, { kind: "accepted" })],
  [43, 16.9, "task.lifecycle.side_effect_intent", task(T_BASH, { kind: "side_effect_intent", operation: "tool:bash", policy_decision: "allow:policy", idempotency_key: "tool:call_python3_check_costs" })],
  [44, 16.9, "tool_batch.effect.started", { task_id: T_BASH }],
  [45, 17.0, "tool_batch.effect.terminal", { task_id: T_BASH }],
  [68, 20.6, "task.lifecycle.proposed", task(T_EDIT, { kind: "proposed", task_kind: "tool.edit_file" })],
  [69, 20.6, "task.lifecycle.accepted", task(T_EDIT, { kind: "accepted" })],
  [71, 20.7, "task.lifecycle.side_effect_intent", task(T_EDIT, { kind: "side_effect_intent", operation: "tool:edit_file", policy_decision: "allow:policy", idempotency_key: "tool:call_edit_check_costs" })],
  [72, 20.7, "tool_batch.effect.started", { task_id: T_EDIT }],
  [73, 20.8, "tool_batch.effect.terminal", { task_id: T_EDIT }],
  [190, 57.7, "task.lifecycle.proposed", task(T_RM, { kind: "proposed", task_kind: "tool.bash" })],
  [191, 57.7, "task.lifecycle.accepted", task(T_RM, { kind: "accepted" })],
  [
    193,
    57.8,
    "approval.review",
    task(T_RM, {
      kind: "requested",
      pending_action_id: PENDING,
      approval_subject: { kind: "shell_command", raw_command: "rm -rf stale_cache.txt" },
      choices: ["Allow once", "Always allow in this workspace", "Reject"],
    }),
  ],
  [194, 57.8, "approval_wait.effect.started", { task_id: T_RM, pending_action_id: PENDING }],
  [195, 57.8, "approval.review", task(T_RM, { kind: "stage_requirement_resolved", pending_action_id: PENDING, resolution: "approved" })],
  [
    196,
    57.8,
    "approval.review",
    task(T_RM, {
      kind: "decision_applied",
      pending_action_id: PENDING,
      decision: "approved",
      policy_result: "allow",
      decision_source: {
        kind: "llm_judge",
        prompt_version: 1,
        params_version: 2,
        context_digest: "sha256:092e6c9694355f789a98a62f46a292c225af4ec3a183735fbe02ac3146597e86",
      },
    }),
  ],
  [197, 57.8, "approval_wait.effect.terminal", { task_id: T_RM, pending_action_id: PENDING, outcome: "approved" }],
  [200, 57.8, "task.lifecycle.side_effect_intent", task(T_RM, { kind: "side_effect_intent", operation: "tool:bash", policy_decision: "allow:llm_judge", idempotency_key: "tool:call_rm_stale_cache", pending_action_id: PENDING })],
  [201, 57.8, "tool_batch.effect.started", { task_id: T_RM }],
  [202, 57.9, "tool_batch.effect.terminal", { task_id: T_RM }],
  [232, 153.58, "session.end", { kind: "session_end", record: { exit_reason: "clean", uptime_ms: 153580 } }],
]);

const CRASH_SESSION = "ff273730-0000-0000-0000-000000000000";
const T7 = "task-gate-rec-7";
const T8 = "task-gate-rec-8";
const T8B = "task-gate-rec-8-after-resume";

const CRASH_LINES = envelopes(CRASH_SESSION, 1785657600000000, [
  [476, 301.2, "task.lifecycle.proposed", task(T7, { kind: "proposed", task_kind: "tool.bash" })],
  [478, 301.3, "task.lifecycle.side_effect_intent", task(T7, { kind: "side_effect_intent", operation: "tool:bash", policy_decision: "allow:policy", idempotency_key: "tool:call_gate_rec_7" })],
  [479, 301.3, "tool_batch.effect.started", { task_id: T7 }],
  [482, 306.4, "tool_batch.effect.terminal", { task_id: T7 }],
  [502, 330.0, "task.lifecycle.proposed", task(T8, { kind: "proposed", task_kind: "tool.bash" })],
  [504, 330.1, "task.lifecycle.side_effect_intent", task(T8, { kind: "side_effect_intent", operation: "tool:bash", policy_decision: "allow:policy", idempotency_key: "tool:call_gate_rec_8" })],
  [505, 330.1, "tool_batch.effect.started", { task_id: T8 }],
  [507, 331.0, "session.end", { kind: "session_end", record: { exit_reason: "crash_inferred" } }],
  [510, 402.5, "session.resumed", { kind: "session_resumed", record: { session_id: "ff273730-...", prior_turn_count: 1, resumed_from_sequence: 500 } }],
  [550, 431.0, "task.lifecycle.proposed", task(T8B, { kind: "proposed", task_kind: "tool.bash" })],
  [552, 431.1, "task.lifecycle.side_effect_intent", task(T8B, { kind: "side_effect_intent", operation: "tool:bash", policy_decision: "allow:policy", idempotency_key: "tool:call_gate_rec_8_resumed" })],
  [553, 431.1, "tool_batch.effect.started", { task_id: T8B }],
  [556, 436.2, "task.lifecycle.completed", task(T8B, { kind: "completed" })],
]);

export const LOG_SAMPLES: readonly LogSample[] = [
  {
    id: "exec",
    label: "Real run",
    description:
      "A real muse exec --json stream (Muse Code 1.4.13, Oct 27, 2026): one prompt that changes an h1, with 3 model calls, a read_file and an edit_file. 89 envelopes, the same shape a session.jsonl holds.",
    excerpt: false,
    lines: EXEC_SAMPLE_LINES,
  },
  {
    id: "approval",
    label: "Approval window",
    description:
      "The recipe's billing demo, rebuilt from the records it quotes: two actions allowed by static policy, then rm -rf stale_cache.txt escalated to the LLM judge (sequences 193 to 202).",
    excerpt: true,
    lines: APPROVAL_LINES,
  },
  {
    id: "crash",
    label: "Crash and resume",
    description:
      "The recipe's gated migration, rebuilt from its jq spine: a committed gate call, one in flight when the process was killed, the inferred crash, the resume, and the retried gate call.",
    excerpt: true,
    lines: CRASH_LINES,
  },
];

export function logSample(id: SampleId): LogSample {
  return LOG_SAMPLES.find((s) => s.id === id) ?? LOG_SAMPLES[0];
}
