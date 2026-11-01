/** A demo window's row, as lib/caps/gpu reads it (table glimmer_windows, migration 0025). */
export interface GlimmerWindow {
  id: string;
  startsAt: Date;
  endsAt: Date;
  createdBy: string | null;
  capUsd: number;
  status: "open" | "closing" | "closed" | "failed";
  costUsd: number | null;
  adapterJobId: string;
  serveJobId: string | null;
  sparkOpen: boolean;
  reservationId: string | null;
  createdAt: Date;
}

/** A product's own tuned model, the contract's ownModelFor answer. */
export interface OwnModel {
  adapterJobId: string;
  trainChannel: 0 | 1;
}
