import type { Metadata } from "next";
import dynamic from "next/dynamic";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import type { ReactNode } from "react";
import { BuildRoom } from "@/components/build/BuildRoom";
import "@/components/build/plan-card.css";
import { NotConnected } from "@/components/ui";
import { contributorBuildsOn, env } from "@/lib/env";
import { canActAsOwner } from "@/lib/auth";
import { canEditProduct, canSteerBuild, editsByPassOnly } from "@/lib/edit-pass";
import { nativeActive } from "@/lib/native/active";
import { ownModelOffer } from "@/lib/train/tune/from-build";
import { currentUser, getBuildRoom, platformOrigin, rebuildRef, safeQuery } from "@/lib/queries";
import { withoutPlanArt } from "@/lib/pipeline/plan-art";
import { withoutStepsFeed } from "@/lib/steps-feed/facts";
import { makeChatAllOn } from "@/lib/make/switch";
import type { BuildEvent } from "@/lib/types";

/** MAKE_CHAT_ALL: loaded only for a build with a paired model, so this page's code is as it was with the switch off. */
const PairedRun = dynamic(() => import("@/components/make/PairedRun").then((m) => m.PairedRun));
const PairedFeed = dynamic(() => import("@/components/make/PairedRun").then((m) => m.PairedFeed));
const PairedPanel = dynamic(() => import("@/components/make/PairedRun").then((m) => m.PairedPanel));

export const metadata: Metadata = { title: "Build room" };

/** What a switched off PLAN_ART or BUILD_ROOM_STEPS wrote stays out of the room. */
function withoutFlagged<E extends Pick<BuildEvent, "type">>(events: E[]): E[] {
  const art = env.planArt ? events : withoutPlanArt(events);
  return env.buildRoomSteps ? art : withoutStepsFeed(art);
}

export default async function BuildRoomPage({
  params,
  searchParams,
}: {
  params: Promise<{ buildId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await connection();
  const [{ buildId }, sp, user] = await Promise.all([params, searchParams, currentUser()]);
  const result = await safeQuery(() => getBuildRoom(buildId));
  if (!result.ok) {
    return (
      <div className="page">
        <NotConnected reason={result.reason} what="this build" />
      </div>
    );
  }
  const data = result.data;
  if (!data) notFound();

  const origin = await platformOrigin();
  // The product's owner decides, as in the messages route. The build's userId is whoever asked for that change.
  const canRefine = Boolean(data.product && (await canEditProduct(user, data.product)));
  // Steering a running build takes the same owner powers (POST /api/builds/{id}/control), and steering switched on.
  const canSteer =
    env.steeringEnabled &&
    (await canSteerBuild(user, {
      id: data.build.id,
      userId: data.build.userId,
      productId: data.product?.id ?? null,
      ownerId: data.product?.ownerId ?? null,
    }));
  // Its own model (TUNE_FROM_BUILDS, with the tune composer on): the product's owner or an admin; planning is admins'
  // only today, as the composer is. The row itself checks the brief picked muse-glimmer and the build shipped.
  const ownModel = ownModelOffer({
    fromBuilds: env.tuneFromBuilds,
    composer: env.tuneComposer,
    hasProduct: Boolean(data.product),
    ownerOrAdmin: Boolean(data.product && canActAsOwner(user, data.product.ownerId)),
    isAdmin: user?.isAdmin === true,
    examples: env.tuneDefaultExamples,
    // limitCeilings in lib/train/gate.ts, without loading the recipes into this page.
    ceilings: { maxMinutes: env.trainJobMaxMinutes, maxUsd: env.trainJobMaxUsd },
  });

  // MAKE_CHAT_ALL: the model started with this build, only for whoever may see it. Needs BUILD_ROOM_STEPS's two columns.
  const paired = makeChatAllOn() && env.buildRoomSteps ? await (await import("@/lib/make/paired-run")).pairedRunFor(data.build.id).catch(() => null) : null;
  const native = await nativeActive(data.build.id);
  const room = (extra: { pairFeed?: ReactNode; pairPanel?: ReactNode }) => (
    <BuildRoom
      {...extra}
      build={data.build}
      product={data.product}
      inspiration={data.inspiration}
      events={withoutFlagged(data.events)}
      stepsFeed={env.buildRoomSteps}
      history={data.history}
      tokens={data.tokens}
      canRefine={canRefine}
      editsByPass={editsByPassOnly(user, data.product?.ownerId ?? null, canRefine)}
      canSteer={canSteer}
      signedIn={Boolean(user)}
      origin={origin}
      serverNow={Date.now()}
      focusRefine={sp.refine === "1"}
      rebuild={rebuildRef(data.build.rebuildOf)}
      maxFixRounds={env.maxFixRounds}
      nativeActive={native}
      ownModel={ownModel}
      contributorNotice={contributorBuildsOn()}
    />
  );
  if (!paired) return room({});
  return (
    <PairedRun run={paired.run} canLink={paired.canLink} buildId={data.build.id}>
      {room({ pairFeed: <PairedFeed />, pairPanel: <PairedPanel /> })}
    </PairedRun>
  );
}
