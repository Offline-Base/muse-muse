import { requireUser } from "@/lib/auth";
import { errorJson, route } from "@/lib/http";
import { isSafeFileKey, localFilesEnabled } from "@/lib/local-files";
import { INSPO_CONTENT_TYPES, MAX_REFERENCE_BYTES } from "@/lib/pipeline/references";
import { putFile } from "@/lib/storage";

function allowedType(contentType: string): boolean {
  return INSPO_CONTENT_TYPES.some((t) => (t.endsWith("/*") ? contentType.startsWith(t.slice(0, -1)) : contentType === t));
}

/**
 * POST multipart {file, pathname: "inspo/..."} -> 200 {url}. Local runs only (lib/local-files.ts): the stand-in for
 * the Blob client upload in /api/inspirations/upload, with the same rules for path, type and size. 404 on Vercel.
 */
export const POST = route(async (req: Request) => {
  if (!localFilesEnabled()) return errorJson(404, "not_found");
  await requireUser();
  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  const pathname = form?.get("pathname");
  if (!(file instanceof File) || typeof pathname !== "string") return errorJson(400, "Send a file and its pathname.");
  if (!pathname.startsWith("inspo/") || pathname.length > 300 || !isSafeFileKey(pathname)) {
    return errorJson(400, "Inspo uploads must go under inspo/.");
  }
  const contentType = file.type || "application/octet-stream";
  if (!allowedType(contentType)) return errorJson(400, `Files of type ${contentType} can't be used as inspo.`);
  if (file.size > MAX_REFERENCE_BYTES) return errorJson(400, "That file is over the 100 MB limit.");
  const url = await putFile("inspo", pathname.slice("inspo/".length), Buffer.from(await file.arrayBuffer()), contentType);
  return Response.json({ url });
});
