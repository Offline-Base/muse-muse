import { env } from "@/lib/env";
import { exportPlan, installerFor, isExportKind } from "@/lib/train/export/installers";
import { licenseDuties } from "@/lib/train/base";
import { localFilesFor } from "@/lib/train/local-files-server";
import { getAdapterSource, getResultJob } from "@/lib/train/store";

// GET ?kind=mac|windows|linux|jetson_orin_nano[&format=modelfile]: one model's installer as a download. Public, and only for a
// model with a public page and public files. The script is text made from checked values, and it costs the platform nothing.
const notFound = () => Response.json({ error: "not_found" }, { status: 404 });

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!env.exportTuned) return notFound();
  const { id } = await params;
  if (!(await getResultJob(id))) return notFound();
  const url = new URL(req.url);
  const kind = url.searchParams.get("kind");
  if (!isExportKind(kind)) return Response.json({ error: "Pick mac, windows, linux or jetson_orin_nano." }, { status: 400 });
  const [files, source] = await Promise.all([localFilesFor(id), getAdapterSource(id)]);
  if (!source || (files && files.adapterJobId !== id)) return notFound();
  const planned = exportPlan(kind, files, licenseDuties({ params: source.job.params, metrics: source.metrics }));
  if (!planned.ok) return Response.json({ error: planned.problem }, { status: 409 });
  const wantsModelfile = url.searchParams.get("format") === "modelfile";
  if (wantsModelfile && !planned.plan.modelfile) return Response.json({ error: "This model has no Modelfile." }, { status: 409 });
  const out = wantsModelfile ? { name: "Modelfile", body: planned.plan.modelfile!, mime: "text/plain; charset=utf-8" } : installerFor(planned.plan);
  return new Response(out.body, {
    headers: { "content-type": out.mime, "content-disposition": `attachment; filename="${out.name}"`, "x-content-type-options": "nosniff", "cache-control": "no-store" },
  });
}
