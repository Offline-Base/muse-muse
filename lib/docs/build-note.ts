import type { DocsPageInfo, RecordedRequest } from "@/components/docs/kit/DocsPageContext";
import { DEMO_GROUPS } from "@/lib/docs/demos/groups";
import type { AgentPromptSpec } from "@/lib/docs/demos/types";
import { RETIRED_SPARK, SPARK_STANDIN } from "@/lib/meta/spark";

/**
 * "Ask Muse Muse to build you something with this" (components/docs/page/BuildWithThis): what the page adds to the
 * reader's words before the build's brief reads them, and the ideas it offers. Pure, so the browser builds the note
 * with what the reader just ran. It goes through POST /api/inspirations like any other muse.
 */

/** The note's limit in lib/pipeline/references (MAX_NOTE_CHARS): the context leaves most of it for the reader. */
export const BUILD_NOTE_MAX = 4000;
export const BUILD_CONTEXT_MAX = 1600;
/** How the context opens: the build room folds the note from here (splitBuildNote). */
const CONTEXT_OPENING = "Build it around this from Meta's API docs: ";

const OPEN_WEIGHT_PAGES: ReadonlySet<string> = new Set(DEMO_GROUPS["open-weights"]);

/** Pages about the weights or the muse CLI: a built product runs on the hosted API, so their how-to doesn't apply. */
function teachesOutsideTheApi(slug: string, spec: AgentPromptSpec | null): boolean {
  if (spec?.setup === "hosted") return false;
  if (spec?.setup === "self-hosted") return true;
  return OPEN_WEIGHT_PAGES.has(slug) || slug === "muse-code" || slug.startsWith("muse-code/");
}

/** No em dashes in what Muse Muse hands out, and muse-spark-1.3 is never named (lib/meta/spark.ts). */
function clean(text: string): string {
  return text
    .replace(/\s*—\s*/g, ", ")
    .replace(new RegExp(`\\b${RETIRED_SPARK.replace(/\./g, "\\.")}\\b(?!-)`, "g"), SPARK_STANDIN)
    .trim();
}

/**
 * What a build needs to know about this page: its feature, how to use it, the facts easy to get wrong and where the
 * docs are. Keeps to BUILD_CONTEXT_MAX by dropping facts, last first, then shortening the how-to. The reader's request
 * body is left out: it was typed to try a demo, not to build from.
 */
export function buildContext({
  page,
  spec,
  lastRequest,
}: {
  page: Pick<DocsPageInfo, "slug" | "title" | "description" | "markdownUrl">;
  spec: AgentPromptSpec | null;
  lastRequest: RecordedRequest | null;
}): string {
  const outside = teachesOutsideTheApi(page.slug, spec);
  const head = [`${CONTEXT_OPENING}${clean(page.title)}.`, clean(page.description)].filter(Boolean);
  const task = outside ? "" : clean(spec?.task ?? "");
  const tail = [
    ...(lastRequest
      ? [`I just tried ${lastRequest.method} /v1/${lastRequest.path.replace(/^\/+/, "")} in the docs${lastRequest.model ? ` on ${clean(lastRequest.model)}` : ""}.`]
      : []),
    `Docs, the source of truth for request and response shapes: ${page.markdownUrl}`,
    outside
      ? "This page covers things a web product can't run itself, so use the closest hosted model and tell people what stands in for what."
      : "Call the API the way this project's setup says. If this feature isn't available there, use the closest one that is and say so in the product.",
  ];

  const render = (how: string, facts: readonly string[]) =>
    [
      ...head,
      ...(how ? [`How to use it: ${how}`] : []),
      ...(facts.length ? ["Get these right:", ...facts.map((f) => `- ${f}`)] : []),
      ...tail,
    ].join("\n");

  const facts = outside ? [] : (spec?.facts ?? []).map(clean);
  for (let keep = facts.length; keep >= 0; keep--) {
    const text = render(task, facts.slice(0, keep));
    if (text.length <= BUILD_CONTEXT_MAX) return text;
  }
  const room = Math.max(0, BUILD_CONTEXT_MAX - render("", []).length - "How to use it: ...\n".length);
  const cut = task.slice(0, room);
  const word = cut.lastIndexOf(" ");
  return render(room >= 40 ? `${word > 0 ? cut.slice(0, word) : cut}...` : "", []).slice(0, BUILD_CONTEXT_MAX);
}

/** A note as what the reader wrote and what a docs page added, so the build room can fold the page's part. */
export function splitBuildNote(note: string): { wish: string; context: string | null } {
  const at = note.indexOf(`\n\n${CONTEXT_OPENING}`);
  return at < 0 ? { wish: note, context: null } : { wish: note.slice(0, at), context: note.slice(at + 2) };
}

/** What the build is told when the reader leaves the box empty. */
export function blankWish(title: string): string {
  return `Make a small, useful app that shows what "${clean(title)}" can do. Pick the idea yourself.`;
}

export interface BuildIdea {
  label: string;
  note: string;
}

const IDEAS: ReadonlyArray<{ pages: RegExp; ideas: readonly BuildIdea[] }> = [
  {
    pages: /slides/,
    ideas: [
      { label: "Pitch deck", note: "Turn a one-paragraph idea into a short pitch deck I can click through and download." },
      { label: "Lesson slides", note: "Make lesson slides from a topic and grade level, with speaker notes for the teacher." },
      { label: "Report to slides", note: "Paste a report and get five clear slides with the main numbers called out." },
    ],
  },
  {
    pages: /game/,
    ideas: [
      { label: "Arcade game", note: "Make a one-screen arcade game with a high score, that plays well on a phone." },
      { label: "Word puzzle", note: "Make a daily word puzzle with hints written by the model." },
      { label: "Text adventure", note: "Make a text adventure where the model plays the narrator and remembers my choices." },
    ],
  },
  {
    pages: /sam|segment|sticker/,
    ideas: [
      { label: "Background remover", note: "Upload a photo, click the subject, and download it with a clean transparent background." },
      { label: "Sticker maker", note: "Turn the people and pets in my photos into a sticker sheet I can download." },
      { label: "Object counter", note: "Count every item of a kind in a photo, like the jars on a shelf, and outline each one." },
    ],
  },
  {
    pages: /image-understanding|vision|perception|video-understanding|chart/,
    ideas: [
      { label: "Fridge to dinner", note: "Take a photo of my fridge and suggest three dinners I can make from what's in it." },
      { label: "Chart explainer", note: "Upload a chart and get a plain-language summary and the numbers behind it as a table." },
      { label: "Error screenshot helper", note: "Drop in a screenshot of an error and get what it means and how to fix it." },
    ],
  },
  {
    pages: /image|glimmer-image/,
    ideas: [
      { label: "Product photo studio", note: "Upload a product photo and get it placed in three styled scenes for my store." },
      { label: "Storybook pages", note: "Write a short children's story and illustrate every page in one consistent style." },
      { label: "Poster maker", note: "Describe an event and get a poster with the date and place laid out cleanly." },
    ],
  },
  {
    pages: /speech|voice|transcri|caption/,
    ideas: [
      { label: "Voice memo to notes", note: "Record a voice memo and get tidy notes with the action items pulled out." },
      { label: "Meeting recap", note: "Upload a meeting recording and get a transcript, decisions and who owes what." },
      { label: "Pronunciation coach", note: "Read a sentence out loud and see which words came through differently from the text." },
    ],
  },
  {
    pages: /structured-output/,
    ideas: [
      { label: "Receipt to spreadsheet", note: "Paste or photograph a receipt and download the store, items and total as a CSV." },
      { label: "Resume parser", note: "Paste a resume and get a clean table of roles, dates and skills I can compare side by side." },
      { label: "Action item extractor", note: "Paste meeting notes and get a checklist of tasks, owners and due dates." },
    ],
  },
  {
    pages: /search-grounding|grounded/,
    ideas: [
      { label: "Cited topic brief", note: "Type a topic and get a one-page brief where every claim links to its source." },
      { label: "Fact checker", note: "Paste a claim and see what current sources say about it, with links." },
      { label: "Weekly digest", note: "Pick three subjects and get a short digest of what's new in each, with sources." },
    ],
  },
  {
    pages: /tool|agent|subagent|goal|loop|replay|approval|guardrail|sandbox|contained|openclaw|side-chat|audit|github|alert|computer-use|chess/,
    ideas: [
      { label: "Trip planner", note: "Plan a weekend trip that checks the weather and my budget with tools before it answers." },
      { label: "Research helper", note: "Give it a question and watch it work through steps, showing each tool it uses and why." },
      { label: "Inbox triage", note: "Paste a pile of messages and have it sort, draft replies and wait for my OK before anything is final." },
    ],
  },
  {
    pages: /file|long-context|multi-turn|prompt-caching|token/,
    ideas: [
      { label: "Chat with a PDF", note: "Upload a PDF and ask questions about it, with answers that point to the page." },
      { label: "Contract explainer", note: "Upload a contract and get the main terms, dates and anything unusual in plain language." },
      { label: "Prompt cost meter", note: "Paste a prompt and see its tokens and what it would cost on each model." },
    ],
  },
  {
    pages: /reasoning/,
    ideas: [
      { label: "Decision helper", note: "Describe a hard choice and get the options weighed, with the reasoning I can read." },
      { label: "Math tutor", note: "Paste a math problem and get hints one step at a time before the full answer." },
      { label: "Plan checker", note: "Paste a project plan and get the risks and gaps it would catch if it thought hard." },
    ],
  },
  {
    pages: /muse-code|bundled-skills|search-and-replace/,
    ideas: [
      { label: "Prompt library", note: "Make a searchable library of coding prompts I can save, tag and copy." },
      { label: "Release notes explainer", note: "Paste release notes and get what changed for me, in plain language." },
      { label: "Project starter", note: "Describe a project and get a clear task list and a starter README." },
    ],
  },
  {
    pages: /glimmer|spark-open|open-weight|run-locally|post-training|torchtitan/,
    ideas: [
      { label: "Can my computer run it?", note: "Enter my computer's memory and GPU and see which open models and sizes will run on it." },
      { label: "Prompt tester", note: "Run the same prompt with different settings and compare the answers side by side." },
      { label: "Training data checker", note: "Upload a JSONL training file and get the problems in it listed line by line." },
    ],
  },
  {
    pages: /pricing|models|status|error|retry|authentication/,
    ideas: [
      { label: "Model cost calculator", note: "Estimate a monthly bill from my traffic, and compare it across models." },
      { label: "Model picker", note: "Answer a few questions about my app and get the model that fits, and why." },
      { label: "Friendly error page", note: "Paste an API error and get what went wrong and what to try next." },
    ],
  },
];

const DEFAULT_IDEAS: readonly BuildIdea[] = [
  { label: "Writing helper", note: "Paste a rough draft and get it rewritten in the tone I pick, with the changes shown." },
  { label: "Study flashcards", note: "Paste my notes and get flashcards that quiz me on what I keep missing." },
  { label: "Email rewriter", note: "Paste an email and get three versions: shorter, warmer and firmer." },
];

/** Three ideas that fit the page, by what its slug is about. The first match wins, so the specific topics come first. */
export function buildIdeas(slug: string): readonly BuildIdea[] {
  return IDEAS.find((topic) => topic.pages.test(slug))?.ideas ?? DEFAULT_IDEAS;
}
