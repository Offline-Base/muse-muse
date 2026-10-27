// Test (c): a voice memo muse. Needs a 16 kHz mono WAV at $TMPDIR/musemuse-brief-test/memo.wav, made with:
//   say -o memo.aiff "..." && ffmpeg -i memo.aiff -ar 16000 -ac 1 -sample_fmt s16 memo.wav
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeBrief } from "@/lib/brief/write";
import { assertBrief, excerpt, MEDIA_DIR, printUsage, ref, saveJson, timed } from "./brief-common";

const wav = readFileSync(join(MEDIA_DIR, "memo.wav"));
const references = [ref("audio", "voice-memo.wav", "audio/wav", wav)];

const result = await timed("writeBrief voice", () => writeBrief({ note: null, references }));
assertBrief(result.brief);
console.log("transcripts:", result.transcripts);
excerpt(result.brief);
printUsage(result.usage, result.costUsd);
saveJson("brief-voice", result.brief);
const voice = result.usage.find((u) => u.model === "muse-voice-transcribe-1.0");
console.log("CHECK transcript present:", result.transcripts[0]?.text ? "ok" : "FAIL");
console.log("CHECK transcription billed:", voice && voice.costUsd > 0 ? `ok ($${voice.costUsd.toFixed(6)} for ${voice.audioSeconds} s)` : "FAIL");
console.log("CHECK reference kind audio:", result.brief.inspiration.references[0]?.kind === "audio" ? "ok" : "FAIL");
