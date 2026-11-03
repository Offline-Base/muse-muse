/**
 * The polish round (POLISH_ENABLED, owner's decision of Nov 3, 1:30 PM ET): one refinement of a live product whose Muse Code
 * runs on Muse Wonder, even while BUILDS_ON_CONTRIBUTOR is on, as a final UI pass to Meta's look. Every other build keeps
 * today's model. POST /api/builds/{buildId}/polish starts it (lib/polish/start.ts).
 *
 * How it is told apart from any other change: its build row's message starts with POLISH_HEADER and its build_model is set
 * to POLISH_MODEL when the row is made (insertRefineBuild). The messages route refuses a person's note that starts with the
 * header, so only the polish route makes one.
 *
 * Pure: no Node APIs and no I/O, so the build workflow can import it.
 */

/** The owner's exception to BUILDS_ON_CONTRIBUTOR for this one refinement (lib/__tests__/no-wonder.test.ts, POLISH). */
export const POLISH_MODEL = "muse-wonder-1.0" as const;

/** First line of every polish note. The build row is a polish only when its message starts with it. */
export const POLISH_HEADER = "Final UI pass by Muse Wonder.";

/** What the room, the product page and the versions list call a polish that passed. */
export const POLISH_LABEL = "UI pass by Muse Wonder";

/** The room's name for the round while it runs, with its estimate. */
export const POLISH_ROOM_TITLE = "Final pass on Muse Wonder";

/** One round, plus at most this many fix rounds. */
export const POLISH_MAX_FIX_ROUNDS = 1;

/** The most a caller's focus text may add to the note. */
export const POLISH_MAX_FOCUS_CHARS = 2000;

/**
 * An estimate of one Muse Code step on Muse Wonder at its list price ($4 a million input, $0.20 cached, $20 output): about
 * 75k cached and 5k fresh input tokens and 2k output tokens. It sets the step caps below, so the round stays near its budget.
 */
export const POLISH_STEP_USD = 0.08;

/** The share of the budget kept for the product's own test calls through the build token. */
const PRODUCT_SHARE = 0.2;
/** The engine's share split between the round and its fix round. */
const ROUND_SHARE = 0.65;
const MIN_STEPS = 12;
/** The fewest steps worth a fix round once the round's cost is known (polishFixSteps). */
const MIN_FIX_STEPS = 6;
/** Muse Code's own step cap (DEFAULT_MAX_MODEL_STEPS in lib/sandbox/muse.ts). */
const MAX_STEPS = 200;

/**
 * The smallest POLISH_MAX_USD a polish starts with: below it the round's floor of MIN_STEPS would cost more than the
 * budget, so the route refuses rather than run past it (about $1.85).
 */
export const POLISH_MIN_USD = Math.ceil(((MIN_STEPS * POLISH_STEP_USD) / ROUND_SHARE / (1 - PRODUCT_SHARE)) * 100) / 100;

/** How a polish is bounded: dollars, model steps per run and fix rounds. Returned by loadRefineStep, so a replay keeps it. */
export interface PolishPlan {
  /** POLISH_MAX_USD: the most the whole round may spend on Meta. */
  maxUsd: number;
  /** The build token's budget: the product's own test calls during verify, the fix round and the judge's screenshots. */
  productUsd: number;
  /** Muse Code's step cap for the round. */
  roundSteps: number;
  /** Muse Code's step cap for its one fix round. */
  fixSteps: number;
  fixRounds: number;
}

function cents(usd: number): number {
  return Math.round(usd * 100) / 100;
}

function stepsFor(usd: number): number {
  return Math.min(MAX_STEPS, Math.max(MIN_STEPS, Math.floor(usd / POLISH_STEP_USD + 1e-9)));
}

/** The bounds of one polish from POLISH_MAX_USD and the platform's build token budget. */
export function polishPlan(maxUsd: number, buildTokenUsd: number): PolishPlan {
  const most = Number.isFinite(maxUsd) && maxUsd > 0 ? maxUsd : 0;
  const productUsd = cents(Math.max(0, Math.min(buildTokenUsd, most * PRODUCT_SHARE)));
  const engineUsd = Math.max(0, most - productUsd);
  return {
    maxUsd: cents(most),
    productUsd,
    roundSteps: stepsFor(engineUsd * ROUND_SHARE),
    fixSteps: stepsFor(engineUsd * (1 - ROUND_SHARE)),
    fixRounds: POLISH_MAX_FIX_ROUNDS,
  };
}

/** Whether a build's message is a polish note. */
export function isPolishMessage(message: string | null | undefined): message is string {
  return typeof message === "string" && message.startsWith(POLISH_HEADER);
}

/** The looks a polish may switch a product to (POST /api/builds/{id}/polish body `look`). Absent keeps the product's look. */
export const POLISH_LOOKS = ["meta"] as const;
export type PolishLook = (typeof POLISH_LOOKS)[number];

/**
 * Step 1 of a polish note with look "meta" starts with this. isMetaLookPolish finds it, so the judge and later fix and
 * change prompts treat the product as meta-ui once such a polish ships (lib/pipeline/build-steps.ts metaLookNote).
 */
export const POLISH_META_STEP = "1. The look: switch this product to the Meta UI look.";

/**
 * Step 1 with look "meta" (owner, Nov 3: every Meta demo and cookbook build uses the Meta UI look). It names what the
 * muse-app overlay wrote (template/targets/muse-app/files, lib/sandbox/look.ts) so Muse Code can undo exactly that, and
 * what the platform puts back before every check (the overlays' platform-files.json), so it doesn't fight them.
 */
const META_LOOK_STEP = [
  `${POLISH_META_STEP} This round changes the look on purpose, so it overrides any line that says to keep the current look. Remove the muse-app look completely and bring back the template's meta-ui look. A product with no app/muse-app.css and no \"Look: muse-app\" commit has it already: keep it.`,
  "   - Delete app/muse-app.css and every import of or reference to it. Any token only it defined becomes the nearest meta-ui token in app/globals.css.",
  "   - The commit \"Look: muse-app\" (and \"Look: build range\" after it, when there) wrote AGENTS.md, app/layout.tsx, app/page.tsx, .agents/skills/meta-ui/SKILL.md, .agents/skills/meta-ui/reference/*.md and .agents/skills/product-ui/SKILL.md. Find it with git log --grep='^Look: muse-app$' --format=%h -1, then see the template's version of a file with git show <commit>^:<path>.",
  "   - Put back .agents/skills/meta-ui and .agents/skills/product-ui as they were before it: git checkout <commit>^ -- .agents/skills/meta-ui .agents/skills/product-ui.",
  "   - In AGENTS.md, take back the template's look, font and skill lines, and keep every other line.",
  "   - In app/layout.tsx, import @fontsource-variable/inter and @fontsource-variable/montserrat as the template does, drop the muse-app.css import and any font the look added, and use the template's dark theme color. Keep the product's title and the rest.",
  "   - If app/manifest.ts or lib/native/app-icon.tsx is there, use Meta's colors again: background_color #f0f2f5, theme_color #0866ff and an icon on #0866ff.",
  "   - Remove the colors, fonts, shadows and decoration a design direction added in the product's own CSS. Every screen uses the meta-ui tokens: a gray page, flat white cards, Meta blue for actions, Inter text under Montserrat headings, and the blue-to-violet gradient only where a model did the work.",
  "   - Point every mention of muse-app-ui, muse-app.css, design-looks or a Design direction in AGENTS.md, BUILD_NOTES.md and code comments at meta-ui. Leave .agents/skills/muse-app-ui and .agents/skills/design-looks in place, since the platform puts them back before each check, but let nothing point at them. Leave brief.md as it is: its Design direction no longer sets the look.",
  "   - Put \"Look: Meta UI (.agents/skills/meta-ui)\" at the top of BUILD_NOTES.md, so later changes keep it.",
  "   Then follow .agents/skills/meta-ui and .agents/skills/product-ui on every screen, and run Muse Code's /taste skill on every screen as the last pass. Where /taste and meta-ui disagree, meta-ui wins.",
].join("\n");

/** Step 1 of a polish note that keeps the product's look. */
const KEEP_LOOK_STEP =
  "1. The look. If app/muse-app.css is in the product, it has the muse-app look: follow .agents/skills/muse-app-ui. Otherwise follow .agents/skills/meta-ui. Read .agents/skills/product-ui too. Then run Muse Code's /taste skill on every screen as the last pass. Where /taste and the look skill disagree, the look skill wins.";

/**
 * The polish note Muse Code gets, with the caller's focus (audit findings, say) at the end. With look "meta", step 1
 * switches the product to the Meta UI look; without it, the note keeps whichever look the product has.
 */
export function polishNote(focus?: string | null, look?: PolishLook | null): string {
  const extra = focus?.trim();
  return [
    `${POLISH_HEADER} This is a polish round on a live product: make it look and read like something Meta would feature on its own site, without changing what it does.`,
    "",
    look === "meta" ? META_LOOK_STEP : KEEP_LOOK_STEP,
    "2. Phones first, at 390 px and 360 px wide. Every tap target at least 44 by 44 px. Text, icons and borders at WCAG AA contrast. Nothing cut off, clipped or scrolling sideways. A result scrolls into view when it arrives. Tab bars and bottom bars fit every label without clipping.",
    "3. Clear copy. Short, plain labels. Buttons say what they do. Empty, loading and error states say what happened and what to do next.",
    "4. Consistent spacing and type. One spacing scale and one type scale, from the look skill's tokens, never one-off values.",
    "5. Keep every feature and every flow working as it does now. Add no new features and no new screens. Add no fake or sample data, and keep every real model call.",
    "6. Run the full verify (npm run verify) before you finish and fix what it finds. The platform runs the full verify and the screenshot judge again after you, and the live version is replaced only when both pass.",
    ...(extra ? ["", "Also fix these findings from an audit of this product:", extra] : []),
  ].join("\n");
}

/** Whether a build's message is a polish note that switches the product to the Meta UI look. */
export function isMetaLookPolish(message: string | null | undefined): message is string {
  return isPolishMessage(message) && message.includes(`\n${POLISH_META_STEP}`);
}

/** Whether a polish that switched a product to the Meta UI look has shipped, from the product's builds. */
export function metaLookShipped(history: ReadonlyArray<{ kind: string; message: string | null; status: string }>): boolean {
  return history.some((h) => h.kind === "refine" && isMetaLookPolish(h.message) && (h.status === "live" || h.status === "partial"));
}

/** The room's estimate, said when the round starts. */
export function polishRoomLine(plan: PolishPlan): string {
  return `${POLISH_ROOM_TITLE}: one round of up to ${plan.roundSteps} model steps and at most ${plan.fixRounds} fix round of up to ${plan.fixSteps}, estimated at no more than $${plan.maxUsd.toFixed(2)} in Meta credits, $${plan.productUsd.toFixed(2)} of it for the product's own test calls.`;
}

/**
 * The step cap of the fix round, from what the round has already spent: never more than the plan's, and only what fits
 * in the budget that's left once the product's whole share is kept for the fix round's own checks. 0: no fix round runs,
 * so a polish can't pass POLISH_MAX_USD by a whole fix round when the round itself ran close to it.
 */
export function polishFixSteps(plan: PolishPlan, spentUsd: number): number {
  const left = plan.maxUsd - (Number.isFinite(spentUsd) ? Math.max(0, spentUsd) : plan.maxUsd) - plan.productUsd;
  const steps = Math.min(plan.fixSteps, Math.floor(left / POLISH_STEP_USD + 1e-9));
  return steps >= MIN_FIX_STEPS ? steps : 0;
}

/** What the room says when a fix round would go past the budget. */
export function polishBudgetLine(plan: PolishPlan, spentUsd: number): string {
  return `${POLISH_ROOM_TITLE} has spent $${spentUsd.toFixed(2)} of its $${plan.maxUsd.toFixed(2)} budget, and a fix round wouldn't fit in what's left, so none runs.`;
}

/** The final word on a polish: plain about which model did the pass, and that a failure changed nothing on the product. */
export function polishEnding(status: string, message: string): string {
  if (status === "failed") return `The ${POLISH_LABEL} didn't ship, so nothing changed on the live product. ${message}`;
  return `${POLISH_LABEL}. ${message}`;
}

/** A row in a product's versions list: the polish label, or the change's own words. */
export function changeLabel(message: string | null | undefined, fallback: string): string {
  return isPolishMessage(message) ? POLISH_LABEL : (message ?? fallback);
}

/** The newest polish that shipped, from a product's builds, for the product page. */
export function passedPolish<T extends { kind: string; message: string | null; status: string; startedAt: Date | string }>(history: readonly T[]): T | null {
  const passed = history.filter((h) => h.kind === "refine" && isPolishMessage(h.message) && (h.status === "live" || h.status === "partial"));
  return passed.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())[0] ?? null;
}
