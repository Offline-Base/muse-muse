"use client";

import Link from "next/link";
import { writeComposerDraft } from "@/components/composer/Composer";
import { roughMinutes, WRITER_NAME } from "@/components/train/format";
import { GLIMMER_NAME } from "@/components/train/results";
import { usd } from "@/lib/format";
import type { Brief } from "@/lib/brief/schema";
import { planCost, planMaxUsd, planSettings } from "@/lib/train/tune/cost";
import { glimmerNeed, offersOwnModel, ownModelNote, planFromBuildHref, TUNE_DRAFT_ID, type OwnModelOffer } from "@/lib/train/tune/from-build";

export type { OwnModelOffer } from "@/lib/train/tune/from-build";

/**
 * "Its own model" in the build room (docs/TRAINING.md "Fine-tune like a build", B): for a live or partial build whose
 * brief picked muse-glimmer, what training this product its own Muse Glimmer would take and cost, and Plan it, which
 * opens /fine-tuning/new with the composer filled in from the brief. Nothing starts until the person presses Start
 * there, and the product stays live on Muse Wonder whatever happens. Renders nothing at all without an offer, so a
 * build room with the flag off is byte for byte what it was.
 */
export function OwnModelRow({ offer, brief, status, buildId }: { offer: OwnModelOffer | null | undefined; brief: Brief | null; status: string; buildId: string }) {
  if (!offer || !brief || !offersOwnModel(brief, status)) return null;
  const need = glimmerNeed(brief)!;
  const cost = planCost(planSettings(offer.examples, offer.ceilings));
  return (
    <li className="room-answer own-model">
      <p>
        <strong>Its own model</strong>
      </p>
      <p>
        This product can answer with its own tuned {GLIMMER_NAME}, trained for what its brief asked of it: {need.replace(/[.!?]+$/, "")}.
        Muse Muse would have {WRITER_NAME} write about {offer.examples} examples, train on one GPU, and score the tuned model against the base.
      </p>
      <p className="muted">
        It keeps answering with {WRITER_NAME} until its own model passes and a serving window is open. It takes {roughMinutes(cost.minutes)} and costs up to about{" "}
        {usd(planMaxUsd(cost))}: an estimate, not a promise (the GPU stops at its limit; Meta&apos;s part isn&apos;t measured yet). Nothing starts until you press Start.
      </p>
      {offer.canPlan ? (
        <div className="row-actions">
          <Link className="btn btn-outline" href={planFromBuildHref(buildId)} onClick={() => writeComposerDraft(TUNE_DRAFT_ID, ownModelNote(brief))}>
            Plan it
          </Link>
        </div>
      ) : (
        <p className="muted">Only admins can plan and start training today.</p>
      )}
    </li>
  );
}
