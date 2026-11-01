// Platform file (Muse Muse platform services). Keep this file as it is.
//
// The browser's side of keeping files (lib/platform/files-browser.ts):
//   POST   {name, contentType, bytes, scope?}   a ticket from the gateway: where the browser puts the bytes
//   GET    ?scope=&after=                       a page of this person's (or the shared) files
//   DELETE ?id=&scope=                           deletes one
// The gateway decides who may do what, from the cookies this route forwards.
import { files, FilesError, type FileScope } from "@/lib/platform/files";

const SCOPES = new Set(["shared", "visitor", "owner", "user"]);

function scopeOf(value: unknown): FileScope | undefined {
  return typeof value === "string" && SCOPES.has(value) ? (value as FileScope) : undefined;
}

function failed(err: unknown): Response {
  if (err instanceof FilesError) return Response.json({ error: err.message, code: err.code }, { status: err.status >= 400 && err.status < 600 ? err.status : 502 });
  return Response.json({ error: "That didn't work this time. Try again.", code: "failed" }, { status: 500 });
}

export async function POST(request: Request): Promise<Response> {
  const body = (await request.json().catch(() => null)) as { name?: unknown; contentType?: unknown; bytes?: unknown; scope?: unknown } | null;
  if (!body || typeof body.name !== "string" || typeof body.contentType !== "string" || typeof body.bytes !== "number") {
    return Response.json({ error: "Send the file's name, type and size.", code: "invalid_arguments" }, { status: 400 });
  }
  try {
    const ticket = await files(request).ticket({ name: body.name, contentType: body.contentType, bytes: body.bytes, scope: scopeOf(body.scope) });
    return Response.json(ticket, { status: 201, headers: { "cache-control": "no-store" } });
  } catch (err) {
    return failed(err);
  }
}

export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  try {
    const page = await files(request).list({ scope: scopeOf(params.get("scope")), after: params.get("after") });
    return Response.json(page, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    return failed(err);
  }
}

export async function DELETE(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  try {
    const deleted = await files(request).delete(params.get("id") ?? "", { scope: scopeOf(params.get("scope")) });
    return Response.json({ deleted }, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    return failed(err);
  }
}
