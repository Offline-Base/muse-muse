/**
 * Recorded runs for the copy-prompt tests: one per kind of request each cookbook-media demo records for "Include what
 * I just ran" (on by default), built with the demos' own request builders and record helpers, so the test sees what a
 * reader's prompt really carries after a run. Ids have the lengths live replies had through the proxy on Oct 30, 2026:
 * a 29-character response id, a 359-character signed image item id (the store: false replay), a 21-character file id.
 */
import { readFileSync } from "node:fs";
import type { RecordedRequest } from "@/components/docs/kit/DocsPageContext";
import { stepRequest, type ImageStep } from "@/components/docs/playgrounds/cookbook-media/image-recipe";
import { samRunOutcome } from "@/components/docs/playgrounds/cookbook-media/sam-summary";
import { describeForm, outcomeOfReply, trimForRecord } from "@/lib/docs/client/record";
import { fileUploadFields, realtimeHandshake, samRequest, transcribeRequestPart, type TranscribeMode } from "@/lib/docs/media/requests";
import { parseSamOutput } from "@/lib/docs/media/sam";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

const RESP_ID = `resp_${"a".repeat(24)}`;
const IMAGE_ITEM_ID = `ig_${"e".repeat(356)}`;
const FILE_ID = `file-${"4".repeat(16)}`;

/** A data URL of about `kb` kilobytes, which the record shortens to its size. */
const dataUrl = (mime: string, kb: number) => `data:${mime};base64,${"A".repeat(Math.round((kb * 1024 * 4) / 3))}`;

const IMAGE_OUTCOME = outcomeOfReply(JSON.parse(fixture("muse-image-turn1.json")), 200);
const PEOPLE = parseSamOutput(fixture("sam-street-person.txt")).records;
const DOGS = parseSamOutput(fixture("sam-street-pan-dog-12f.txt")).records;
/** The longest result line a clip gives: nine people over every frame of the street clip, as the live run had. */
const CLIP_OUTCOME = "9 tracked objects across 120 frames, 699 one_bit masks";
const TRANSCRIPT = JSON.parse(fixture("transcribe-two-voices-diarization.json")).transcript as string;

type Props = Record<string, unknown>;

/** Every step of an ImageRecipe page, in each state mode and search setting the page offers. */
function imageSteps(props: Props): Record<string, RecordedRequest> {
  const steps = props.steps as ImageStep[];
  const modes = props.stateModes ? (["server", "client-id", "client-item"] as const) : (["server"] as const);
  const searches = props.searchSwitches ? [true, false] : [true];
  const out: Record<string, RecordedRequest> = {};
  for (const step of steps) {
    const references = (step.references ?? []).map(() => ({ dataUrl: dataUrl("image/jpeg", 140) }));
    for (const mode of modes) {
      for (const search of searches) {
        const parent = step.chainFrom
          ? { responseId: RESP_ID, item: { type: "image_generation_call", id: IMAGE_ITEM_ID, status: "completed", result: "A".repeat(300_000) } }
          : null;
        const { path, body } = stepRequest({
          prompt: step.prompt,
          references,
          parent,
          mode: mode === "server" ? "server" : "client",
          replay: mode === "client-item" ? "item" : "id",
          settings: search ? {} : { enableWebSearch: false, enableImageSearch: false },
        });
        out[`${step.id} ${mode}${search ? "" : " no search"}`] = { method: "POST", path, body: trimForRecord(body), status: 200, outcome: IMAGE_OUTCOME };
      }
    }
    if (props.bareList && references.length) {
      const { path, body } = stepRequest({ prompt: step.prompt, references, parent: { responseId: RESP_ID, item: null }, mode: "server", bareList: true });
      out[`${step.id} bare list`] = { method: "POST", path, body: trimForRecord(body), status: 400, outcome: outcomeOfReply(null, 400, "input[0] did not match any supported type") };
    }
  }
  return out;
}

/** asr/transcribe as the kit and the demos record it: the form described in one line, the transcript's start. */
function transcribe(mode: TranscribeMode, file: string, kb: number, keywords: string[] = [], languageBias: string[] = []): RecordedRequest {
  const form = new FormData();
  form.append("request", JSON.stringify(transcribeRequestPart({ mode, keywords, languageBias })));
  form.append("audio", new Blob([new Uint8Array(kb * 1024)], { type: "audio/wav" }), file);
  return { method: "POST", path: "asr/transcribe", body: describeForm(form), model: "muse-voice-transcribe-1.0", status: 200, outcome: outcomeOfReply({ transcript: TRANSCRIPT }, 200) };
}

/** A realtime session as TranscribePlayground and VoiceChess record it: the handshake (no key), the transcript's start. */
function realtime(mode: TranscribeMode, keywords: string[] = [], languageBias: string[] = []): RecordedRequest {
  return {
    method: "GET",
    path: "asr/realtime (WebSocket)",
    body: realtimeHandshake({ mode, keywords, languageBias }),
    status: 200,
    outcome: `transcript: ${TRANSCRIPT.slice(0, 180)}`,
  };
}

function sam(prompt: string, kind: "image" | "video", media: "inline" | "file", maskEncoding?: "one_bit" | "lossless"): RecordedRequest {
  const { path, body } = samRequest({
    prompt,
    media: media === "file" ? { fileId: FILE_ID } : { dataUrl: kind === "video" ? dataUrl("video/mp4", 1100) : dataUrl("image/jpeg", 360) },
    kind,
    stream: true,
    maskEncoding,
  });
  const outcome = kind === "video" ? CLIP_OUTCOME : samRunOutcome({ ok: true, status: 200, media: "image", records: prompt === "dog" ? DOGS.filter((r) => r.frame === 0) : PEOPLE });
  return { method: "POST", path, body: trimForRecord(body), status: 200, outcome };
}

function upload(file: string, kb: number): RecordedRequest {
  const form = new FormData();
  for (const [k, v] of fileUploadFields({})) form.append(k, v);
  form.append("file", new Blob([new Uint8Array(kb * 1024)], { type: "video/mp4" }), file);
  return {
    method: "POST",
    path: "files",
    body: describeForm(form),
    status: 200,
    outcome: outcomeOfReply({ id: FILE_ID, object: "file", filename: file, status: "processed", purpose: "user_data" }, 200),
  };
}

/** The recorded runs a page's demo can leave behind, by a short name. */
export function recordedRuns(slug: string, props: Props): Record<string, RecordedRequest> {
  switch (slug) {
    case "cookbook/muse-image": {
      const recipes = props.recipes as Array<{ slug: string; quick: { prompt: string; referenceSampleId?: string } }>;
      return Object.fromEntries(
        recipes.map((r) => {
          const references = r.quick.referenceSampleId ? [{ dataUrl: dataUrl("image/jpeg", 140) }] : [];
          const { path, body } = stepRequest({ prompt: r.quick.prompt, references, parent: null, mode: "server" });
          return [r.slug, { method: "POST", path, body: trimForRecord(body), status: 200, outcome: IMAGE_OUTCOME } satisfies RecordedRequest];
        }),
      );
    }
    case "cookbook/image-generation-basics":
    case "cookbook/image-editing-with-reasoning":
    case "cookbook/anchored-image-series":
    case "cookbook/search-grounded-image-generation":
      return imageSteps(props);
    case "cookbook/muse-voice-transcribe":
      return {
        diarized: transcribe("DIARIZATION", "two-voices.wav", 793),
        chess: transcribe("PUSH_TO_TALK", "chess-moves.wav", 286, ["Pawn to e4", "Knight to f3", "Bishop to c4", "Castle kingside"]),
      };
    case "cookbook/voice-api-fundamentals":
      return {
        "realtime push to talk": realtime("PUSH_TO_TALK"),
        "realtime diarization": realtime("DIARIZATION"),
        "realtime biased": realtime("PUSH_TO_TALK", ["Anaya", "Kolkata", "Acme Mobile", "eSIM"], ["english"]),
        "file diarization": transcribe("DIARIZATION", "two-voices.wav", 793),
        "file biased": transcribe("PUSH_TO_TALK", "speech-paragraph.wav", 457, ["Anaya", "Kolkata", "Acme Mobile", "eSIM"], ["english"]),
      };
    case "cookbook/voice-chess-cua": {
      const sets = (props.keywordSets as Array<{ label: string; keywords: string[] }>) ?? [];
      return Object.fromEntries(
        sets.flatMap((set) => [
          [`realtime, ${set.label}`, { ...realtime("ENDPOINTING", set.keywords), outcome: `speechComplete turns: ${" pawn to e4 | Knight to f3 | Bishop to c4 | Castle kingside".slice(0, 180)}` }],
          [`file, ${set.label}`, transcribe("ENDPOINTING", "chess-moves.wav", 286, set.keywords)],
        ]),
      );
    }
    case "cookbook/headlocked-speech-bubble-captions":
      return {
        voices: transcribe("DIARIZATION", "two-voices.wav", 793),
        "photo people": sam("people", "image", "inline", "one_bit"),
        "clip upload": upload("street-pan.mp4", 1213),
        "clip people": sam("people", "video", "file", "one_bit"),
      };
    case "cookbook/sam":
      return { "photo dog": sam("dog", "image", "inline"), "photo people": sam("people", "image", "inline"), "clip dog": sam("dog", "video", "inline") };
    case "cookbook/sam-api-basics":
      return {
        "photo lossless": sam("bicycle", "image", "inline"),
        "photo one_bit": sam("bicycle", "image", "inline", "one_bit"),
        "clip upload": upload("street-pan.mp4", 1213),
        "clip lossless": sam("dog", "video", "file"),
        "clip one_bit": sam("dog", "video", "file", "one_bit"),
      };
    case "cookbook/video-to-sticker-pack":
      return { "clip upload": upload("street-pan.mp4", 1213), "clip dog": sam("dog", "video", "file", "one_bit") };
  }
  return {};
}
