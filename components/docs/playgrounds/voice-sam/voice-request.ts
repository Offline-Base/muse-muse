import type { PartialMode, VoiceMode } from "@/components/docs/playgrounds/voice-sam/voice-events";

/**
 * The requests the voice demos send and the code they hand out, from one settings object, so what runs, what "Show
 * code" prints and what the copy prompt records agree. Shapes follow api-reference/voice/transcribe (the two-part
 * multipart body, the sessionId query parameter, the Accept header) and api-reference/voice/schemas (Transcribe
 * Request, Realtime Handshake Request). The key is always read from MODEL_API_KEY; nothing here holds one.
 */

export const VOICE_MODEL = "muse-voice-transcribe-1.0";
export const API_BASE = "https://api.meta.ai/v1";

export type VoiceAccept = "json" | "sse" | "text";

export const ACCEPT_HEADER: Readonly<Record<VoiceAccept, string>> = {
  json: "application/json",
  sse: "text/event-stream",
  text: "text/plain",
};

export interface VoiceSettings {
  mode: VoiceMode;
  keywords: string[];
  languageBias: string[];
  /** Applies to text/event-stream replies and to realtime. */
  partialMode: PartialMode;
  /** Applies to text/event-stream replies (and realtime, where Muse Muse's relay keeps it on). */
  emitAudioProgress: boolean;
  accept: VoiceAccept;
  /** Optional correlation id; empty lets the server make one. */
  sessionId: string;
}

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  mode: "PUSH_TO_TALK",
  keywords: [],
  languageBias: [],
  partialMode: "CUMULATIVE",
  emitAudioProgress: true,
  accept: "json",
  sessionId: "",
};

/** The 25 languages Muse Voice Transcribe supports (speech-to-text, "Language biasing"), as languageBias names them. */
export const VOICE_LANGUAGES: readonly string[] = [
  "Arabic",
  "Bengali",
  "Dutch",
  "English",
  "French",
  "German",
  "Hebrew",
  "Hindi",
  "Indonesian",
  "Italian",
  "Japanese",
  "Kannada",
  "Korean",
  "Malay",
  "Mandarin Chinese",
  "Marathi",
  "Polish",
  "Portuguese",
  "Spanish",
  "Tagalog",
  "Tamil",
  "Telugu",
  "Thai",
  "Turkish",
  "Vietnamese",
];

/** Splits a comma list typed by the reader ("Acme Mobile, eSIM, 5G"), dropping blanks and repeats. */
export function splitList(text: string): string[] {
  return [...new Set(text.split(",").map((s) => s.trim()).filter(Boolean))];
}

/** Language names the model doesn't list. A hint, not a rule: the API decides. */
export function unknownLanguages(names: readonly string[]): string[] {
  const known = new Set(VOICE_LANGUAGES.map((l) => l.toLowerCase()));
  return names.filter((n) => !known.has(n.toLowerCase()));
}

/**
 * The `request` part: model and audioEncoding (required, no default), the mode, the biasing lists when set, and
 * partialMode and emitAudioProgress only when they differ from their defaults and the reply is an event stream, the
 * only reply they change.
 */
export function transcribeRequestJson(s: VoiceSettings): Record<string, unknown> {
  const req: Record<string, unknown> = { model: VOICE_MODEL, audioEncoding: "WAV", mode: s.mode };
  if (s.keywords.length) req.keywords = [...s.keywords];
  if (s.languageBias.length) req.languageBias = [...s.languageBias];
  if (s.accept === "sse") {
    if (s.partialMode !== "CUMULATIVE") req.partialMode = s.partialMode;
    if (!s.emitAudioProgress) req.emitAudioProgress = false;
  }
  return req;
}

/**
 * Where a preset runs: the endpoint it names, else asr/transcribe when it picks a reply format (only a file upload
 * has one), else the demo's first endpoint. A preset never inherits the endpoint the reader was on, so a file preset
 * picked after a realtime one still sends the file.
 */
export function presetEndpoint<E extends string>(preset: { endpoint?: E; accept?: unknown }, endpoints: readonly E[]): E | null {
  const want = preset.endpoint ?? (preset.accept !== undefined ? ("transcribe" as E) : endpoints[0]);
  return want !== undefined && endpoints.includes(want) ? want : (endpoints[0] ?? null);
}

/** Meta's path with the optional sessionId query parameter. */
export function transcribePath(s: Pick<VoiceSettings, "sessionId">): string {
  const id = s.sessionId.trim();
  return id ? `asr/transcribe?sessionId=${encodeURIComponent(id)}` : "asr/transcribe";
}

/**
 * The first frame of a realtime session for these settings, with the credential as a placeholder. Muse Muse's relay
 * streams the WAV's own 16 kHz samples, so it says PCM_16KHZ, and it always asks for audio progress.
 */
export function realtimeHandshakeFrame(s: VoiceSettings, sampleRate = 16_000): Record<string, unknown> {
  const h: Record<string, unknown> = {
    authorization: { accessToken: "Bearer $MODEL_API_KEY" },
    audioEncoding: sampleRate === 24_000 ? "PCM_24KHZ" : "PCM_16KHZ",
    model: VOICE_MODEL,
    mode: s.mode,
  };
  if (s.partialMode !== "CUMULATIVE") h.partialMode = s.partialMode;
  h.emitAudioProgress = true;
  if (s.keywords.length) h.keywords = [...s.keywords];
  if (s.languageBias.length) h.languageBias = [...s.languageBias];
  return h;
}

/** The query string for Muse Muse's relay, POST /api/docs/asr-realtime (lib/docs/proxy/realtime.ts reads it). */
export function relayQuery(s: VoiceSettings): string {
  const q = new URLSearchParams({ model: VOICE_MODEL, mode: s.mode });
  if (s.mode === "DIARIZATION") q.set("diarization", "true");
  if (s.partialMode !== "CUMULATIVE") q.set("partialMode", s.partialMode);
  if (s.keywords.length) q.set("keywords", s.keywords.join(","));
  if (s.languageBias.length) q.set("languageBias", s.languageBias.join(","));
  return q.toString();
}

// ---- Code ---------------------------------------------------------------------------------------------------------

export type SnippetLang = "curl" | "python" | "typescript";

export interface Snippet {
  lang: SnippetLang;
  label: string;
  syntax: "bash" | "python" | "typescript";
  code: string;
}

function pyValue(v: unknown, indent: number): string {
  const pad = "    ".repeat(indent);
  const inner = "    ".repeat(indent + 1);
  if (v === null || v === undefined) return "None";
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map((x) => pyValue(x, indent)).join(", ")}]`;
  const entries = Object.entries(v as Record<string, unknown>);
  if (!entries.length) return "{}";
  return `{\n${entries.map(([k, x]) => `${inner}${JSON.stringify(k)}: ${pyValue(x, indent + 1)},`).join("\n")}\n${pad}}`;
}

function tsValue(v: unknown, indent: number): string {
  const pad = "  ".repeat(indent);
  const inner = "  ".repeat(indent + 1);
  if (v === null || v === undefined) return "null";
  if (typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map((x) => tsValue(x, indent)).join(", ")}]`;
  const entries = Object.entries(v as Record<string, unknown>);
  if (!entries.length) return "{}";
  const key = (k: string) => (/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k));
  return `{\n${entries.map(([k, x]) => `${inner}${key(k)}: ${tsValue(x, indent + 1)},`).join("\n")}\n${pad}}`;
}

const shSingle = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** POST /v1/asr/transcribe as curl, Python (requests) and TypeScript (fetch), for the settings and file name. */
export function transcribeSnippets(s: VoiceSettings, fileName = "recording.wav"): Snippet[] {
  const request = transcribeRequestJson(s);
  const url = `${API_BASE}/${transcribePath(s)}`;
  const accept = ACCEPT_HEADER[s.accept];
  const sse = s.accept === "sse";

  const curl = [
    `curl --fail-with-body${sse ? " -N" : ""} -X POST ${shSingle(url)}`,
    `  -H "Authorization: Bearer $MODEL_API_KEY"`,
    `  -H ${shSingle(`Accept: ${accept}`)}`,
    `  -F ${shSingle(`request=${JSON.stringify(request)};type=application/json`)}`,
    `  -F ${shSingle(`audio=@${fileName};type=audio/wav`)}`,
  ].join(" \\\n");

  const pyRead = sse
    ? [
        "    response.raise_for_status()",
        "    for line in response.iter_lines(decode_unicode=True):",
        '        if not line or not line.startswith("data: "):',
        "            continue",
        '        event = json.loads(line.removeprefix("data: "))',
        '        if event["type"] == "error":',
        '            raise RuntimeError(event["message"])',
        '        if event["type"] in ("speechComplete", "speaker") or event.get("final"):',
        "            print(event)",
      ]
    : s.accept === "text"
      ? ["    response.raise_for_status()", "    print(response.text)"]
      : ["    response.raise_for_status()", "    print(json.dumps(response.json(), indent=2))"];
  const python = [
    "import json",
    "import os",
    "",
    "import requests",
    "",
    `with open(${JSON.stringify(fileName)}, "rb") as audio:`,
    "    response = requests.post(",
    `        ${JSON.stringify(`${API_BASE}/asr/transcribe`)},`,
    ...(s.sessionId.trim() ? [`        params={"sessionId": ${JSON.stringify(s.sessionId.trim())}},`] : []),
    "        headers={",
    `            "Authorization": f"Bearer {os.environ['MODEL_API_KEY']}",`,
    `            "Accept": ${JSON.stringify(accept)},`,
    "        },",
    "        files={",
    `            "request": (None, json.dumps(${pyValue(request, 3)}), "application/json"),`,
    `            "audio": (${JSON.stringify(fileName)}, audio, "audio/wav"),`,
    "        },",
    ...(sse ? ["        stream=True,"] : []),
    "    )",
    ...pyRead,
  ].join("\n");

  const tsRead = sse
    ? [
        "const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();",
        'let buffer = "";',
        "for (;;) {",
        "  const { value, done } = await reader.read();",
        "  if (done) break;",
        "  buffer += value;",
        "  let at: number;",
        '  while ((at = buffer.indexOf("\\n\\n")) >= 0) {',
        "    const data = buffer.slice(0, at).split(\"\\n\").find((l) => l.startsWith(\"data: \"));",
        "    buffer = buffer.slice(at + 2);",
        "    if (!data) continue;",
        "    const event = JSON.parse(data.slice(6));",
        '    if (event.type === "error") throw new Error(event.message);',
        '    if (event.type === "speechComplete" || event.type === "speaker" || event.final) console.log(event);',
        "  }",
        "}",
      ]
    : s.accept === "text"
      ? ["console.log(await res.text());"]
      : ["console.log(JSON.stringify(await res.json(), null, 2));"];
  const typescript = [
    'import { readFile } from "node:fs/promises";',
    "",
    "const form = new FormData();",
    `form.append("request", JSON.stringify(${tsValue(request, 0)}));`,
    `form.append("audio", new Blob([await readFile(${JSON.stringify(fileName)})], { type: "audio/wav" }), ${JSON.stringify(fileName)});`,
    "",
    `const res = await fetch(${JSON.stringify(url)}, {`,
    '  method: "POST",',
    `  headers: { Authorization: \`Bearer \${process.env.MODEL_API_KEY}\`, Accept: ${JSON.stringify(accept)} },`,
    "  body: form,",
    "});",
    "if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);",
    ...tsRead,
  ].join("\n");

  return [
    { lang: "curl", label: "curl", syntax: "bash", code: curl },
    { lang: "python", label: "Python (requests)", syntax: "python", code: python },
    { lang: "typescript", label: "TypeScript (fetch)", syntax: "typescript", code: typescript },
  ];
}

/**
 * A realtime client for the settings: Python with websockets (the page's own example, reading a 16 kHz WAV) and
 * TypeScript with the WebSocket built into Node 22. The handshake is the first text frame and carries the key; audio
 * goes in 80 ms binary frames at real-time pace; endStream ends input; the server closes with 1000.
 */
export function realtimeSnippets(s: VoiceSettings, fileName = "recording.wav"): Snippet[] {
  // The handshake's fields after the credential, which each client writes from its own environment.
  const rest = Object.fromEntries(Object.entries(realtimeHandshakeFrame(s)).filter(([k]) => k !== "authorization"));
  const done = s.mode === "PUSH_TO_TALK" ? 'event.get("final")' : 'event["type"] == "speechComplete"';
  const python = [
    "import asyncio",
    "import json",
    "import os",
    "import uuid",
    "import wave",
    "",
    "import websockets",
    "",
    'URI = f"wss://api.meta.ai/v1/asr/realtime?sessionId=docs-{uuid.uuid4()}"',
    "FRAME_MS = 80",
    "",
    "async def main() -> None:",
    `    with wave.open(${JSON.stringify(fileName)}, "rb") as wav:  # mono 16-bit PCM at 16 kHz`,
    "        pcm = wav.readframes(wav.getnframes())",
    "    frame_bytes = 16_000 * 2 * FRAME_MS // 1000",
    "    async with websockets.connect(URI, open_timeout=30) as ws:",
    "        await ws.send(json.dumps({",
    `            "authorization": {"accessToken": f"Bearer {os.environ['MODEL_API_KEY']}"},`,
    ...Object.entries(rest).map(([k, v]) => `            ${JSON.stringify(k)}: ${pyValue(v, 3)},`),
    "        }))",
    "        ack = json.loads(await ws.recv())  # the only frame without a type",
    '        if "sessionId" not in ack:',
    '            raise RuntimeError(f"Handshake failed: {ack}")',
    "",
    "        async def receive() -> None:",
    "            async for message in ws:",
    "                event = json.loads(message)",
    '                if event.get("type") == "error":',
    '                    raise RuntimeError(event["message"])',
    `                if ${done}:`,
    '                    print(event.get("turnId"), event["transcript"])',
    "",
    "        receiver = asyncio.create_task(receive())",
    "        for at in range(0, len(pcm), frame_bytes):",
    "            await ws.send(pcm[at : at + frame_bytes])",
    "            await asyncio.sleep(FRAME_MS / 1000)  # real-time pace",
    '        await ws.send(json.dumps({"type": "endStream"}))',
    "        await receiver  # ends when the server closes with 1000",
    "",
    "asyncio.run(main())",
  ].join("\n");

  const tsDone = s.mode === "PUSH_TO_TALK" ? "event.final" : 'event.type === "speechComplete"';
  const typescript = [
    'import { readFile } from "node:fs/promises";',
    "",
    `const pcm = (await readFile(${JSON.stringify(fileName)})).subarray(44); // a 16 kHz mono 16-bit WAV's samples`,
    "const FRAME = (16_000 * 2 * 80) / 1000; // 80 ms",
    "const ws = new WebSocket(`wss://api.meta.ai/v1/asr/realtime?sessionId=docs-${crypto.randomUUID()}`);",
    "ws.onopen = () =>",
    "  ws.send(JSON.stringify({",
    "    authorization: { accessToken: `Bearer ${process.env.MODEL_API_KEY}` },",
    ...Object.entries(rest).map(([k, v]) => `    ${k}: ${tsValue(v, 2)},`),
    "  }));",
    "ws.onmessage = async (e) => {",
    "  const event = JSON.parse(String(e.data));",
    '  if (!("type" in event)) {',
    "    // The acknowledgement: stream the audio at real-time pace, then end input.",
    "    for (let at = 0; at < pcm.length; at += FRAME) {",
    "      ws.send(pcm.subarray(at, at + FRAME));",
    "      await new Promise((r) => setTimeout(r, 80));",
    "    }",
    '    ws.send(JSON.stringify({ type: "endStream" }));',
    '  } else if (event.type === "error") {',
    "    console.error(event.message);",
    `  } else if (${tsDone}) {`,
    "    console.log(event.turnId, event.transcript);",
    "  }",
    "};",
    'ws.onclose = (e) => console.log("closed", e.code); // 1000 is normal completion',
  ].join("\n");

  return [
    { lang: "python", label: "Python (websockets)", syntax: "python", code: python },
    { lang: "typescript", label: "TypeScript (WebSocket, Node 22)", syntax: "typescript", code: typescript },
  ];
}

/**
 * The multipart body as it goes over the wire, for the reference view: the request line, headers and both parts,
 * with the audio's bytes summarized. The boundary is illustrative; fetch picks its own.
 */
export function multipartPreview(
  r: { path: string; accept: string; request: Record<string, unknown> },
  audio: { name: string; bytes: number; durationMs?: number } | null,
): string {
  const boundary = "----docs-boundary";
  const size = audio ? `${audio.bytes.toLocaleString("en-US")} bytes of RIFF/WAVE, mono 16-bit PCM` : "the WAV bytes";
  return [
    `POST /v1/${r.path} HTTP/1.1`,
    "Host: api.meta.ai",
    "Authorization: Bearer $MODEL_API_KEY",
    `Accept: ${r.accept}`,
    `Content-Type: multipart/form-data; boundary=${boundary}`,
    "",
    `--${boundary}`,
    'Content-Disposition: form-data; name="request"',
    "Content-Type: application/json",
    "",
    JSON.stringify(r.request),
    `--${boundary}`,
    `Content-Disposition: form-data; name="audio"; filename="${audio?.name ?? "recording.wav"}"`,
    "Content-Type: audio/wav",
    "",
    `<${size}${audio?.durationMs ? `, ${(audio.durationMs / 1000).toFixed(1)} s` : ""}>`,
    `--${boundary}--`,
  ].join("\n");
}
