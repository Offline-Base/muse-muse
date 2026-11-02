/**
 * The owner's controls for a running build (docs/MUSE_CODE_FULL.md, "The owner steers"): what POST
 * /api/builds/{id}/control accepts, turned into the MuseCommands that go into the round's mailbox, the text its
 * `control` build event shows and the owner's own words the change policy checks first. Pure, so the route stays thin
 * and tests feed it bodies directly.
 */
import type { MuseAnswer, MuseCommand } from "@/lib/sandbox/bridge-protocol";
import type { BuildEventBody, BuildStatus } from "@/lib/types";

export type ControlAction = Extract<BuildEventBody, { type: "control" }>["action"];

const ACTIONS: readonly ControlAction[] = ["steer", "queue", "interrupt", "stop", "goal", "answer", "workflow", "subagent"];

/** Every field a body may carry. Anything else is refused, so a misspelled field never passes as a missing one. */
const FIELDS = new Set([
  "action",
  "text",
  "goalAction",
  "objective",
  "userInputId",
  "answers",
  "workflowAction",
  "workflowId",
  "childSessionId",
  "subagentAction",
]);
const ANSWER_FIELDS = new Set(["questionId", "selectedLabel", "selectedLabels", "freeText"]);

/** The statuses a build is in while one of its Muse Code rounds may run: the build round, then each fix round. */
export const STEERABLE_STATUSES: readonly BuildStatus[] = ["building", "fixing"];

/** Commands one build takes in a minute. Past it the route answers 429, except to a stop, which always goes through. */
export const CONTROLS_PER_MINUTE = 20;

/** Under STEER_CHAT: notes one build takes in a minute, and in all. Each one costs a policy check. Stop never counts. */
export const NOTES_PER_MINUTE = 6;
export const NOTES_PER_BUILD = 40;

/** How Muse Code starts the line that answers a note, which the build room shows in the feed (conversationItems). */
export const NOTE_REPLY_PREFIX = "About your note:";

/** Why a note that nothing read by the end of its round did nothing. */
export const NOTE_TOO_LATE = "It arrived as this step ended, so Muse Code didn't use it. Send it again, or ask for it as a change once the build is done.";

/**
 * A note as Muse Code gets it under STEER_CHAT: the owner's words, what they can't change, and how to answer. The
 * policy check and the `control` event use the owner's words alone.
 */
export function noteForAgent(text: string): string {
  return [
    "This note is from the build's owner and it outranks brief.md. Where they differ on the name, words, look, screens or features, follow the note: change what you already built and its tests, and add what it asks for. Keeping to the brief is never a reason to turn it down.",
    "It never overrides the rules in AGENTS.md, secrets or limits, and it never adds spend or time.",
    `Before your next tool call, write one line that starts with "${NOTE_REPLY_PREFIX}" and says in plain words what you'll do. If you can't do it, or can do only part of it, say that on the line and name the rule or limit that stops you.`,
    "",
    "The note:",
    text,
  ].join("\n");
}

/** The longest note, goal or subagent message, in characters. */
export const MAX_CONTROL_TEXT = 4000;
// What `userInput/answer` allows (UserInputAnswer, UserInputQuestion and UserInputOption in the MSP schema): one to
// three questions with two or three options each, ids up to 64 characters, labels up to 80, free text up to 500.
const MAX_ANSWERS = 3;
const MAX_OPTIONS = 3;
const MAX_QUESTION_ID = 64;
const MAX_LABEL = 80;
const MAX_FREE_TEXT = 500;

/** Why the session's `end` was sent, kept on its record. */
const STOP_REASON = "The build's owner stopped it.";

// Control characters: C0 but tab and line feed, DEL and C1. Line breaks are fine in a note, never in an id or a label.
const CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;
const ANY_CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
// Half of a surrogate pair on its own isn't text, and Postgres refuses it in the event's JSON.
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
/** Opaque ids the session hands out, such as a workflow run's ("workflow-run-model-tool-call_01a1...") or a prompt's. */
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
/** Session ids, a child's included, are UUIDs (v7 from Muse Code 1.4.14, older ones v4). */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const VERB = { pause: "Pause", resume: "Resume", clear: "Clear", cancel: "Cancel", interrupt: "Interrupt", stop: "Stop" } as const;

export interface ControlRequest {
  action: ControlAction;
  /** What goes into the mailbox, in this order. A stop is an interrupt, then an end. */
  commands: MuseCommand[];
  /** The `control` event's text: the owner's own words, or what they asked for when the command has none. */
  text?: string;
  /**
   * The words the owner wrote that reach the agent: a note, a goal, a subagent message or typed answers. The route puts
   * them through the change policy before anything is sent. Absent for a command with no words of their own, such as a
   * stop or an option the session offered.
   */
  ownerText?: string;
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

function bad(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

/**
 * Text the owner typed, trimmed, with Windows and old Mac line breaks made plain: 1 to `max` characters, with no
 * control characters other than line breaks and tabs.
 */
function cleanText(value: unknown, what: string, max: number): Parsed<string> {
  const text = typeof value === "string" ? value.replace(/\r\n?/g, "\n").trim() : "";
  if (!text) return bad(`Write the ${what} first.`);
  if ([...text].length > max) return bad(`Keep the ${what} to ${max.toLocaleString("en-US")} characters.`);
  if (CONTROL_CHARS.test(text) || LONE_SURROGATE.test(text)) {
    return bad(`The ${what} has characters that can't be sent, like control characters. Take them out.`);
  }
  return { ok: true, value: text };
}

/** A question's id or an option's label, sent exactly as the session gave it, so it is checked but never trimmed. */
function isLabel(value: unknown, max: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    [...value].length <= max &&
    !ANY_CONTROL.test(value) &&
    !LONE_SURROGATE.test(value)
  );
}

/** One answer per question, each with exactly one of an option, several options or a short reply. */
function cleanAnswers(value: unknown): Parsed<MuseAnswer[]> {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_ANSWERS) {
    return bad(`Send one answer for each question, ${MAX_ANSWERS} at most.`);
  }
  const out: MuseAnswer[] = [];
  const seen = new Set<string>();
  for (const raw of value as unknown[]) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return bad("Send each answer as an object.");
    const a = raw as Record<string, unknown>;
    if (Object.keys(a).some((k) => !ANSWER_FIELDS.has(k))) return bad("Send only questionId and the answer itself in each answer.");
    const { questionId } = a;
    if (!isLabel(questionId, MAX_QUESTION_ID)) return bad("Each answer needs the id of the question it answers.");
    if (seen.has(questionId)) return bad("Answer each question once.");
    seen.add(questionId);
    const given = (["selectedLabel", "selectedLabels", "freeText"] as const).filter((k) => a[k] !== undefined && a[k] !== null);
    if (given.length !== 1) return bad("Give each answer one option, a few options or a short reply, and only one of those.");
    if (given[0] === "selectedLabel") {
      if (!isLabel(a.selectedLabel, MAX_LABEL)) return bad("Pick one of the options the question gave.");
      out.push({ questionId, selectedLabel: a.selectedLabel });
    } else if (given[0] === "selectedLabels") {
      const labels: unknown = a.selectedLabels;
      const fine =
        Array.isArray(labels) &&
        labels.length >= 1 &&
        labels.length <= MAX_OPTIONS &&
        labels.every((l) => isLabel(l, MAX_LABEL)) &&
        new Set(labels).size === labels.length;
      if (!fine) return bad("Pick options the question gave, each one once.");
      out.push({ questionId, selectedLabels: labels as string[] });
    } else {
      const reply = cleanText(a.freeText, "reply", MAX_FREE_TEXT);
      if (!reply.ok) return reply;
      out.push({ questionId, freeText: reply.value });
    }
  }
  return { ok: true, value: out };
}

function answerText(answers: MuseAnswer[]): string {
  return answers.map((a) => a.freeText ?? a.selectedLabel ?? (a.selectedLabels ?? []).join(", ")).join("; ");
}

/**
 * Checks a control body and turns it into mailbox commands. Every field is checked against what the action takes and
 * what the session protocol expects, and fields no action takes are refused. The error is a sentence for the owner.
 */
export function parseControl(body: Record<string, unknown>): Parsed<ControlRequest> {
  if (Object.keys(body).some((k) => !FIELDS.has(k))) return bad("Send only the fields this action takes.");
  const action = body.action;
  if (typeof action !== "string" || !(ACTIONS as readonly string[]).includes(action)) {
    return bad("Say what to do: steer, queue, interrupt, stop, goal, answer, workflow or subagent.");
  }
  const act = action as ControlAction;
  switch (act) {
    case "steer":
    case "queue": {
      const text = cleanText(body.text, "note", MAX_CONTROL_TEXT);
      if (!text.ok) return text;
      const command: MuseCommand = act === "steer" ? { type: "steer", text: text.value } : { type: "queue", text: text.value };
      return { ok: true, value: { action: act, commands: [command], text: text.value, ownerText: text.value } };
    }
    case "interrupt":
      return { ok: true, value: { action: act, commands: [{ type: "interrupt" }] } };
    case "stop":
      return { ok: true, value: { action: act, commands: [{ type: "interrupt" }, { type: "end", reason: STOP_REASON }] } };
    case "goal": {
      const goalAction = body.goalAction;
      if (goalAction === "set" || goalAction === "edit") {
        const objective = cleanText(body.objective, "goal", MAX_CONTROL_TEXT);
        if (!objective.ok) return objective;
        return {
          ok: true,
          value: {
            action: act,
            commands: [{ type: "goal", action: goalAction, objective: objective.value }],
            text: objective.value,
            ownerText: objective.value,
          },
        };
      }
      if (goalAction === "pause" || goalAction === "resume" || goalAction === "clear") {
        return { ok: true, value: { action: act, commands: [{ type: "goal", action: goalAction }], text: `${VERB[goalAction]} the goal` } };
      }
      return bad("Say what to do with the goal: set, edit, pause, resume or clear.");
    }
    case "answer": {
      const { userInputId } = body;
      if (typeof userInputId !== "string" || !OPAQUE_ID.test(userInputId)) return bad("Say which question you're answering.");
      const answers = cleanAnswers(body.answers);
      if (!answers.ok) return answers;
      // The session refuses a label it didn't offer (userInputAnswerInvalid), so only typed replies are the owner's own.
      const typed = answers.value.flatMap((a) => (a.freeText ? [a.freeText] : []));
      return {
        ok: true,
        value: {
          action: act,
          commands: [{ type: "answer", userInputId, answers: answers.value }],
          text: answerText(answers.value),
          ...(typed.length ? { ownerText: typed.join("\n\n") } : {}),
        },
      };
    }
    case "workflow": {
      const { workflowAction } = body;
      if (workflowAction !== "pause" && workflowAction !== "resume" && workflowAction !== "cancel") {
        return bad("Say what to do with the workflow: pause, resume or cancel.");
      }
      const workflowId = body.workflowId ?? undefined;
      if (workflowId !== undefined && (typeof workflowId !== "string" || !OPAQUE_ID.test(workflowId))) {
        return bad("That isn't a workflow id Muse Code gave out.");
      }
      return {
        ok: true,
        value: {
          action: act,
          commands: [{ type: "workflow", action: workflowAction, ...(workflowId ? { workflowId } : {}) }],
          text: `${VERB[workflowAction]} the workflow`,
        },
      };
    }
    case "subagent": {
      const { subagentAction, childSessionId } = body;
      if (subagentAction !== "message" && subagentAction !== "interrupt" && subagentAction !== "stop") {
        return bad("Say what to do with the subagent: message, interrupt or stop.");
      }
      if (typeof childSessionId !== "string" || !UUID.test(childSessionId)) return bad("Say which subagent, by its child session id.");
      if (subagentAction === "message") {
        const text = cleanText(body.text, "message", MAX_CONTROL_TEXT);
        if (!text.ok) return text;
        return {
          ok: true,
          value: {
            action: act,
            commands: [{ type: "subagent", action: "message", childSessionId, text: text.value }],
            text: text.value,
            ownerText: text.value,
          },
        };
      }
      return {
        ok: true,
        value: { action: act, commands: [{ type: "subagent", action: subagentAction, childSessionId }], text: `${VERB[subagentAction]} the subagent` },
      };
    }
  }
}

/**
 * The build-room round a command lands in, numbered as the build's `muse` events are: 0 while the build (or the change)
 * runs, then the fix number during each fix round.
 */
export function controlRound(build: { status: BuildStatus; fixRounds: number }): number {
  return build.status === "fixing" ? build.fixRounds : 0;
}
