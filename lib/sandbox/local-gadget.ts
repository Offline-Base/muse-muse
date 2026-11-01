import { readFileSync } from "node:fs";
import path from "node:path";
import { env } from "@/lib/env";
import { SIM_AUDIO_WAV_BASE64, SIM_PHOTO_JPEG_BASE64 } from "@/lib/gateway/gadget-sim-media";
import { publicHost } from "@/lib/sandbox/policy";

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
