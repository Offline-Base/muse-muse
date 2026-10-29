/**
 * Flash drive order requests (docs/VIBE_TUNING.md, Feature 6). Someone asks for a tuned model on a USB stick; the site
 * takes no payment. The owner emails an invoice, marks the order paid, flashes the stick on a bench Mac
 * (scripts/drive-bench.ts) and ships it. Types only, so lib/db/schema.ts can import them without pulling in logic.
 */
import type { QuantLevel } from "@/lib/train/local-files";

/**
 * Where an order stands. The admin moves it to invoiced, paid, shipped and delivered (or cancels it), the bench script
 * to flashing and checked, and the buyer may cancel it until it is flashing. lib/drive/logic.ts holds the moves.
 */
export type DriveStatus =
  | "requested" // the buyer sent the request, nothing is charged
  | "invoiced" // the owner emailed an invoice
  | "paid" // the invoice is paid: in the bench queue
  | "flashing" // the bench is writing a stick for it
  | "checked" // the stick was read back after a replug and every file matched
  | "shipped" // on its way, with the carrier and tracking number
  | "delivered"
  | "cancelled";

export const DRIVE_STATUSES: readonly DriveStatus[] = [
  "requested",
  "invoiced",
  "paid",
  "flashing",
  "checked",
  "shipped",
  "delivered",
  "cancelled",
];

/** "all" puts every build that passed its file checks on a 64 GB stick; one level fits a 32 GB stick. */
export type DriveBuild = "all" | QuantLevel;

/** A US shipping address. v1 takes US addresses only: a two-letter state and a 5 or 9 digit ZIP. */
export interface DriveAddress {
  line1: string;
  line2?: string;
  city: string;
  state: string;
  postalCode: string;
}

/** One GGUF file that goes on the drive, as the GGUF repo has it at the order's commit. */
export interface DriveFile {
  level: QuantLevel;
  name: string;
  bytes: number;
  sha256: string;
}

/**
 * What the drive needs to know about the model besides its files, saved with the order so the bench never depends on
 * what the platform answers later: the title, the slug, the system message it was trained with, and whether it needs
 * tuned.jinja from the repo (an adapter trained before trainChannel).
 */
export interface DriveModel {
  title: string;
  slug: string;
  systemLine: string;
  needsTunedTemplate: boolean;
  quantJobId: string;
}

/** Who moves an order: the buyer (holding the order link), an admin, or the bench script (its token). */
export type DriveActor = "buyer" | "admin" | "bench";

export type VerifyResult = "PASS" | "FAIL";
