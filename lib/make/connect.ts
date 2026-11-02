/**
 * How the app and the model of a "both" request connect, honestly (docs/TRAINING.md "One box for everything"). Starting
 * both never rewires anything. "window": the run is linked to the product, so the product may ask for it through the GPU
 * capability's askGlimmer once it has passed and a serving window is open with it. "none": they only sit side by side.
 * Pure, so the routes and the pages share the words.
 */
export type ConnectMode = "window" | "none";

/** Runs for a product stay admin only and behind TUNE_FROM_BUILDS, and a product can only ask with the GPU capability on. */
export function connectMode(i: { isAdmin: boolean; fromBuilds: boolean; gpuForBuilds: boolean }): ConnectMode {
  return i.isAdmin && i.fromBuilds && i.gpuForBuilds ? "window" : "none";
}

export const WHILE_TRAINING = "While the model trains, the app answers with what its own plan picks, the same as any build. It doesn't wait for the model.";

export function connectWords(mode: ConnectMode): string {
  return mode === "window"
    ? "This is a link, not a switch. The app can ask for this model only if its plan picks Muse Glimmer, once the model has passed its scoring and a serving window is open with it. Until then it says its own model isn't ready."
    : "This is only a link between two pages. The app won't start using the tuned model by itself: you get the app and a scored model side by side.";
}

/** A note for the build, so its brief can pick Muse Glimmer, only where it could really use it. */
export function appNoteFor(appNote: string, mode: ConnectMode): string {
  return mode === "window" ? `${appNote}\n\nIt should ask for its own tuned Muse Glimmer through the hosted Muse Glimmer, and say plainly when that isn't ready yet.` : appNote;
}
