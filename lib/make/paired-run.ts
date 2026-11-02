/**
 * The model run the person viewing a build room started with it, or null (docs/TRAINING.md "One box for everything"). A
 * build room is public and a run isn't, so a run shows only to whoever may touch it, and a visitor gets visitorRunView:
 * no instance, IP, log or job page. Anyone else sees the room as it always was. Server only.
 */
import { AuthError } from "@/lib/auth";
import { env } from "@/lib/env";
import { runsOfBuild } from "@/lib/make/pair";
import { getDataset } from "@/lib/train/store";
import { mayTouchRun, pageRunCaller, runCeilings, type RunCaller } from "@/lib/train/tune/caller";
import { loadTuneRun } from "@/lib/train/tune/store";
import type { TuneRunView } from "@/lib/train/tune/types";
import { visitorRunView } from "@/lib/train/tune/view";

export interface PairedRunDeps {
  caller(): Promise<RunCaller>;
  runs(buildId: string): Promise<string[]>;
  owner(runId: string): Promise<string | null | undefined | false>;
  mayTouch(caller: RunCaller, owner: string | null | undefined): Promise<boolean>;
  load(runId: string, now: Date, caller: RunCaller): Promise<TuneRunView | null>;
}

const DEPS: PairedRunDeps = {
  caller: pageRunCaller,
  runs: runsOfBuild,
  owner: async (id) => {
    const d = await getDataset(id);
    return d ? d.createdBy : false;
  },
  mayTouch: mayTouchRun,
  load: (id, now, caller) => loadTuneRun(id, now, runCeilings(caller)),
};

export interface PairedRunProps {
  run: TuneRunView;
  /** An admin can link it to the product (POST /api/make/pair). Never a visitor. */
  canLink: boolean;
}

export async function pairedRunFor(buildId: string, now: Date = new Date(), deps: PairedRunDeps = DEPS): Promise<PairedRunProps | null> {
  const ids = await deps.runs(buildId);
  if (!ids.length) return null;
  let caller: RunCaller;
  try {
    caller = await deps.caller();
  } catch (err) {
    if (err instanceof AuthError) return null;
    throw err;
  }
  for (const id of ids) {
    const owner = await deps.owner(id);
    if (owner === false || !(await deps.mayTouch(caller, owner))) continue;
    const run = await deps.load(id, now, caller);
    if (!run) continue;
    return { run: caller.visitor ? visitorRunView(run) : run, canLink: caller.isAdmin && !caller.visitor && env.tuneFromBuilds };
  }
  return null;
}
