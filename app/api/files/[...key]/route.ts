import { readFile, stat } from "node:fs/promises";
import { isSafeFileKey, localFilesEnabled } from "@/lib/local-files";
import { localFilePaths } from "@/lib/storage";

type Ctx = { params: Promise<{ key: string[] }> };

/**
 * GET -> the file stored at this key in .data/files, for local runs with no Blob store (lib/local-files.ts). 404 on
 * Vercel or for unknown keys. Answers Range requests, which Safari needs to play the demo video.
 */
export async function GET(req: Request, { params }: Ctx): Promise<Response> {
  if (!localFilesEnabled()) return new Response("Not found", { status: 404 });
  const key = (await params).key.join("/");
  if (!isSafeFileKey(key)) return new Response("Not found", { status: 404 });
  const { file, type } = localFilePaths(key);
  let size: number;
  try {
    size = (await stat(file)).size;
  } catch {
    return new Response("Not found", { status: 404 });
  }
  const contentType = await readFile(type, "utf8").catch(() => "application/octet-stream");
  const headers: Record<string, string> = {
    "content-type": contentType,
    "accept-ranges": "bytes",
    "cache-control": "public, max-age=3600",
  };
  const body = await readFile(file);
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get("range") ?? "");
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start > end || start >= size) {
      return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
    }
    return new Response(new Uint8Array(body.subarray(start, end + 1)), {
      status: 206,
      headers: { ...headers, "content-range": `bytes ${start}-${end}/${size}`, "content-length": String(end - start + 1) },
    });
  }
  return new Response(new Uint8Array(body), { headers: { ...headers, "content-length": String(size) } });
}
