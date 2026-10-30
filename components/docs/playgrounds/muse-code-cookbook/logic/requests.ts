import { responsesBody } from "@/lib/docs/client/body";
import { DEFAULT_TEXT_MODEL, fitEffort } from "@/lib/docs/client/models";
import { formatLocal } from "@/components/docs/playgrounds/muse-code-cookbook/logic/cron";
import { DEMO_AGENTS_MD, DEMO_BILLING_PY, GUARDRAIL_DEMO } from "@/components/docs/playgrounds/muse-code-cookbook/logic/guardrails";
import { BASH_TOOL, EDIT_FILE_TOOL, strictJsonBody, type Json, type ToolLoopRequest } from "@/components/docs/playgrounds/muse-code-cookbook/logic/live";
import type { GoalCheck } from "@/components/docs/playgrounds/muse-code-cookbook/logic/goal";
import { RECOMMEND_SCHEMA, recommendInstructions } from "@/components/docs/playgrounds/muse-code-cookbook/logic/recipes";
import { LAUNCH_FLAGS, type Launch } from "@/components/docs/playgrounds/muse-code-cookbook/logic/sandbox";
import { QUESTION_SCHEMA, QUESTION_WITH_RECORD_SCHEMA, skillInput, TASTE_SCHEMA, type Skill } from "@/components/docs/playgrounds/muse-code-cookbook/logic/skills";

/**
 * Every live request the Muse Code recipe demos send, built in one place: the components call these, and so do the
 * tests and the proxy checks, so what was checked is byte for byte what a reader's Run sends. Each starts on Muse
 * Spark 1.3 Contributor (or the model the reader picked) with low reasoning effort. Output budgets leave room for
 * reasoning, which at low effort still varies from a few hundred to over a thousand tokens: a strict JSON reply cut
 * off mid-object can't be parsed at all. On Contributor the largest budget here costs under a tenth of a cent.
 */

const PLAIN = "Write plain text without em dashes.";

/**
 * Each tool-loop call's output budget. Low-effort reasoning before a guardrail edit has used over 1,900 tokens, and a
 * reply cut off at the limit isn't a report, so the loops get the room the other calls have.
 */
export const TOOL_LOOP_TOKENS = 4000;

// ---------------------------------------------------------------------------------------------------------------
// cookbook/muse-code: which recipe fits

export function recommendBody(model: string, need: string): Json {
  return strictJsonBody({ model, instructions: recommendInstructions(), input: need, name: "RecipePicks", schema: RECOMMEND_SCHEMA, maxOutputTokens: 2500 });
}

// ---------------------------------------------------------------------------------------------------------------
// cookbook/audit-agent-sessions: a reviewer reads the ledger

export const REVIEW_SCHEMA: Json = {
  type: "object",
  properties: {
    actions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          sequence: { type: "integer" },
          action: { type: "string" },
          authorized_by: { type: "string" },
          concern: { type: "string" },
        },
        required: ["sequence", "action", "authorized_by", "concern"],
        additionalProperties: false,
      },
    },
    follow_ups: { type: "array", items: { type: "string" } },
    summary: { type: "string" },
  },
  required: ["actions", "follow_ups", "summary"],
  additionalProperties: false,
};

export interface Review {
  actions: Array<{ sequence: number; action: string; authorized_by: string; concern: string }>;
  follow_ups: string[];
  summary: string;
}

export const REVIEW_INSTRUCTIONS = `You are a security reviewer reading an audit ledger exported from a Muse Code agent session. Each row is one journaled action with the policy_decision that authorized it (allow:policy is static policy, allow:llm_judge is the reviewer, not_applicable is a model call). Answer only from what you are given. List every action that is not a model call: its sequence number, what it did, who or what authorized it in plain words, and a concern if there is one (empty string if none). Then list follow-ups for a human: effects that were announced but never confirmed, an abnormal end, anything that ran without an authorization. Finish with a two-sentence summary. ${PLAIN}`;

export function reviewBody(model: string, ledgerSummary: string): Json {
  return strictJsonBody({ model, instructions: REVIEW_INSTRUCTIONS, input: ledgerSummary, name: "AuditReview", schema: REVIEW_SCHEMA, maxOutputTokens: 3000 });
}

// ---------------------------------------------------------------------------------------------------------------
// cookbook/deterministic-replay: record a live run

export const TARIFF_PY = `#!/usr/bin/env python3
"""Vasquollo checkout pricing for the Grintable tier."""

BASE_PRICE = 120.00            # Vasquollo cart base, in dollars
GRINTABLE_RATE = 0.15          # Grintable surcharge rate

def final_total(base=BASE_PRICE, rate=GRINTABLE_RATE):
    """Return the checkout total after the Grintable surcharge."""
    return round(base * (1 + rate), 2)

if __name__ == "__main__":
    print(f"Final total: {final_total():.2f}")`;

export const TARIFF_PROMPT = "Read tariff.py and tell me the exact final checkout total it prints after the Grintable surcharge. Give the number.";
export const TARIFF_OUTPUT = "Final total: 138.00";

export function recordRunBody(model: string): Json {
  return responsesBody({
    model,
    system: `You are a coding agent in a terminal. The user asked about tariff.py. You already read the file and ran it; the tool output is below. Answer the user's question in one short line. ${PLAIN}`,
    messages: [{ role: "user", content: `${TARIFF_PROMPT}\n\n--- tariff.py ---\n${TARIFF_PY}\n\n--- output of python3 tariff.py ---\n${TARIFF_OUTPUT}` }],
    effort: fitEffort(model, "low"),
    maxOutputTokens: 1500,
  });
}

// ---------------------------------------------------------------------------------------------------------------
// The harness recipes: the model with Muse Code's tools, around a simulated harness

export function containmentRequest(prompt: string, model: string = DEFAULT_TEXT_MODEL): ToolLoopRequest {
  return {
    model,
    instructions: `You are Muse Code, a coding agent working in the project at /tmp/sandbox_demo, which contains build_info.sh. Run commands with the bash tool, exactly as the user gives them. After a command runs, report exactly what happened: the output, any error verbatim, the exit code, and what that means. Keep it short. ${PLAIN}`,
    input: prompt,
    tools: [BASH_TOOL],
    maxOutputTokens: TOOL_LOOP_TOKENS,
  };
}

/** The guardrail recipe's launch line: it always trusts the workspace so the rules load. */
export function guardrailLaunch(launch: Launch): string {
  return launch === "disable-approval" ? LAUNCH_FLAGS[launch] : `${LAUNCH_FLAGS[launch]} --trust-workspace`;
}

export function guardrailRequest(prompt: string, model: string, launch: Launch): ToolLoopRequest {
  return {
    model,
    instructions: [
      `You are Muse Code, a coding agent in the trusted workspace ${GUARDRAIL_DEMO.root} (launched as: ${guardrailLaunch(launch)}).`,
      "Standing rules loaded at session open from .agents/AGENTS.md:",
      DEMO_AGENTS_MD,
      "The workspace also has billing.py:",
      DEMO_BILLING_PY,
      `Use edit_file for file edits and bash for shell commands. If a tool call is denied, say so plainly and don't retry on your own. Report exactly what happened. ${PLAIN}`,
    ].join("\n\n"),
    input: prompt,
    tools: [EDIT_FILE_TOOL, BASH_TOOL],
    maxOutputTokens: TOOL_LOOP_TOKENS,
  };
}

export const STAGED_WORKSPACE = "/tmp/perm_run";

export function stagedRequest(prompt: string, model: string = DEFAULT_TEXT_MODEL): ToolLoopRequest {
  return {
    model,
    instructions: `You are Muse Code, a coding agent in the workspace ${STAGED_WORKSPACE}, which holds quota_tool.py and report.log. Run shell commands with the bash tool. If a command is denied, report that plainly and don't retry. ${PLAIN}`,
    input: prompt,
    tools: [BASH_TOOL],
    maxOutputTokens: TOOL_LOOP_TOKENS,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// cookbook/subagent-fanout: plan the fan-out

export const PLAN_SCHEMA: Json = {
  type: "object",
  properties: {
    tasks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          role: { type: "string" },
          objective: { type: "string" },
          files: { type: "array", items: { type: "string" } },
          verify: { type: "string" },
        },
        required: ["id", "role", "objective", "files", "verify"],
        additionalProperties: false,
      },
    },
    merge_order: { type: "array", items: { type: "string" } },
    notes: { type: "string" },
  },
  required: ["tasks", "merge_order", "notes"],
  additionalProperties: false,
};

export const PLAN_INSTRUCTIONS = `You plan a Muse Code subagent fanout. Split the job into two to eight bounded, independently verifiable tasks, each for one write-capable subagent in its own git worktree. For each: a short kebab-case id, a role, a one-sentence objective, the files it will most likely touch (paths relative to the repo root), and the command that proves it is done. Then give merge_order: every task id once, in the order the parent should merge the children's commits, putting fixes others depend on first and tasks that touch the same files apart. In notes, one or two sentences on conflicts to watch. Keep sequential work in one task rather than splitting it. ${PLAIN}`;

export function fanoutPlanBody(model: string, job: string): Json {
  return strictJsonBody({ model, instructions: PLAN_INSTRUCTIONS, input: job, name: "FanoutPlan", schema: PLAN_SCHEMA, maxOutputTokens: 4000 });
}

// ---------------------------------------------------------------------------------------------------------------
// cookbook/goal-tracking: the completion audit's judge

export const JUDGE_SCHEMA: Json = {
  type: "object",
  properties: {
    checks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          status: { type: "string", enum: ["pass", "fail", "unproven"] },
          evidence: { type: "string" },
        },
        required: ["id", "status", "evidence"],
        additionalProperties: false,
      },
    },
    verdict: { type: "string", enum: ["complete", "incomplete"] },
    next_step: { type: "string" },
  },
  required: ["checks", "verdict", "next_step"],
  additionalProperties: false,
};

export const JUDGE_INSTRUCTIONS = `You are the completion audit for an agent's pinned goal. You get the goal, its acceptance checks with ids, and the agent's completion report. Grade every check on its own: pass only when the report shows it is met (command output, test results, a named change), fail when the report shows it is not met, unproven when the report doesn't say. For evidence, copy the exact words from the report that decide it (empty when unproven). Then give the overall verdict (complete only if every check passes) and the next step the agent should take. Don't assume anything the report doesn't show. ${PLAIN}`;

export function judgeBody(model: string, objective: string, checks: readonly GoalCheck[], report: string): Json {
  const input = [`Goal: ${objective}`, "Acceptance checks:", ...checks.map((c) => `- ${c.id}: ${c.text}`), "", "Agent's completion report:", report].join("\n");
  return strictJsonBody({ model, instructions: JUDGE_INSTRUCTIONS, input, name: "CompletionAudit", schema: JUDGE_SCHEMA, maxOutputTokens: 3000 });
}

// ---------------------------------------------------------------------------------------------------------------
// cookbook/bundled-skills: a run in the skill's style

/** The first request of a skill run: /plan streams prose; the interviews and /taste answer as strict JSON. */
export function skillFirstBody(model: string, skill: Skill, prompt: string): Json {
  if (skill.shape === "plan") {
    return responsesBody({ model, system: skill.instructions, messages: [{ role: "user", content: skillInput(skill, prompt) }], effort: fitEffort(model, "low"), maxOutputTokens: 3000, stream: true });
  }
  return strictJsonBody({ model, instructions: skill.instructions, input: skillInput(skill, prompt), name: skill.shape === "taste" ? "TasteChoices" : "GrillQuestion", schema: skillSchema(skill), maxOutputTokens: 3000 });
}

export function skillSchema(skill: Skill): Json {
  return skill.shape === "taste" ? TASTE_SCHEMA : skill.shape === "question-with-record" ? QUESTION_WITH_RECORD_SCHEMA : QUESTION_SCHEMA;
}

/** The reader's answer to an interview question, continuing the stored response. */
export function skillAnswerBody(model: string, skill: Skill, answer: string, previousResponseId: string): Json {
  return strictJsonBody({ model, instructions: skill.instructions, input: `My answer: ${answer}`, name: "GrillQuestion", schema: skillSchema(skill), maxOutputTokens: 3000, previousResponseId });
}

// ---------------------------------------------------------------------------------------------------------------
// cookbook/loop-and-cron: a /loop request to a stored job

export interface Translation {
  cron: string;
  recurring: boolean;
  task: string;
  also_run_now: boolean;
  notes: string;
}

export const SCHEDULE_SCHEMA: Json = {
  type: "object",
  properties: {
    cron: { type: "string" },
    recurring: { type: "boolean" },
    task: { type: "string" },
    also_run_now: { type: "boolean" },
    notes: { type: "string" },
  },
  required: ["cron", "recurring", "task", "also_run_now", "notes"],
  additionalProperties: false,
};

export function scheduleInstructions(now: Date, zone: string): string {
  return [
    "You turn a Muse Code /loop request into the job it stores. Jobs use a five-field cron expression (minute hour day-of-month month day-of-week) in the machine's local timezone.",
    `It is now ${formatLocal(now)} ${now.getFullYear()}, in ${zone}.`,
    "Recurring work gets recurring: true. A one-time request (tomorrow at 2pm, once on Friday) gets recurring: false and a cron that pins the minute, hour, day of month and month of that one date.",
    `task is what the job runs, without the timing words. also_run_now is true unless the request says to only create the job or not to do the work now. notes is one sentence on anything ambiguous. ${PLAIN}`,
  ].join(" ");
}

export function scheduleBody(model: string, request: string, now: Date, zone: string): Json {
  return strictJsonBody({ model, instructions: scheduleInstructions(now, zone), input: request, name: "ScheduledJob", schema: SCHEDULE_SCHEMA, maxOutputTokens: 2500 });
}

// ---------------------------------------------------------------------------------------------------------------
// cookbook/side-chats: the two lanes

export const MAIN_INSTRUCTIONS = `You are Muse Code, a coding agent working in /tmp/sidechat_demo, on the main thread. Answer from this conversation. Keep answers short. ${PLAIN}`;

export const SIDE_INSTRUCTIONS = `This is a side chat branched from the main thread at a turn boundary. Everything before this point is the main thread: reference you may read and cite, not a task to continue. Answer the user's side questions. The main run keeps going separately, so don't continue its work. Side chats are for investigation and explanation only: no subagents, no workflows, and no file changes unless the user explicitly asks. Keep answers short. ${PLAIN}`;

/** One streamed turn on a lane: the main thread chains its own ids; the side starts from the main thread's cut. */
export function chatTurnBody(model: string, lane: "main" | "side", text: string, previousResponseId: string | null): Json {
  return responsesBody({
    model,
    system: lane === "main" ? MAIN_INSTRUCTIONS : SIDE_INSTRUCTIONS,
    messages: [{ role: "user", content: text }],
    previousResponseId,
    effort: fitEffort(model, "low"),
    maxOutputTokens: 3000,
    stream: true,
  });
}
