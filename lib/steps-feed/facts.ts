import type { BuildEvent, MuseLogLine } from "@/lib/types";

/**
 * BUILD_ROOM_STEPS (docs/BUILD_ROOM_STEPS.md): the build room's feed of one-line steps, worked out from the build's real
 * events. The same pure function runs in the browser and in the summarizer, so every line stands for something in the
 * log. Contributor can only reword a step that already exists here, by its id, and it can never add one. Each step has
 * its own plain wording, so the feed reads fine with no model at all. No path, tool name or agent prose reaches a line.
 */

export type StepTone = "plain" | "good" | "bad";

export interface FeedStep {
  /** The first event and line it came from, so it stays the same however often the log is read. */
  id: string;
  /** The line to show: Contributor's words once they're in, else `plain`. */
  text: string;
  plain: string;
  /** What it was about, for the plain recap. */
  noun: string;
  tone: StepTone;
  /** The build's own ending. Written from the status alone and never reworded. */
  final: boolean;
}

export interface FeedRecap {
  /** The id of the group's last step. */
  after: string;
  text: string;
  comment: string;
  /** The ids of the steps it sums up. */
  steps: string[];
  /** The plain wording of those steps, what the summarizer may build on. */
  plain: string[];
  tone: StepTone;
}

export type FeedRow = { type: "step"; step: FeedStep; running: boolean } | { type: "recap"; recap: FeedRecap };

export interface Feed {
  steps: FeedStep[];
  /** Every step with its recaps between them. */
  rows: FeedRow[];
  /** The steps that are over: all of them but a still running last one. */
  closed: FeedStep[];
  recaps: FeedRecap[];
  /** Ids Contributor has already worded. */
  wordedSteps: Set<string>;
  wordedRecaps: Set<string>;
  /** How many summaries were written. */
  batches: number;
  /** Publishing was off for this run, so it never went online whatever its status says. */
  unpublished: boolean;
}

/** A recap after every this many steps. */
export const RECAP_EVERY = 3;
/** A run of Muse Code's work under this long stays one step, so the feed moves at a pace a person can read. */
const MIN_STEP_MS = 40_000;

const STATUS_STEPS: Partial<Record<string, { plain: string; noun: string; tone?: StepTone; final?: boolean }>> = {
  briefing: { plain: "Reading what you asked for", noun: "your idea" },
  provisioning: { plain: "Setting up a little workspace", noun: "a workspace" },
  previewing: { plain: "Opening a first look", noun: "a first look" },
  verifying: { plain: "Trying everything out", noun: "a try-out" },
  fixing: { plain: "Fixing what the checks found", noun: "some fixes" },
  recording: { plain: "Recording a short demo", noun: "a demo" },
  deploying: { plain: "Putting it online", noun: "going online" },
  live: { plain: "It's online", noun: "the finished product", tone: "good", final: true },
  partial: { plain: "Part of it is online", noun: "the part that made it", tone: "good", final: true },
  failed: { plain: "The build stopped and did not ship", noun: "a stop", tone: "bad", final: true },
  refused: { plain: "This one can't be made", noun: "a no", tone: "bad", final: true },
};

/** The steps when publishing is off: the status still reads live, but nothing went online. */
const UNPUBLISHED_STEPS: Partial<Record<string, { plain: string; noun: string; tone?: StepTone; final?: boolean }>> = {
  deploying: { plain: "Saving the finished version", noun: "a saved version" },
  live: { plain: "It's finished, but not online", noun: "the finished product", tone: "good", final: true },
  partial: { plain: "Part of it is finished, but not online", noun: "the part that made it", tone: "good", final: true },
};

/** How the workflow's log line and ending say publishing was off (lib/pipeline/workflow.ts). feed.test.ts holds the two together. */
export const NOT_PUBLISHED = /didn't get its own link|without publishing to its own link/;

type Activity = "page" | "look" | "tests" | "behind" | "parts" | "files" | "run" | "read" | "helper" | "snag";

/** A word from a path that's safe to show: lower case letters and hyphens only. Anything else is no word at all. */
function pageWord(segment: string | undefined): string | null {
  if (!segment || !/^[a-z][a-z-]{1,20}$/.test(segment)) return null;
  if (/^(app|api|src|lib|components|public|pages|env|secret|secrets|token|tokens|key|keys|admin)$/.test(segment)) return null;
  return segment.replace(/-/g, " ");
}

/** What editing this file amounts to, from the backticked path in a line's text. Only ever a category, never the path. */
function fromPath(p: string): { activity: Activity; page?: string } {
  const path = p.toLowerCase();
  if (/(^|\/)\.env|(^|\/)(secret|credential)/.test(path)) return { activity: "files" };
  if (/(^|\/)(tests?|__tests__|e2e)\/|\.(test|spec)\.[a-z]+$/.test(path)) return { activity: "tests" };
  if (/\.(css|scss)$|tailwind|(^|\/)(fonts?|theme)/.test(path)) return { activity: "look" };
  if (/(^|\/)(package(-lock)?\.json|[a-z.-]*lock[a-z.]*)$/.test(path)) return { activity: "parts" };
  if (/(^|\/)page\.[a-z]+$/.test(path)) {
    const parts = path.split("/").slice(0, -1);
    const word = pageWord(parts.at(-1));
    if (word) return { activity: "page", page: word };
    return { activity: "page", ...(parts.length && parts.at(-1) === "app" ? { page: "home" } : {}) };
  }
  if (/(^|\/)(components?|layout)|\.(tsx|jsx|html)$/.test(path)) return { activity: "page" };
  if (/(^|\/)api\/|route\.[a-z]+$|(^|\/)(lib|server|db)\//.test(path)) return { activity: "behind" };
  return { activity: "files" };
}

function lineActivity(l: MuseLogLine): { activity: Activity; page?: string } | null {
  if (l.kind === "error") return { activity: "snag" };
  if (l.kind === "edit") return { activity: "files" };
  if (l.kind === "subagent" || l.kind === "workflow") return { activity: "helper" };
  if (l.kind === "status") return l.detail?.source ? { activity: "read" } : null;
  if (l.kind !== "tool") return null;
  if (l.detail?.source) return { activity: "read" };
  const path = /`([^`]+)`/.exec(l.text)?.[1];
  if (/edit|write|patch/i.test(l.tool ?? "") || /^(edited|wrote|created)\b/i.test(l.text)) return path ? fromPath(path) : { activity: "files" };
  if (/read|list|grep|glob|search|docs/i.test(l.tool ?? "")) return { activity: "read" };
  if (/bash|shell|exec|run/i.test(l.tool ?? "")) return /install|npm i\b|add .*package/i.test(l.text) ? { activity: "parts" } : { activity: "run" };
  return null;
}

/** How much each kind of work counts when one step holds several: making things says the most about a stretch of work. */
const WEIGHT: Record<Activity, number> = { page: 4, look: 4, tests: 3, behind: 3, parts: 3, files: 2, run: 1, read: 1, helper: 1, snag: 1 };

function activityWords(activity: Activity, page: string | undefined): { plain: string; noun: string; tone?: StepTone } {
  switch (activity) {
    case "page":
      return page ? { plain: `Drawing the ${page} page`, noun: `the ${page} page` } : { plain: "Drawing what you'll see on screen", noun: "the screens" };
    case "look":
      return { plain: "Picking the colors and letters", noun: "the look" };
    case "tests":
      return { plain: "Writing little tests", noun: "the tests" };
    case "behind":
      return { plain: "Building the behind-the-scenes parts", noun: "the behind-the-scenes parts" };
    case "parts":
      return { plain: "Getting the parts it needs", noun: "the parts it needs" };
    case "files":
      return { plain: "Putting pieces together", noun: "some pieces" };
    case "run":
      return { plain: "Trying a few things out", noun: "some tries" };
    case "read":
      return { plain: "Reading up on how to do it", noun: "some reading" };
    case "helper":
      return { plain: "Asking a helper to pitch in", noun: "a helper" };
    case "snag":
      return { plain: "Bumped into a snag", noun: "a snag", tone: "bad" };
  }
}

/** A stretch of Muse Code's work, growing as its lines come in. */
interface Run {
  id: string;
  startedAt: number;
  scores: Map<Activity, number>;
  pages: Map<string, number>;
  index: number;
}

/** Every edit also logs a bare "Edited 1 file" line, so "files" means something only when nothing says more. */
const SAYS_MORE: readonly Activity[] = ["page", "look", "tests", "behind", "parts"];

function runWords(run: Run): { plain: string; noun: string; tone?: StepTone } {
  let best: Activity = "files";
  let top = -1;
  const saysMore = SAYS_MORE.some((a) => run.scores.has(a));
  for (const [activity, score] of run.scores) {
    if (activity === "files" && saysMore) continue;
    if (score > top) {
      best = activity;
      top = score;
    }
  }
  const page = [...run.pages].sort((a, b) => b[1] - a[1])[0]?.[0];
  return activityWords(best, best === "page" ? page : undefined);
}

function dedupe<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

function joinNouns(nouns: string[]): string {
  const list = dedupe(nouns);
  if (list.length < 2) return list[0] ?? "";
  return `${list.slice(0, -1).join(", ")} and ${list.at(-1)}`;
}

function hash(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
  return Math.abs(h);
}

const PLAIN_COMMENTS = ["Busy little paws.", "One small piece at a time.", "Tiny steps add up.", "Still humming along."];
const BAD_COMMENTS = ["A little wobble. That's okay.", "That one was bumpy. Bumps are allowed."];

/** The kind words when Contributor's aren't in. They never say anything worked unless the build's own ending says so. */
export function plainComment(after: string, tone: StepTone, ended: boolean): string {
  if (tone === "bad") return BAD_COMMENTS[hash(after) % BAD_COMMENTS.length]!;
  if (tone === "good" && ended) return "Here it is.";
  return PLAIN_COMMENTS[hash(after) % PLAIN_COMMENTS.length]!;
}

export function buildFeed(events: readonly BuildEvent[]): Feed {
  const made: Array<Omit<FeedStep, "text">> = [];
  const lineWords = new Map<string, string>();
  const recapWords = new Map<string, { text?: string; comment?: string }>();
  const seenItems = new Set<string>();
  let run: Run | null = null;
  let batches = 0;
  let unpublished = false;

  const closeRun = () => {
    if (!run) return;
    const r = run;
    made[r.index] = { ...made[r.index]!, ...runWords(r), tone: runWords(r).tone ?? "plain" };
    run = null;
  };
  const add = (id: string, s: { plain: string; noun: string; tone?: StepTone; final?: boolean }) => {
    closeRun();
    // Two notes in a row are one line.
    if (made.at(-1)?.plain === s.plain) return;
    made.push({ id, plain: s.plain, noun: s.noun, tone: s.tone ?? "plain", final: s.final === true });
  };

  for (const e of events) {
    switch (e.type) {
      case "status": {
        if (e.message && NOT_PUBLISHED.test(e.message)) unpublished = true;
        const s = (unpublished && UNPUBLISHED_STEPS[e.status]) || STATUS_STEPS[e.status];
        if (s) add(`e${e.id}`, s);
        break;
      }
      case "log":
        if (NOT_PUBLISHED.test(e.text)) unpublished = true;
        break;
      case "brief":
        if (e.brief?.verdict !== "no") add(`e${e.id}`, { plain: "Wrote down the plan", noun: "the plan" });
        break;
      case "verify":
        add(`e${e.id}`, e.summary?.passed ? { plain: "The checks passed", noun: "the checks", tone: "good" } : { plain: "A check did not pass", noun: "a check that did not pass", tone: "bad" });
        break;
      case "judge":
        add(`e${e.id}`, e.verdict?.pass ? { plain: "Took a good look at the screens, and they look right", noun: "a look at the screens", tone: "good" } : { plain: "Took a good look at the screens and found things to fix", noun: "a look at the screens", tone: "bad" });
        break;
      case "milestone":
        if (e.state === "building") add(`e${e.id}`, { plain: `Starting part ${e.index} of ${e.of}`, noun: `part ${e.index}` });
        else if (e.state === "passed") add(`e${e.id}`, { plain: `Part ${e.index} of ${e.of} passed its checks`, noun: `part ${e.index}`, tone: "good" });
        else if (e.state === "failed") add(`e${e.id}`, { plain: `Part ${e.index} of ${e.of} did not pass`, noun: `part ${e.index}`, tone: "bad" });
        break;
      case "live_check":
        if (!e.ok) add(`e${e.id}`, e.action ? { plain: "The online version did not work right when tried once", noun: "the online version", tone: "bad" } : { plain: "The online link did not answer", noun: "the online link", tone: "bad" });
        break;
      case "control":
        if (e.ok && e.action !== "subagent" && e.action !== "workflow") add(`e${e.id}`, e.action === "stop" ? { plain: "Got your stop", noun: "your stop" } : { plain: "Got your note", noun: "your note" });
        break;
      case "steps_feed":
        batches++;
        for (const l of e.lines ?? []) if (!lineWords.has(l.id)) lineWords.set(l.id, l.text);
        for (const r of e.recaps ?? []) if (!recapWords.has(r.after)) recapWords.set(r.after, { text: r.text, comment: r.comment });
        break;
      case "muse":
        (e.lines ?? []).forEach((line, i) => {
          // A line that's updated later keeps the place of its first sighting, except that an edit's path may come late.
          if (line.kind === "question" && line.itemId && !seenItems.has(line.itemId)) {
            seenItems.add(line.itemId);
            add(`e${e.id}.${i}`, { plain: "Asking you a question", noun: "a question for you" });
            return;
          }
          const found = lineActivity(line);
          if (!found) return;
          if (line.itemId) {
            const key = `${line.itemId}:${found.activity}`;
            if (seenItems.has(key)) return;
            seenItems.add(key);
          }
          const at = Date.parse(e.at);
          // A new kind of work starts a new step once this one has run a while. Reading never ends a stretch of making.
          if (run && !run.scores.has(found.activity) && at - run.startedAt >= MIN_STEP_MS && found.activity !== "read" && found.activity !== "run") closeRun();
          if (!run) {
            made.push({ id: `e${e.id}.${i}`, plain: "", noun: "", tone: "plain", final: false });
            run = { id: `e${e.id}.${i}`, startedAt: at, scores: new Map(), pages: new Map(), index: made.length - 1 };
          }
          run.scores.set(found.activity, (run.scores.get(found.activity) ?? 0) + WEIGHT[found.activity]);
          if (found.page) run.pages.set(found.page, (run.pages.get(found.page) ?? 0) + 1);
          // The step reads right while it's still growing.
          const words = runWords(run);
          made[run.index] = { ...made[run.index]!, plain: words.plain, noun: words.noun, tone: words.tone ?? "plain" };
        });
        break;
    }
  }
  closeRun();

  const ended = made.at(-1)?.final === true;
  const steps: FeedStep[] = made.map((s) => ({ ...s, text: (!s.final && lineWords.get(s.id)) || s.plain }));
  // The newest step is still going, unless the build has ended. A step's words only land once it's over.
  const runningAt = ended ? -1 : steps.length - 1;
  if (runningAt >= 0) steps[runningAt] = { ...steps[runningAt]!, text: steps[runningAt]!.plain };
  const closed = runningAt >= 0 ? steps.slice(0, runningAt) : steps;

  const recaps: FeedRecap[] = [];
  const rows: FeedRow[] = [];
  steps.forEach((step, i) => {
    rows.push({ type: "step", step, running: i === runningAt });
    if ((i + 1) % RECAP_EVERY !== 0 || i === runningAt) return;
    const group = steps.slice(i + 1 - RECAP_EVERY, i + 1);
    const tone: StepTone = group.some((s) => s.tone === "bad") ? "bad" : group.some((s) => s.tone === "good") ? "good" : "plain";
    const words = recapWords.get(step.id);
    const plainText = `That covered ${joinNouns(group.map((s) => s.noun))}.`;
    const recap: FeedRecap = {
      after: step.id,
      text: words?.text || plainText,
      comment: words?.comment || plainComment(step.id, tone, group.some((s) => s.final)),
      steps: group.map((s) => s.id),
      plain: group.map((s) => s.plain),
      tone,
    };
    recaps.push(recap);
    rows.push({ type: "recap", recap });
  });

  return { steps, rows, closed, recaps, wordedSteps: new Set(lineWords.keys()), wordedRecaps: new Set(recapWords.keys()), batches, unpublished };
}

/** The room's log with BUILD_ROOM_STEPS off: summaries written while it was on stay out, as if there never were any. */
export function withoutStepsFeed<E extends Pick<BuildEvent, "type">>(events: E[]): E[] {
  return events.some((e) => e.type === "steps_feed") ? events.filter((e) => e.type !== "steps_feed") : events;
}
