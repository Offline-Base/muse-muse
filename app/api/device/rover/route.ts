import {
  activeRoverSetup,
  isJobId,
  lastRoverReport,
  listRoverTools,
  roverBoard,
  RoverError,
  roverLogText,
  RoverNotConfiguredError,
  roverSetupState,
  setupRover,
  type RoverSetupState,
} from "@/lib/device/rover";
import { roverAdmin, roverFailure, roverOff } from "@/lib/device/rover-http";
import { env } from "@/lib/env";
import { badRequest, errorJson, readJson, route } from "@/lib/http";

// Sending the kit takes a few execs through the tunnel, and the install itself can take minutes on the board.
export const maxDuration = 300;

/** How long a POST waits on the board after sending the kit, before it hands the job back for GET ?job= to follow. */
const SETUP_WAIT_MS = 20_000;

const reply = (state: RoverSetupState) => Response.json(state, { status: state.state === "running" ? 202 : 200 });

/**
 * POST {pins?, stopMm?, invert?, reset?} -> a setup's state: sends the board kit to the rover through the fleet, runs
 * setup-rover.sh with those changes (lib/device/rover.ts, overrideFlags), and waits a little for its report. 200 {state:
 * "done", job, report} or {state: "failed", job, message}, or 202 {state: "running", job, step} for GET ?job= to follow.
 * Behind ROVER_ENABLED (404 otherwise), signed-in admins only. 400 invalid_input, 409 setup_running, 503
 * fleet_not_configured or kit_missing, 502 rover_unavailable.
 */
export const POST = route(async (req: Request) => {
  if (!env.roverEnabled) return roverOff();
  const user = await roverAdmin(req);
  const body = await readJson(req);
  try {
    const board = roverBoard();
    // A setup still going on the board, from this process, is picked up rather than started again.
    const running = activeRoverSetup(board);
    if (running) {
      const state = await roverSetupState(board, running);
      if (state.state === "running") return errorJson(409, "setup_running", { job: state.job, step: state.step });
    }
    console.info(`[device/rover] admin ${user.id} setup ${board}`);
    return reply(await setupRover(board, body, {}, { until: Date.now() + SETUP_WAIT_MS }));
  } catch (err) {
    return roverFailure(err, "device/rover");
  }
});

/**
 * GET ?job= -> that setup's state, as POST answers it. GET alone -> {board, report, reportAt, setup, answers, tools, why}:
 * the last self-test this server saw, a setup job it's following, and whether the rover's tool server answers through the
 * fleet, with the rover tools it lists. Same gate and errors as POST.
 */
export const GET = route(async (req: Request) => {
  if (!env.roverEnabled) return roverOff();
  await roverAdmin(req);
  const job = new URL(req.url).searchParams.get("job");
  try {
    const board = roverBoard();
    if (job !== null) {
      if (!isJobId(job)) throw badRequest("job isn't a job's id.");
      return reply(await roverSetupState(board, job));
    }
    const last = lastRoverReport(board);
    const status = { board, report: last?.report ?? null, reportAt: last?.at ?? null, setup: activeRoverSetup(board) };
    try {
      const tools = await listRoverTools(board);
      return Response.json({ ...status, answers: true, tools: tools.map((tool) => tool.name), why: null });
    } catch (err) {
      if (err instanceof RoverNotConfiguredError) throw err;
      if (!(err instanceof RoverError)) console.error("[device/rover]", roverLogText(err));
      return Response.json({ ...status, answers: false, tools: [], why: err instanceof RoverError ? err.message : "The rover's tool server didn't answer." });
    }
  } catch (err) {
    return roverFailure(err, "device/rover");
  }
});
