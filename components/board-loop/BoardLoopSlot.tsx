import Link from "next/link";
import { BoardLoopStart } from "@/components/board-loop/BoardLoopStart";
import { boardLabel, judgedProblem } from "@/lib/board-loop/logic";
import { latestLoopOf } from "@/lib/board-loop/store";
import { env } from "@/lib/env";
import { getJob } from "@/lib/train/store";

/** On a tune's admin view, with BOARD_LOOP on: the one button that takes a judged model to a board. Nothing with it off. */
export async function BoardLoopSlot({ jobId }: { jobId: string }) {
  if (!env.boardLoop) return null;
  const [job, latest] = await Promise.all([getJob(jobId), latestLoopOf(jobId)]);
  if (job?.recipe !== "glimmer-lora") return null;
  const problem = judgedProblem(job);
  const target = env.boardLoopTarget;
  return (
    <div className="page" style={{ paddingTop: 0 }}>
      <section className="card section-card" aria-labelledby="board-loop-title">
        <h2 id="board-loop-title">Put it on a board</h2>
        <p>
          One button: makes the file, sends it, serves it, runs the fixed test set, records a clip and opens a try page.{" "}
          {target === "simulated" ? "This site is set to the simulated board: canned text, no model and no GPU." : `This site is set to: ${boardLabel(target)}.`}
        </p>
        {problem ? <p>{problem}</p> : <BoardLoopStart adapterJobId={jobId} simulated={target === "simulated"} />}
        {latest ? (
          <p>
            <Link href={`/fine-tuning/board-loop/${latest.id}`}>See the latest run ({latest.status})</Link>
          </p>
        ) : null}
      </section>
    </div>
  );
}
