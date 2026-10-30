/**
 * The subagent fanout contract (cookbook/subagent-fanout) as a board the reader can drive: one write-capable child per
 * task, each in its own git worktree under .muse/worktrees/ at the parent's HEAD, run up to a concurrency limit of
 * roughly cores - 2 clamped to 4 to 8, extra spawns queued in submission order. The parent steers a child with
 * subagent_send_message (a queued message lands on the child's next turn, an interrupt preempts the current one) and
 * stops one with subagent_cancel, which is cooperative. Time moves one turn per tick, so the recipe's timing failures
 * (a steer that arrives too late, a cancel after the result) can be reproduced on purpose.
 */

export interface PlannedTask {
  id: string;
  role: string;
  objective: string;
  /** Files the task expects to touch, for spotting merge overlaps. */
  files: string[];
  /** How the child proves it's done, run in its own worktree. */
  verify: string;
}

export interface FanoutPlan {
  tasks: PlannedTask[];
  /** Task ids in the order the parent should merge the children's commits. */
  merge_order: string[];
  notes?: string;
}

export type ChildState = "queued" | "running" | "result_ready" | "closing" | "cancelled" | "rejected";

export interface Steer {
  message: string;
  mode: "queue" | "interrupt";
  status: "queued" | "delivered" | "too_late" | "not_delivered";
}

export interface Child {
  id: string;
  task: PlannedTask;
  state: ChildState;
  turns: number;
  turnsNeeded: number;
  worktree: string | null;
  steers: Steer[];
  cancel: { reason: string; outcome: "accepted" | "already_terminal" } | null;
  /** Worktree lifecycle and status changes, as the session log records them. */
  events: string[];
  note: string | null;
}

export interface Board {
  children: Child[];
  limit: number;
  isolation: boolean;
  tick: number;
  baseCommit: string;
}

export function concurrencyLimit(cores: number): number {
  return Math.min(8, Math.max(4, Math.round(cores) - 2));
}

/** The rejection a spawn with worktree_isolation gets on a launch without --subagent-worktree-isolation. */
export const ISOLATION_REJECTION = {
  status: "rejected",
  reason: "worktree_isolation_unavailable",
  cause: "isolation_not_enabled_in_profile",
};

/** The subagent_spawn call the parent makes for a task. */
export function spawnCall(task: PlannedTask): Record<string, unknown> {
  return { role: task.role, objective: task.objective, worktree_isolation: true };
}

function worktreeFor(n: number): string {
  return `.muse/worktrees/subagent-v2-...-subagent-${n}`;
}

const LIFECYCLE = ["operation_requested", "prepared", "lease_active", "workspace_scope_activated"];

function start(child: Child, board: Pick<Board, "baseCommit">): Child {
  return {
    ...child,
    state: "running",
    events: [...child.events, ...LIFECYCLE.map((e) => `worktree ${e} (base_commit ${board.baseCommit}, base_ref HEAD, cleanup_policy remove_if_clean)`), "state: running"],
  };
}

/** A small, stable amount of work per task, so the board plays out the same way every time. */
function workFor(task: PlannedTask, index: number): number {
  return 2 + ((task.objective.length + index) % 3);
}

/** Spawns one child per task. Up to the limit start now; the rest are admitted and queue in submission order. */
export function spawnAll(plan: FanoutPlan, opts: { cores: number; isolation: boolean; baseCommit?: string }): Board {
  const limit = concurrencyLimit(opts.cores);
  const baseCommit = opts.baseCommit ?? "e426b70";
  const children = plan.tasks.map((task, i): Child => {
    const base: Child = {
      id: `subagent-${i + 1}`,
      task,
      state: "queued",
      turns: 0,
      turnsNeeded: workFor(task, i),
      worktree: null,
      steers: [],
      cancel: null,
      events: [],
      note: null,
    };
    if (!opts.isolation) {
      return { ...base, state: "rejected", events: [`spawn rejected: ${JSON.stringify(ISOLATION_REJECTION)}`], note: "Spawn rejected: isolation is off for this profile." };
    }
    const admitted: Child = { ...base, worktree: worktreeFor(i + 1), events: ["spawn admitted"] };
    return i < limit ? start(admitted, { baseCommit }) : { ...admitted, events: [...admitted.events, "state: queued (concurrency limit)"] };
  });
  return { children, limit, isolation: opts.isolation, tick: 0, baseCommit };
}

/** One turn of time: running children work, queued steers land, cooperative cancels settle, free slots admit the queue. */
export function tick(board: Board): Board {
  let children = board.children.map((c): Child => {
    if (c.state === "closing") {
      // Cooperative: a child already writing its result may still finish that write.
      if (c.turnsNeeded - c.turns <= 1) {
        return { ...c, state: "result_ready", turns: c.turnsNeeded, events: [...c.events, "finished its last write before the cancel took effect", "state: result_ready"], note: "Cancel is cooperative: it finished the write it was in." };
      }
      return { ...c, state: "cancelled", events: [...c.events, `state: cancelled (${c.cancel?.reason ?? "cancelled"})`] };
    }
    if (c.state !== "running") return c;
    const turns = c.turns + 1;
    const finishing = turns >= c.turnsNeeded;
    const steers = c.steers.map((s): Steer => (s.status === "queued" ? { ...s, status: finishing ? "too_late" : "delivered" } : s));
    const landed = steers.filter((s, i) => s.status !== c.steers[i]?.status);
    const events = [
      ...c.events,
      ...landed.map((s) => (s.status === "too_late" ? `queued steer never applied: the child finished first ("${s.message}")` : `queued steer delivered on turn ${turns} ("${s.message}")`)),
      ...(finishing ? ["state: result_ready (the result drains to the parent when it is idle)"] : [`turn ${turns} of ${c.turnsNeeded}`]),
    ];
    return { ...c, turns, steers, state: finishing ? "result_ready" : "running", events };
  });
  // Free slots admit queued children in submission order.
  let running = children.filter((c) => c.state === "running" || c.state === "closing").length;
  children = children.map((c) => {
    if (c.state !== "queued" || running >= board.limit || c.cancel) return c;
    running++;
    return start(c, board);
  });
  return { ...board, children, tick: board.tick + 1 };
}

function update(board: Board, id: string, fn: (c: Child) => Child): Board {
  return { ...board, children: board.children.map((c) => (c.id === id ? fn(c) : c)) };
}

/** subagent_send_message: queue a message for the child's next turn, or interrupt its current turn. */
export function steer(board: Board, id: string, message: string, mode: "queue" | "interrupt"): Board {
  return update(board, id, (c) => {
    if (c.state === "result_ready" || c.state === "cancelled" || c.state === "rejected") {
      return { ...c, steers: [...c.steers, { message, mode, status: "not_delivered" }], events: [...c.events, `steer not delivered: the child is ${c.state}`] };
    }
    if (mode === "interrupt" && c.state === "running") {
      // An interrupt preempts the turn in progress, so the child redoes it with the new direction.
      return {
        ...c,
        turnsNeeded: c.turnsNeeded + 1,
        steers: [...c.steers, { message, mode, status: "delivered" }],
        events: [...c.events, `interrupt delivered: the current turn was preempted ("${message}")`],
      };
    }
    return { ...c, steers: [...c.steers, { message, mode, status: "queued" }], events: [...c.events, `steer accepted: message queued (delivery mode ${mode === "queue" ? "queue, non-interrupting" : "interrupt, waiting for the child to start"})`] };
  });
}

/** subagent_cancel: cooperative. A finished child only records the reason (already_terminal). */
export function cancel(board: Board, id: string, reason: string): Board {
  return update(board, id, (c) => {
    if (c.state === "result_ready" || c.state === "cancelled" || c.state === "rejected") {
      return { ...c, cancel: { reason, outcome: "already_terminal" }, events: [...c.events, JSON.stringify({ kind: "cancel_outcome", subagent_id: c.id, outcome: "already_terminal", reason })] };
    }
    if (c.state === "queued") {
      return { ...c, state: "cancelled", cancel: { reason, outcome: "accepted" }, events: [...c.events, `cancel accepted before it started (${reason})`] };
    }
    return { ...c, state: "closing", cancel: { reason, outcome: "accepted" }, events: [...c.events, `cancel accepted: state closing (${reason})`] };
  });
}

/** What subagent_status returns: each child's state and task. */
export function statusOf(board: Board): Array<Record<string, unknown>> {
  return board.children.map((c) => ({ subagent_id: c.id, state: c.state, task: c.task.objective, ...(c.worktree ? { worktree: c.worktree } : {}) }));
}

/** Pairs of tasks that expect to touch the same file: isolated while running, but they meet at merge time. */
export function overlaps(tasks: readonly PlannedTask[]): Array<{ a: string; b: string; files: string[] }> {
  const out: Array<{ a: string; b: string; files: string[] }> = [];
  for (let i = 0; i < tasks.length; i++) {
    for (let j = i + 1; j < tasks.length; j++) {
      const shared = tasks[i].files.filter((f) => tasks[j].files.includes(f));
      if (shared.length) out.push({ a: tasks[i].id, b: tasks[j].id, files: shared });
    }
  }
  return out;
}

/** Problems with a plan's merge order: ids it misses, repeats or doesn't know. */
export function mergeOrderProblems(plan: FanoutPlan): string[] {
  const ids = plan.tasks.map((t) => t.id);
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const id of plan.merge_order) {
    if (!ids.includes(id)) problems.push(`merge_order names ${id}, which isn't a task`);
    if (seen.has(id)) problems.push(`merge_order lists ${id} twice`);
    seen.add(id);
  }
  for (const id of ids) if (!seen.has(id)) problems.push(`merge_order leaves out ${id}`);
  if (new Set(ids).size !== ids.length) problems.push("two tasks share an id");
  return problems;
}

/** The recipe's Bastion Breaker batch, as a plan, for the board before the model has planned anything. */
export const BASTION_PLAN: FanoutPlan = {
  tasks: [
    { id: "fix-enemy-laser", role: "bug fixer", objective: "Fix the bug where enemy lasers destroy bricks (game/engine.py _resolve_laser)", files: ["game/engine.py"], verify: "SDL_VIDEODRIVER=dummy python3 -m pytest tests/ -q" },
    { id: "high-score", role: "feature builder", objective: "Add high-score persistence", files: ["game/engine.py", "game/storage.py"], verify: "SDL_VIDEODRIVER=dummy python3 -m pytest tests/ -q" },
    { id: "brick-colors", role: "feature builder", objective: "Make bricks multi-colored by row from assets/bricks/*.png", files: ["game/render.py"], verify: "SDL_VIDEODRIVER=dummy python3 -m pytest tests/ -q" },
    { id: "shatter-fx", role: "feature builder", objective: "Add a brick-shatter particle effect", files: ["game/render.py", "game/effects.py"], verify: "SDL_VIDEODRIVER=dummy python3 -m pytest tests/ -q" },
    { id: "combo", role: "feature builder", objective: "Add a combo multiplier", files: ["game/engine.py"], verify: "SDL_VIDEODRIVER=dummy python3 -m pytest tests/ -q" },
    { id: "power-up", role: "feature builder", objective: "Add a power-up drop from a broken brick", files: ["game/engine.py", "game/render.py"], verify: "SDL_VIDEODRIVER=dummy python3 -m pytest tests/ -q" },
  ],
  merge_order: ["fix-enemy-laser", "brick-colors", "shatter-fx", "high-score", "combo", "power-up"],
  notes: "The recipe's six tasks. The files each touches are this demo's guess, for the overlap check.",
};
