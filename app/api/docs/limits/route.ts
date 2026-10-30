import { after } from "next/server";
import { docsDeps } from "@/lib/docs/proxy/deps";
import { handleDocsLimits } from "@/lib/docs/proxy/handler";

// What the docs UI shows about the live demos' limits and today's spend. No secrets. Sets the visitor cookie for a
// first-time visitor, so the uploads that follow are theirs.
export const runtime = "nodejs";

export async function GET(req: Request) {
  return handleDocsLimits(req, docsDeps((task) => after(task)));
}
