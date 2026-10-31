import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { gone, isJobId, jobFolder, labGate, notFound, unauthorized, uploadRule } from "@/lib/native/agent-http";
import { localFilesEnabled, localFileUrl } from "@/lib/local-files";
import { bearerToken } from "@/lib/native/lab-token";
import { ownedJob } from "@/lib/native/queue";
import { localFilePaths } from "@/lib/storage";

// A local run's stand-in for Blob: the "put" upload slot in docs/NATIVE_LAB.md. It keeps the file under .data/files, at
// the same path Blob would. Vercel and any run with a Blob store get a 404, so production can never take a file this way.
export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string; name: string }> };

export async function PUT(req: Request, { params }: Ctx): Promise<Response> {
  const off = labGate();
  if (off) return off;
  if (!localFilesEnabled()) return notFound();
  const token = bearerToken(req);
  if (!token) return unauthorized();
  const { id, name } = await params;
  const rule = uploadRule(name);
  if (!rule) return notFound();
  const job = isJobId(id) ? await ownedJob(id, token) : null;
  if (!job) return gone();
  const body = Buffer.from(await req.arrayBuffer());
  if (body.length > rule.maxBytes) return Response.json({ error: "too_large" }, { status: 413 });
  const pathname = `${jobFolder(job)}${name}`;
  const { file, type } = localFilePaths(pathname);
  await mkdir(path.dirname(file), { recursive: true });
  await mkdir(path.dirname(type), { recursive: true });
  await writeFile(file, body);
  await writeFile(type, rule.contentType);
  return Response.json({ url: localFileUrl(pathname), pathname });
}
