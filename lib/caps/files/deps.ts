import { liveBrief } from "@/lib/caps/data/store";
import { filesBlob } from "@/lib/caps/files/blob";
import { filesBlock, filesRule } from "@/lib/caps/files/brief";
import { datasetBlobPath, vettedDatasets } from "@/lib/caps/files/datasets";
import type { FilesDeps } from "@/lib/caps/files/handler";
import { fileById, filesStore } from "@/lib/caps/files/store";
import { buildBrief, capProduct, capToken } from "@/lib/caps/store";
import { env } from "@/lib/env";
import { acquireInFlight, hitRateLimits, releaseInFlight } from "@/lib/gateway/store";
import { localFilesEnabled } from "@/lib/local-files";
import { localFilePaths } from "@/lib/storage";

/**
 * The files cap's real wiring: Postgres, Blob and the flags, read per request. Files spend nothing at Meta, so the gate's
 * money deps aren't wired: bytes and files count in product_files, calls in rate_limits.
 */
export function filesDeps(): FilesDeps {
  return {
    servedCaps: () => env.servedCaps,
    findToken: capToken,
    product: capProduct,
    adminEmails: env.adminEmails,
    hitRateLimits,
    acquireInFlight,
    releaseInFlight,
    store: filesStore,
    blob: filesBlob,
    quotas: () => ({ productBytes: env.filesProductMb * 1024 * 1024, maxFileBytes: env.filesMaxFileMb * 1024 * 1024 }),
    searchOn: () => env.filesSearch,
    datasetsOn: () => env.filesDatasets,
    async rule(token) {
      // A build follows its own brief, a live product the brief it shipped with, which the platform wrote. The manifest,
      // which the product wrote, can't change a scope or who adds files.
      const brief = token.scope === "build" ? (token.buildId ? await buildBrief(token.buildId) : null) : await liveBrief(token.productId);
      return filesRule(filesBlock(brief as object | null));
    },
    fileById,
    datasets: () => vettedDatasets(),
    localDatasetPath: (id, file) => (localFilesEnabled() ? localFilePaths(datasetBlobPath(id, file)).file : null),
    gatewayUrl: env.gatewayUrl,
  };
}
