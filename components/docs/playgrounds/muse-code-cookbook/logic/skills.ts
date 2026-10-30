/**
 * The four bundled skills from cookbook/bundled-skills: how each is invoked, what it does, whether it stops to ask,
 * when to reach for it, and the recipe's own sample prompt and project. The live run sends the sample in the skill's
 * style; those instructions are this demo's summary of what the recipe says each skill does, not Muse Code's
 * SKILL.md, which a browser can't load.
 */

export type SkillId = "plan" | "grilling" | "grill-with-docs" | "taste";

export interface Skill {
  id: SkillId;
  invoke: string;
  does: string;
  stopsToAsk: string;
  whenToUse: string;
  /** The recipe's own prompt for this skill. */
  prompt: string;
  /** What the recipe shows coming back. */
  output: string;
  /** Files of the sample project the run reads. */
  files: Array<{ path: string; text: string }>;
  /** How the live run answers: free text, or one structured question at a time, or a checklist mapping. */
  shape: "plan" | "question" | "question-with-record" | "taste";
  /** This demo's instructions in the skill's style, from the recipe's description. */
  instructions: string;
}

export const SNORKEL_README = `# Snorkel Ledger

A tiny in-memory ledger for **Glimber** tokens. A Glimber is a unit of reservation
credit. The ledger tracks balances per account and lets you transfer Glimbers between
accounts.

Not yet built: a \`transfer\` operation with overdraft protection.`;

export const SNORKEL_LEDGER = `"""Snorkel Ledger: an in-memory ledger for Glimber tokens."""

class SnorkelLedger:
    def __init__(self):
        self._balances: dict[str, int] = {}

    def open_account(self, name: str, opening_glimbers: int = 0) -> None:
        if name in self._balances:
            raise ValueError(f"account {name!r} already exists")
        self._balances[name] = opening_glimbers

    def balance(self, name: str) -> int:
        return self._balances[name]

    def deposit(self, name: str, glimbers: int) -> None:
        self._balances[name] += glimbers`;

export const DECISIONS_MD = `# Design Decisions

Durable decisions for the Snorkel Ledger. Each entry is a settled choice with rationale.`;

export const PEMBLEWICK_README = `# Pemblewick Coffee, landing page

A single-page marketing site for Pemblewick, a small-batch coffee roaster.
One index.html (Tailwind via CDN is fine). Hero, three features, a sign-up CTA.`;

/** The defaults /taste avoids, as the recipe lists them. */
export const TASTE_DEFAULTS: readonly string[] = [
  "The purple-to-blue hero gradient",
  "The centered eyebrow, headline and two buttons hero",
  "The identical three-card feature grid",
  "Inter everywhere",
  "rounded-2xl on every element",
];

const PLAIN = "Write plain text without em dashes.";

export const SKILLS: readonly Skill[] = [
  {
    id: "plan",
    invoke: "/plan",
    does: "Grounds a plan in your files, names the key decisions, and stops for approval.",
    stopsToAsk: "Yes, at the end",
    whenToUse: "The work has decisions to make before code: an API to design, a migration to sequence, a PR to split.",
    prompt: "/plan Add a transfer(src, dst, glimbers) operation to SnorkelLedger with overdraft protection. Plan it, do not implement yet.",
    output: "A decision-complete plan: goal, success criteria, the key decisions with a recommended choice for each, an ordered work plan and a validation plan, saved to .agents/plans/, ending with Approve, request changes, or cancel?",
    files: [
      { path: "README.md", text: SNORKEL_README },
      { path: "ledger.py", text: SNORKEL_LEDGER },
    ],
    shape: "plan",
    instructions: [
      "You are running a /plan turn. Read the project files you are given before planning and ground every point in them: name functions and behaviors you actually saw, including gaps such as missing validation.",
      "Write a decision-complete plan with these sections: Goal, Success criteria, Key decisions (each with the options and one recommended choice), Work plan (ordered steps), Validation plan.",
      "Do not write the implementation. Keep it under 300 words. End with exactly this line: Approve, request changes, or cancel?",
      PLAIN,
    ].join(" "),
  },
  {
    id: "grilling",
    invoke: "/grilling",
    does: "Interviews you one decision-forcing question at a time until the design is sharp.",
    stopsToAsk: "Yes, every question",
    whenToUse: "You have a rough idea and want it pressure-tested before you build it.",
    prompt: "/grilling I want to add a transfer operation with overdraft protection to SnorkelLedger. Grill me on the design before I build it.",
    output: "Exactly one question per turn, grounded in your code. When the answer fits two or three short choices, a structured prompt with the recommended option first.",
    files: [
      { path: "README.md", text: SNORKEL_README },
      { path: "ledger.py", text: SNORKEL_LEDGER },
    ],
    shape: "question",
    instructions: [
      "You are running a /grilling interview. Inspect the project files first. Ask exactly one decision-forcing question per turn about the design, the hardest open edge first, grounded in what the code does (cite the function).",
      "Offer two or three short, mutually exclusive options with the recommended one first and a tradeoff for each. Do not implement anything and do not write a plan.",
      "When the user answers, acknowledge the decision in one sentence, then ask the next hardest question.",
      PLAIN,
    ].join(" "),
  },
  {
    id: "grill-with-docs",
    invoke: "/grill-with-docs",
    does: "Same interview, plus it writes settled decisions into your project docs.",
    stopsToAsk: "Yes, every question",
    whenToUse: "The interview produces decisions worth keeping as durable project knowledge, not chat scrollback.",
    prompt: "/grill-with-docs Pressure-test the transfer + overdraft design for SnorkelLedger, and record the settled decisions in docs/DECISIONS.md as we go.",
    output: "The same one-at-a-time questions; after each answer, a decision record in docs/DECISIONS.md: the decision, the rationale, and the alternatives it rejected.",
    files: [
      { path: "README.md", text: SNORKEL_README },
      { path: "ledger.py", text: SNORKEL_LEDGER },
      { path: "docs/DECISIONS.md", text: DECISIONS_MD },
    ],
    shape: "question-with-record",
    instructions: [
      "You are running a /grill-with-docs interview. Inspect the project files first. Ask exactly one decision-forcing question per turn, grounded in the code, with two or three options, the recommended one first.",
      "When the user has answered a question, write a decision record for docs/DECISIONS.md covering only what they settled or what you verified in the files: an id like D1, a short title, the decision, the rationale, and the rejected alternatives. Never invent architecture. Then ask the next question.",
      "Before any answer, leave the record empty.",
      PLAIN,
    ].join(" "),
  },
  {
    id: "taste",
    invoke: "/taste",
    does: "A flat checklist of visual defaults to avoid, so generated UI stops looking AI-made.",
    stopsToAsk: "No",
    whenToUse: "You are generating a UI and don't want the look that reads as machine-made.",
    prompt: "/taste Build index.html for the Pemblewick Coffee landing page from the README. Apply good design taste.",
    output: "The page, plus which defaults it avoided and what it chose instead: an asymmetric hero, editorial numbered rows, a warm palette, a real type hierarchy.",
    files: [{ path: "README.md", text: PEMBLEWICK_README }],
    shape: "taste",
    instructions: [
      "You are running a /taste turn for a landing page brief. Before building, decide the design. For each default on this checklist, say what you will do instead: " + TASTE_DEFAULTS.join("; ") + ".",
      "Also pick a palette of three to five colors that fits the brand (name and hex), a type pairing, and one sentence on the layout. Don't prescribe a house style: only remove the machine-made defaults. An explicit brand request in the brief would override the checklist.",
      PLAIN,
    ].join(" "),
  },
];

export function skillById(id: SkillId): Skill {
  return SKILLS.find((s) => s.id === id) ?? SKILLS[0];
}

/** The input a live run sends: the project files, then the user's turn. */
export function skillInput(skill: Skill, prompt: string): string {
  const files = skill.files.map((f) => `--- ${f.path} ---\n${f.text}`).join("\n\n");
  return `Project files:\n\n${files}\n\nUser turn:\n${prompt}`;
}

export const QUESTION_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    acknowledged: { type: "string" },
    question: { type: "string" },
    grounded_in: { type: "string" },
    options: {
      type: "array",
      items: {
        type: "object",
        properties: { label: { type: "string" }, recommended: { type: "boolean" }, tradeoff: { type: "string" } },
        required: ["label", "recommended", "tradeoff"],
        additionalProperties: false,
      },
    },
  },
  required: ["acknowledged", "question", "grounded_in", "options"],
  additionalProperties: false,
};

export const QUESTION_WITH_RECORD_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    ...(QUESTION_SCHEMA.properties as Record<string, unknown>),
    decision_record: {
      type: "object",
      properties: {
        id: { type: "string" },
        title: { type: "string" },
        decision: { type: "string" },
        rationale: { type: "string" },
        rejected: { type: "string" },
      },
      required: ["id", "title", "decision", "rationale", "rejected"],
      additionalProperties: false,
    },
  },
  required: ["acknowledged", "question", "grounded_in", "options", "decision_record"],
  additionalProperties: false,
};

export const TASTE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    avoided: {
      type: "array",
      items: {
        type: "object",
        properties: { default: { type: "string" }, instead: { type: "string" } },
        required: ["default", "instead"],
        additionalProperties: false,
      },
    },
    palette: {
      type: "array",
      items: {
        type: "object",
        properties: { name: { type: "string" }, hex: { type: "string" } },
        required: ["name", "hex"],
        additionalProperties: false,
      },
    },
    type_pairing: { type: "string" },
    layout: { type: "string" },
  },
  required: ["avoided", "palette", "type_pairing", "layout"],
  additionalProperties: false,
};

export interface QuestionReply {
  acknowledged: string;
  question: string;
  grounded_in: string;
  options: Array<{ label: string; recommended: boolean; tradeoff: string }>;
  decision_record?: { id: string; title: string; decision: string; rationale: string; rejected: string };
}

export interface TasteReply {
  avoided: Array<{ default: string; instead: string }>;
  palette: Array<{ name: string; hex: string }>;
  type_pairing: string;
  layout: string;
}

/** A decision record as the recipe's DECISIONS.md shows it. */
export function decisionMarkdown(r: NonNullable<QuestionReply["decision_record"]>): string {
  return [`### ${r.id}: ${r.title}`, `- **Decision:** ${r.decision}`, `- **Rationale:** ${r.rationale}`, `- **Rejected:** ${r.rejected}`].join("\n");
}

/** A hex color the swatch can draw, or null for anything else the model returns. */
export function safeHex(hex: string): string | null {
  return /^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(hex.trim()) ? hex.trim() : null;
}
