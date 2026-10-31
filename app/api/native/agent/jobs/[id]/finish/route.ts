import { z } from "zod";
import { artifactLinkHolds, cleanForJsonb, gone, isJobId, labGate, readJson, unauthorized, uploadRule } from "@/lib/native/agent-http";
import { bearerToken } from "@/lib/native/lab-token";
import { finishJob, ownedJob, type FinishedArtifact } from "@/lib/native/queue";
import type { NativeJobResult } from "@/lib/native/types";

// A job's result (docs/NATIVE_LAB.md). Nothing here is trusted for money or for the gallery: the body is cut down to the
// contract's fields at the contract's sizes, and a file is only kept if its pathname is this job's and its link really
// goes there. A bad optional field is dropped, not refused: refusing it would cost the whole check.
export const runtime = "nodejs";
export const maxDuration = 30;

const MAX_BODY_BYTES = 256 * 1024;

const text = (max: number) => z.string().transform((s) => s.slice(0, max));
const list = <T extends z.ZodType>(item: T, max: number) => z.array(item).transform((items) => items.slice(0, max));
const number = z.number().finite().nullable();

const Artifact = z.object({
  name: z.string().max(64),
  url: z.string().max(2048),
  pathname: z.string().max(512),
  bytes: z.number().int().min(0).max(2 ** 31 - 1).catch(0),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable().catch(null),
  caption: text(300).nullable().catch(null),
});

const Finish = z.object({
  outcome: z.enum(["passed", "failed", "lab_error"]),
  summary: text(1000).catch(""),
  device: z.object({ name: text(120).nullable().catch(null), os: text(60).nullable().catch(null) }).nullable().catch(null),
  checks: list(z.object({ id: text(60), ok: z.boolean().nullable(), detail: text(500).nullable().optional() }), 40).catch([]),
  reasons: list(text(500), 20).catch([]),
  warnings: list(text(500), 50).catch([]),
  captionBurned: z.boolean().catch(false),
  loadMs: number.catch(null),
  durationMs: number.catch(null),
  attempt: number.catch(null),
  agentVersion: text(40).nullable().catch(null),
  artifacts: z.array(z.unknown()).max(16).catch([]),
  error: z.object({ code: text(40), message: text(500) }).nullable().catch(null),
});

const FALLBACK_SUMMARY: Record<z.infer<typeof Finish>["outcome"], string> = {
  passed: "Checked.",
  failed: "This check didn't pass.",
  lab_error: "Not checked: the lab had a problem.",
};

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const off = labGate();
  if (off) return off;
  const token = bearerToken(req);
  if (!token) return unauthorized();
  const { id } = await params;
  const job = isJobId(id) ? await ownedJob(id, token) : null;
  if (!job) return gone();
  const parsed = Finish.safeParse(await readJson(req, MAX_BODY_BYTES));
  if (!parsed.success) return Response.json({ error: "bad_request" }, { status: 400 });
  const { artifacts: claimed, ...body } = parsed.data;

  const artifacts: FinishedArtifact[] = [];
  const dropped: string[] = [];
  for (const raw of claimed) {
    const artifact = Artifact.safeParse(raw);
    const rule = artifact.success ? uploadRule(artifact.data.name) : null;
    if (!artifact.success || !rule) {
      dropped.push("a file the job isn't allowed to leave");
      continue;
    }
    const { name, url, pathname, bytes, sha256, caption } = artifact.data;
    if (!artifactLinkHolds(job, name, pathname, url)) {
      dropped.push(name);
      continue;
    }
    const device = body.device ? [body.device.name, body.device.os].filter(Boolean).join(", ") || null : null;
    artifacts.push({ kind: rule.kind, platform: job.kind, device, caption, url, pathname, bytes, sha256 });
  }
  if (dropped.length) console.warn(`[native/finish] job ${job.id} named files outside its folder: ${dropped.join(", ")}`);

  const result: NativeJobResult = {
    ...body,
    // Whether a result can block shipping comes from the job, not from the box reporting it.
    informational: job.kind === "glasses_sim",
    summary: cleanForJsonb(body.summary) || FALLBACK_SUMMARY[body.outcome],
    artifacts: artifacts.map(({ kind, url, pathname, bytes, sha256, caption }) => ({ kind, url, pathname, bytes, sha256, caption })),
  };
  const finished = await finishJob(job, token, result, artifacts);
  if (finished.state === "gone") return gone();
  return Response.json({ ok: true, state: finished.state, status: finished.job.status });
}
