"use client";

import { Fragment, useState, type ReactNode } from "react";
import { preload } from "react-dom";
import type { RoomState } from "@/components/build/derive";
import { BriefBody, VERDICT } from "@/components/build/turns";
import type { Brief, BuildStatus } from "@/lib/types";

/**
 * The plan, in the build room's conversation once the brief is written: the Muse mascot at the top left and the whole
 * plan beside it, its name, tagline and every part of the brief (BriefBody, the same one the steps panel's "Read the
 * brief" folds), so the plan reads once in the conversation. Owner, Oct 31: on a wide column the text wraps beside the
 * picture and runs on full width under it; a narrow one keeps the small picture beside the name with the plan under
 * both. Styles are in components/build/plan-card.css, which the build room page loads.
 *
 * The card draws a PlanView, so another plan can use it: the build room's comes from its brief (planViewFromBrief), and
 * the fine-tune room's from its training plan (components/train/room/plan.ts planViewFromTrainPlan), with its own
 * actions under the summary and the grid layout it had.
 */

export type PlanArt = "present" | "building" | "shield";

/**
 * The owner's mascot pictures (Oct 31), web-sized in public/muse/. present.png and building.png are 1440 x 1632.
 * shield.png is 1920 x 1280, scaled 1.1x and set on the same 1440 x 1632 canvas in its own white (the pair centered and
 * whole, 94% of the width and 73% of the height, like the single figure in the other two), so all three swap in one box.
 * Then `sips -s format jpeg -s formatOptions 82 -Z 640`: 564 x 640, about 47, 50 and 43 KB, a little over twice the
 * card's widest picture (240 px).
 */
export const PLAN_ART: Record<PlanArt, string> = {
  present: "/muse/muse-present.jpg",
  building: "/muse/muse-building.jpg",
  shield: "/muse/muse-shield.jpg",
};
const ART_ORDER: readonly PlanArt[] = ["present", "building", "shield"];
const ART_SIZE = { width: 564, height: 640 };

/**
 * The picture for each build status, the state the status rail and the steps read (railStates, roomSteps). Presenting
 * while the plan is new and the sandbox is set up; building while Muse Code works, the preview starts, the checks run, a
 * fix round goes, and the demo records and deploys; the pair, the "shield", once it's live, whole or partial.
 *
 * A failed or stopped build goes back to presenting: the plan still stands, nothing is being built, and the room's own
 * words under the card say it didn't ship. Building would say it's still going, and the pair would say it's done. A
 * declined build ("refused") has no card at all, see planCardState.
 */
const ART_FOR: Record<BuildStatus, PlanArt | null> = {
  queued: "present",
  briefing: "present",
  provisioning: "present",
  building: "building",
  previewing: "building",
  verifying: "building",
  fixing: "building",
  recording: "building",
  deploying: "building",
  live: "shield",
  partial: "shield",
  failed: "present",
  refused: null,
};

/** A brief that says no. Its own words say why, in the room's declined message, with no mascot beside them. */
export function isDeclined(brief: Brief): boolean {
  return brief.verdict === "no" || Boolean(brief.refusal);
}

/**
 * Whether the conversation shows the plan card, and with which picture. Only a build that wrote its brief has one: a
 * change (a refine) carries its product's brief without writing a plan.
 *
 * A declined brief has no card. A presenting mascot beside "Can't build this" says two things at once, and the declined
 * message (BriefBody) has no plan to sum up: no one it's for and no steps, only the reason. So the room keeps that
 * message as it was, on its own.
 */
export function planCardState(room: Pick<RoomState, "status" | "segments">): { brief: Brief; art: PlanArt } | null {
  const seg = room.segments.find((s) => s.type === "brief");
  if (seg?.type !== "brief" || isDeclined(seg.brief)) return null;
  const art = ART_FOR[room.status];
  return art ? { brief: seg.brief, art } : null;
}

/**
 * While the brief is being written, fetches the pictures the card opens with, so the mascot is there when the card fades
 * in instead of popping in after it. Called while the room renders (react-dom's preload dedupes). A change passes
 * through "briefing" too, for its policy check, but never gets a card, so it fetches nothing, and neither does a room
 * whose build already has its own picture (PLAN_ART), which the card shows instead.
 */
export function preloadPlanArt(status: BuildStatus, isRefine: boolean, artUrl: string | null = null): void {
  if (isRefine || artUrl || (status !== "queued" && status !== "briefing")) return;
  preload(PLAN_ART.present, { as: "image" });
  preload(PLAN_ART.building, { as: "image", fetchPriority: "low" });
}

/** One part of a plan's summary: a heading with a line of text or numbered steps, or a line on its own. */
export interface PlanSection {
  heading?: string;
  text?: string;
  steps?: readonly string[];
}

/** What the card shows: a name, a tagline, a status pill, the summary's parts, a link under them and any actions. */
export interface PlanView {
  name: string;
  tagline?: string;
  badge?: { label: string; tone: string } | null;
  sections: readonly PlanSection[];
}

/** A brief's plan: who it's for and how it works, with "Can build part of it" when that's the verdict. */
export function planViewFromBrief(brief: Brief): PlanView {
  const user = brief.user.trim();
  const flow = brief.primaryFlow.map((s) => s.trim()).filter(Boolean);
  return {
    name: brief.name,
    tagline: brief.tagline.trim(),
    badge: brief.verdict === "partly" ? VERDICT.partly : null,
    sections: [...(user ? [{ heading: "Who it's for", text: user }] : []), ...(flow.length ? [{ heading: "How it works", steps: flow }] : [])],
  };
}

export function PlanCard({
  brief,
  art,
  running,
  artUrl = null,
}: {
  brief: Brief;
  art: PlanArt;
  running: boolean;
  /** PLAN_ART: the picture made for this build (RoomState.planArtUrl), shown instead of the stock mascot once it's in. */
  artUrl?: string | null;
}) {
  // Under the card's own name, tagline and badge: the rest of the brief, written out in full.
  return (
    <PlanViewCard
      view={{ ...planViewFromBrief(brief), sections: [] }}
      art={art}
      artUrl={artUrl}
      running={running}
      wrap
      body={<BriefBody brief={brief} title={false} />}
    />
  );
}

/**
 * The card itself, for any PlanView. `body` comes after the sections, `more` is the link under them and `actions` come
 * last. `wrap` lets the text flow beside the picture and on under it where the column is wide (the build room's card).
 */
export function PlanViewCard({
  view,
  art,
  running,
  more,
  actions,
  body,
  wrap = false,
  artUrl = null,
}: {
  view: PlanView;
  art: PlanArt;
  /**
   * A picture made for this plan, shown instead of the stock mascot for every state. One there from the first render is
   * the only picture the card loads; one that comes in later fades in over the stock mascot once it has loaded, in the
   * same box, so nothing moves. Until then, or if it never loads, the stock mascot by state.
   */
  artUrl?: string | null;
  /** The plan can still change state. Then all three pictures load at once, so a swap fades with nothing to wait for. */
  running: boolean;
  more?: ReactNode;
  actions?: ReactNode;
  body?: ReactNode;
  wrap?: boolean;
}) {
  // Decided once: a plan that has finished keeps its picture, so it loads only that one.
  const [all] = useState(running);
  const [ownFirst] = useState(Boolean(artUrl));
  const [ownLoaded, setOwnLoaded] = useState(Boolean(artUrl));
  // The URL of a picture of its own that failed to load (a 404, a block): the card goes back to the stock mascot.
  const [ownBroken, setOwnBroken] = useState<string | null>(null);
  const ownUrl = artUrl && artUrl !== ownBroken ? artUrl : null;
  const own = Boolean(ownUrl) && ownLoaded;
  const arts = ownFirst && ownUrl ? [] : all ? ART_ORDER : [art];
  const broke = (url: string) => {
    setOwnBroken(url);
    setOwnLoaded(false);
  };
  const tagline = view.tagline?.trim() ?? "";
  return (
    <div className={wrap ? "plan-card plan-card-wrap" : "plan-card"} data-art={art}>
      {/* Decorative: the room's own words, the working step above the card or the outcome under it, say the state. */}
      <div className="plan-card-art">
        <div className="plan-card-stack">
          {arts.map((a) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={a}
              className={a === art && !own ? "is-on" : undefined}
              src={PLAN_ART[a]}
              alt=""
              width={ART_SIZE.width}
              height={ART_SIZE.height}
              decoding="async"
              {...(a === art ? {} : { fetchPriority: "low" as const })}
            />
          ))}
          {ownUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key="own"
              // A server-drawn picture can fail before the page hydrates, when onError has no one listening yet.
              ref={(img) => {
                if (img?.complete && img.naturalWidth === 0) broke(ownUrl);
              }}
              className={own ? "is-on" : undefined}
              src={ownUrl}
              alt=""
              width={ART_SIZE.width}
              height={ART_SIZE.height}
              decoding="async"
              onLoad={() => setOwnLoaded(true)}
              onError={() => broke(ownUrl)}
            />
          ) : null}
        </div>
      </div>
      <div className="plan-card-head">
        <h2 className="plan-card-name">
          <span className="sr-only">The plan: </span>
          {view.name}
        </h2>
        {tagline ? <p className="plan-card-tagline">{tagline}</p> : null}
        {view.badge ? (
          <p className="plan-card-verdict">
            <span className={`pill pill-${view.badge.tone}`}>
              <span className="pill-dot" aria-hidden />
              {view.badge.label}
            </span>
          </p>
        ) : null}
      </div>
      <div className="plan-card-body">
        {view.sections.map((section, n) => (
          <Fragment key={n}>
            {section.heading ? <h3>{section.heading}</h3> : null}
            {section.text ? <p>{section.text}</p> : null}
            {section.steps?.length ? (
              <ol>
                {section.steps.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ol>
            ) : null}
          </Fragment>
        ))}
        {body}
        {more ? <p className="plan-card-more">{more}</p> : null}
        {actions}
      </div>
    </div>
  );
}
