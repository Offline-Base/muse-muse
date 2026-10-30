/**
 * Rewind as data (content/meta-docs/pages/muse-code/rewind.md): a conversation is a tree of branches; rewinding to an
 * earlier input makes a child branch whose context is everything before that input and whose composer holds the input
 * as an unsent draft, while the source branch keeps every turn. On the Model API the same move is
 * previous_response_id pointing at the response before the chosen input, which the live demo uses. The picker rules
 * (Exact, Review required, Blocked, and the inputs that are never rewind points) are here too.
 */

export interface Turn {
  input: string;
  reply: string;
  /** The stored response this turn produced, which the next turn chains from. */
  responseId: string;
}

export interface Branch {
  id: string;
  label: string;
  /**
   * Where this branch came from: the source branch, how many of its context turns it keeps, and how many the source
   * had at the time (its scrollback stays visible above the divider, but only the kept turns enter this context).
   */
  parent: { branch: string; keep: number; seen: number } | null;
  turns: Turn[];
  /** The restored input, waiting in the composer. */
  draft: string | null;
}

export interface Tree {
  branches: Branch[];
}

export function newTree(): Tree {
  return { branches: [{ id: "b0", label: "Original conversation", parent: null, turns: [], draft: null }] };
}

function find(tree: Tree, id: string): Branch {
  const b = tree.branches.find((x) => x.id === id);
  if (!b) throw new Error(`No branch ${id}`);
  return b;
}

/** Every turn the branch's model context holds, inherited ones first. */
export function contextOf(tree: Tree, id: string): Array<Turn & { inherited: boolean }> {
  const b = find(tree, id);
  const inherited = b.parent ? contextOf(tree, b.parent.branch).slice(0, b.parent.keep).map((t) => ({ ...t, inherited: true })) : [];
  return [...inherited, ...b.turns.map((t) => ({ ...t, inherited: false }))];
}

/** The response the branch's next turn continues from (previous_response_id), or null for a fresh start. */
export function previousIdFor(tree: Tree, id: string): string | null {
  const ctx = contextOf(tree, id);
  return ctx.length ? ctx[ctx.length - 1].responseId : null;
}

export function addTurn(tree: Tree, id: string, turn: Turn): Tree {
  return { branches: tree.branches.map((b) => (b.id === id ? { ...b, turns: [...b.turns, turn], draft: null } : b)) };
}

export function setDraft(tree: Tree, id: string, draft: string | null): Tree {
  return { branches: tree.branches.map((b) => (b.id === id ? { ...b, draft } : b)) };
}

/**
 * Rewinds branch `id` to the input at `index` in its context: a new branch keeps the turns before it, and the input
 * comes back as the draft. The source branch is untouched. Returns the new tree and the new branch's id.
 */
export function rewindTo(tree: Tree, id: string, index: number): { tree: Tree; branch: string } {
  const ctx = contextOf(tree, id);
  if (index < 0 || index >= ctx.length) throw new Error(`No input ${index} to rewind to`);
  const n = tree.branches.length;
  const branch: Branch = {
    id: `b${n}`,
    label: `Branch ${n}: rewound to message ${index + 1}`,
    parent: { branch: id, keep: index, seen: ctx.length },
    turns: [],
    draft: ctx[index].input,
  };
  return { tree: { branches: [...tree.branches, branch] }, branch: branch.id };
}

/** The source's scrollback a child branch shows above its divider, each turn marked in or out of the child's context. */
export function scrollbackOf(tree: Tree, id: string): Array<Turn & { inContext: boolean }> {
  const b = find(tree, id);
  if (!b.parent) return [];
  return contextOf(tree, b.parent.branch)
    .slice(0, b.parent.seen)
    .map((t, i) => ({ input: t.input, reply: t.reply, responseId: t.responseId, inContext: i < b.parent!.keep }));
}

/** A branch's inputs as one line, "A → B → C", for the branch list. */
export function pathOf(tree: Tree, id: string, letters = true): string {
  const ctx = contextOf(tree, id);
  const b = find(tree, id);
  const parts = ctx.map((t, i) => (letters ? short(t.input, i) : t.input));
  if (b.draft !== null) parts.push(`${short(b.draft, ctx.length)} (draft)`);
  return parts.join(" → ") || "(empty)";
}

function short(text: string, i: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return `${i + 1}. ${flat.length > 28 ? `${flat.slice(0, 26)}...` : flat}`;
}

// ---------------------------------------------------------------------------------------------------------------
// The picker's labels

export type Availability = "exact" | "review" | "blocked";

export interface PickerRow {
  text: string;
  label: Availability;
  /** What the action screen says (missing attachment, why it's blocked). */
  detail: string;
}

/** A sample retained session, oldest first, with one row for each label and reason the page lists. */
export const PICKER_SAMPLE: readonly PickerRow[] = [
  { text: "Summarize how requests flow through this service", label: "blocked", detail: "The point is older than retained history." },
  { text: "Add a token-bucket rate limiter to the API", label: "exact", detail: "Muse Code can recreate the branch and restore this input without known loss." },
  {
    text: "Match the design in [Image #1]",
    label: "review",
    detail: "Part of this input is unavailable: [Image #1] can't be found. Replace or remove the missing-content marker before you submit the restored draft.",
  },
  { text: "Keep going until the limiter ships with tests", label: "blocked", detail: "The conversation contains Goal history that can't cross this boundary." },
  { text: "Run the /check skill on the new middleware", label: "blocked", detail: "The original input or plugin binding can't be reconstructed safely." },
  { text: "Now cover the admin routes too", label: "exact", detail: "Muse Code can recreate the branch and restore this input without known loss." },
];

/** Inputs the picker never offers: rewind uses complete top-level turn boundaries. */
export const NOT_REWIND_POINTS: readonly string[] = [
  "Mid-turn steering (text sent with Enter while a turn ran)",
  "Pending queued input (Alt+Enter, not yet delivered)",
  "Local slash commands such as /name or /recap",
  "The turn that's still running",
];

export const AVAILABILITY_LABEL: Record<Availability, string> = { exact: "Exact", review: "Review required", blocked: "Blocked" };

/** The picker's keys: Up and Down (or Ctrl+P and Ctrl+N), Home and End. Returns the new index, or null for other keys. */
export function pickerMove(key: string, ctrl: boolean, index: number, count: number): number | null {
  if (!count) return null;
  if (key === "ArrowUp" || (ctrl && key.toLowerCase() === "p")) return Math.max(0, index - 1);
  if (key === "ArrowDown" || (ctrl && key.toLowerCase() === "n")) return Math.min(count - 1, index + 1);
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}
