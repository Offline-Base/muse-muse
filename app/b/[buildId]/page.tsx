import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { BuildRoom } from "@/components/build/BuildRoom";
import "@/components/build/plan-card.css";
import { NotConnected } from "@/components/ui";
import { env } from "@/lib/env";
import { canActAsOwner } from "@/lib/auth";
import { nativeActive } from "@/lib/native/active";
import { ownModelOffer } from "@/lib/train/tune/from-build";
import { currentUser, getBuildRoom, platformOrigin, rebuildRef, safeQuery } from "@/lib/queries";
import { withoutPlanArt } from "@/lib/pipeline/plan-art";

export const metadata: Metadata = { title: "Build room" };

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
  const canRefine = Boolean(data.product && canActAsOwner(user, data.product.ownerId));
  // Steering a running build takes the same owner powers (POST /api/builds/{id}/control), and steering switched on.
  const canSteer = env.steeringEnabled && canActAsOwner(user, data.product?.ownerId ?? data.build.userId);
  // Its own model (TUNE_FROM_BUILDS, with the tune composer on): the product's owner or an admin; planning is admins'
  // only today, as the composer is. The row itself checks the brief picked muse-glimmer and the build shipped.
  const ownModel = ownModelOffer({
    fromBuilds: env.tuneFromBuilds,
    composer: env.tuneComposer,
    hasProduct: Boolean(data.product),
    ownerOrAdmin: canRefine,
    isAdmin: user?.isAdmin === true,
    examples: env.tuneDefaultExamples,
    // limitCeilings in lib/train/gate.ts, without loading the recipes into this page.
    ceilings: { maxMinutes: env.trainJobMaxMinutes, maxUsd: env.trainJobMaxUsd },
  });

  return (
    <BuildRoom
      build={data.build}
      product={data.product}
      inspiration={data.inspiration}
      events={env.planArt ? data.events : withoutPlanArt(data.events)}
      history={data.history}
      tokens={data.tokens}
      canRefine={canRefine}
      canSteer={canSteer}
      signedIn={Boolean(user)}
      origin={origin}
      serverNow={Date.now()}
      focusRefine={sp.refine === "1"}
      rebuild={rebuildRef(data.build.rebuildOf)}
      maxFixRounds={env.maxFixRounds}
      nativeActive={await nativeActive(data.build.id)}
      ownModel={ownModel}
    />
  );
}
