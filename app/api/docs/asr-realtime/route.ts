import { after } from "next/server";
import { docsDeps } from "@/lib/docs/proxy/deps";
import { handleDocsRealtime } from "@/lib/docs/proxy/realtime";

// Realtime transcription for the docs: the WAV goes up to Meta's WebSocket at real-time pace, transcripts come back as
// server-sent events (lib/docs/proxy/realtime.ts). A minute of audio plus the handshake and the flush fits in 150 s.
export const runtime = "nodejs";
export const maxDuration = 150;

export async function POST(req: Request) {
  return handleDocsRealtime(req, docsDeps((task) => after(task)));
}
