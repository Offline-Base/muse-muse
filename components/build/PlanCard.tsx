"use client";

import { useState } from "react";
import { preload } from "react-dom";
import type { RoomState } from "@/components/build/derive";
import { VERDICT } from "@/components/build/turns";
import { Icon } from "@/components/icons";
import type { Brief, BuildStatus } from "@/lib/types";

/**
 * The plan, in the build room's conversation once the brief is written: the Muse mascot on the left and a short summary
 * on the right, the plan's name, its tagline, who it's for and how it works. The models, limits, inspo and cost stay in
 * the steps panel's "Read the brief", which the card links to, so the plan reads once in the conversation. Styles are in
 * components/build/plan-card.css, which the build room page loads.
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
 * change (a refine) carries its product's brief without writing a plan, and has no "Read the brief" to open.
 *
 * A declined brief has no card. A presenting mascot beside "Can't build this" says two things at once, and the declined
 * message (BriefBody) has no plan to sum up: no one it's for and no steps, only the reason. So the room keeps that
 * message as it was, on its own.
 */
export function planCardState(room: Pick<RoomState, "status" | "segments">): { brief: Brief; art: PlanArt; step: string } | null {
  const seg = room.segments.find((s) => s.type === "brief");
  if (seg?.type !== "brief" || isDeclined(seg.brief)) return null;
  const art = ART_FOR[room.status];
  // `step` is the brief's row in the steps list (its data-step), where "Read the brief" folds the whole of it.
  return art ? { brief: seg.brief, art, step: seg.key } : null;
}

/**
 * While the brief is being written, fetches the pictures the card opens with, so the mascot is there when the card fades
 * in instead of popping in after it. Called while the room renders (react-dom's preload dedupes). A change passes
 * through "briefing" too, for its policy check, but never gets a card, so it fetches nothing.
 */
export function preloadPlanArt(status: BuildStatus, isRefine: boolean): void {
  if (isRefine || (status !== "queued" && status !== "briefing")) return;
  preload(PLAN_ART.present, { as: "image" });
  preload(PLAN_ART.building, { as: "image", fetchPriority: "low" });
}

export function PlanCard({
  brief,
  art,
  running,
  panelId,
  onReadBrief,
}: {
  brief: Brief;
  art: PlanArt;
  /** The build can still change state. Then all three pictures load at once, so a swap fades with nothing to wait for. */
  running: boolean;
  /** The steps panel, which "Read the full brief" opens. */
  panelId?: string;
  onReadBrief?: () => void;
}) {
  // Decided once: a build that has finished keeps its picture, so it loads only that one.
  const [all] = useState(running);
  const arts = all ? ART_ORDER : [art];
  const tagline = brief.tagline.trim();
  const user = brief.user.trim();
  const flow = brief.primaryFlow.map((s) => s.trim()).filter(Boolean);
  return (
    <div className="plan-card" data-art={art}>
      {/* Decorative: the room's own words, the working step above the card or the outcome under it, say the state. */}
      <div className="plan-card-art">
        <div className="plan-card-stack">
          {arts.map((a) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={a}
              className={a === art ? "is-on" : undefined}
              src={PLAN_ART[a]}
              alt=""
              width={ART_SIZE.width}
              height={ART_SIZE.height}
              decoding="async"
              {...(a === art ? {} : { fetchPriority: "low" as const })}
            />
          ))}
        </div>
      </div>
      <div className="plan-card-head">
        <h2 className="plan-card-name">
          <span className="sr-only">The plan: </span>
          {brief.name}
        </h2>
        {tagline ? <p className="plan-card-tagline">{tagline}</p> : null}
        {brief.verdict === "partly" ? (
          <p className="plan-card-verdict">
            <span className={`pill pill-${VERDICT.partly.tone}`}>
              <span className="pill-dot" aria-hidden />
              {VERDICT.partly.label}
            </span>
          </p>
        ) : null}
      </div>
      <div className="plan-card-body">
        {user ? (
          <>
            <h3>Who it&apos;s for</h3>
            <p>{user}</p>
          </>
        ) : null}
        {flow.length ? (
          <>
            <h3>How it works</h3>
            <ol>
              {flow.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ol>
          </>
        ) : null}
        {onReadBrief ? (
          <p className="plan-card-more">
            <button type="button" className="link-btn room-steps-link" aria-controls={panelId} onClick={onReadBrief}>
              Read the full brief
              <Icon name="chevronRight" size={16} />
            </button>
          </p>
        ) : null}
      </div>
    </div>
  );
}
