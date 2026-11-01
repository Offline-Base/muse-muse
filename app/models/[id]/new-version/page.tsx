import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { connection } from "next/server";
import { limitCeilings } from "@/app/api/train/shared";
import { pageViewer } from "@/app/fine-tuning/viewer";
import { NewVersionForm } from "@/components/models/NewVersionForm";
import { SparkOpenNote } from "@/components/train/SparkOpenNote";
import { NotConnected, PageHeader } from "@/components/ui";
import { env } from "@/lib/env";
import { safeQuery } from "@/lib/queries";
import { isSparkOpenDerivative } from "@/lib/train/base";
import { recipeById } from "@/lib/train/recipes";
import { ADAPTER_RECIPE } from "@/lib/train/logic";
import { getJob, getResultJob } from "@/lib/train/store";
import { newVersionPlan } from "@/lib/train/versions";

export const metadata: Metadata = { title: "New model version" };

/**
 * A planned new version of a tuned model, admins only (POST /api/train/jobs is too): the last version's settings filled
 * in, and nothing starts until Start training is clicked. Anyone else goes back to the model's page.
 */
export default async function NewVersionPage({ params }: { params: Promise<{ id: string }> }) {
  await connection();
  const [{ id }, user] = await Promise.all([params, pageViewer()]);
  if (!user?.isAdmin) redirect(`/models/${encodeURIComponent(id)}`);

  const loaded = await safeQuery(async () => {
    // Only a judged job has a model page, so only that can have a new version from here.
    const [judged, job] = await Promise.all([getResultJob(id), getJob(id)]);
    const recipe = recipeById(ADAPTER_RECIPE);
    if (!judged || !job || !recipe) return null;
    const plan = newVersionPlan(job, recipe.params);
    return plan ? { plan, fields: recipe.params, sparkOpen: isSparkOpenDerivative({ params: job.params }) } : null;
  });
  if (!loaded.ok) {
    return (
      <div className="page">
        <NotConnected reason={loaded.reason} what="this model" />
      </div>
    );
  }
  if (!loaded.data) notFound();
  const { plan, fields, sparkOpen } = loaded.data;
  const pick = (key: string) => {
    const f = fields.find((x) => x.key === key);
    return f && plan.params[key] !== undefined ? { key, label: f.label, min: f.min, max: f.max, value: Number(plan.params[key]) } : null;
  };
  const tunable = [pick("maxSteps"), pick("epochs"), pick("learningRate")].flatMap((f) => (f ? [f] : []));
  const ceilings = limitCeilings();

  return (
    <div className="page">
      <PageHeader title="Train a new version" subtitle={plan.title} />
      <NewVersionForm plan={plan} tunable={tunable} limits={{ maxActive: env.trainMaxActive, dailyUsd: env.trainDailyUsd }} capUsd={Math.min(plan.maxUsd, ceilings.maxUsd)} capMinutes={Math.min(plan.maxMinutes, ceilings.maxMinutes)} />
      {sparkOpen ? <SparkOpenNote what="The new version" compact /> : null}
    </div>
  );
}
