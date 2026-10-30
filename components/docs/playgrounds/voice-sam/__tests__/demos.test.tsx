/**
 * The voice-sam DemoSpecs as the docs page uses them: every page in the group has one, its props are plain JSON,
 * every preset points at a real sample and draws its box and point prompts inside that sample, the copy prompt fits
 * and keeps the page's facts and snippet whole in every language and for every agent, also with the requests these
 * demos record included (the default), nothing has an em dash, and each component server-renders with its props the
 * way the page mounts it (pickers, presets, Run, notes). The CSS module is the only stand-in: a load hook turns
 * *.module.css into class names (as components/docs/media/__tests__/render.test.tsx does). Effects don't run in a
 * server render, so nothing reaches the network. The demo registry (lib/docs/demos/index.ts) imports every group's
 * file, so only the one test that compares against it loads it.
 *
 *   npx tsx --test --experimental-test-module-mocks components/docs/playgrounds/voice-sam/__tests__/demos.test.tsx
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { before, describe, it } from "node:test";
import { createElement, type ComponentType, type ReactElement } from "react";

const CSS_HOOK = `export async function load(url, context, nextLoad) {
  if (url.endsWith(".module.css")) {
    return { format: "module", shortCircuit: true, source: "export default new Proxy({}, { get: (_t, k) => (typeof k === 'string' ? k : undefined) });" };
  }
  return nextLoad(url, context);
}`;
register(`data:text/javascript,${encodeURIComponent(CSS_HOOK)}`, import.meta.url);

const SLUGS = [
  "speech-to-text",
  "media-segmentation",
  "sam/overview",
  "sam/segmenting",
  "sam/reading-segmentation",
  "sam/client-libraries",
  "api-reference/voice",
  "api-reference/voice/transcribe",
  "api-reference/voice/realtime",
  "api-reference/voice/schemas",
];

const EM = String.fromCharCode(0x2014);
const KEYISH = /\bsk-[A-Za-z0-9]{8}|LLM_\d{6}|DOCS_MODEL_API_KEY|Bearer [A-Za-z0-9_]{12}/;

type Demos = typeof import("@/lib/docs/demos/voice-sam");
type Recorded = import("@/components/docs/kit/DocsPageContext").RecordedRequest;
let demos: Demos["voiceSamDemos"];
let prompt: typeof import("@/lib/docs/agent-prompt");
let requests: typeof import("@/lib/docs/media/requests");
let trim: typeof import("@/lib/docs/client/record");
let voice: typeof import("@/components/docs/playgrounds/voice-sam/voice-request");
let samRun: typeof import("@/components/docs/playgrounds/voice-sam/useSamRun");
let samples: typeof import("@/lib/docs/media/samples");
let sam: typeof import("@/lib/docs/media/sam");
let html: (el: ReactElement) => string;

before(async () => {
  const { renderToString } = await import("react-dom/server");
  html = (e) => renderToString(e).replace(/<!-- -->/g, "");
  demos = (await import("@/lib/docs/demos/voice-sam")).voiceSamDemos;
  prompt = await import("@/lib/docs/agent-prompt");
  requests = await import("@/lib/docs/media/requests");
  trim = await import("@/lib/docs/client/record");
  voice = await import("@/components/docs/playgrounds/voice-sam/voice-request");
  samRun = await import("@/components/docs/playgrounds/voice-sam/useSamRun");
  samples = await import("@/lib/docs/media/samples");
  sam = await import("@/lib/docs/media/sam");
});

describe("voice-sam DemoSpecs", () => {
  it("has a DemoSpec for each of the group's pages", () => {
    assert.deepEqual(Object.keys(demos).sort(), [...SLUGS].sort());
  });

  it("lists the same pages as the demo registry", async () => {
    // Loaded here alone: the registry imports every group's file, and one that doesn't resolve fails only this test.
    const { DEMO_GROUPS } = await import("@/lib/docs/demos/index");
    assert.deepEqual([...DEMO_GROUPS["voice-sam"]].sort(), [...SLUGS].sort());
  });

  it("has plain JSON props, a title, a blurb and no em dashes", () => {
    for (const slug of SLUGS) {
      const d = demos[slug];
      assert.ok(d.title && d.blurb, slug);
      assert.deepEqual(JSON.parse(JSON.stringify(d.props)), d.props, `${slug} props survive JSON`);
      const text = JSON.stringify({ t: d.title, b: d.blurb, p: d.props, a: d.agentPrompt });
      assert.equal(text.includes(EM), false, `${slug} has no em dash`);
      assert.doesNotMatch(text, KEYISH, slug);
      assert.doesNotMatch(text, /muse-spark-1\.3"/, `${slug} never names muse-spark-1.3 without -contributor`);
    }
  });

  it("points every preset at a sample of the right kind, with prompts inside it", () => {
    for (const slug of SLUGS) {
      const props = demos[slug].props as { presets?: Array<Record<string, unknown>> };
      for (const p of props.presets ?? []) {
        const id = p.sampleId as string | undefined;
        if (!id) continue;
        const s = samples.sampleById(id);
        assert.ok(s, `${slug} / ${p.label}: sample ${id}`);
        if (p.media === "video") assert.equal(s?.kind, "video", `${slug} / ${p.label}`);
        else if (p.media === "image") assert.equal(s?.kind, "image", `${slug} / ${p.label}`);
        else assert.equal(s?.kind, "audio", `${slug} / ${p.label}`);
        if (Array.isArray(p.objects) && s?.width && s.height) {
          // Throws when a box or point lies outside the sample.
          assert.match(sam.buildSamPrompt({ width: s.width, height: s.height }, p.objects as never), /^<\d+f>/, `${slug} / ${p.label}`);
        }
      }
    }
  });

  it("builds a copy prompt under the limit that keeps the page's snippet whole", () => {
    for (const slug of SLUGS) {
      const d = demos[slug];
      for (const language of ["python", "typescript", "curl"] as const) {
        const text = prompt.buildAgentPrompt({
          page: { slug, title: slug, description: "", sourceUrl: `https://dev.meta.ai/docs/${slug}`, markdownUrl: `https://dev.meta.ai/docs/${slug}.md` },
          spec: d.agentPrompt,
          agent: "claude-code",
          language,
          lastRequest: null,
        });
        assert.ok(text.length <= prompt.PROMPT_MAX_CHARS, `${slug} ${language}: ${text.length} characters`);
        assert.equal(text.includes(EM), false);
        assert.ok(text.includes(d.agentPrompt.task.slice(0, 80)), `${slug}: the task is there`);
        const snippet = d.agentPrompt.snippets?.[language];
        if (snippet) assert.ok(text.includes(snippet.trim()), `${slug} ${language}: the snippet is whole (${snippet.length} characters)`);
        for (const fact of d.agentPrompt.facts ?? []) assert.ok(text.includes(fact.slice(0, 60)), `${slug}: fact kept: ${fact.slice(0, 40)}`);
        assert.match(text, /Model: (muse-voice-transcribe-1\.0|sam-3\.1)/, `${slug}: the right model`);
      }
    }
  });

  it("stays under the limit with a long last request included", () => {
    const lastRequest = {
      method: "POST" as const,
      path: "responses",
      body: { model: "sam-3.1", input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "dog" }, { type: "input_image", image_url: `data:image/jpeg;base64,${"A".repeat(5000)}` }] }], stream: true },
      status: 200,
      outcome: "2 objects (ids 0, 1) on 1 frame, as box and mask tokens in output_text",
    };
    for (const slug of SLUGS) {
      const text = prompt.buildAgentPrompt({
        page: { slug, title: slug, description: "", sourceUrl: "https://dev.meta.ai/docs/x", markdownUrl: "https://dev.meta.ai/docs/x.md" },
        spec: demos[slug].agentPrompt,
        agent: "codex",
        language: "typescript",
        lastRequest,
      });
      assert.ok(text.length <= prompt.PROMPT_MAX_CHARS, `${slug}: ${text.length}`);
    }
  });
});

const VOICE_SLUGS = SLUGS.filter((s) => s === "speech-to-text" || s.startsWith("api-reference/voice"));
const AGENTS = ["claude-code", "codex", "cursor", "opencode", "muse-code", "other"] as const;
const LANGUAGES = ["python", "typescript", "curl"] as const;

/**
 * Requests these demos record for the copy prompt, the longest each page's demo can make: what SegmentLab, WireInspector
 * and ParserLab record through useSamRun (the body trimmed by trimForRecord, samOutcome's words), and what TranscribeLab
 * and the schema explorer record for a transcription, a realtime session and a live check.
 */
function recordsFor(slug: string): Recorded[] {
  const image = { dataUrl: `data:image/jpeg;base64,${"A".repeat(488_000)}` };
  const clip = { dataUrl: `data:video/mp4;base64,${"A".repeat(400_000)}` };
  const ok = { ok: true, status: 200, json: null, text: "", blob: null, headers: {}, error: null, model: "sam-3.1", note: null, elapsedMs: 1 };
  const sam = (prompt: string, kind: "image" | "video", outcome: string, extra: { propagation?: "forward"; status?: number } = {}): Recorded => ({
    method: "POST",
    path: "responses",
    body: trim.trimForRecord(requests.samRequest({ prompt, media: kind === "image" ? image : clip, kind, stream: true, maskEncoding: "one_bit", includeConfidence: true, propagation: extra.propagation }).body),
    status: extra.status ?? 200,
    outcome,
  });
  const concept = (kind: "image" | "video") => sam("brown dog on a red leash", kind, `3 objects (ids 0, 1, 2) on ${kind === "image" ? "1 frame" : "120 frames"}, as box and mask tokens in output_text`);
  const clipObjects = sam(
    "<30f>1<|box;x1=434;y1=551;x2=648;y2=719;w=1280;h=720|><60f>2<|point;x=200;y=640;w=1280;h=720|><90f>1<|box;x1=273;y1=551;x2=486;y2=719;w=1280;h=720|>",
    "video",
    "2 objects (ids 1, 2) on 90 frames, as box and mask tokens in output_text",
    { propagation: "forward" },
  );
  const photoObjects = sam("<0f>1<|box;x1=186;y1=587;x2=392;y2=834;w=1280;h=853|>,2<|point;x=496;y=690;w=1280;h=853|>", "image", "2 objects (ids 1, 2) on 1 frame, as box and mask tokens in output_text");
  const failedOut = {
    ...samRun.EMPTY_SAM_OUTPUT,
    events: [["error", 1], ["response.failed", 1]] as Array<[string, number]>,
    done: true,
    error: { code: "invalid_prompt", message: "prompt coordinates are given in a 1280x720 frame, whose aspect ratio does not match the 1280x853 media" },
  };
  const failedInStream = sam("<0f>1<|point;x=100;y=100;w=1280;h=720|>", "image", samRun.samOutcome(failedOut, ok));
  const rejected = sam("dog <0f>1<|box;x1=186;y1=587;x2=392;y2=834;w=1280;h=853|>", "image", "error 400: invalid prompt: object prompts cannot be combined with a phrase", { status: 400 });

  const settings = (over: Partial<import("@/components/docs/playgrounds/voice-sam/voice-request").VoiceSettings>) => ({ ...voice.DEFAULT_VOICE_SETTINGS, ...over });
  const chess = ["pawn", "e4", "knight", "f3", "bishop", "c4", "castle", "kingside"];
  const said = "Hi, thanks for calling Riverside bikes. How can I help? Hi, the back brake on my bike is squeaking and I would like to bring it in today if you have time.";
  const transcribe = (s: ReturnType<typeof settings>, outcome: string, status = 200): Recorded => ({
    method: "POST",
    path: voice.transcribePath(s),
    body: `multipart: request=${JSON.stringify(voice.transcribeRequestJson(s))}, audio=two-voices.wav (791 KB); Accept: ${voice.ACCEPT_HEADER[s.accept]}`,
    status,
    outcome,
  });
  const files = [
    transcribe(settings({ mode: "DIARIZATION", keywords: chess, languageBias: ["English", "Spanish"], sessionId: "my-session-id" }), `transcript: ${said.slice(0, 160)} | 7 turns with speaker labels`),
    transcribe(settings({ mode: "ENDPOINTING", accept: "sse", partialMode: "DELTA", emitAudioProgress: false, keywords: chess }), `events: speechStart x4, transcript x30, speechEnd x4, speechComplete x4; transcript: ${said.slice(0, 100)}`),
    transcribe(settings({ mode: "DIARIZATION", accept: "text" }), `text/plain: ${said.slice(0, 180)}`),
  ];
  const realtime: Recorded = {
    method: "GET",
    path: "asr/realtime (WebSocket)",
    body: voice.realtimeHandshakeFrame(settings({ mode: "DIARIZATION", partialMode: "DELTA", keywords: chess })),
    outcome: `events: speechStart x3, transcript x31, speaker x3, speechEnd x3, speechComplete x3; transcript: ${said.slice(0, 100)}; closed with 1000`,
  };
  const liveCheck: Recorded = {
    method: "POST",
    path: "asr/transcribe",
    body: `multipart: request=${JSON.stringify(voice.transcribeRequestJson(settings({ mode: "DIARIZATION", accept: "sse" })))}, audio=two-voices.wav; Accept: text/event-stream`,
    status: 200,
    outcome: "41 messages checked against the Voice schemas",
  };

  switch (slug) {
    case "media-segmentation":
    case "sam/overview":
    case "sam/reading-segmentation":
      return [concept("image"), concept("video")];
    case "sam/client-libraries":
      return [concept("image"), concept("video"), photoObjects];
    case "sam/segmenting":
      return [concept("image"), clipObjects, photoObjects, failedInStream, rejected];
    case "api-reference/voice/transcribe":
      return [...files, transcribe(settings({ mode: "PUSH_TO_TALK" }), "error 400: audioEncoding is required", 400)];
    case "api-reference/voice/realtime":
      return [realtime];
    case "api-reference/voice/schemas":
      return [liveCheck];
    default:
      return [...files, realtime];
  }
}

describe("voice-sam copy prompts with a recorded run", () => {
  const titles = new Map<string, string>(
    (JSON.parse(readFileSync(new URL("../../../../../content/meta-docs/pages.json", import.meta.url), "utf8")) as Array<{ slug: string; title: string }>).map((p) => [p.slug, p.title]),
  );

  it("keep the task, every fact and the snippet whole for every agent and language, and never write curl for a WebSocket or a multipart comment", () => {
    for (const slug of SLUGS) {
      const d = demos[slug];
      for (const lastRequest of recordsFor(slug)) {
        for (const agent of AGENTS) {
          for (const language of LANGUAGES) {
            const text = prompt.buildAgentPrompt({
              page: { slug, title: titles.get(slug) ?? slug, description: "", sourceUrl: `https://dev.meta.ai/docs/${slug}`, markdownUrl: `https://dev.meta.ai/docs/${slug}.md` },
              spec: d.agentPrompt,
              agent,
              language,
              lastRequest,
            });
            const where = `${slug}, ${agent}, ${language}, after "${lastRequest.outcome?.slice(0, 40)}"`;
            assert.ok(text.length <= prompt.PROMPT_MAX_CHARS, `${where}: ${text.length} characters`);
            assert.equal(text.includes("... (trimmed)"), false, `${where}: nothing trimmed (${text.length} characters)`);
            assert.ok(text.includes(d.agentPrompt.task), `${where}: the task`);
            for (const fact of d.agentPrompt.facts ?? []) assert.ok(text.includes(fact), `${where}: fact ${fact.slice(0, 40)}`);
            const snippet = d.agentPrompt.snippets?.[language];
            if (snippet) assert.ok(text.includes(snippet.trim()), `${where}: the snippet`);
            assert.ok(text.includes("What I just ran in the docs"), `${where}: the run is included`);
            assert.doesNotMatch(text, /curl -X GET "https:\/\/api\.meta\.ai\/v1\/asr\/realtime/, `${where}: no curl to the WebSocket`);
            assert.doesNotMatch(text, /\\\n\s*# multipart/, `${where}: no multipart body turned into a shell comment`);
          }
        }
      }
    }
  });

  it("give every page a snippet in each language, so a recorded run is never turned into broken starter code", () => {
    for (const slug of ["api-reference/voice/realtime", "api-reference/voice/schemas"]) {
      for (const language of LANGUAGES) assert.ok(demos[slug].agentPrompt.snippets?.[language], `${slug} ${language}`);
    }
  });

  it("send the speech-to-text file presets to asr/transcribe, whichever endpoint was open before", () => {
    for (const slug of ["speech-to-text", "api-reference/voice"]) {
      const props = demos[slug].props as { endpoints: Array<"transcribe" | "realtime">; presets: Array<{ label: string; endpoint?: "transcribe" | "realtime"; accept?: string }> };
      for (const p of props.presets) {
        const where = voice.presetEndpoint(p, props.endpoints);
        assert.equal(where, p.accept ? "transcribe" : "realtime", `${slug} / ${p.label}`);
      }
    }
  });
});

describe("voice-sam components render with their DemoSpec props", () => {
  const render = (slug: string) => {
    const d = demos[slug];
    const out = html(createElement(d.Component as ComponentType<object>, { ...d.props, slug }));
    assert.equal(out.includes(EM), false, `${slug}: no em dash`);
    assert.doesNotMatch(out, KEYISH, slug);
    return out;
  };

  it("speech-to-text: both endpoints, the modes, reply formats, biasing and presets", () => {
    const out = render("speech-to-text");
    assert.match(out, /File: POST asr\/transcribe/);
    assert.match(out, /Realtime: WS asr\/realtime/);
    for (const m of ["PUSH_TO_TALK", "ENDPOINTING", "DIARIZATION"]) assert.match(out, new RegExp(`>${m}<`));
    for (const a of ["application/json", "text/event-stream", "text/plain"]) assert.match(out, new RegExp(`>${a.replace("/", "\\/")}<`));
    assert.match(out, /Vocabulary biasing \(keywords\)/);
    assert.match(out, /Language bias \(languageBias\)/);
    assert.match(out, />Dictation with keywords</);
    assert.match(out, />Live captions \(realtime\)</);
    assert.match(out, />Transcribe</);
    assert.match(out, /Muse Voice Transcribe 1\.0/);
    assert.match(out, /Spoken paragraph/);
  });

  it("the voice reference pages: one endpoint each, the HTTP exchange open, error presets grouped", () => {
    const transcribe = render("api-reference/voice/transcribe");
    assert.match(transcribe, /POST \/v1\/asr\/transcribe/);
    assert.match(transcribe, />Errors</);
    assert.match(transcribe, /406: an unsupported Accept/);
    assert.match(transcribe, /aria-label="Request"/);
    assert.match(transcribe, /name=&quot;request&quot;/);
    const realtime = render("api-reference/voice/realtime");
    assert.match(realtime, /WS \/v1\/asr\/realtime/);
    assert.match(realtime, /Stream it/);
    assert.match(realtime, /Client frames/);
    assert.doesNotMatch(realtime, /Reply format \(Accept\)/);
    assert.match(render("api-reference/voice"), /Call|File: POST asr\/transcribe/);
  });

  it("schemas: every group and the first schema's fields", () => {
    const out = render("api-reference/voice/schemas");
    for (const g of ["Requests", "Responses", "Server events"]) assert.match(out, new RegExp(g));
    assert.match(out, />TranscribeRequest</);
    assert.match(out, />audioEncoding</);
    assert.match(out, /Check a live stream/);
  });

  it("SAM pages: media, prompt kinds, presets and options", () => {
    const seg = render("sam/segmenting");
    for (const s of ["Concept (a noun phrase)", "Boxes and points", "Raw input_text", "Errors (400)", "Video", "mask_encoding", "include_confidence"]) {
      assert.ok(seg.includes(s.replace(/"/g, "&quot;")), `sam/segmenting shows ${s}`);
    }
    assert.match(seg, /SAM 3\.1/);
    const media = render("media-segmentation");
    assert.match(media, /Image \(input_image\)/);
    assert.match(media, /Video \(input_video\)/);
    assert.match(media, />Count the people</);
    assert.doesNotMatch(media, /Raw input_text/, "media-segmentation keeps to concept prompts");
    assert.match(render("sam/overview"), />Zero matches</);
  });

  it("reading-segmentation: the page's example parsed beside the raw line", () => {
    const out = render("sam/reading-segmentation");
    assert.match(out, /The page&#x27;s examples/);
    assert.match(out, /Raw wire \(1 line\)/);
    assert.match(out, /Frame marker <code>&lt;0f&gt;<\/code>/);
    assert.match(out, /27 x 60/);
    assert.match(out, /~ lossless/);
  });

  it("client-libraries: the parser's tabs", () => {
    const out = render("sam/client-libraries");
    for (const t of ["Parse a stream", "Decode masks", "Render overlays", "Build prompts", "Stream lifecycle"]) assert.match(out, new RegExp(t));
    assert.match(out, /parseImageStream/);
    assert.match(out, /Stream and parse/);
  });
});
