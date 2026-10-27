import { notImplemented } from "@/lib/http";

// TODO(kickoff, day 3): stream BuildEvents (lib/types.ts) as server-sent events, resuming from Last-Event-ID.
export async function GET(_req: Request, { params }: { params: Promise<{ buildId: string }> }) {
  const { buildId } = await params;
  return notImplemented(`Stream build events for ${buildId}`);
}
