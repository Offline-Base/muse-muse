import { issueSignedToken } from "@vercel/blob";
import { handleUploadPresigned } from "@vercel/blob/client";
import { z } from "zod";
import { gone, isJobId, jobFolder, labGate, readJson, unauthorized, uploadRule, type UploadRule } from "@/lib/native/agent-http";
import { bearerToken } from "@/lib/native/lab-token";
import { localFilesEnabled } from "@/lib/local-files";
import { NO_CALLBACK_KEY } from "@/lib/pipeline/inspo-upload";
import { ownedJob } from "@/lib/native/queue";
import { blobAuth } from "@/lib/storage";
import { env } from "@/lib/env";

// Upload slots for a job's files, all at once, near the end of the job. Each pathname comes from the job row and each slot
// allows one file of one type and size. A file with no slot is skipped with a warning, and the job still finishes.
export const runtime = "nodejs";
export const maxDuration = 30;

const UPLOAD_TTL_MS = 15 * 60_000;
/** Blob's multipart threshold, as in lib/storage.ts. */
const MULTIPART_BYTES = 16 * 1024 * 1024;

const UploadBody = z.object({
  files: z
    .array(z.object({ name: z.string().max(64), contentType: z.string().max(80), bytes: z.number().int().min(0), sha256: z.string().max(128).optional() }))
    .max(16),
});

/**
 * A slot on Vercel Blob. Production has no read-write token, only OIDC, so this asks Blob for a delegation scoped to this
 * one pathname with its limits, as lib/pipeline/inspo-upload.ts does. A retried job writes to the same pathnames.
 */
async function blobSlot(req: Request, name: string, pathname: string, rule: UploadRule, bytes: number) {
  const multipart = bytes > MULTIPART_BYTES;
  const limits = { allowedContentTypes: [rule.contentType], maximumSizeInBytes: rule.maxBytes };
  const token = await issueSignedToken({
    pathname,
    operations: ["put"],
    validUntil: Date.now() + UPLOAD_TTL_MS,
    ...limits,
    ...blobAuth(),
  });
  const reply = await handleUploadPresigned({
    body: { type: "blob.generate-presigned-url", payload: { pathname, clientPayload: null, multipart } },
    request: req,
    webhookPublicKey: process.env.BLOB_WEBHOOK_PUBLIC_KEY || NO_CALLBACK_KEY,
    getSignedToken: async () => ({ token, urlOptions: { ...limits, addRandomSuffix: false, allowOverwrite: true } }),
  });
  return { name, method: "blob" as const, pathname, multipart, presignedUrlPayload: (reply as { presignedUrlPayload: unknown }).presignedUrlPayload };
}

/** A slot on the local dev server, which has no Blob store. Its route refuses to exist anywhere else. */
function localSlot(jobId: string, jobToken: string, name: string, pathname: string) {
  return {
    name,
    method: "put" as const,
    pathname,
    url: `${env.platformUrl}/api/native/agent/jobs/${jobId}/files/${encodeURIComponent(name)}`,
    headers: { authorization: `Bearer ${jobToken}` },
  };
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const off = labGate();
  if (off) return off;
  const token = bearerToken(req);
  if (!token) return unauthorized();
  const { id } = await params;
  const job = isJobId(id) ? await ownedJob(id, token) : null;
  if (!job) return gone();
  const parsed = UploadBody.safeParse(await readJson(req, 16 * 1024));
  if (!parsed.success) return Response.json({ error: "bad_request" }, { status: 400 });

  const folder = jobFolder(job);
  const named = new Set<string>();
  const uploads = await Promise.all(
    parsed.data.files.map(async (file) => {
      const rule = uploadRule(file.name);
      if (!rule || named.has(file.name) || file.contentType !== rule.contentType || file.bytes > rule.maxBytes) return null;
      named.add(file.name);
      const pathname = `${folder}${file.name}`;
      if (localFilesEnabled()) return localSlot(job.id, token, file.name, pathname);
      try {
        return await blobSlot(req, file.name, pathname, rule, file.bytes);
      } catch (err) {
        console.error(`[native/upload] no slot for ${file.name}:`, err instanceof Error ? err.message : err);
        return null;
      }
    }),
  );
  return Response.json({ uploads: uploads.filter(Boolean) });
}
