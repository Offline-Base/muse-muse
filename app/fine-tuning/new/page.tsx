import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { connection } from "next/server";
import { limitCeilings } from "@/app/api/train/shared";
import { TrainComposer } from "@/components/train/compose/TrainComposer";
import { env } from "@/lib/env";
import { visitorJobCeilings, visitorLimits } from "@/lib/train/public/limits";
import { buildForTune } from "@/lib/train/tune/build-source";
import { FROM_BUILD_PARAM } from "@/lib/train/tune/from-build";
import { pageViewer } from "../viewer";

export const metadata: Metadata = { title: "New fine-tune" };

/**
 * A new fine-tune, as simple as a new build (docs/TRAINING.md "Fine-tune like a build"). Off with TUNE_COMPOSER: a 404
 * for everyone. On: admins only today (open-train opens it to visitors later); anyone else goes to /fine-tuning, which
 * shows them the read-only Lab. With ?fromBuild=<build id> and TUNE_FROM_BUILDS on, the plan is drafted for that
 * build's product (POST /api/train/plan {fromBuildId}), and the box opens with what the build room's row wrote into it.
 */
/*
 * With OPEN_TRAIN on, anyone gets the composer, within the visitor limits (lib/train/public/limits.ts), and Start asks for
 * the start code. TUNE_FOLDER adds the folder drop.
 */
export default async function NewFineTunePage({ searchParams }: { searchParams?: Promise<Record<string, string | string[] | undefined>> }) {
  await connection();
  if (!env.tuneComposer) notFound();
  const user = await pageViewer();
  if (!user?.isAdmin) {
    if (!env.openTrain) redirect("/fine-tuning");
    const limits = visitorLimits();
    return (
      <TrainComposer
        defaultExamples={Math.min(env.tuneDefaultExamples, limits.datasetMaxRows)}
        ceilings={visitorJobCeilings(limits)}
        visitor={{ maxExamples: limits.datasetMaxRows, maxSteps: limits.job.maxSteps }}
        folder={env.tuneFolder}
        codeUnset={!env.tuneStartCode}
        fireworks={env.fireworksTune}
      />
    );
  }
  // ?fromBuild=<id> (TUNE_FROM_BUILDS): the build room's "Its own model" opened this, so the plan is for that product.
  const asked = (await searchParams)?.[FROM_BUILD_PARAM];
  const build = env.tuneFromBuilds && typeof asked === "string" ? await buildForTune(asked).catch(() => null) : null;
  const fromBuild = build?.offers ? { id: build.buildId, name: build.productName } : null;
  return <TrainComposer fireworks={env.fireworksTune} defaultExamples={env.tuneDefaultExamples} ceilings={limitCeilings()} fromBuild={fromBuild} folder={env.tuneFolder} anyBase={env.tuneAnyBase} autoUpload={env.tuneAutoPublish && !env.hubOffReason ? (env.hfPublicSet && env.hfPublic ? "public" : "private") : null} />;
}
