// Probes the multipart shapes /v1/asr/transcribe accepts. Throwaway.
//   npx tsx --env-file=.env.local scripts/dev/gateway-asr-probe.ts
import { readFileSync } from "node:fs";

const wav = readFileSync("lib/gateway/__tests__/fixtures/speech.wav");
const key = process.env.MODEL_API_KEY!;

async function attempt(label: string, form: FormData) {
  const res = await fetch("https://api.meta.ai/v1/asr/transcribe", {
    method: "POST",
    headers: { authorization: `Bearer ${key}` },
    body: form,
  });
  console.log(label, res.status, (await res.text()).slice(0, 300));
}

async function main() {
  const req = { model: "muse-voice-transcribe-1.0", audioEncoding: "WAV" };
  let f = new FormData();
  f.set("request", JSON.stringify(req));
  f.set("audio", new Blob([wav], { type: "audio/wav" }), "audio.wav");
  await attempt("string-field", f);

  f = new FormData();
  f.set("request", new Blob([JSON.stringify(req)], { type: "application/json" }), "request.json");
  f.set("audio", new Blob([wav], { type: "audio/wav" }), "audio.wav");
  await attempt("json-blob-part", f);

  f = new FormData();
  f.set("request", JSON.stringify({ ...req, language: "en" }));
  f.set("audio", new Blob([wav], { type: "audio/wav" }), "audio.wav");
  await attempt("with-language", f);
}

main();
