/**
 * The simulated board: starts scripts/sim-board.mjs as a real local process and reaches it through the fleet driver, so the
 * loop runs the same code it will run against a real control plane, and every label says simulated. The process serves
 * canned text and holds no model. It needs a machine that keeps a process running, so on Vercel it needs BOARD_SIM_URL.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BoardOfflineError, type BoardDriver } from "@/lib/board-loop/driver";
import { fleetBoard } from "@/lib/board-loop/fleet";

const NODE = "simulated-board";
const START_WAIT_MS = 5_000;

interface SimState {
  pid: number;
  port: number;
  token: string;
}

const stateFile = () => path.join(process.env.BOARD_SIM_DIR || path.join(tmpdir(), "muse-sim-board"), "state.json");

function readState(): SimState | null {
  try {
    return JSON.parse(readFileSync(stateFile(), "utf8")) as SimState;
  } catch {
    return null;
  }
}

async function alive(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1_500) });
    return res.ok && res.headers.get("x-simulated-board") === "1";
  } catch {
    return false;
  }
}

/** Starts the process and waits for its port, or throws. */
function startProcess(): Promise<SimState> {
  const token = randomBytes(24).toString("base64url");
  const script = path.join(process.cwd(), "scripts", "sim-board.mjs");
  const child = spawn(process.execPath, [script], {
    detached: true,
    stdio: ["ignore", "pipe", "ignore"],
    // Only what it needs: this process holds the platform's secrets, and the simulated board has no use for them.
    env: { PATH: process.env.PATH, SIM_BOARD_TOKEN: token, SIM_BOARD_IDLE_S: process.env.SIM_BOARD_IDLE_S, SIM_BOARD_TPS: process.env.SIM_BOARD_TPS, SIM_BOARD_FAIL: process.env.SIM_BOARD_FAIL, SIM_BOARD_JOB_MS: process.env.SIM_BOARD_JOB_MS } as unknown as NodeJS.ProcessEnv,
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new BoardOfflineError("The simulated board didn't start.")), START_WAIT_MS);
    child.once("error", () => reject(new BoardOfflineError("The simulated board didn't start.")));
    child.stdout!.once("data", (chunk: Buffer) => {
      clearTimeout(timer);
      const { port } = JSON.parse(chunk.toString("utf8").split("\n")[0]!) as { port: number };
      child.stdout!.destroy();
      child.unref();
      const state: SimState = { pid: child.pid!, port, token };
      mkdirSync(path.dirname(stateFile()), { recursive: true, mode: 0o700 });
      writeFileSync(stateFile(), JSON.stringify(state), { mode: 0o600 });
      resolve(state);
    });
  });
}

const driverFor = (url: string, token: string): BoardDriver => fleetBoard({ url: `${url}/admin`, token, node: NODE }, "simulated");

/** A simulated board somewhere else, for a host that can't keep a process running. */
function remoteDriver(): BoardDriver | null {
  const url = process.env.BOARD_SIM_URL?.trim();
  const token = process.env.BOARD_SIM_TOKEN?.trim();
  return url && token ? driverFor(url.replace(/\/+$/, ""), token) : null;
}

/** The running simulated board, or null: the try page reads this, so a dead board shows as offline and doesn't restart. */
export async function runningSimBoard(): Promise<BoardDriver | null> {
  const remote = remoteDriver();
  if (remote) return remote;
  const state = readState();
  return state && (await alive(state.port)) ? driverFor(`http://127.0.0.1:${state.port}`, state.token) : null;
}

/** Starts the simulated board when it isn't running. Only the loop's own stages call this. */
export async function startSimBoard(): Promise<BoardDriver> {
  const running = await runningSimBoard();
  if (running) return running;
  if (process.env.VERCEL) throw new BoardOfflineError("The simulated board needs a machine that keeps a process running: set BOARD_SIM_URL and BOARD_SIM_TOKEN, or run the loop locally.");
  const state = await startProcess();
  return driverFor(`http://127.0.0.1:${state.port}`, state.token);
}

/** Ends the local simulated board, if any. For tests, and to show the offline state. */
export function stopSimBoard(): void {
  const state = readState();
  if (!state) return;
  try {
    process.kill(state.pid, "SIGTERM");
  } catch {
    // Already gone.
  }
  rmSync(stateFile(), { force: true });
}
