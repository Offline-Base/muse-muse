/**
 * A fake control plane with the rover enrolled, for the rover's tests: /api/nodes, a node's exec action and /api/jobs/{id}
 * as jetson-infra's routes give them, and a board that answers each kind of command the rover sends. Its token read does
 * the same arithmetic as SEAL_PY in lib/device/rover.ts, which was checked once against the real Python.
 */
import { createDiffieHellman, createHash, createHmac } from "node:crypto";
import { gunzipSync } from "node:zlib";

// As the kit prints it. Not imported from lib/device/rover.ts, so a route test can mock what that file loads first.
const REPORT_MARKER = "MUSE_ROVER_REPORT ";

export const FLEET_URL = "https://fleet.example.com/admin";
/** Test values, not real tokens. */
export const FLEET_TOKEN = "jpt_made_up_fleet_token";
export const BOARD_TOKEN = "made-up-board-token-0123456789-abcdefghijkl";

/** As muse-device/rover/setup-rover.sh ends: its steps' words by name, and selftest.py's report. */
export const REPORT = {
  ok: true,
  steps: { tools: "ok", config: "ok", packages: "skipped: already there", app: "ok", server: "ok", self_test: "ok" },
  self_test: {
    ok: true,
    checks: { server: "ok", sketch: "ok", ranges: "ok", left_wheel: "ok, 41 ticks", photo: "skipped: no camera is attached" },
    seen: { ranges: { front_mm: 412, left_mm: null, right_mm: 233, sensors: { front: "ok", left: "clear", right: "ok" } }, left_ticks: 41 },
  },
};

export interface FakeJob {
  id: string;
  command: string;
  timeoutS: number;
  reads: number;
}

export interface FakeFleet {
  doFetch: typeof fetch;
  jobs: FakeJob[];
  requests: Array<{ method: string; path: string; authorization: string | null; redirect: RequestRedirect | undefined }>;
  /** What the board answers for a command: output and exit code. Replace to make a step fail. */
  board: (command: string) => { output: string; exit: number | null; status?: string; error?: string };
  /** How many reads of a job still say running. */
  readsRunning: number;
  online: boolean;
  status: number | null;
}

const hex = (n: bigint) => n.toString(16);

/** What SEAL_PY prints for this command and token. */
export function sealLikeTheBoard(command: string, token: string): string {
  const [, a, p] = command.match(/'arduino' ([0-9a-f]+) ([0-9a-f]+) \d+$/)!;
  const board = createDiffieHellman(Buffer.from(p!, "hex"), Buffer.from([2]));
  board.generateKeys();
  const shared = board.computeSecret(Buffer.from(a!, "hex"));
  const key = createHash("sha256").update(hex(BigInt(`0x${shared.toString("hex")}`))).digest();
  const t = Buffer.from(token);
  const pad = Buffer.concat(Array.from({ length: Math.floor(t.length / 32) + 1 }, (_, i) => createHmac("sha256", key).update(Buffer.concat([Buffer.from("pad"), Buffer.from([i])])).digest()));
  const c = Buffer.from(t.map((byte, i) => byte ^ pad[i]!));
  const m = createHmac("sha256", key).update(Buffer.concat([Buffer.from("mac"), c])).digest("hex");
  return `MUSE_ROVER_SEALED ${JSON.stringify({ b: hex(BigInt(`0x${board.getPublicKey("hex")}`)), c: c.toString("hex"), m })}\n`;
}

/** The kit a setup's commands carry, put back together the way the board does. */
export function kitFrom(jobs: FakeJob[]): Array<{ path: string; mode: number; text?: string }> {
  const install = jobs.find((job) => job.command.startsWith("# mm-rover-setup "))!.command;
  const inline = install.match(/<<'KIT'\n([A-Za-z0-9+/=]+)\nKIT/);
  const base64 = inline
    ? inline[1]!
    : jobs
        .filter((job) => job.command.startsWith("# mm-rover-kit "))
        .map((job) => job.command.match(/printf %s '([A-Za-z0-9+/=]+)'/)![1]!)
        .join("");
  return (JSON.parse(gunzipSync(Buffer.from(base64, "base64")).toString()) as { files: Array<{ path: string; mode: number; text?: string }> }).files;
}

export function fakeFleet(): FakeFleet {
  const fleet: FakeFleet = {
    jobs: [],
    requests: [],
    readsRunning: 1,
    online: true,
    status: null,
    board: (command) => {
      if (command.startsWith("# mm-rover-kit ")) return { output: "", exit: 0 };
      if (command.startsWith("# mm-rover-token")) return { output: sealLikeTheBoard(command, BOARD_TOKEN), exit: 0 };
      if (command.startsWith("# mm-rover-setup ")) return { output: `Unpacked 6 files.\ntools:       ok\nself_test:   ok\n${REPORT_MARKER}${JSON.stringify(REPORT)}\n`, exit: 0 };
      return { output: "", exit: 127 };
    },
    doFetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const path = url.pathname.replace(/^\/admin/, "");
      const method = init?.method ?? "GET";
      fleet.requests.push({ method, path, authorization: new Headers(init?.headers).get("authorization"), redirect: init?.redirect });
      if (fleet.status !== null) return new Response("{}", { status: fleet.status });
      if (path === "/api/nodes") return Response.json([{ id: "nd_other", name: "jetson-02", status: "online" }, { id: "nd_rover", name: "ArduinoQ-01", status: fleet.online ? "online" : "offline" }]);
      const action = path.match(/^\/api\/nodes\/([^/]+)\/actions$/);
      if (action && method === "POST") {
        const body = JSON.parse(String(init?.body)) as { action: string; params: { command: string }; timeout_s: number };
        if (action[1] !== "nd_rover" || body.action !== "exec") return new Response("{}", { status: 400 });
        const job: FakeJob = { id: `jb_${fleet.jobs.length + 1}`, command: body.params.command, timeoutS: body.timeout_s, reads: 0 };
        fleet.jobs.push(job);
        return Response.json({ id: job.id, action: "exec", params: body.params, status: "running", tasks: [{ status: "queued", output: "", result: null, error: null }] });
      }
      const read = path.match(/^\/api\/jobs\/([^/]+)$/);
      if (read) {
        const job = fleet.jobs.find((j) => j.id === read[1]);
        if (!job) return new Response("{}", { status: 404 });
        job.reads++;
        const params = { command: job.command };
        if (job.reads <= fleet.readsRunning) {
          // As setup-rover.sh prints its steps, with a line from the config step that isn't one.
          const progress = `$ ${job.command}\ntools:       ok\nconfig:      ok\n             pins: pwma=D5\ngroups:      ok\n`;
          return Response.json({ id: job.id, params, status: "running", tasks: [{ status: "running", output: progress, result: null, error: null }] });
        }
        const done = fleet.board(job.command);
        const status = done.status ?? "succeeded";
        return Response.json({
          id: job.id,
          params,
          status: status === "succeeded" ? "succeeded" : "failed",
          tasks: [{ status, output: `$ ${job.command}\n${done.output}`, result: done.exit === null ? null : { exit_code: done.exit, output: done.output }, error: done.error ?? null }],
        });
      }
      return new Response("{}", { status: 404 });
    }) as typeof fetch,
  };
  return fleet;
}
