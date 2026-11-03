/**
 * Requirements only a target can prove (target audit, Nov 3): an app package, a board's backup answer, a spoken question
 * that was transcribed, a session in a headset or through glasses. A web screenshot can't show any of these, so the
 * screenshot judge never reads them. Code decides each one from what the pipeline really saw: the outage drills, the
 * gateway's record of the voice model, the smoke test's simulated session. With nothing that speaks for one, it stays
 * "not proven in this build", never Works. Pure, so the judge, the room and their tests share it.
 */
import { splitDrillSteps } from "@/lib/edge/drills";
import { buildableRequirements, type Requirement, type RequirementResult } from "@/lib/full/requirements";
import type { VerifySummary } from "@/lib/types";

/** What proves a target-only requirement. */
export type TargetCheckKind = "native" | "board" | "voice" | "headset" | "glasses";

/** The model a spoken question goes to. */
export const TRANSCRIBE_MODEL = "muse-voice-transcribe-1.0";

// An app people install: a Mac, Windows, Android or iPhone app, its shell, package or download. A "desktop layout" or a
// "phone screen" is a web screen, so it stays with the judge.
const NATIVE = /\b(?:android|iphone|ios|mac|macos|windows|desktop)\s+(?:app|application|shell|package|download|installer)s?\b(?!\s+(?:layout|view|screen|width|size|look|style))|\b(?:apk|dmg|msi|expo go|play store|app store)\b|\binstall(?:s|ed|able|ing)?\s+(?:it|the app|an app|on (?:a|the|their|your) (?:phone|mac|pc|computer|desktop))\b/i;
// The board's backup: an edge board, a Jetson, an answer when the cloud or the network is down.
const BOARD = /\b(?:edge board|jetson|on (?:the|a|an) (?:[a-z-]+ )?board|board(?:'s)? (?:backup|model|answer)|backup (?:model|answer)|offline|outage)\b|\b(?:cloud|network|internet|wi-?fi) (?:is |goes |stays )?(?:cut|down|out|unreachable|lost|unavailable)\b|\bwithout (?:the )?(?:cloud|internet|network)\b/i;
// A photo look on the board, which the SAM drills prove.
const BOARD_LOOK = /\b(?:photo|picture|image|camera|door|sam|outline|mask|look at)\b/i;
// A question that comes in by voice. An answer spoken out ("speaks the answer") is not this.
const VOICE_IN = /\b(?:voice|spoken)\s+(?:question|request|command|query|note|input|prompt)s?\b|\b(?:ask|asks|asking|asked|say|says|speak|speaks)\b[^.]{0,40}\b(?:out loud|aloud|by voice|with (?:their|your|the) voice|into the (?:mic|microphone))\b|\bmicrophone\b|\btranscrib\w*|\bhears? (?:the|a|their|your) (?:short )?question\b|\bhearing the question\b/i;
// The headset itself: Quest, Quest Browser, a headset. "In VR" alone is what the simulated screenshots show the judge.
const HEADSET = /\b(?:meta quest|quest browser|quest 3|(?:on|for|in|from) quest|headsets?)\b/i;
// The glasses themselves, not a fallback without them.
const GLASSES = /\b(?:meta (?:ai )?glasses|ray-ban|oakley|smart glasses|glasses)\b/i;
const NO_GLASSES = /\b(?:without|no)\s+(?:the\s+)?(?:meta\s+)?(?:ai\s+)?glasses\b/i;

/**
 * Which target, if any, must prove this requirement. Only targets the brief has count, so a web product's "offline" note
 * or a "Mac app" in passing stays with the judge.
 */
export function targetCheckOf(text: string, targets: readonly string[]): TargetCheckKind | null {
  const has = (t: string) => targets.includes(t);
  if ((has("phone") || has("desktop")) && NATIVE.test(text)) return "native";
  if (has("edge") && BOARD.test(text)) return "board";
  if ((has("glasses") || has("vr")) && VOICE_IN.test(text)) return "voice";
  if (has("vr") && HEADSET.test(text)) return "headset";
  if (has("glasses") && GLASSES.test(text) && !NO_GLASSES.test(text)) return "glasses";
  return null;
}

type TargetBrief = { targets?: ReadonlyArray<{ id: unknown }> | null; requirements?: Requirement[] | null };

function targetIds(brief: TargetBrief): string[] {
  return (brief.targets ?? []).map((t) => t?.id).filter((id): id is string => typeof id === "string");
}

/** The buildable requirements a target must prove, each with its kind, in the brief's order. */
export function targetCheckedRequirements(brief: TargetBrief | null | undefined): Array<{ requirement: Requirement; kind: TargetCheckKind }> {
  if (!brief) return [];
  const targets = targetIds(brief);
  if (!targets.length) return [];
  return buildableRequirements(brief).flatMap((requirement) => {
    const kind = targetCheckOf(requirement.text, targets);
    return kind ? [{ requirement, kind }] : [];
  });
}

/** The requirements the screenshot judge reads: every buildable one a target doesn't have to prove. */
export function judgeReadRequirements(brief: TargetBrief | null | undefined): Requirement[] {
  const checked = new Set(targetCheckedRequirements(brief).map((c) => c.requirement.id));
  return buildableRequirements(brief).filter((r) => !checked.has(r.id));
}

/** What the pipeline knew at the judge's round. Every field may be unknown, and unknown never reads as proof. */
export interface TargetFacts {
  /** verify's smoke step passed. For a VR product that means it entered a simulated Quest session, for glasses a photo through simulated glasses. */
  smokePassed: boolean | null;
  /** The outage drills on this round: whether the four main ones and the four photo ones all passed, or null when they didn't run. */
  drills: { main: boolean | null; look: boolean | null } | null;
  /** The models the gateway recorded for this build's tests, or null when its record can't speak for the product. */
  modelsCalled: readonly string[] | null;
  /** True when the brief lists Muse Voice Transcribe, so the gateway would have served it. */
  transcribeListed: boolean;
  /** PACKAGER_SNAPSHOT_ID is set, so app packages are made after the product goes live. */
  packagerReady: boolean;
}

export const NO_TARGET_FACTS: TargetFacts = { smokePassed: null, drills: null, modelsCalled: null, transcribeListed: false, packagerReady: false };

/** The drills in a verify summary, split into the main four and the photo four. Null when none ran. */
export function drillFacts(summary: Pick<VerifySummary, "steps"> | null | undefined): TargetFacts["drills"] {
  const { drills } = splitDrillSteps(summary?.steps ?? []);
  if (!drills.length) return null;
  const all = (rows: typeof drills) => (rows.length ? rows.every((d) => d.ok) : null);
  return { main: all(drills.filter((d) => d.id < 10)), look: all(drills.filter((d) => d.id >= 10)) };
}

/** The facts from one round's verify summary and what the caller read elsewhere. */
export function targetFactsFrom(
  summary: Pick<VerifySummary, "steps"> | null | undefined,
  more: { modelsCalled?: readonly string[] | null; transcribeListed?: boolean; packagerReady?: boolean } = {},
): TargetFacts {
  const smoke = summary?.steps.find((s) => s.name === "smoke");
  return {
    smokePassed: smoke ? smoke.ok : null,
    drills: drillFacts(summary),
    modelsCalled: more.modelsCalled ?? null,
    transcribeListed: more.transcribeListed === true,
    packagerReady: more.packagerReady === true,
  };
}

/** What the person reads on a requirement nothing proved. */
export const NOT_PROVEN_HERE = "Not proven in this build:";

/** One target-only requirement's verdict from the facts. Its test already passed. */
export function targetCheckVerdict(requirement: Pick<Requirement, "text">, kind: TargetCheckKind, facts: TargetFacts): Pick<RequirementResult, "state" | "detail"> {
  const unproven = (why: string) => ({ state: "unchecked" as const, detail: `${NOT_PROVEN_HERE} ${why}` });
  switch (kind) {
    case "native":
      return unproven(
        facts.packagerReady
          ? "the app package is made after the product goes live. Its download shows under Get it once it is made."
          : "phone and desktop packaging isn't set up here, so no app package was made. A screenshot of the web product can't show one.",
      );
    case "board": {
      const look = BOARD_LOOK.test(requirement.text);
      const passed = look ? facts.drills?.look : facts.drills?.main;
      if (passed === true) {
        return {
          state: "met",
          detail: look
            ? "The simulated outage drills passed: with the cloud cut, Meta SAM 3.1 on a simulated board looked at the photo and labeled it. No real board was tried."
            : "The simulated outage drills passed: with the cloud cut, a simulated board answered with its label. No real board was tried.",
        };
      }
      if (passed === false) return { state: "unmet", detail: "The simulated outage drills failed, so the board backup isn't working." };
      return unproven(look ? "no photo drill ran, so nothing showed Meta SAM 3.1 answering from a board. An answer from the cloud doesn't count." : "no outage drill ran, so nothing showed a board answering. An answer from the cloud doesn't count.");
    }
    case "voice": {
      if (facts.modelsCalled?.includes(TRANSCRIBE_MODEL)) return { state: "met", detail: "The gateway recorded Muse Voice Transcribe calls from this build's tests." };
      if (facts.modelsCalled && facts.transcribeListed) {
        return {
          state: "unmet",
          detail:
            "No spoken question was transcribed: the gateway recorded no Muse Voice Transcribe call in this build's tests. Send the recorded question to muse-voice-transcribe-1.0 with transcribeFile and answer what it says, and have the smoke test give the glasses a spoken question (fixtures/question.wav). Never drop the recording for a typed question.",
        };
      }
      return unproven("nothing recorded a spoken question going to Muse Voice Transcribe.");
    }
    case "headset":
      return facts.smokePassed
        ? { state: "met", detail: "The smoke test entered a simulated Meta Quest 3 session and saw the scene inside it. No real headset was tried." }
        : unproven("no session in a simulated headset passed.");
    case "glasses":
      return facts.smokePassed
        ? { state: "met", detail: "The smoke test took a photo through simulated glasses. No real glasses were tried." }
        : unproven("no photo through simulated glasses was taken.");
  }
}

/** The verdict on every target-only requirement of a brief, by id. Facts left out are all unknown. */
export function targetCheckResults(brief: TargetBrief | null | undefined, facts: TargetFacts | null | undefined): Map<string, Pick<RequirementResult, "state" | "detail">> {
  return new Map(targetCheckedRequirements(brief).map(({ requirement, kind }) => [requirement.id, targetCheckVerdict(requirement, kind, facts ?? NO_TARGET_FACTS)]));
}

/** How the build is told each target-only requirement is checked, so its tests give that check something to see. */
export const TARGET_CHECK_HOW: Record<TargetCheckKind, string> = {
  native: "the platform packages the app after the product goes live, so no screenshot can show it. Build the web product it opens.",
  board: "the outage drills prove it, with the cloud cut and a simulated board. A cloud answer never counts for it.",
  voice: "the gateway's record must show a Muse Voice Transcribe call from your tests, so the smoke test gives the product a spoken question and the product transcribes it.",
  headset: "the smoke test must enter VR with xr.enter(page) and take a judge screenshot inside it.",
  glasses: "the smoke test must take a photo through the fake glasses in tests/glasses.ts.",
};
