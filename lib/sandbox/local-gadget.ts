import { readFileSync } from "node:fs";
import path from "node:path";
import { env } from "@/lib/env";
import { SIM_AUDIO_WAV_BASE64, SIM_PHOTO_JPEG_BASE64 } from "@/lib/gateway/gadget-sim-media";
import { publicHost } from "@/lib/sandbox/policy";
import { gadgetConnectUsable } from "@/lib/caps/hardware/flags";

/**
 * A local run's stand-in for the gateway's simulated board (docs/GADGETS.md). On a local run the sandbox can't reach this
 * machine's gateway, so a product's gadget calls hit the build firewall and every board looks missing. These replies are the
 * ones SIMULATED_BOARD gives a build token, and a test in lib/gateway/__tests__ holds them together. A deployed platform has
 * a public gateway and never writes these files.
 */
export const LOCAL_BOARD_REPLIES = {
  describe_device: [
    {
      type: "text",
      text: JSON.stringify({
        simulated: true,
        model: "Simulated Muse Muse gadget",
        cameras: [{ device: "/dev/video0", name: "Simulated camera" }],
        microphones: [{ device: "plughw:0,0", name: "Simulated microphone" }],
      }),
    },
  ],
  capture_image: [{ type: "image", data: SIM_PHOTO_JPEG_BASE64, mimeType: "image/jpeg" }],
  record_audio: [
    { type: "text", text: JSON.stringify({ seconds: 3, sample_rate: 16000, simulated: true }) },
    { type: "audio", data: SIM_AUDIO_WAV_BASE64, mimeType: "audio/wav" },
  ],
};

const CALL = "async function callGadget(tool: string, args: Record<string, unknown>, request?: RequestLike | null): Promise<GadgetReply> {";

/**
 * Header a local build's test sends to get the gateway's real no-board answer, the only way to reach that path here.
 * Exact words from noBoard() in lib/gateway/gadget.ts.
 */
const LOCAL_CALL = `${CALL}
  // Written by the Muse Muse platform for a local run only: the simulated board, as the gateway gives builds. A test can send
  // the header x-musemuse-test-board: offline on a request to get what a live product with no board gets.
  const headers = (request as { headers?: { get?(name: string): string | null } } | null | undefined)?.headers;
  if (headers?.get?.("x-musemuse-test-board") === "offline") {
    throw new GadgetError("No gadget is connected to this product right now. Connect one in Muse Muse, then try again.", "gadget_offline", 503);
  }
  const local = LOCAL_BOARD_REPLIES[tool as keyof typeof LOCAL_BOARD_REPLIES];
  if (local) return { content: local as Content[], isError: false, simulated: true };
`;

export function patchGadgetForLocalRun(source: string): string {
  if (!source.includes(CALL)) throw new Error("template/lib/meta/gadget.ts no longer has the call this patches.");
  return `import { LOCAL_BOARD_REPLIES } from "@/lib/meta/gadget-local";\n${source.replace(CALL, LOCAL_CALL)}`;
}

/** The files a local run's product with the gadget option gets. None for anything else. */
export function localGadgetFiles(brief: { capabilities?: ReadonlyArray<{ model: string }> } | null): Array<{ path: string; content: string }> {
  if (!brief?.capabilities?.some((c) => c.model === "muse-gadget") || publicHost(env.platformUrl) !== null) return [];
  const source = readFileSync(path.join(process.cwd(), "template/lib/meta/gadget.ts"), "utf8");
  return [
    { path: "lib/meta/gadget.ts", content: patchGadgetForLocalRun(source) },
    { path: "lib/meta/gadget-local.ts", content: `// Written by the Muse Muse platform for a local run only.\nexport const LOCAL_BOARD_REPLIES = ${JSON.stringify(LOCAL_BOARD_REPLIES)};\n` },
  ];
}

const BOARD_SEND = "async function send(tool: string, args: Record<string, unknown>, request: RequestLike | null, approval?: string): Promise<Reply> {";

/** The same stand-in for lib/platform/board.ts (GADGET_CONNECT): the simulated model and robot, from lib/gateway/gadget-sim.ts. */
const BOARD_LOCAL = `// Written by the Muse Muse platform for a local run only: the simulated board, as the gateway gives builds.
import { newSimRobot, robotActionLines, robotActionProblem, SIM_TARGET, simulatedAnswer } from "./gadget-sim";

const robot = newSimRobot();
const text = (value: unknown) => ({ content: [{ type: "text", text: JSON.stringify(value) }], isError: false, simulated: true });
const asked = new Set<string>();
const OFFLINE = "Your board isn't connected, so this can't run on it right now. Turn the board on, or pair it in Muse Muse, then try again.";

export function localBoardOffline(): string {
  return OFFLINE;
}

export function localBoard(tool: string, args: Record<string, unknown>, approval?: string) {
  if (tool === "ask_board") return text({ text: simulatedAnswer(SIM_TARGET.id, args.messages as Array<{ role: string; content: string }>), target: SIM_TARGET.label });
  if (tool === "robot_status") return text(robot.status());
  if (tool === "hard_stop") return text({ ...robot.stop(), stopped: true });
  if (tool === "read_sensor") return text({ simulated: true, sensors: robot.status().sensors });
  if (tool === "show_text") return text({ simulated: true, shown: args.text });
  if (tool === "robot_action") {
    const problem = robotActionProblem(args.action, args.args);
    if (problem) return { content: [{ type: "text", text: problem }], isError: true, simulated: true };
    const action = args.action as string;
    const values = args.args as Record<string, number>;
    if (!approval || !asked.delete(approval)) {
      const id = "local-" + Math.random().toString(36).slice(2);
      asked.add(id);
      return text({ ok: false, code: "needs_confirmation", approval: { id, ...robotActionLines(action, values) } });
    }
    const done = robot.act(action, values);
    return typeof done === "string" ? text({ ok: false, code: "stopped", message: done }) : text({ ok: true, status: done });
  }
  return null;
}
`;

export function patchBoardForLocalRun(source: string): string {
  if (!source.includes(BOARD_SEND)) throw new Error("the hardware overlay's lib/platform/board.ts no longer has the call this patches.");
  return `import { localBoard, localBoardOffline } from "@/lib/platform/board-local";\n${source.replace(
    BOARD_SEND,
    `${BOARD_SEND}
  // Written by the Muse Muse platform for a local run only. A test can send the header x-musemuse-test-board: offline.
  const headers = (request as { headers?: { get?(name: string): string | null } } | null)?.headers;
  if (headers?.get?.("x-musemuse-test-board") === "offline") throw new BoardError(localBoardOffline(), "gadget_offline", 503);
  const local = localBoard(tool, args, approval);
  if (local) return local as Reply;
`,
  )}`;
}

/**
 * The hardware overlay as a local run installs it while GADGET_CONNECT is on: the board helper patched for the simulator, and its two
 * new platform files. It goes in the overlay, not the product, because verify restores platform files from there. So a local test build
 * needs no new snapshot, but a deployed site does.
 */
export function localHardwareOverlay<T extends { path: string; content: Buffer | string }>(capFiles: readonly T[]): Array<{ path: string; content: Buffer | string }> {
  const prefix = "caps/hardware/";
  const out: Array<{ path: string; content: Buffer | string }> = capFiles.filter((f) => f.path.startsWith(prefix)).map((f) => {
    if (f.path === `${prefix}files/lib/platform/board.ts`) return { path: f.path, content: patchBoardForLocalRun(f.content.toString()) };
    if (f.path === `${prefix}platform-files.json`) return { path: f.path, content: JSON.stringify([...(JSON.parse(f.content.toString()) as string[]), "lib/platform/board-local.ts", "lib/platform/gadget-sim.ts"].sort(), null, 2) };
    return { path: f.path, content: f.content };
  });
  out.push({ path: `${prefix}files/lib/platform/board-local.ts`, content: BOARD_LOCAL });
  out.push({ path: `${prefix}files/lib/platform/gadget-sim.ts`, content: readFileSync(path.join(process.cwd(), "lib/gateway/gadget-sim.ts"), "utf8") });
  return out;
}

/** True on a local run that serves board tools with GADGET_CONNECT on: the sandbox can't reach this machine's gateway. */
export const usesLocalHardwareOverlay = (overlays: readonly string[]): boolean => !process.env.VERCEL && gadgetConnectUsable() && overlays.includes("hardware") && publicHost(env.platformUrl) === null;
