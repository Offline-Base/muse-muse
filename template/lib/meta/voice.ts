export interface TranscriptTurn {
  speaker: string;
  startSec: number;
  endSec: number;
  text: string;
}

export interface Transcript {
  text: string;
  turns: TranscriptTurn[];
  durationSec?: number;
}

export interface TranscribeOptions {
  /** Public URL from uploadMedia. */
  url: string;
  mimeType: string;
  language?: string;
}

/**
 * Transcribes a recorded file with muse-voice-transcribe-1.0 through the gateway (POST /v1/asr/transcribe).
 *
 * TODO(kickoff, day 2): confirm the request and response format in spike 3, then implement.
 */
export async function transcribeFile(opts: TranscribeOptions): Promise<Transcript> {
  void opts;
  throw new Error("transcribeFile is not implemented yet. This repo is a scaffold until kickoff.");
}
