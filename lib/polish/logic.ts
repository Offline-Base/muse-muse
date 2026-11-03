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
import { APP_LOOK_COMMIT, APP_LOOK_NOTE, LOOK_CSS, MUSE_APP_OVERLAY, OVERLAYS_DIR, RANGE_COMMIT } from "@/lib/sandbox/look";

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

/**
 * The looks a polish may switch a product to (POST /api/builds/{id}/polish body `look`). Absent keeps the product's look.
 * "meta" is the Meta AI app look, muse-app-ui (owner, Nov 3, evening), whatever the product has now.
 */
export const POLISH_LOOKS = ["meta"] as const;
export type PolishLook = (typeof POLISH_LOOKS)[number];

/**
 * Step 1 of a polish note with look "meta" starts with this. isMetaLookPolish finds it, so the judge and later fix and
 * change prompts keep the product on muse-app-ui with no Design direction once such a polish ships
 * (lib/pipeline/build-steps.ts metaLookNote).
 */
export const POLISH_META_STEP = "1. The look: put this product on the muse-app look, .agents/skills/muse-app-ui.";

/**
 * Step 1 of a look "meta" polish from the afternoon of Nov 3, which moved products to meta-ui. Kept only to tell those
 * polishes apart (isMetaUiLookPolish): they still set a product's look on purpose, so a later judge reads no direction,
 * and they don't count as this look, so --look=meta --again polishes those products again.
 */
export const POLISH_META_UI_STEP = "1. The look: switch this product to the Meta UI look.";

/** The muse-app overlay's files in a product's sandbox, read-only (OVERLAYS_DIR in lib/sandbox/look.ts). */
const APP_LOOK_FILES = `${OVERLAYS_DIR}/${MUSE_APP_OVERLAY}/files`;

/**
 * Step 1 with look "meta" (owner, Nov 3, evening: every product has the look of the Meta AI app). It works from what
 * the product has: app/muse-app.css kept and stripped of any design direction, or the overlay copied in from the
 * sandbox's read-only copy (a sandbox from a snapshot before Oct 31 may not have it: then from the skill's tokens
 * table). The "Look: Meta AI app" commit stops the build-range skill files coming back before each check
 * (restoreRangeFilesScript).
 */
const META_LOOK_STEP = [
  `${POLISH_META_STEP} This round changes the look on purpose, so it overrides any line that says to keep the current look or follow a Design direction. The look: a white page, hairline cards, regular-weight Inter, one blue for actions, a purple gradient only on what a model made, a floating composer, and a left sidebar where the product has room for one.`,
  `   - The look's own files are in ${APP_LOOK_FILES} (read-only). Put its .agents/skills/muse-app-ui, .agents/skills/product-ui and .agents/skills/meta-ui in place of the product's: D=${APP_LOOK_FILES}; for s in muse-app-ui product-ui meta-ui; do [ -d $D/.agents/skills/$s ] && rm -rf .agents/skills/$s && cp -R $D/.agents/skills/$s .agents/skills/; done. If ${LOOK_CSS} is missing, copy it from $D too. Then chmod -R u+w .agents/skills ${LOOK_CSS}: copies are read-only.`,
  `   - If that folder isn't in this sandbox: keep .agents/skills/muse-app-ui if the product has it, and keep or write ${LOOK_CSS} with every token in .agents/skills/muse-app-ui/reference/tokens.md, light and dark, as that table gives them. If the skill is missing too, keep the current look, say so at the top of BUILD_NOTES.md, and go on to step 2.`,
  `   - Remove every design direction. ${LOOK_CSS} must hold the look's own values (diff it with $D/${LOOK_CSS}, or check it against the tokens table): take out every color, font, shadow, radius or token that differs. Map a token only the product's CSS defines to the nearest one in ${LOOK_CSS}, and take out the colors, fonts and decoration a direction added in the product's own CSS. Delete .agents/skills/design-looks and any font package a direction added. If the commit "${RANGE_COMMIT}" is there, git show --stat on it lists what it wrote.`,
  `   - In app/layout.tsx, import @fontsource-variable/inter/opsz.css and then ./muse-app.css after ./globals.css, drop @fontsource-variable/montserrat and any other font, and use #181819 as the dark theme color. Keep the product's title and the rest.`,
  "   - If app/manifest.ts or lib/native/app-icon.tsx is there, use background_color #ffffff, theme_color #ffffff and an icon on #0064d4.",
  `   - In AGENTS.md, take the look, font and skill lines from the copy in that folder, and keep every other line. Point every mention of meta-ui, design-looks or a Design direction in AGENTS.md, BUILD_NOTES.md and code comments at muse-app-ui. Leave brief.md as it is: its Design direction no longer sets the look.`,
  `   - Put "${APP_LOOK_NOTE}" at the top of BUILD_NOTES.md, then commit: git add -A && git commit -qm "${APP_LOOK_COMMIT}".`,
  "   Then follow .agents/skills/muse-app-ui and .agents/skills/product-ui on every screen, and run Muse Code's /taste skill on every screen as the last pass. Where /taste and muse-app-ui disagree, muse-app-ui wins.",
].join("\n");

/** Step 1 of a polish note that keeps the product's look. */
const KEEP_LOOK_STEP =
  "1. The look. If app/muse-app.css is in the product, it has the muse-app look: follow .agents/skills/muse-app-ui. Otherwise follow .agents/skills/meta-ui. Read .agents/skills/product-ui too. Then run Muse Code's /taste skill on every screen as the last pass. Where /taste and the look skill disagree, the look skill wins.";

/**
 * The polish note Muse Code gets, with the caller's focus (audit findings, say) at the end. With look "meta", step 1
 * puts the product on the Meta AI app look, muse-app-ui; without it, the note keeps whichever look the product has.
 */
export function polishNote(focus?: string | null, look?: PolishLook | null): string {
  const extra = focus?.trim();
  return [
    `${POLISH_HEADER} This is a polish round on a live product: make it look and read finished and polished, without changing what it does.`,
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

/** Whether a build's message is a polish note with look "meta" as it is now: the Meta AI app look, muse-app-ui. */
export function isMetaLookPolish(message: string | null | undefined): message is string {
  return isPolishMessage(message) && message.includes(`\n${POLISH_META_STEP}`);
}

/** Whether a build's message is a look "meta" polish from the afternoon of Nov 3, which moved the product to meta-ui. */
export function isMetaUiLookPolish(message: string | null | undefined): message is string {
  return isPolishMessage(message) && message.includes(`\n${POLISH_META_UI_STEP}`);
}

/** Whether a polish set the product's look on purpose, either look "meta": no Design direction sets its look after it. */
export function isLookPolish(message: string | null | undefined): message is string {
  return isMetaLookPolish(message) || isMetaUiLookPolish(message);
}

/**
 * Whether a look polish (isLookPolish) has shipped, from the product's builds. The judge and later fix and change prompts
 * then keep the look the product's files have, with no Design direction or asked look.
 */
export function metaLookShipped(history: ReadonlyArray<{ kind: string; message: string | null; status: string }>): boolean {
  return history.some((h) => h.kind === "refine" && isLookPolish(h.message) && (h.status === "live" || h.status === "partial"));
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

// ---------------------------------------------------------------------------------------------------------------
// The no-worse gate (owner's rule, Nov 3). A polish ships when it is no worse than the live version: verify passes,
// the screenshot judge's own call passes, and every requirement that passed on the live build still passes. A
// requirement that already failed there and still fails doesn't block it, and stays listed as a known issue. Anything
// that passed before and fails now still blocks it. Every other build and change keeps today's gate.

/** What the live build's last judge recorded of the product's requirements. */
export interface PolishBaseline {
  /** False when the live build has no per-requirement record: then every requirement must pass, as today. */
  known: boolean;
  /** The requirements unmet on the live build, in id order. Only these may stay unmet. */
  failing: string[];
  /** The requirements met on the live build, in id order. Each must still be met: unmet, cant or unchecked now blocks. */
  met: string[];
}

const idOrder = (a: string, b: string) => Number(a.slice(1)) - Number(b.slice(1)) || a.localeCompare(b);

/** The ids with this state, once each, in id order. */
function idsIn(requirements: ReadonlyArray<{ id: string; state: string }>, state: string): string[] {
  return [...new Set(requirements.filter((r) => r.state === state).map((r) => r.id))].sort(idOrder);
}

/** The baseline from the live build's last judge verdict. No requirement list (or no verdict) is unknown, never "all passed". */
export function polishBaseline(requirements: ReadonlyArray<{ id: string; state: string }> | null | undefined): PolishBaseline {
  if (!Array.isArray(requirements) || !requirements.length) return { known: false, failing: [], met: [] };
  return { known: true, failing: idsIn(requirements, "unmet"), met: idsIn(requirements, "met") };
}

/** What the gate reads of the judge's call on the polish (JudgeCall in lib/pipeline/logic.ts). */
export interface PolishJudge {
  pass: boolean;
  blocking: boolean;
  /** The judge model's own call, before code failed it for unmet requirements. */
  ownPass?: boolean;
  requirements?: ReadonlyArray<{ id: string; state: string }>;
}

export interface PolishGate {
  ship: boolean;
  /** Unmet now and on the live build: the known issues it ships with. */
  stillFailing: string[];
  /** Unmet now but not unmet on the live build, or met there and not met now (cant, unchecked or missing): these block it. */
  newlyFailing: string[];
}

/**
 * The no-worse gate on one checked round of a polish. `failing` and `met` are the baseline's (polishBaseline). A judge
 * that passed is today's gate. With an empty baseline, a judge that failed for anything but those requirements, a
 * requirement met on the live build that isn't met now, a blocking call or a failed verify, it doesn't ship.
 */
export function polishNoWorse(input: { verifyPassed: boolean; judge: PolishJudge | null; failing: readonly string[]; met?: readonly string[] }): PolishGate {
  const no: PolishGate = { ship: false, stillFailing: [], newlyFailing: [] };
  if (!input.verifyPassed || !input.judge) return no;
  if (input.judge.pass) return { ship: true, stillFailing: [], newlyFailing: [] };
  if (!input.failing.length || !input.judge.requirements?.length) return no;
  const before = new Set(input.failing);
  const unmet = idsIn(input.judge.requirements, "unmet");
  const metNow = new Set(idsIn(input.judge.requirements, "met"));
  const stillFailing = unmet.filter((id) => before.has(id));
  // Met on the live build and not met now is worse, whatever state it is in now ("unchecked" doesn't fail the verdict).
  const lost = (input.met ?? []).filter((id) => !metNow.has(id));
  const newlyFailing = [...new Set([...unmet.filter((id) => !before.has(id)), ...lost])].sort(idOrder);
  const ship = input.judge.ownPass === true && !input.judge.blocking && stillFailing.length > 0 && newlyFailing.length === 0;
  return { ship, stillFailing, newlyFailing };
}

/** "R3", "R3 and R7", "R3, R7 and R8". */
function idList(ids: readonly string[]): string {
  return ids.length <= 1 ? (ids[0] ?? "") : `${ids.slice(0, -1).join(", ")} and ${ids.at(-1)}`;
}

/** The room's line, said once at the start, on what the polish is held to. Null when nothing differs from today's gate. */
export function polishBaselineLine(baseline: PolishBaseline): string | null {
  if (!baseline.known) return "The live version has no per-requirement results on record, so this pass ships only if every requirement passes.";
  if (!baseline.failing.length) return null;
  const n = baseline.failing.length;
  return `The live version already fails ${idList(baseline.failing)}. This pass can still ship if every requirement that passed there still passes, and ${n === 1 ? "that one stays" : "those stay"} listed as known issues.`;
}

/** The room's line when a polish broke a requirement the live version didn't fail (polishNoWorse's newlyFailing). */
export function polishBrokeLine(newlyFailing: readonly string[]): string {
  return `This pass broke ${idList(newlyFailing)}, which ${newlyFailing.length === 1 ? "wasn't" : "weren't"} failing on the live version, so it can't ship as it is.`;
}

/** The final word on a polish that shipped with the live version's failing requirements still failing. */
export function polishKeptLine(liveUrl: string | null, stillFailing: readonly string[]): string {
  const n = stillFailing.length;
  const where = liveUrl ? `Shipped as partial at ${liveUrl}.` : "Finished as partial without publishing to its own link.";
  return `${where} Every requirement that passed on the live version still passes. ${idList(stillFailing)} still ${n === 1 ? "fails" : "fail"} as before, so ${n === 1 ? "it stays" : "they stay"} listed as known issues.`;
}

/** What the judge is told on a polish of a product whose live version already fails some requirements. */
export function polishJudgeNote(failing: readonly string[]): string {
  return [
    `This is a UI pass on a live product. Its live version already failed ${idList(failing)} before this pass.`,
    `Report ${failing.length === 1 ? "it" : "them"} in requirements as the screens show, but don't fail the product for ${failing.length === 1 ? "it" : "them"} alone. Fail it for anything else under the rules above, including anything that looks or works worse than a finished product should.`,
  ].join(" ");
}

/** The judge's mismatch lines without the ones for requirements that already failed on the live version (unmetLines' wording). */
export function withoutKnownFailing(mismatches: readonly string[], failing: readonly string[]): string[] {
  return mismatches.filter((m) => !failing.some((id) => m.startsWith(`${id} is not met:`)));
}

/** The fix round's section on the requirements the live version already failed, so it spends no steps on them. */
export function polishFixLines(failing: readonly string[]): string[] {
  const n = failing.length;
  return [
    "## Already failing before this pass",
    "",
    `${idList(failing)} already failed on the live version before this UI pass. Leave ${n === 1 ? "it" : "them"} as ${n === 1 ? "it is" : "they are"}: don't spend steps on ${n === 1 ? "it" : "them"}, and don't change ${n === 1 ? "its test" : "their tests"}. \`npm run verify\` still reports ${n === 1 ? "it" : "them"}, and that doesn't block this pass. Fix only what this pass broke and what the checks above found besides ${n === 1 ? "it" : "them"}.`,
  ];
}
