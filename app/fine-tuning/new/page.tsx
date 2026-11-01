import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { connection } from "next/server";
import { limitCeilings } from "@/app/api/train/shared";
import { TrainComposer } from "@/components/train/compose/TrainComposer";
import { env } from "@/lib/env";
import { pageViewer } from "../viewer";

export const metadata: Metadata = { title: "New fine-tune" };

/**
 * A new fine-tune, as simple as a new build (docs/TRAINING.md "Fine-tune like a build"). Off with TUNE_COMPOSER: a 404
 * for everyone. On: admins only today (open-train opens it to visitors later); anyone else goes to /fine-tuning, which
 * shows them the read-only Lab.
 */
export default async function NewFineTunePage() {
  await connection();
  if (!env.tuneComposer) notFound();
  const user = await pageViewer();
  if (!user?.isAdmin) redirect("/fine-tuning");
  return <TrainComposer defaultExamples={env.tuneDefaultExamples} ceilings={limitCeilings()} />;
}
