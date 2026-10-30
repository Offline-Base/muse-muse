/**
 * The media kit server-rendered with JSON props, the way a DemoSpec mounts it: what each playground shows before
 * anything runs (pickers with our samples, the model menu and its Contributor notice, options, Run, Show code), and
 * the components' markup for given inputs (an overlay with the docs' own SAM line, a generated image). The CSS module
 * is the only stand-in: a load hook turns *.module.css into an object whose every class name is itself (Node's own
 * module mocks can't, since they ask for the real file's format first). Nothing reaches the network, since effects
 * don't run in a server render.
 *
 *   npx tsx --test --experimental-test-module-mocks components/docs/media/__tests__/render.test.tsx
 */
import assert from "node:assert/strict";
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

let html: (el: ReactElement) => string;
let media: typeof import("@/components/docs/media");
let sam: typeof import("@/lib/docs/media/sam");

const VIDEO_LINE =
  "<0f>0<|box;x1=211;y1=228;x2=270;y2=254;w=320;h=334|><|mask;x=0;y=0;data=27,60,~!!!!M!0c[0o91w?q1!pIH4pPRVp2B3'7`e.ioeAf6-k/#Xd8%dX9x(|>," +
  "1<|box;x1=155;y1=228;x2=202;y2=254;w=320;h=334;c=0.75|><|mask;x=0;y=0;c=0.75;data=27,48,~!!!!J!0c[q=Pj_zs=*4C4(/./x#:/`S_GnD`=o3?X{emCgO$y@|>";

function clean(out: string): string {
  assert.equal(out.includes(String.fromCharCode(0x2014)), false, "no em dash");
  assert.doesNotMatch(out, /\bsk-[A-Za-z0-9]{8}|LLM_\d{6}|DOCS_MODEL_API_KEY|Bearer [A-Za-z0-9_]{12}/, "no key-like strings");
  return out;
}

const el = <P extends object>(c: ComponentType<P>, props: P) => createElement(c as ComponentType<object>, props);
const NOTICE = /Runs on Muse Spark 1\.3 Contributor: Meta may use what you send to train future models\. Don&#x27;t send anything private\./;

describe("media kit render", () => {
  before(async () => {
    const { renderToString } = await import("react-dom/server");
    html = (e) => clean(renderToString(e).replace(/<!-- -->/g, ""));
    media = await import("@/components/docs/media");
    sam = await import("@/lib/docs/media/sam");
  });

  describe("FilePicker", () => {
    it("offers the samples the accept list allows, with thumbnails for images", () => {
      const out = html(el(media.FilePicker, { accept: "image/*", value: null, onChange() {}, label: "Image" }));
      assert.match(out, /<label[^>]*>Image<\/label>/);
      assert.match(out, /Drop a file here, or/);
      assert.match(out, /<input[^>]*type="file"[^>]*accept="image\/\*"/);
      const chips = out.match(/aria-pressed="false"/g) ?? [];
      assert.equal(chips.length, media.samplesOf("image").length);
      assert.match(out, /<img[^>]*src="\/docs-samples\/thumbs\/street\.jpg"/, "chips load small thumbnails");
      assert.match(out, />Street with dogs and bikes<\/button>/);
      assert.doesNotMatch(out, /Spoken paragraph/);
    });

    it("takes sample kinds or ids, or none", () => {
      const audio = html(el(media.FilePicker, { accept: "audio/*", value: null, onChange() {}, samples: ["audio"] }));
      assert.equal((audio.match(/aria-pressed="false"/g) ?? []).length, 3);
      const ids = html(el(media.FilePicker, { accept: "image/*", value: null, onChange() {}, samples: ["sneaker", "living-room"] }));
      assert.match(ids, /Sneaker on white.*Living room/);
      assert.doesNotMatch(ids, /Open fridge/);
      const none = html(el(media.FilePicker, { accept: "image/*", value: null, onChange() {}, samples: false }));
      assert.doesNotMatch(none, /aria-label="Samples"/);
    });

    it("shows a picked file's size, note and problems", () => {
      const out = html(
        el(media.FilePicker, {
          accept: "video/mp4",
          onChange() {},
          value: {
            blob: new Blob([new Uint8Array(10)]),
            name: "clip.mp4",
            mime: "video/mp4",
            bytes: 5_000_000,
            kind: "video",
            source: "upload",
            width: 1920,
            height: 1080,
            durationMs: 12_000,
            fps: 30,
            note: "H.264, 30 fps, 360 frames.",
            problems: ["This clip is 4.8 MB."],
          },
        }),
      );
      assert.match(out, /clip\.mp4/);
      assert.match(out, /4\.8 MB · 1920 x 1080 · 0:12 · 30 fps/);
      assert.match(out, /H\.264, 30 fps, 360 frames\./);
      assert.match(out, /This clip is 4\.8 MB\./);
      assert.match(out, /aria-label="Remove clip\.mp4"/);
    });
  });

  it("AudioRecorder starts idle with a meter and the cap", () => {
    const out = html(el(media.AudioRecorder, { onRecorded() {}, maxSeconds: 60 }));
    assert.match(out, />Record<\/button>/);
    assert.match(out, /role="meter"[^>]*aria-valuenow="0"/);
    assert.match(out, /0:00 \/ 1:00/);
    assert.match(out, /stops by itself after 60 seconds/);
  });

  it("ImageOutput shows base64 images with a download named by type", () => {
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const out = html(el(media.ImageOutput, { images: [{ b64: png, label: "Turn 1" }], name: "fox" }));
    assert.match(out, /<img src="data:image\/png;base64,iVBOR/);
    assert.match(out, /download="fox-1\.png"/);
    assert.match(out, /Turn 1 · PNG/);
    assert.equal(html(el(media.ImageOutput, { images: [] })), "");
  });

  describe("MaskOverlay", () => {
    it("draws on a canvas over the image and lists each object with its confidence", () => {
      const records = sam.parseSamOutput(VIDEO_LINE).records;
      const out = html(el(media.MaskOverlay, { src: "/docs-samples/street.jpg", media: "image", records, label: "button" }));
      assert.match(out, /<img[^>]*src="\/docs-samples\/street\.jpg"/);
      assert.match(out, /<canvas[^>]*aria-hidden="true"/);
      assert.match(out, /aria-pressed="true"[^>]*>.*button 0<\/button>/);
      assert.match(out, /button 1 · 0\.75<\/button>/);
      assert.match(out, />Masks<\/label>.*>Boxes<\/label>.*>Labels<\/label>/);
      // Meta's decoder is registered (components/docs/media/mask-decoder.ts), so the recorded masks decode.
      assert.doesNotMatch(out, /mask decoder isn&#x27;t loaded/);
      assert.doesNotMatch(out, /didn&#x27;t decode/);
    });

    it("adds a frame bar for video", () => {
      const out = html(el(media.MaskOverlay, { src: "/docs-samples/street-pan.mp4", media: "video", records: [], fps: 24, frames: 120 }));
      assert.match(out, /<video[^>]*src="\/docs-samples\/street-pan\.mp4"/);
      assert.match(out, /<input type="range" min="0" max="119"[^>]*aria-label="Frame"[^>]*value="0"/);
      assert.match(out, /Frame 0 of 119 \(24 fps\)/);
    });

    it("lists grounding shapes by label", () => {
      const out = html(
        el(media.MaskOverlay, {
          src: "/docs-samples/fridge.jpg",
          media: "image",
          shapes: [
            { kind: "box", label: "milk", x1: 1, y1: 2, x2: 30, y2: 40, group: "milk" },
            { kind: "point", label: "eggs", x: 5, y: 6, group: "eggs" },
          ],
        }),
      );
      assert.match(out, /milk \(1\)/);
      assert.match(out, /eggs \(1\)/);
    });
  });

  describe("VisionPlayground", () => {
    it("starts on Contributor with an image picker, the question and detail", () => {
      const out = html(el(media.VisionPlayground, { slug: "image-understanding" }));
      assert.match(out, /<option value="muse-spark-1\.3-contributor" selected="">Muse Spark 1\.3 Contributor<\/option>/);
      assert.match(out, NOTICE);
      assert.match(out, /accept="image\/png,image\/jpeg,image\/webp,image\/gif"/);
      assert.match(out, /<textarea[^>]*>What&#x27;s in this image\? List the main things you see\.<\/textarea>/);
      assert.match(out, /aria-label="Image detail".*aria-checked="true"[^>]*>Not set<\/button>/);
      assert.match(out, /<span>Run<\/span>/);
      assert.match(out, />Show code<\/label>/);
      assert.doesNotMatch(out, /pg-response/, "no reply before a run");
      assert.doesNotMatch(out, /aria-label="API"/);
    });

    it("shows the extra body, the API switch and presets when asked", () => {
      const out = html(
        el(media.VisionPlayground, {
          slug: "structured-output",
          apiSwitch: true,
          grounding: true,
          extraBody: { text: { format: { type: "json_schema", name: "items" } } },
          presets: [{ label: "Receipt", question: "Extract the total.", sampleId: "receipt" }],
          model: "muse-wonder-1.0",
        }),
      );
      assert.match(out, /aria-label="API"/);
      assert.match(out, /Extra body \(merged into the request\)/);
      assert.match(out, /&quot;json_schema&quot;/);
      assert.match(out, />Receipt<\/button>/);
      assert.doesNotMatch(out, /pg-notice/, "Muse Wonder is Standard mode");
    });
  });

  describe("ImageGenPlayground", () => {
    it("offers the three endpoints, size, format, reasoning and the built-in tools", () => {
      const out = html(el(media.ImageGenPlayground, { slug: "image-generation" }));
      assert.match(out, /aria-label="Endpoint".*>Conversation \(Responses\)<\/button>.*>Generate \(images\/generations\)<\/button>.*>Edit \(images\/edits\)<\/button>/);
      assert.match(out, /Muse Image 1\.0/);
      assert.match(out, /<textarea[^>]*>A watercolor painting of a red fox/);
      assert.match(out, /<option value="1536x1024">1536x1024<\/option>/);
      assert.match(out, />Image search<\/label>.*>Web search<\/label>.*>Shell \(charts, layouts\)<\/label>/);
      assert.match(out, /\$0\.01 per image/);
      assert.match(out, /<span>Generate<\/span>/);
      assert.match(out, /Reference images/);
    });

    it("starts on edits with an image picker and the body switch", () => {
      const out = html(el(media.ImageGenPlayground, { slug: "api-reference/images/edit-image", modes: ["edits"] }));
      assert.doesNotMatch(out, /aria-label="Endpoint"/);
      assert.match(out, />Image to edit<\/label>/);
      assert.match(out, /<textarea[^>]*>Make the sneaker bright orange/);
      assert.match(out, /aria-label="Edit body".*>JSON images array<\/button>.*>multipart \(OpenAI SDK\)<\/button>/);
      assert.match(out, /<span>Edit<\/span>/);
      assert.match(out, /aria-label="Number of images"/);
    });
  });

  describe("VideoPlayground", () => {
    it("picks a clip and offers inline or uploaded sends", () => {
      const out = html(el(media.VideoPlayground, { slug: "video-understanding" }));
      assert.match(out, /accept="video\/mp4,video\/quicktime"/);
      assert.match(out, />Street clip \(5 s\)<\/button>/);
      assert.match(out, /aria-label="How the video is sent".*Inline \(input_video data URL\).*Upload, then input_file.*Upload, then input_video/);
      assert.match(out, NOTICE);
    });

    it("adds the audio tab, starting on Muse Spark 1.2", () => {
      const out = html(el(media.VideoPlayground, { slug: "video-understanding", audio: true, startWith: "audio" }));
      assert.match(out, /aria-label="Input"/);
      assert.match(out, /<option value="muse-spark-1\.2" selected="">/);
      assert.match(out, /Transcribe this audio\. Return only the transcript\./);
      assert.match(out, /isn&#x27;t fully supported yet/);
    });
  });

  describe("TranscribePlayground", () => {
    it("starts on file transcription with samples, the mic, modes and biasing", () => {
      const out = html(el(media.TranscribePlayground, { slug: "speech-to-text", keywords: ["Acme Mobile", "eSIM"] }));
      assert.match(out, /aria-label="Endpoint".*File \(asr\/transcribe\).*Realtime \(asr\/realtime\)/);
      assert.match(out, /aria-label="Audio source".*Sample or file.*Microphone/);
      assert.match(out, />Spoken paragraph<\/button>.*>Two-voice call<\/button>.*>Spoken chess moves<\/button>/);
      assert.match(out, /aria-label="Mode".*aria-checked="true"[^>]*>PUSH_TO_TALK<\/button>/);
      assert.match(out, /value="Acme Mobile, eSIM"/);
      assert.match(out, /Muse Voice Transcribe 1\.0/);
      assert.match(out, /<span>Transcribe<\/span>/);
      assert.match(out, /converted to 16 kHz mono 16-bit WAV here/);
    });

    it("warns that speaker turns may come back empty", () => {
      const out = html(el(media.TranscribePlayground, { slug: "x", mode: "DIARIZATION", endpoints: ["realtime"] }));
      assert.match(out, /can include a few empty turns between speakers/);
      assert.match(out, /aria-label="Partial mode"/);
      assert.match(out, /<span>Stream<\/span>/);
    });
  });

  describe("SegmentPlayground", () => {
    it("starts on an image with a concept, one_bit masks, confidence and streaming", () => {
      const out = html(el(media.SegmentPlayground, { slug: "sam/segmenting" }));
      assert.match(out, /aria-label="Media".*Image \(input_image\).*Video \(input_video\)/);
      assert.match(out, /SAM 3\.1/);
      assert.match(out, /<input[^>]*value="dog"/);
      assert.match(out, /aria-label="Prompt".*Concept \(a noun phrase\).*Boxes and points/);
      assert.match(out, /aria-label="Mask encoding".*aria-checked="true"[^>]*>one_bit<\/button>/);
      assert.match(out, /aria-checked="true"[^>]*><\/button><label[^>]*>Confidence<\/label>/);
      assert.match(out, /aria-checked="true"[^>]*><\/button><label[^>]*>Stream<\/label>/);
      assert.match(out, /aria-checked="false"[^>]*><\/button><label[^>]*>Raw wire<\/label>/);
      assert.match(out, /<span>Segment<\/span>/);
      assert.match(out, /\$0\.0025 a run/);
    });

    it("offers the drawing tools for box and point prompts", () => {
      const out = html(el(media.SegmentPlayground, { slug: "sam/segmenting", promptKind: "objects", media: ["video"] }));
      assert.match(out, /aria-label="Prompt tool".*>Box<\/button>.*>Point<\/button>.*>Negative point<\/button>/);
      assert.match(out, />New object<\/button>/);
      assert.match(out, /Pick a video first\./);
      assert.match(out, /billed per frame/);
    });
  });

  it("FilesPlayground walks through upload, list, one file and use", () => {
    const out = html(el(media.FilesPlayground, { slug: "file-handling" }));
    assert.match(out, /1\. Upload a file.*2\. Your files.*3\. Retrieve, download or delete it.*4\. Use it in a request/);
    assert.match(out, /<code>user_data<\/code>/);
    assert.match(out, />expires_after<\/label>/);
    assert.match(out, />2-page PDF report<\/button>/);
    assert.match(out, />List files<\/button>/);
    assert.match(out, /<button[^>]*disabled=""[^>]*>Retrieve<\/button>/);
    assert.match(out, /Summarize this document in three bullet points\./);
    assert.match(out, /<span>Ask<\/span>/);
    assert.match(out, NOTICE);
  });
});
