import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { connection } from "next/server";
import { limitCeilings } from "@/app/api/train/shared";
import { TrainComposer } from "@/components/train/compose/TrainComposer";
import { env } from "@/lib/env";
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
export default async function NewFineTunePage({ searchParams }: { searchParams?: Promise<Record<string, string | string[] | undefined>> }) {
  await connection();
  if (!env.tuneComposer) notFound();
  const user = await pageViewer();
  if (!user?.isAdmin) redirect("/fine-tuning");
  // ?fromBuild=<id> (TUNE_FROM_BUILDS): the build room's "Its own model" opened this, so the plan is for that product.
  const asked = (await searchParams)?.[FROM_BUILD_PARAM];
  const build = env.tuneFromBuilds && typeof asked === "string" ? await buildForTune(asked).catch(() => null) : null;
  const fromBuild = build?.offers ? { id: build.buildId, name: build.productName } : null;
  return <TrainComposer defaultExamples={env.tuneDefaultExamples} ceilings={limitCeilings()} fromBuild={fromBuild} autoUpload={env.tuneAutoPublish && !env.hubOffReason ? (env.hfPublicSet && env.hfPublic ? "public" : "private") : null} />;
}
