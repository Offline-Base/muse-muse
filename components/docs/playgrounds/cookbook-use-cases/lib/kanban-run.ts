import type { AgentDef, LoopOptions, LoopResult, ToolOutcome } from "@/components/docs/playgrounds/cookbook-use-cases/lib/agent";
import { parseArguments, type FnCall } from "@/components/docs/playgrounds/cookbook-use-cases/lib/responses";
import { createTask, nextRunnable, pmMayWrite, runbookCheck, spawnPrompt, updateTask, type Board, type Profile } from "@/components/docs/playgrounds/cookbook-use-cases/lib/kanban";

/**
 * The multi-agent run as a script over a runtime, so the page (useAgentRun) and a test harness drive the same logic:
 * the PM's kickoff, the dispatcher's loop (answer blocks first, then release the next runnable task, then the PM's
 * review with at most one rework round), and what each Kanban and file tool does to the board.
 */

type Tone = "info" | "good" | "bad" | "warn";

export interface BoardRuntime {
  run(agent: AgentDef, input: string, depth?: number, opts?: LoopOptions): Promise<LoopResult>;
  note(text: string, tone?: Tone, agent?: string, depth?: number): void;
  ask(agent: string, prompt: string, options: Array<{ value: string; label: string }>, opts?: { title?: string; allowText?: boolean; textLabel?: string }): Promise<string | null>;
  stopped(): boolean;
}

export interface BoardHost {
  board(): Board;
  commit(b: Board): void;
  /** The task each profile is working on, so block and complete can find it without an id. */
  current: Partial<Record<Profile, string>>;
}

export const PM_KICKOFF =
  "Start with clarify (the smallest set of sharp questions, at most three). When the brief is clear, write brief.md and runbook.md (stack, workspace layout, the API contract location, the handoff protocol, the definition of done, and a ## Do NOT section), then create one task per workstream with kanban_create, linking real dependencies with parent_ids. Reply with a one-line status when the board is set up.";

export const PM_REVIEW =
  "Every task is done. Judge the result against the brief: read the deliverables you need. If one is below bar, create ONE rework task for the same assignee whose description lists the specific defects (files, what to fix) with parent_ids pointing at the reviewed task. Otherwise reply with your final message, referencing the brief's acceptance criteria.";

/** What the board's tools do. Returns the outcome for the model, after updating the board through the host. */
export async function boardTool(host: BoardHost, agent: AgentDef, call: FnCall, rt: BoardRuntime): Promise<ToolOutcome> {
  const { value: a, error } = parseArguments(call.arguments);
  if (error) return { output: error, status: "error" };
  const who = agent.name as Profile;
  const b = host.board();
  const taskId = String(a.task_id ?? "");
  const task = b.tasks.find((t) => t.id === taskId);
  switch (call.name) {
    case "clarify": {
      const options = (Array.isArray(a.options) ? a.options : []).slice(0, 4).map(String);
      const answer = await rt.ask("pm", String(a.question ?? ""), options.map((o) => ({ value: o, label: o })), { title: "clarify", allowText: true, textLabel: "Other: answer in your own words" });
      return answer === null ? { output: "No answer (the run was stopped).", status: "error" } : { output: `The user answered: ${answer}`, note: "your answer" };
    }
    case "write_file": {
      const path = String(a.path ?? "").replace(/^\.?\//, "");
      if (who === "pm" && !pmMayWrite(path)) return { output: `Denied: the pm profile has no terminal or code toolsets and may not write implementation files (${path}).`, status: "denied" };
      const content = String(a.content ?? "");
      host.commit({ ...b, files: { ...b.files, [path]: content } });
      return { output: `Wrote ${path} (${content.split("\n").length} lines).` };
    }
    case "read_file": {
      const path = String(a.path ?? "").replace(/^\.?\//, "");
      const text = b.files[path];
      return text === undefined ? { output: `No such file: ${path}. Files: ${Object.keys(b.files).join(", ") || "none"}.`, status: "error" } : { output: text };
    }
    case "kanban_create": {
      const assignee = String(a.assignee ?? "") as Profile;
      if (!["backend", "frontend", "gtm"].includes(assignee)) return { output: `Unknown assignee ${assignee}: the dispatcher would skip it.`, status: "error" };
      const r = createTask(b, { title: String(a.title ?? "Task"), assignee, description: String(a.description ?? ""), parents: Array.isArray(a.parent_ids) ? a.parent_ids.map(String) : [] });
      host.commit(r.board);
      rt.note(`Board: ${r.task.id} "${r.task.title}" created for ${assignee}${r.task.parents.length ? `, after ${r.task.parents.join(", ")}` : ""}.`, "info", "pm");
      return { output: JSON.stringify({ id: r.task.id, status: "ready", parent_ids: r.task.parents }) };
    }
    case "kanban_comment": {
      if (!task) return { output: `No task ${taskId}.`, status: "error" };
      host.commit(updateTask(b, taskId, (t) => ({ ...t, comments: [...t.comments, { author: who, body: String(a.body ?? ""), kind: "comment" }], events: [...t.events, `comment by ${who}`] })));
      return { output: `Commented on ${taskId}.` };
    }
    case "kanban_unblock": {
      if (!task) return { output: `No task ${taskId}.`, status: "error" };
      if (task.status !== "blocked") return { output: `${taskId} isn't blocked (it's ${task.status}).`, status: "error" };
      host.commit(updateTask(b, taskId, (t) => ({ ...t, status: "ready", comments: [...t.comments, { author: who, body: "unblocked", kind: "unblock" }], events: [...t.events, "unblocked, back to ready"] })));
      return { output: `${taskId} is ready again; the dispatcher will release it.` };
    }
    case "kanban_block": {
      const target = task ?? b.tasks.find((t) => t.id === host.current[who]);
      if (!target) return { output: `No task ${taskId}.`, status: "error" };
      host.commit(updateTask(b, target.id, (t) => ({ ...t, status: "blocked", comments: [...t.comments, { author: who, body: String(a.question ?? ""), kind: "block" }], events: [...t.events, "blocked: needs_input"] })));
      rt.note(`${target.id} blocked by ${who}: needs_input.`, "warn", who, 1);
      return { output: "Blocked. Stop working now; the PM will answer on the task and unblock it." };
    }
    case "kanban_complete": {
      const target = task ?? b.tasks.find((t) => t.id === host.current[who]);
      if (!target) return { output: `No task ${taskId}.`, status: "error" };
      host.commit(updateTask(b, target.id, (t) => ({ ...t, status: "done", comments: [...t.comments, { author: who, body: String(a.summary ?? ""), kind: "complete" }], events: [...t.events, "kanban_complete"] })));
      return { output: `${target.id} is done. Stop now.` };
    }
  }
  return { output: `Unknown tool ${call.name}.`, status: "error" };
}

/** The whole run: kickoff, the dispatcher loop, the PM's review. */
export async function orchestrate(rt: BoardRuntime, host: BoardHost, cfg: { brief: string; def(p: Profile): AgentDef; maxTicks?: number }): Promise<void> {
  // The PM keeps one chat session across the run: the next call continues its history (replay) or its chain.
  let pmHistory: Record<string, unknown>[] | null = null;
  let pmChain: string | null = null;
  const runPm = async (input: string) => {
    const r = await rt.run(cfg.def("pm"), input, 0, { previousResponseId: pmChain, history: pmHistory });
    if (r.history) pmHistory = r.history;
    else if (typeof r.response?.id === "string") pmChain = r.response.id;
    return r;
  };
  rt.note("hermes gateway: running. The Kanban dispatcher lives in the gateway; without it tasks sit in ready forever.");
  await runPm(`${cfg.brief.trim()}\n\n${PM_KICKOFF}`);
  if (rt.stopped()) return;
  const check = runbookCheck(host.board().files);
  rt.note(
    `Step 2 check: brief.md ${check.hasBrief ? "written" : "missing"}, runbook.md ${check.hasRunbook ? "written" : "missing"}, Do NOT section ${check.doNot ? "says no" : "missing or empty"}.`,
    check.hasBrief && check.hasRunbook && check.doNot ? "good" : "warn",
  );
  if (!host.board().tasks.length) return rt.note("The PM created no tasks, so there is nothing to dispatch.", "warn");
  let rework = 0;
  const attempts = new Map<string, number>();
  for (let tick = 0; tick < (cfg.maxTicks ?? 16) && !rt.stopped(); tick++) {
    const blocked = host.board().tasks.find((t) => t.status === "blocked");
    if (blocked) {
      const q = blocked.comments.filter((c) => c.kind === "block").pop()?.body ?? "";
      rt.note(`Dispatcher: ${blocked.id} is blocked; asking the PM to decide.`);
      await runPm(`Task ${blocked.id} (${blocked.assignee}, "${blocked.title}") is blocked with needs_input:\n"${q}"\nDecide: answer with kanban_comment on ${blocked.id}, then kanban_unblock it.`);
      if (host.board().tasks.find((t) => t.id === blocked.id)?.status === "blocked") {
        host.commit(updateTask(host.board(), blocked.id, (t) => ({ ...t, status: "ready", events: [...t.events, "unblocked by the dispatcher (the PM didn't)"] })));
        rt.note(`The PM didn't unblock ${blocked.id}; returning it to ready so the run can go on.`, "warn");
      }
      continue;
    }
    const next = nextRunnable(host.board());
    if (!next) {
      const open = host.board().tasks.filter((t) => t.status !== "done");
      if (open.length) {
        rt.note(`Nothing can run: ${open.map((t) => `${t.id} waits on ${t.parents.join(", ") || "nothing"}`).join("; ")}.`, "warn");
        break;
      }
      if (rework >= 1) break;
      rework++;
      const before = host.board().tasks.length;
      rt.note("Every task is done. The PM judges the result against the brief.");
      await runPm(PM_REVIEW);
      if (host.board().tasks.length === before) break;
      continue;
    }
    attempts.set(next.id, (attempts.get(next.id) ?? 0) + 1);
    host.commit(updateTask(host.board(), next.id, (t) => ({ ...t, status: "running", events: [...t.events, `claimed by ${t.assignee}`] })));
    host.current[next.assignee] = next.id;
    rt.note(`Dispatcher: ${next.id} "${next.title}" moves to In progress under ${next.assignee}.`, "info", next.assignee, 1);
    const res = await rt.run(cfg.def(next.assignee), spawnPrompt(next, host.board()), 1);
    if (host.board().tasks.find((t) => t.id === next.id)?.status === "running") {
      // A worker that exits without kanban_complete is done when it answered; one that ran out of calls gets one more
      // try, then the task is closed with a note, so a run always ends.
      const giveUp = res.stoppedBy !== "answer" && (attempts.get(next.id) ?? 0) >= 2;
      host.commit(
        updateTask(host.board(), next.id, (t) => ({
          ...t,
          status: res.stoppedBy === "answer" || giveUp ? "done" : "ready",
          comments: res.text ? [...t.comments, { author: t.assignee, body: res.text, kind: "complete" }] : t.comments,
          events: [
            ...t.events,
            res.stoppedBy === "answer"
              ? "worker exited without kanban_complete; summary taken from its last message"
              : giveUp
                ? `closed after two tries that ended at the call limit (${res.stoppedBy})`
                : `worker stopped (${res.stoppedBy}); back to ready for one more try`,
          ],
        })),
      );
      if (giveUp) rt.note(`${next.id} closed after two tries without kanban_complete.`, "warn", next.assignee, 1);
    }
  }
  const all = host.board().tasks;
  const done = all.filter((t) => t.status === "done");
  rt.note(`${done.length} of ${all.length} tasks done; each done task has its summary in its drawer.`, done.length === all.length ? "good" : "warn");
}
