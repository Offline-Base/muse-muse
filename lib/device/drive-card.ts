/**
 * What the Flash drive card (components/device/DeviceDrive.tsx) offers for an export that ended without a PASS. Carrying
 * one on keeps its export id, so the board writes into the same MuseMuse/<slug>-<id> folder, keeps every file already there
 * that hashes right, and writes only what is missing or wrong (POST /api/device/drive {resume, drive, identity}).
 */
import type { BoardDrive, ExportStatus } from "@/lib/device/drive";

export type CarryOn =
  /** The card carries it on, on `drive` (null until one is plugged in or picked). */
  | { by: "card"; drive: BoardDrive | null }
  /** The owner's own file: only the owner's script can sign its link again. */
  | { by: "script" }
  | null;

/** Whether an export that ended can be carried on, and on which drive: its own when it's back, or the one picked. */
export function carryOn(status: ExportStatus | null, drives: BoardDrive[], picked: string): CarryOn {
  if (!status) return null;
  const unfinished = status.state === "failed" || status.state === "stopped" || (status.state === "done" && status.result === "FAIL");
  if (!unfinished) return null;
  if (status.source === "url") return { by: "script" };
  const usable = drives.filter((d) => d.usable);
  const own = status.drive ? usable.find((d) => d.identity === status.drive!.identity) : undefined;
  return { by: "card", drive: own ?? usable.find((d) => d.name === picked) ?? null };
}

/** The POST body that carries an export on, on a drive from the list. */
export const carryOnBody = (status: ExportStatus, drive: BoardDrive) => ({ resume: status.export, drive: drive.name, identity: drive.identity });
