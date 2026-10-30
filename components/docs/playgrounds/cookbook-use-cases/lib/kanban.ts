import type { FnToolDef } from "@/components/docs/playgrounds/cookbook-use-cases/lib/agent";

/**
 * cookbook/multi-agent-orchestration: the four Hermes profiles (their SOUL.md text and toolsets, from the recipe),
 * the Kanban board they coordinate through, and the dispatcher's rule: a task in ready whose parents are all done goes
 * to its assignee when that profile is idle. Every cross-role decision is a comment on a task. Pure, so the board
 * logic is tested without a model.
 */

export type Profile = "pm" | "backend" | "frontend" | "gtm";
export type TaskStatus = "ready" | "running" | "blocked" | "done";

export interface TaskComment {
  author: Profile | "dispatcher";
  body: string;
  kind?: "comment" | "block" | "complete" | "unblock";
}

export interface Task {
  id: string;
  title: string;
  assignee: Profile;
  description: string;
  parents: string[];
  status: TaskStatus;
  comments: TaskComment[];
  events: string[];
}

export interface Board {
  tasks: Task[];
  files: Record<string, string>;
}

export const PROFILES: Profile[] = ["pm", "backend", "frontend", "gtm"];

export const DESCRIPTIONS: Record<Profile, string> = {
  pm: "Product manager. Pulls fuzzy ideas into shape by asking the right questions, names the target audience, sets scope, sequences work, and arbitrates trade-offs between specialists. Does not write code.",
  backend: "Backend engineer. Designs clear data models and API contracts, writes server-side logic in Python by default. Values correctness and simple interfaces.",
  frontend: "Frontend engineer with strong design sensibilities. Translates audience and tone into concrete visual decisions. Refuses to start building until the brief's audience and vibe are explicit.",
  gtm: "Technical writer and launch marketer. Reads code and product artifacts and produces deep technical narratives for engineers and crisp benefit-led copy for end users.",
};

export const TOOLSETS: Record<Profile, string[]> = {
  pm: ["kanban", "clarify", "file", "memory", "todo"],
  backend: ["kanban", "terminal", "file", "code_execution", "memory", "todo"],
  frontend: ["kanban", "terminal", "file", "memory", "todo"],
  gtm: ["kanban", "file", "web", "memory", "todo"],
};

export const SOULS: Record<Profile, string> = {
  pm: `You are a product manager. You pull fuzzy ideas into shape.

How you work:
- Start by understanding the user, not the solution. Audience comes before features; features come before implementation.
- Treat the initial request as a starting prompt, not a spec. Ask the smallest set of sharp questions that will let you write a brief no one needs to follow up on. Stop asking when the marginal question stops changing the brief.
- Once the brief is clear, write it down. Then write a runbook: the project-specific conventions (workspace layout, file naming, handoff protocol, definition of done) your specialists will need to coordinate without further questions from you.
- Decompose work into the smallest number of tasks that respect real dependencies. Route each task to the specialist whose description fits best. Encode dependencies as parent/child links on the board so the dispatcher releases work at the right moment.
- Stay available. When a specialist blocks for input, answer fast and unblock. You are the arbiter of ambiguity: never punt a question back without a decision.
- Judge the result against the brief, not against what feels finished.

What you do not do:
- You do not write code. You do not write copy. You do not touch implementation files.
- You do not invent answers when the user can tell you. Ask.
- You do not let a specialist drift into another specialist's lane.`,
  backend: `You are a backend engineer. You build the server side of products.

How you work:
- Read the brief and the runbook before touching code. If the runbook tells you where to put files, what stack to use, or what contract to produce for the frontend, follow it.
- Design the data model first. Keep it small and obvious.
- Design the API surface second. Names matter. A good endpoint name tells the frontend engineer everything they need without asking.
- Implement third. Write the minimum code that satisfies the brief, not the most.
- Leave a contract document the frontend can build against without follow-up questions. The runbook tells you the format and location.
- Verify what you can locally. Don't claim "done" without evidence.

What you do not do:
- You do not design the UI. You do not write marketing copy. You do not make product scope decisions; those belong to the PM.
- You do not start long-running servers or processes. You leave those to the user.`,
  frontend: `You are a frontend engineer with strong design sensibilities.

How you work:
- Translate audience and tone into concrete visual decisions: palette, typography, layout density, copy register, motion.
- Refuse to start building until the audience and the vibe are explicit. If the brief leaves them implicit, post your reading and your proposed direction as a comment on your task and block for confirmation from the PM. Do not guess.
- Once direction is confirmed, build. Consume the backend's contract document as your source of truth for API calls; do not invent endpoints.
- Match the runbook's conventions for stack, file location, and structure.
- Treat the UI as the product's first impression. A correct page that feels wrong to the audience is a failure.

What you do not do:
- You do not redesign the API. You do not change product scope. If the backend's contract makes the UI awkward, comment on the relevant task; do not work around it silently.`,
  gtm: `You are a technical writer and launch marketer.

How you work:
- Read what was actually built: the brief, the code, the UI, the inter-agent conversations on the board. Write from evidence, not from a template.
- Adapt register precisely to the named audience. Engineers want architecture, trade-offs, and honest gotchas. End users want the problem and the relief. Never write for both in the same piece.
- Make every paragraph earn its place. Cut anything the audience already knows.
- The runbook tells you which artifacts to produce, where to put them, and the rough length budget. Honor it.

What you do not do:
- You do not write code. You do not change the product. You do not paper over gaps the brief or the code reveal; surface them in a comment and let the PM decide.`,
};

/** This demo's one rule on top of the SOULs: it runs in a browser, so deliverables are short files and nothing executes. */
export const SIM_NOTE =
  "This run is a short simulation: keep every file you write under 40 lines (an outline or a stub is fine), and finish each task in a few tool calls. Nothing you write is executed.";

export const ONE_LINE_BRIEF =
  "build me a habit tracker app with a fabulous UI/UX that is reminiscent of Steve Jobs in the 90s. I want the backend to be scalable to a billion users. The GTM should include 2 blogs and a launch post. As a PM, you decide what the brief is and how to decompose it into specific details for the other agents.";

const str = (description: string) => ({ type: "string", description });

const T = {
  clarify: {
    name: "clarify",
    description: "Ask the user one multiple-choice question (they can also answer in their own words). Use it before writing the brief.",
    parameters: {
      type: "object",
      properties: { question: str("One sharp question"), options: { type: "array", items: { type: "string" }, description: "2 to 4 short answers" } },
      required: ["question", "options"],
      additionalProperties: false,
    },
  },
  write_file: {
    name: "write_file",
    description: "Write a file in the project workspace (relative path).",
    parameters: { type: "object", properties: { path: str("Relative path"), content: str("The whole file") }, required: ["path", "content"], additionalProperties: false },
  },
  read_file: {
    name: "read_file",
    description: "Read a file from the project workspace: brief.md, runbook.md, or another profile's deliverable.",
    parameters: { type: "object", properties: { path: str("Relative path") }, required: ["path"], additionalProperties: false },
  },
  kanban_create: {
    name: "kanban_create",
    description: "Create a task on the Kanban board. The dispatcher releases it when every parent task is done and the assignee is idle.",
    parameters: {
      type: "object",
      properties: {
        title: str("Short task title"),
        assignee: { type: "string", enum: ["backend", "frontend", "gtm"] },
        description: str("Deliverables, file paths and acceptance criteria"),
        parent_ids: { type: "array", items: { type: "string" }, description: "Task ids that must finish first (from earlier kanban_create results)" },
      },
      required: ["title", "assignee", "description", "parent_ids"],
      additionalProperties: false,
    },
  },
  kanban_comment: {
    name: "kanban_comment",
    description: "Post a comment on a task. Every cross-role decision goes here.",
    parameters: { type: "object", properties: { task_id: str("Task id"), body: str("The comment") }, required: ["task_id", "body"], additionalProperties: false },
  },
  kanban_unblock: {
    name: "kanban_unblock",
    description: "Return a blocked task to ready after you answered it.",
    parameters: { type: "object", properties: { task_id: str("Task id") }, required: ["task_id"], additionalProperties: false },
  },
  kanban_block: {
    name: "kanban_block",
    description: "Pause your task and ask the PM for a decision (kind needs_input). Stop working after you call it.",
    parameters: {
      type: "object",
      properties: { task_id: str("Your task id"), kind: { type: "string", enum: ["needs_input"] }, question: str("Your reading, your proposed direction, and the decision you need") },
      required: ["task_id", "kind", "question"],
      additionalProperties: false,
    },
  },
  kanban_complete: {
    name: "kanban_complete",
    description: "Mark your task done with a summary of what you produced and where.",
    parameters: { type: "object", properties: { task_id: str("Your task id"), summary: str("What you produced, with file paths") }, required: ["task_id", "summary"], additionalProperties: false },
  },
} satisfies Record<string, FnToolDef>;

export const TOOLS_FOR: Record<Profile, FnToolDef[]> = {
  pm: [T.clarify, T.write_file, T.read_file, T.kanban_create, T.kanban_comment, T.kanban_unblock],
  backend: [T.read_file, T.write_file, T.kanban_comment, T.kanban_block, T.kanban_complete],
  frontend: [T.read_file, T.write_file, T.kanban_comment, T.kanban_block, T.kanban_complete],
  gtm: [T.read_file, T.write_file, T.kanban_comment, T.kanban_block, T.kanban_complete],
};

export function instructionsFor(p: Profile): string {
  return `${SOULS[p]}\n\nYour profile: ${p}. ${DESCRIPTIONS[p]}\nYour toolsets: ${TOOLSETS[p].join(", ")}.\n\n${SIM_NOTE}`;
}

/** The ids tasks get, in order: T1, T2, ... */
export function nextTaskId(board: Board): string {
  return `T${board.tasks.length + 1}`;
}

export function createTask(board: Board, t: { title: string; assignee: Profile; description: string; parents: string[] }): { board: Board; task: Task } {
  const known = new Set(board.tasks.map((x) => x.id));
  const task: Task = { id: nextTaskId(board), ...t, parents: t.parents.filter((p) => known.has(p)), status: "ready", comments: [], events: ["created in ready"] };
  return { board: { ...board, tasks: [...board.tasks, task] }, task };
}

export function updateTask(board: Board, id: string, patch: (t: Task) => Task): Board {
  return { ...board, tasks: board.tasks.map((t) => (t.id === id ? patch(t) : t)) };
}

/** The dispatcher's pick: the first ready task whose parents are all done and whose assignee isn't running another. */
export function nextRunnable(board: Board): Task | null {
  const busy = new Set(board.tasks.filter((t) => t.status === "running").map((t) => t.assignee));
  const done = new Set(board.tasks.filter((t) => t.status === "done").map((t) => t.id));
  return board.tasks.find((t) => t.status === "ready" && !busy.has(t.assignee) && t.parents.every((p) => done.has(p))) ?? null;
}

/** What a specialist reads when the dispatcher spawns it: its task, the thread so far, and where the files are. */
export function spawnPrompt(task: Task, board: Board): string {
  const thread = task.comments.length ? `\n\nComments on ${task.id} so far:\n${task.comments.map((c) => `- ${c.author}: ${c.body}`).join("\n")}` : "";
  const parents = task.parents.length
    ? `\n\nParent tasks (done): ${task.parents
        .map((p) => {
          const pt = board.tasks.find((t) => t.id === p);
          const summary = pt?.comments.filter((c) => c.kind === "complete").pop()?.body;
          return `${p} ${pt?.title ?? ""}${summary ? `: ${summary}` : ""}`;
        })
        .join("; ")}`
    : "";
  return `You are assigned task ${task.id}: ${task.title}\n\n${task.description}${parents}${thread}\n\nWorkspace files: ${Object.keys(board.files).join(", ") || "(none yet)"}. Read brief.md and runbook.md first. Finish with kanban_complete, or kanban_block if you need a decision.`;
}

/** The runbook check from the recipe: it exists and its Do NOT section actually says no. */
export function runbookCheck(files: Record<string, string>): { hasBrief: boolean; hasRunbook: boolean; doNot: boolean } {
  const runbook = files["runbook.md"] ?? "";
  const section = /^#{1,3}\s*Do NOT\b[^\n]*\n([\s\S]*?)(?=^#{1,3}\s|$(?![\s\S]))/im.exec(runbook);
  return { hasBrief: !!files["brief.md"]?.trim(), hasRunbook: !!runbook.trim(), doNot: !!section && /\b(no|not|never|don't|do not)\b/i.test(section[1]) };
}

/** Workspace files the PM may write: markdown at the root (brief, runbook, notes), never implementation files. */
export function pmMayWrite(path: string): boolean {
  return /^[\w.-]+\.md$/.test(path);
}
