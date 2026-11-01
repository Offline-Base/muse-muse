import { assetBlobPath, handleAsset } from "@/lib/caps/media/assets";
import { env } from "@/lib/env";
import { hitRateLimits } from "@/lib/gateway/store";
import { localFilesEnabled } from "@/lib/local-files";
import { localFilePaths } from "@/lib/storage";

// Vetted large files for products' pages, by sha256 (lib/caps/media/assets.ts, docs/CAPABILITIES.md section 14).
// 404 unknown_endpoint while no cap that lists files is on. Served caps, not the brief's enabled ones (2.4a), so a live
// product's files keep loading whatever the builder snapshot has.
export const runtime = "nodejs";

const deps = {
  enabledCaps: () => env.servedCaps,
  hitRateLimits,
  localPath: (sha256: string) => (localFilesEnabled() ? localFilePaths(assetBlobPath(sha256)).file : null),
};

async function handle(req: Request, { params }: { params: Promise<{ sha256: string }> }) {
  const { sha256 } = await params;
  return handleAsset(req, sha256, deps);
}

export const GET = handle;
export const HEAD = handle;
export const OPTIONS = handle;
export const POST = handle;
