import { clearFilesBuild, clearLiveFiles, productTakenDown, sweepFiles, type RemoveBlobs } from "@/lib/caps/files/store";

/**
 * The files cap's cleanup (docs/CAPABILITIES.md, 2.9 and section 10), registered in lib/caps/cleanup.ts. Blobs go first,
 * then their rows, so a file whose blob couldn't be removed is still found by the next sweep. The Blob backend is loaded
 * only when there is something to remove, so the cleanup registry stays light for everything that imports it.
 */
const removeBlobs: RemoveBlobs = async (store, paths) => {
  if (!paths.length) return;
  const { filesBlob } = await import("@/lib/caps/files/blob");
  await filesBlob.remove(store, paths);
};

/** A build ended: its test files, index and dataset reads go. */
export const filesBuildEnded = (buildId: string) => clearFilesBuild(buildId, removeBlobs);

/**
 * A product was turned off or taken down. Taken down (unit 1) deletes its live files and index, since that is what a
 * report about its content asks for (section 10, Guards). Turned off by an admin's switch, which can be undone, keeps
 * them: the gateway already serves none of them while it is off.
 */
export async function filesProductOff(productId: string): Promise<void> {
  if (await productTakenDown(productId)) await clearLiveFiles(productId, removeBlobs);
}

/** The hourly sweep. */
export const filesSweep = (now: Date) => sweepFiles(now, removeBlobs);
