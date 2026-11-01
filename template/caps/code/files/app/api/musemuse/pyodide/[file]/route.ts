// Platform file (Muse Muse platform services). Don't edit.
//
// Serves Pyodide's own files from this product's node_modules, so Python in the browser (lib/platform/pyodide.ts) never
// loads anything from another site. Only these five names answer. Each is read by its literal path, so the deployment
// carries exactly these files.
import { readFile } from "node:fs/promises";
import path from "node:path";

export const runtime = "nodejs";

const dir = () => path.join(process.cwd(), "node_modules", "pyodide");

const FILES: Record<string, { type: string; read: () => Promise<Buffer> }> = {
  "pyodide.mjs": { type: "text/javascript; charset=utf-8", read: () => readFile(path.join(dir(), "pyodide.mjs")) },
  "pyodide.asm.mjs": { type: "text/javascript; charset=utf-8", read: () => readFile(path.join(dir(), "pyodide.asm.mjs")) },
  "pyodide.asm.wasm": { type: "application/wasm", read: () => readFile(path.join(dir(), "pyodide.asm.wasm")) },
  "python_stdlib.zip": { type: "application/zip", read: () => readFile(path.join(dir(), "python_stdlib.zip")) },
  "pyodide-lock.json": { type: "application/json; charset=utf-8", read: () => readFile(path.join(dir(), "pyodide-lock.json")) },
};

export async function GET(_request: Request, { params }: { params: Promise<{ file: string }> }) {
  const { file } = await params;
  const entry = Object.hasOwn(FILES, file) ? FILES[file] : undefined;
  if (!entry) return Response.json({ error: "Not found" }, { status: 404 });
  const body = await entry.read().catch(() => null);
  if (!body) return Response.json({ error: "Python isn't installed in this product." }, { status: 404 });
  return new Response(new Uint8Array(body), { headers: { "content-type": entry.type, "cache-control": "public, max-age=86400" } });
}
