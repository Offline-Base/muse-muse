import Link from "next/link";
import { TrainStatusPill } from "@/components/train/TrainStatusPill";
import { errorHeadline, gpuName, jobElapsedMs, liveCostUsd } from "@/components/train/format";
import { dateTimeUtc, relativeTime, shortDuration, truncate, usd } from "@/lib/format";
import { isTrainTerminal, type RecipeView, type TrainJobView } from "@/lib/train/types";

/** The jobs list in the Usage page's table style: title, recipe, GPU, status, time, cost and when it started. */
export function JobsTable({
  jobs,
  recipes,
  now,
  caption,
}: {
  jobs: TrainJobView[];
  recipes: RecipeView[];
  now: number;
  caption: string;
}) {
  const recipeOf = (id: string) => recipes.find((r) => r.id === id) ?? null;
  return (
    <div className="table-wrap">
      <table className="data data-list">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Job</th>
            <th scope="col">Recipe</th>
            <th scope="col">GPU</th>
            <th scope="col">Status</th>
            <th scope="col" className="num">
              Time
            </th>
            <th scope="col" className="num">
              Cost (est.)
            </th>
            <th scope="col">Started</th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((j) => {
            const recipe = recipeOf(j.recipe);
            const ms = jobElapsedMs(j, now);
            return (
              <tr key={j.id}>
                <td>
                  <Link href={`/fine-tuning/${j.id}`} className="row-title">
                    {j.title}
                  </Link>
                  {j.error && j.status === "failed" ? (
                    <span className="row-sub train-row-error">{truncate(errorHeadline(j.error), 90)}</span>
                  ) : null}
                </td>
                <td>{recipe?.title ?? j.recipe}</td>
                <td className="train-nowrap">{gpuName(recipe, j.instanceType)}</td>
                <td>
                  <TrainStatusPill status={j.status} stopRequested={j.stopRequested} />
                </td>
                <td className="num">{ms || isTrainTerminal(j.status) ? shortDuration(ms) : ""}</td>
                <td className="num">{usd(liveCostUsd(j, now))}</td>
                <td className="train-nowrap">
                  <time dateTime={j.createdAt} title={dateTimeUtc(j.createdAt)}>
                    {relativeTime(j.createdAt, now)}
                  </time>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
