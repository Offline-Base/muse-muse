/**
 * A stand-in for Auto-review's approval judge on the Model API: one Responses call that reviews the held shell stage
 * in the context of the agent's task and answers with a structured decision. Muse Code's own reviewer and its prompt
 * aren't published; this shows the idea (a model clears what it judges safe and hands the rest to you) with a request
 * a reader can copy. Pure: the simulator and the tests build the same body.
 */

export interface JudgeInput {
  model: string;
  task: string;
  command: string;
  stageNumber: number;
  stageCount: number;
  stage: string;
  why: string;
  sandbox: string;
}

export const JUDGE_SCHEMA = {
  type: "object",
  properties: {
    decision: { type: "string", enum: ["allow", "ask_user"] },
    reason: { type: "string" },
  },
  required: ["decision", "reason"],
  additionalProperties: false,
} as const;

export const JUDGE_INSTRUCTIONS =
  "You review one shell command stage for a coding agent before it runs, the way an automated approval reviewer does. " +
  "Answer allow only when the stage is clearly safe and needed for the agent's task; otherwise answer ask_user so a person decides. " +
  "Destructive or irreversible actions, anything outside the task, and code you can't see count against allowing. " +
  "Keep the reason to one sentence.";

export function judgeBody(input: JudgeInput): Record<string, unknown> {
  return {
    model: input.model,
    instructions: JUDGE_INSTRUCTIONS,
    input: [
      `Agent's task: ${input.task.trim() || "(not stated)"}`,
      `Full command: ${input.command.trim()}`,
      `Held stage: ${input.stageNumber} of ${input.stageCount}: ${input.stage}`,
      `Why it held: ${input.why}`,
      `Sandbox: ${input.sandbox}`,
    ].join("\n"),
    // Even at minimal effort the model reasons for several hundred tokens before the JSON (checked through the docs
    // proxy, Oct 30, 2026), so the budget leaves room for both.
    reasoning: { effort: "minimal" },
    text: { format: { type: "json_schema", name: "approval_decision", strict: true, schema: JUDGE_SCHEMA } },
    // Muse Wonder costs about 100 times more per output token, so its budget stays at 800.
    max_output_tokens: input.model === "muse-wonder-1.0" ? 800 : 1500,
  };
}

export interface JudgeVerdict {
  decision: "allow" | "ask_user";
  reason: string;
}

/** The decision from the reply's text, or null when the model didn't return the schema's JSON. */
export function parseJudgeReply(text: string): JudgeVerdict | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const v = JSON.parse(text.slice(start, end + 1)) as { decision?: unknown; reason?: unknown };
    if ((v.decision === "allow" || v.decision === "ask_user") && typeof v.reason === "string") return { decision: v.decision, reason: v.reason };
  } catch {
    return null;
  }
  return null;
}
