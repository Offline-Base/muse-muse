// Platform file (Muse Muse platform services). Keep this file as it is.
//
// POST {id, scope?}: the last step of uploadFile. The gateway checks the size and type of what arrived, hashes it and
// keeps it, and answers with the stored file and a link good for an hour.
import { files, FilesError, type FileScope } from "@/lib/platform/files";

export async function POST(request: Request): Promise<Response> {
  const body = (await request.json().catch(() => null)) as { id?: unknown; scope?: unknown } | null;
  if (!body || typeof body.id !== "string") return Response.json({ error: "Send the ticket's id.", code: "invalid_arguments" }, { status: 400 });
  const scope = typeof body.scope === "string" && ["shared", "visitor", "owner", "user"].includes(body.scope) ? (body.scope as FileScope) : undefined;
  try {
    return Response.json(await files(request).done(body.id, { scope }), { headers: { "cache-control": "no-store" } });
  } catch (err) {
    if (err instanceof FilesError) return Response.json({ error: err.message, code: err.code }, { status: err.status >= 400 && err.status < 600 ? err.status : 502 });
    return Response.json({ error: "That didn't work this time. Try again.", code: "failed" }, { status: 500 });
  }
}
