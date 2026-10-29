/**
 * localFilesFor, the server half of the local files contract (lib/train/local-files.ts). It reads the database, so only
 * server code imports it: pages, routes and scripts. A client component that reached it would pull the store and its
 * database driver into the browser bundle, which next dev refuses with a Turbopack error on node:module.
 */
import { localFilesOf } from "@/lib/train/hub-cards";
import type { LocalFiles } from "@/lib/train/local-files";
import { latestQuantSource } from "@/lib/train/store";

/**
 * The newest glimmer-quantize job's files for this adapter that finished and passed its checks, or null when there is
 * none: a job that succeeded, had its GPU shut down, and reported its files checked and in the Hub's storage, with its
 * GGUF repo's hub state (docs/TRAINING.md "Local files"). A job whose repo is published comes before newer ones that
 * aren't, so a new run never hides files that are already out. `public` holds only while the adapter is public too.
 */
export async function localFilesFor(adapterJobId: string): Promise<LocalFiles | null> {
  const source = await latestQuantSource(adapterJobId);
  return source ? localFilesOf(source) : null;
}
