/**
 * The simulated board a build gets for the product drive tools (docs/CAPABILITIES.md 2.7, unit 12): a short export that
 * ends in PASS, so builds and judge checks never touch hardware. Its answers carry simulated: true. The gateway's drive tools
 * (drive_status, export_to_drive) answer a build token from it, through lib/device/drive-product.ts.
 */
import type { DriveStatusReply, ExportState, ExportStatus } from "@/lib/device/drive";

/** How long each step of the simulated export lasts, in seconds, from the call that started it. */
const STEPS: ReadonlyArray<{ until: number; state: ExportState; message: string }> = [
  { until: 2, state: "checking", message: "Checking Simulated USB stick." },
  { until: 6, state: "writing", message: "Writing to Simulated USB stick." },
  { until: 8, state: "verifying", message: "Reading every file back from the drive." },
];

const TOTAL_BYTES = 650_000_000;

const SIM_DRIVE = { name: "sda", title: "Simulated USB stick", bytes: 32e9, kind: "USB stick", filesystem: "exfat", label: "MUSEMUSE", identity: "5157500000000000" };

/** drive_status for a build: a simulated stick and, once one was started at `startedAt` (ms), its export as of `now`. */
export function simulatedDriveStatus(startedAt: number | null, now: number): DriveStatusReply & { simulated: true } {
  const drives = [{ ...SIM_DRIVE, free: 31e9, read_only: false, usable: true, why: null }];
  if (startedAt === null) return { simulated: true, drives, export: null, runs: [] };
  const seconds = Math.max(0, (now - startedAt) / 1000);
  const step = STEPS.find((s) => seconds < s.until);
  const writing = step?.state === "writing" ? Math.min(1, (seconds - 2) / 4) : step ? 0 : 1;
  const exp: ExportStatus = step
    ? { export: "exp_51a1a7ed0000", state: step.state, message: step.message, drive: SIM_DRIVE, done_bytes: Math.round(TOTAL_BYTES * writing), total_bytes: TOTAL_BYTES, mbps: 60 }
    : { export: "exp_51a1a7ed0000", state: "done", message: "Done: PASS. Safe to unplug.", drive: SIM_DRIVE, done_bytes: TOTAL_BYTES, total_bytes: TOTAL_BYTES, result: "PASS", problems: [], seconds: 8 };
  return { simulated: true, drives: step ? drives : [], export: exp, runs: [] };
}
