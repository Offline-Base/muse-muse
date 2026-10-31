import { isJobId, labGate, gone, notFound, readJson, unauthorized } from "@/lib/native/agent-http";
import { bearerToken, verifySelftestToken } from "@/lib/native/lab-token";
import { saveSelftest } from "@/lib/native/queue";

// The lab shell's health report (native/shell-mobile/src/selftest.ts). Its token is an HMAC naming the job and does nothing
// else. The report is kept as sent, `at` included, because the agent compares `at` with its own launch. Only text Postgres
// can't store comes out, in saveSelftest.
export const runtime = "nodejs";

/** The shell caps a report at 50 errors of 300 characters each, so this is well above a real one. */
const MAX_REPORT_BYTES = 128 * 1024;

export async function POST(req: Request): Promise<Response> {
  const off = labGate();
  if (off) return off;
  const token = bearerToken(req);
  const jobId = token ? verifySelftestToken(token) : null;
  if (!jobId) return unauthorized();
  if (!isJobId(jobId)) return notFound();
  const report = await readJson(req, MAX_REPORT_BYTES);
  if (!report || typeof report !== "object" || Array.isArray(report)) return Response.json({ error: "bad_request" }, { status: 400 });
  if (!(await saveSelftest(jobId, report as Record<string, unknown>))) return gone();
  return Response.json({ ok: true });
}
