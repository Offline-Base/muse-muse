import type { DemoMap, DemoSpec } from "@/lib/docs/demos/types";
import { FilesPlayground, type FilesPlaygroundProps } from "@/components/docs/media/FilesPlayground";
import { FileHandlingLab, type FileHandlingLabProps } from "@/components/docs/playgrounds/media/FileHandlingLab";
import { FilesApiConsole, type FilesApiConsoleProps } from "@/components/docs/playgrounds/media/FilesApiConsole";
import { ImageGenerationLab, type ImageGenerationLabProps } from "@/components/docs/playgrounds/media/ImageGenerationLab";
import { MediaUnderstandingLab, type MediaUnderstandingLabProps } from "@/components/docs/playgrounds/media/MediaUnderstandingLab";
import { PresetConsole, type ConsolePreset, type PresetConsoleProps } from "@/components/docs/playgrounds/media/PresetConsole";
import { SchemaExplorer, type SchemaExplorerProps } from "@/components/docs/playgrounds/media/SchemaExplorer";
import { parseSchemaPage, type SchemaDoc } from "@/components/docs/playgrounds/media/schema-tables";
import { VisionLab, type VisionLabProps } from "@/components/docs/playgrounds/media/VisionLab";
import { docsMarkdown } from "@/lib/docs/pages";

/**
 * Live demos and coding-agent prompts for the "media" pages:
 *   image-understanding
 *   image-generation
 *   video-understanding
 *   file-handling
 *   api-reference/images
 *   api-reference/images/create-image
 *   api-reference/images/edit-image
 *   api-reference/images/schemas
 *   api-reference/files
 *   api-reference/files/upload-file
 *   api-reference/files/list-files
 *   api-reference/files/retrieve-file
 *   api-reference/files/retrieve-file-content
 *   api-reference/files/delete-file
 *   api-reference/files/schemas
 * Components live in components/docs/playgrounds/media/. Text demos run on muse-spark-1.3-contributor (audio on Muse
 * Spark 1.2, as video-understanding advises), and the code and prompts here use it wherever Meta's examples say
 * muse-spark-1.3. Muse Image costs $0.01 per image; the Files API and token counts are free.
 */

const M = "muse-spark-1.3-contributor";
const IMAGE = "muse-image-1.0";
/** Meta's own example image (image-understanding), public, so the URL modes and URL edits run with one press. */
const AVOCADO = "https://upload.wikimedia.org/wikipedia/commons/thumb/c/c9/Avocado_Hass_-_single_and_halved.jpg/1280px-Avocado_Hass_-_single_and_halved.jpg";
/** Meta's own example PDF for file_url (file-handling). */
const DUMMY_PDF = "https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf";
const FOX = "a watercolor painting of a red fox sitting in a snowy pine forest, soft golden morning light";
const TOOLS_OFF = { enable_image_search: false, enable_web_search: false, enable_shell: false };
const IMAGE_ACCEPT = "image/png,image/jpeg,image/webp";

/** One page's demo, typed by its component's props so a wrong prop is a compile error (DemoMap itself takes any). */
const demo = <P extends object>(spec: DemoSpec<P>): DemoSpec<P> => spec;

/** The schema tables of a "Schemas" page, read from the mirrored Markdown on the server. Empty if it can't be read. */
function schemasOf(slug: string): SchemaDoc[] {
  try {
    return parseSchemaPage(docsMarkdown(slug));
  } catch {
    return [];
  }
}

const IMAGES_SCHEMAS = schemasOf("api-reference/images/schemas");
const FILES_SCHEMAS = schemasOf("api-reference/files/schemas");

// ---- Shared Muse Image requests ---------------------------------------------------------------------------------

const generate: ConsolePreset = {
  label: "The page's example",
  note: "$0.01. The page's own request: muse-image-1.0, a prompt and n. The reply's data[0].b64_json is the image.",
  method: "POST",
  path: "images/generations",
  body: { model: IMAGE, prompt: FOX, n: 1 },
};

const editByUrl: ConsolePreset = {
  label: "Image by URL (JSON)",
  note: "$0.01. Meta's JSON body: an images array whose items are an image_url (a public URL or a data URL) or a file_id. Here, the avocado from image-understanding.",
  method: "POST",
  path: "images/edits",
  body: { model: IMAGE, prompt: "Put the avocado halves on a rustic wooden cutting board, keep the soft studio light", images: [{ image_url: AVOCADO }], n: 1 },
};

const editMultipart: ConsolePreset = {
  label: "multipart (OpenAI SDK)",
  note: "$0.01. What client.images.edit sends: multipart/form-data with the image in the image part and each field once. Pick a sample or your image.",
  method: "POST",
  path: "images/edits",
  form: [
    { name: "model", value: IMAGE },
    { name: "prompt", value: "Make the sneaker bright orange with white laces, keep the white background" },
    { name: "n", value: "1" },
    { name: "image", file: { label: "image", accept: IMAGE_ACCEPT } },
  ],
};

const streamGenerate: ConsolePreset = {
  label: "Stream",
  note: "$0.01. stream: true answers with server-sent events: one image_generation.completed event carries the finished image as b64_json, with usage.",
  method: "POST",
  path: "images/generations",
  body: { model: IMAGE, prompt: FOX, n: 1, stream: true },
};

// ---- The images endpoints' errors (image-generation, "Errors"), each refused before an image is made -------------

const errorPresets: ConsolePreset[] = [
  {
    label: "Unknown field",
    note: "Free. An unknown top-level field (seed) is refused with 400, naming it in param.",
    method: "POST",
    path: "images/generations",
    body: { model: IMAGE, prompt: "a red fox in the snow", seed: 42 },
  },
  {
    label: "Too wide",
    note: "Free. size sets only the aspect ratio, and ratios beyond 16:1 return 400 (param: size).",
    method: "POST",
    path: "images/generations",
    body: { model: IMAGE, prompt: "a red fox in the snow", size: "1700x100" },
  },
  {
    label: "moderation",
    note: "Free. moderation is enabled per model and not on muse-image-1.0, so any value returns 400 unsupported_parameter. Leaving it out is always valid.",
    method: "POST",
    path: "images/generations",
    body: { model: IMAGE, prompt: "a red fox in the snow", moderation: "auto" },
  },
  {
    label: "Bad output_format",
    note: "Free. output_format takes webp, png or jpeg; anything else is a 400.",
    method: "POST",
    path: "images/generations",
    body: { model: IMAGE, prompt: "a red fox in the snow", output_format: "gif" },
  },
  {
    label: "Empty prompt",
    note: "Free. A missing, empty or over-long prompt is rejected with 400 (param: prompt) before inference runs.",
    method: "POST",
    path: "images/generations",
    body: { model: IMAGE, prompt: "" },
  },
  {
    label: "web_search tool",
    note: "Free. Muse Image searches on its own and accepts only the image_generation tool, so web_search (or a function tool) is a 400.",
    method: "POST",
    path: "responses",
    body: { model: IMAGE, input: "a red fox in the snow", tools: [{ type: "web_search" }] },
  },
  {
    label: "Unknown edit item field",
    note: "Free. Unknown members of an edit image item are refused, with param images[0].detail.",
    method: "POST",
    path: "images/edits",
    body: { model: IMAGE, prompt: "make it orange", images: [{ image_url: AVOCADO, detail: "high" }] },
  },
  {
    label: "No images",
    note: "Free. An edit needs 1 to 10 images.",
    method: "POST",
    path: "images/edits",
    body: { model: IMAGE, prompt: "make it orange", images: [] },
  },
  {
    label: "Not an image",
    note: "Free. A fetched image_url whose Content-Type isn't image/* returns 400 with param images[0].image_url. This one is a PDF.",
    method: "POST",
    path: "images/edits",
    body: { model: IMAGE, prompt: "make it orange", images: [{ image_url: DUMMY_PDF }] },
  },
];

// ---- Snippets -----------------------------------------------------------------------------------------------------

const PY_CLIENT = `from openai import OpenAI

client = OpenAI(base_url="https://api.meta.ai/v1", api_key=os.environ["MODEL_API_KEY"])`;

const TS_CLIENT = `const client = new OpenAI({ baseURL: 'https://api.meta.ai/v1', apiKey: process.env.MODEL_API_KEY });`;

export const mediaDemos: DemoMap = {
  "image-understanding": demo<VisionLabProps>({
    title: "Ask about images, then point, box and count",
    blurb:
      "Run sends your image and question to Muse Spark and streams the answer; grounding presets draw its points and boxes on the image, and Count input tokens is free. Under a cent a run on the default model.",
    Component: VisionLab,
    props: {
      publicUrl: AVOCADO,
      presets: [
        { group: "Ask", label: "Describe a photo", samples: ["street"], question: "What is in this image? Describe the scene in two sentences." },
        { group: "Ask", label: "Read a chart", samples: ["bar-chart"], question: 'Read every bar\'s value and return them as JSON: [{"drink": string, "cups": number}].' },
        { group: "Ask", label: "Read a document", samples: ["receipt"], question: "Extract the store, the date, every line item with its price, and the total as JSON." },
        { group: "Ask", label: "Compare two images", samples: ["cat-sofa", "living-room"], question: "What do these two images have in common?" },
        { group: "Locate", label: "Point", samples: ["fridge"], grounding: "point", objects: ["the milk", "the eggs", "the container labeled SOUP"] },
        { group: "Locate", label: "Box", samples: ["street"], grounding: "box", objects: ["the golden retriever", "the black labrador", "the bicycle rack"] },
        { group: "Locate", label: "Count", samples: ["street"], grounding: "count", objects: ["person", "bicycle"] },
        { group: "Send", label: "Public URL", send: "public_url", question: "What is in this image?" },
        { group: "Send", label: "Uploaded file", send: "file_id_file", samples: ["receipt"], question: "What is the total on this receipt?" },
        { group: "Send", label: "file_url", send: "file_url", question: "What is in this image?" },
        { group: "Send", label: "Chat Completions", api: "chat", samples: ["cat-sofa"], question: "Describe what you see in this image." },
      ],
    },
    agentPrompt: {
      task:
        "Add image understanding to my app with Meta's Responses API: send a user message with an input_text part and one or more input_image parts (a public URL, a base64 data URL, or an uploaded file's id), print the answer, and add a grounding helper that asks for points or boxes on the 0 to 1000 grid and converts them to pixels of the image I sent.",
      facts: [
        'POST /v1/responses, user content [{"type": "input_text", ...}, {"type": "input_image", "image_url": <http(s) URL or data:image/...;base64 URL>}].',
        'Uploads: {"type": "input_image", "file_id": ...} (POST /v1/files, purpose user_data). Chat: {"type": "image_url", "image_url": {"url": ...}}.',
        "Images count only in user messages: up to 50 per request (more is a 400), 50 MB each inline.",
        "Grounding uses a 0 to 1000 grid of the sent image, (0, 0) top left: pixel = round(v * size / 1000).",
        "POST /v1/responses/input_tokens counts an input for free; a ~1280 px image is 1,300 to 1,500 tokens.",
        "Reasoning shares max_output_tokens: keep it roomy, or set the reasoning effort low.",
      ],
      checklist: [
        "Asking about a public image URL prints a description of that image.",
        "The same question about a local file, sent as a data URL, works too.",
        "The grounding helper's pixel boxes land on the named objects when drawn on the image.",
        "POST /v1/responses/input_tokens returns a count for the same input.",
      ],
      snippets: {
        python: `import base64
import os

${PY_CLIENT}

with open("photo.jpg", "rb") as f:
    image = "data:image/jpeg;base64," + base64.b64encode(f.read()).decode()

response = client.responses.create(
    model="${M}",
    input=[
        {
            "type": "message",
            "role": "user",
            "content": [
                {"type": "input_text", "text": "What is in this image?"},
                {"type": "input_image", "image_url": image},
            ],
        }
    ],
)
print(response.output_text)


def to_pixels(x_norm, y_norm, width, height):
    return round(x_norm * width / 1000), round(y_norm * height / 1000)`,
        typescript: `import OpenAI from 'openai';

${TS_CLIENT}

const response = await client.responses.create({
  model: '${M}',
  input: [
    {
      type: 'message',
      role: 'user',
      content: [
        { type: 'input_text', text: 'What is in this image?' },
        { type: 'input_image', image_url: '${AVOCADO}' },
      ],
    },
  ],
});
console.log(response.output_text);

const toPixels = (x: number, y: number, width: number, height: number) => [Math.round((x * width) / 1000), Math.round((y * height) / 1000)];`,
        curl: `curl -X POST "https://api.meta.ai/v1/responses" \\
  -H "Authorization: Bearer $MODEL_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
  "model": "${M}",
  "input": [
    {
      "type": "message",
      "role": "user",
      "content": [
        {"type": "input_text", "text": "What is in this image?"},
        {"type": "input_image", "image_url": "${AVOCADO}"}
      ]
    }
  ]
}'`,
      },
    },
  }),

  "image-generation": demo<ImageGenerationLabProps>({
    title: "Generate an image, then refine it turn by turn",
    blurb:
      "Generate makes an image with Muse Image on the Responses API and follow-ups edit it through previous_response_id, $0.01 an image; the other tabs run store: false turns and the images endpoints' options at the same price, and the page's errors for free.",
    Component: ImageGenerationLab,
    props: {
      playground: {
        modes: ["responses", "generations", "edits"],
        prompt: "a red fox trotting through fresh snow, golden hour",
        followUps: ["now make it night, with the aurora overhead", "add a small red wool hat on the fox's head", "make it a watercolor painting"],
        sizes: ["auto", "1024x1024", "1536x1024", "1024x1536", "1792x1024"],
        editPrompt: "Make the sneaker bright orange with white laces. Keep the white background and the soft shadow.",
        editSampleIds: ["sneaker", "living-room", "cat-sofa", "street"],
      },
      stateless: {
        prompt: "a red fox trotting through fresh snow, golden hour",
        followUps: ["now make it night, with the aurora overhead", "add a small red wool hat on the fox's head", "make it a pencil sketch"],
        fast: true,
      },
      options: {
        presets: [
          streamGenerate,
          {
            label: "Signed URL",
            note: "$0.01. response_format: url returns a temporary signed link in data[].url instead of base64.",
            method: "POST",
            path: "images/generations",
            body: { model: IMAGE, prompt: FOX, response_format: "url" },
          },
          {
            label: "Quick and plain",
            note: "$0.01, same as always. reasoning_strength low returns after one pass, and tool_enablement turns the lookups off: faster when the prompt needs no real-world facts.",
            method: "POST",
            path: "images/generations",
            body: { model: IMAGE, prompt: FOX, size: "1536x1024", output_format: "jpeg", reasoning_strength: "low", tool_enablement: TOOLS_OFF },
          },
          {
            label: "Grounded infographic",
            note: "$0.01, same price with tools on. Muse Image looks up the current table and each crest before it renders, so this one takes longer.",
            method: "POST",
            path: "images/generations",
            body: {
              model: IMAGE,
              prompt: "An infographic of the current Premier League top four, with each club's crest",
              reasoning_strength: "high",
              tool_enablement: { enable_image_search: true, enable_web_search: true, enable_shell: true },
            },
          },
          editByUrl,
          {
            label: "Edit by file_id",
            note: "$0.01. Upload an image once with the Files API, then edit it by id: the images item is {\"file_id\": ...}.",
            method: "POST",
            path: "images/edits",
            body: { model: IMAGE, prompt: "Make the sneaker bright orange with white laces, keep the white background", images: [{ file_id: "file-abc123" }], n: 1 },
            fileId: "/images/0/file_id",
            uploadSampleId: "sneaker",
            uploadAccept: IMAGE_ACCEPT,
          },
          {
            label: "Stream an edit",
            note: "$0.01. images/edits streams one image_edit.completed event with the edited image.",
            method: "POST",
            path: "images/edits",
            body: { model: IMAGE, prompt: "Put the avocado halves on a rustic wooden cutting board", images: [{ image_url: AVOCADO }], stream: true },
          },
        ],
      },
      errors: { presets: errorPresets },
    },
    agentPrompt: {
      task:
        "Add image generation to my app with Muse Image on the Responses API: generate from a prompt, save the base64 image from the image_generation_call item, refine it with follow-up turns chained by previous_response_id, and add one-off calls to POST /v1/images/generations and POST /v1/images/edits.",
      facts: [
        "Pick output items by type: one image_generation_call per image, base64 in result.",
        'Follow-ups: previous_response_id and only the new instruction; with store: false, replay {"type": "image_generation_call", "id": ..., "status": "completed", "result": null} first.',
        'One {"type": "image_generation"} tool sets enable_image_search, enable_web_search, enable_shell, reasoning_strength, size and output_format; other tools are 400s.',
        "images/* take top-level tool_enablement and reasoning_strength (SDK: extra_body); edits take multipart image parts or JSON images: [{image_url} or {file_id}].",
        "$0.01 per image. Unknown top-level fields and moderation are 400s; 503 is retryable.",
      ],
      checklist: [
        "One prompt saves a .webp file that opens as an image.",
        "A follow-up with previous_response_id changes that image as asked.",
        "client.images.generate and an images/edits call each return data[0].b64_json.",
      ],
      snippets: {
        python: `import base64
import os

${PY_CLIENT}


def save_image(response, path):
    image_b64 = next(o.result for o in response.output if o.type == "image_generation_call")
    with open(path, "wb") as f:
        f.write(base64.b64decode(image_b64))


t1 = client.responses.create(model="${IMAGE}", input="a red fox trotting through fresh snow, golden hour")
save_image(t1, "fox.webp")

t2 = client.responses.create(
    model="${IMAGE}",
    previous_response_id=t1.id,
    input="now make it night, with the aurora overhead",
)
save_image(t2, "fox-night.webp")

one_off = client.images.generate(model="${IMAGE}", prompt="${FOX}", n=1)
with open("watercolor.webp", "wb") as f:
    f.write(base64.b64decode(one_off.data[0].b64_json))`,
        typescript: `import fs from 'fs';
import OpenAI from 'openai';

${TS_CLIENT}

function saveImage(response: OpenAI.Responses.Response, path: string) {
  const call = response.output.find((o) => o.type === 'image_generation_call');
  if (call?.type === 'image_generation_call' && call.result) fs.writeFileSync(path, Buffer.from(call.result, 'base64'));
}

const t1 = await client.responses.create({ model: '${IMAGE}', input: 'a red fox trotting through fresh snow, golden hour' });
saveImage(t1, 'fox.webp');

const t2 = await client.responses.create({
  model: '${IMAGE}',
  previous_response_id: t1.id,
  input: 'now make it night, with the aurora overhead',
});
saveImage(t2, 'fox-night.webp');`,
        curl: `curl -X POST "https://api.meta.ai/v1/responses" \\
  -H "Authorization: Bearer $MODEL_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
  "model": "${IMAGE}",
  "input": "a red fox trotting through fresh snow, golden hour"
}'

# Then: the same call with "previous_response_id": "<the id above>" and the next instruction as input.`,
      },
    },
  }),

  "video-understanding": demo<MediaUnderstandingLabProps>({
    title: "Ask about a clip or a recording",
    blurb:
      "Run sends a clip (uploaded and referenced by file_id, inline, or by URL) or a recording to Muse Spark on the Responses API or Chat Completions and streams the answer. Under a cent a run on the default model.",
    Component: MediaUnderstandingLab,
    props: {
      presets: [
        { group: "Video", label: "Describe (upload, input_file)", media: "video", send: "upload_input_file", question: "Describe what happens in this video." },
        { group: "Video", label: "Public URL", media: "video", send: "public_url", question: "Describe what happens in this video." },
        { group: "Video", label: "Timestamps", media: "video", send: "inline", question: "List what happens in this clip with timestamps (mm:ss), one line per moment." },
        { group: "Video", label: "Ask a question", media: "video", send: "inline", question: "How many dogs are in the clip, and which way does the camera move?" },
        {
          group: "Video",
          label: "Structured details",
          media: "video",
          send: "inline",
          question: "Return only JSON with summary (one sentence), objects (an array of the things you see) and camera_motion (a few words).",
        },
        { group: "Video", label: "Chat Completions video_url", media: "video", api: "chat", send: "inline", question: "Describe what happens in this video." },
        { group: "Audio", label: "Transcribe", media: "audio", send: "input_audio", sampleId: "speech-paragraph", question: "Transcribe this audio. Return only the transcript." },
        { group: "Audio", label: "Summarize a call", media: "audio", send: "input_audio", sampleId: "two-voices", question: "Who is calling, what do they need, and what time do they agree on?" },
        { group: "Audio", label: "audio_url", media: "audio", send: "audio_url", sampleId: "chess-moves", question: "Transcribe this audio. Return only the transcript." },
        { group: "Audio", label: "Uploaded audio", media: "audio", send: "upload", sampleId: "chess-moves", question: "List the chess moves you hear, one per line." },
        { group: "Audio", label: "Chat Completions input_audio", media: "audio", api: "chat", send: "input_audio", sampleId: "speech-paragraph", question: "Transcribe this audio. Return only the transcript." },
      ],
    },
    agentPrompt: {
      task:
        "Add video and audio understanding to my app with Meta's Responses API: upload an MP4 with the Files API (purpose user_data), reference its file_id in an input_file part next to my question, and transcribe WAV or MP3 audio sent as an input_audio part. Print each answer.",
      facts: [
        'Video: {"type": "input_file", "file_id": ...} (or input_video) for an upload (purpose user_data), or {"type": "input_video", "video_url": <public or data URL>}. Chat: {"type": "video_url", "video_url": {"url": ...}}.',
        'Audio, both APIs: {"type": "input_audio", "input_audio": {"data": <base64>, "format": "wav"}} (or mp3). Responses also: {"type": "input_audio", "audio_url": <data URI>} or {"type": "input_audio", "file_id": ...}.',
        "Send audio to muse-spark-1.2 or 1.2-contributor: 1.3 doesn't fully support it yet.",
        "Transcripts need 4000+ max_output_tokens (Chat: max_tokens), as reasoning shares it; stream long clips.",
        "Formats: video/mp4 (sound included), audio/mpeg, audio/wav.",
      ],
      checklist: [
        "Uploading a short MP4 and asking about it prints a description of the clip.",
        "A WAV file comes back as its transcript.",
        "A long clip streams without an idle timeout.",
      ],
      snippets: {
        python: `import base64
import os

${PY_CLIENT}


def ask(model, text, part, **options):
    message = {"type": "message", "role": "user", "content": [{"type": "input_text", "text": text}, part]}
    return client.responses.create(model=model, input=[message], **options).output_text


with open("clip.mp4", "rb") as f:
    video = client.files.create(file=f, purpose="user_data")
print(ask("${M}", "Describe what happens in this video.", {"type": "input_file", "file_id": video.id}))

with open("speech.wav", "rb") as f:
    audio = {"type": "input_audio", "input_audio": {"data": base64.b64encode(f.read()).decode(), "format": "wav"}}
print(ask("muse-spark-1.2", "Transcribe this audio. Return only the transcript.", audio, max_output_tokens=4000))`,
        typescript: `import fs from 'fs';
import OpenAI from 'openai';

${TS_CLIENT}

const video = await client.files.create({ file: fs.createReadStream('clip.mp4'), purpose: 'user_data' });

const answer = await client.responses.create({
  model: '${M}',
  input: [
    {
      type: 'message',
      role: 'user',
      content: [
        { type: 'input_text', text: 'Describe what happens in this video.' },
        { type: 'input_file', file_id: video.id },
      ],
    },
  ],
});
console.log(answer.output_text);`,
        curl: `FILE_ID=$(curl -s -X POST "https://api.meta.ai/v1/files" \\
  -H "Authorization: Bearer $MODEL_API_KEY" \\
  -F "purpose=user_data" \\
  -F "file=@clip.mp4" | jq -r .id)

curl -X POST "https://api.meta.ai/v1/responses" \\
  -H "Authorization: Bearer $MODEL_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
  "model": "${M}",
  "input": [{"type": "message", "role": "user", "content": [
    {"type": "input_text", "text": "Describe what happens in this video."},
    {"type": "input_file", "file_id": "'"$FILE_ID"'"}
  ]}]
}'`,
      },
    },
  }),

  "file-handling": demo<FileHandlingLabProps>({
    title: "Send a file inline, or upload it once and reuse the id",
    blurb:
      "The first tab sends a PDF, image or clip inline (file_data, a Chat Completions file block, file_url or input_video) and streams the answer; the second uploads it with the Files API, lists, downloads and deletes it, and asks about it by file_id. Under a cent a run on the default model; Files calls are free.",
    Component: FileHandlingLab,
    props: {
      inline: {
        fileUrl: DUMMY_PDF,
        presets: [
          { label: "PDF as file_data", send: "responses_file_data", sampleId: "field-report", question: "Summarize this document." },
          { label: "Chat Completions file block", send: "chat_file", sampleId: "field-report", question: "Summarize this document." },
          { label: "PDF by URL (file_url)", send: "responses_file_url", url: DUMMY_PDF, question: "Summarize this document." },
          { label: "An image as file_data", send: "responses_file_data", sampleId: "receipt", question: "What is the total on this receipt?" },
          { label: "Inline video", send: "responses_video_url", sampleId: "street-pan", question: "Describe what happens in this video." },
        ],
      },
      upload: { sampleId: "field-report", focus: "upload", expiry: true },
    },
    agentPrompt: {
      task:
        "Add file input to my app: send a PDF inline in a Responses request as an input_file with file_data (a base64 data URL) and a filename, and add an upload path that POSTs the file once to /v1/files (purpose user_data, optional expires_after), reuses the returned file- id in later requests, and deletes it when done.",
      facts: [
        'Inline (up to 50 MB): Responses {"type": "input_file", "filename": ..., "file_data": "data:application/pdf;base64,..."} or {"type": "input_file", "file_url": ...}; Chat {"type": "file", "file": {"filename": ..., "file_data": ...}}.',
        'Upload: multipart POST /v1/files with purpose=user_data (and expires_after) before the file part, up to 1 GiB, then {"type": "input_file", "file_id": ...}.',
        "Uploads never expire unless expires_after[anchor]=created_at and expires_after[seconds] (3600 to 2592000) are set, and count toward the team's 100 GiB until DELETE /v1/files/{file_id}.",
        "PDFs: text from the first 100 pages, images of the first 50 (counted toward 50 images per request).",
      ],
      checklist: [
        "A PDF sent inline gets a summary back.",
        "Uploading the same PDF returns a file- id, and a request with that file_id answers about it.",
        "GET /v1/files lists it, and DELETE /v1/files/{file_id} returns deleted: true.",
      ],
      snippets: {
        python: `import base64
import os

${PY_CLIENT}


def ask(text, part):
    message = {"type": "message", "role": "user", "content": [{"type": "input_text", "text": text}, part]}
    return client.responses.create(model="${M}", input=[message]).output_text


with open("document.pdf", "rb") as f:
    file_data = "data:application/pdf;base64," + base64.b64encode(f.read()).decode()
print(ask("Summarize this document.", {"type": "input_file", "filename": "document.pdf", "file_data": file_data}))

with open("document.pdf", "rb") as f:
    uploaded = client.files.create(purpose="user_data", expires_after={"anchor": "created_at", "seconds": 86400}, file=f)
print(ask("List the action items.", {"type": "input_file", "file_id": uploaded.id}))
client.files.delete(uploaded.id)`,
        typescript: `import fs from 'fs';
import OpenAI from 'openai';

${TS_CLIENT}

const file_data = \`data:application/pdf;base64,\${fs.readFileSync('document.pdf').toString('base64')}\`;

const inline = await client.responses.create({
  model: '${M}',
  input: [
    {
      type: 'message',
      role: 'user',
      content: [
        { type: 'input_text', text: 'Summarize this document.' },
        { type: 'input_file', filename: 'document.pdf', file_data },
      ],
    },
  ],
});
console.log(inline.output_text);

const uploaded = await client.files.create({ purpose: 'user_data', file: fs.createReadStream('document.pdf') });
console.log(uploaded.id);`,
        curl: `curl -X POST "https://api.meta.ai/v1/files" \\
  -H "Authorization: Bearer $MODEL_API_KEY" \\
  -F "purpose=user_data" \\
  -F "expires_after[anchor]=created_at" \\
  -F "expires_after[seconds]=86400" \\
  -F "file=@document.pdf"

curl -X POST "https://api.meta.ai/v1/responses" \\
  -H "Authorization: Bearer $MODEL_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"model": "${M}", "input": [{"type": "message", "role": "user", "content": [
    {"type": "input_text", "text": "Summarize this document."},
    {"type": "input_file", "file_id": "file-abc123"}]}]}'`,
      },
    },
  }),

  "api-reference/images": demo<PresetConsoleProps>({
    title: "Call the images endpoints",
    blurb: "Send a ready request to POST /v1/images/generations or /v1/images/edits and see the image and its ImagesResponse; $0.01 per image.",
    Component: PresetConsole,
    props: {
      presets: [
        { ...generate, label: "Generate an image" },
        { ...editByUrl, label: "Edit an image (JSON)" },
        { ...editMultipart, label: "Edit an image (multipart)" },
        streamGenerate,
      ],
    },
    agentPrompt: {
      task:
        "Call Meta's images endpoints from my app: POST /v1/images/generations for text to image and POST /v1/images/edits to edit or compose images, decode data[].b64_json into image files, and surface the API's 400 messages.",
      facts: [
        "Model muse-image-1.0 on both. They're compatible with the OpenAI Images API: client.images.generate and client.images.edit with base_url https://api.meta.ai/v1.",
        'Both answer an ImagesResponse: {"created", "data": [{"b64_json"} or {"url"}], "output_format", "background": "opaque", "usage"}.',
        "Edits: the OpenAI SDK sends multipart image parts; over raw HTTP, Meta also takes JSON with images: [{image_url} or {file_id}], 1 to 10 items.",
        "stream: true answers with server-sent events: image_generation.completed or image_edit.completed, each carrying b64_json.",
        "$0.01 per image returned, whatever reasoning_strength or tools did.",
      ],
      checklist: [
        "A generation saves data[0].b64_json as an image file that opens.",
        "An edit of that file returns a changed image.",
        "A bad request (an unknown field such as seed) prints Meta's 400 message.",
      ],
      snippets: {
        python: `import base64
import os

${PY_CLIENT}

generated = client.images.generate(model="${IMAGE}", prompt="${FOX}", n=1)
with open("fox.webp", "wb") as f:
    f.write(base64.b64decode(generated.data[0].b64_json))

with open("fox.webp", "rb") as image:
    edited = client.images.edit(
        model="${IMAGE}",
        prompt="add a small red wool hat on the fox's head, keep the snowy forest background",
        image=image,
        n=1,
    )
with open("fox-hat.webp", "wb") as f:
    f.write(base64.b64decode(edited.data[0].b64_json))`,
        typescript: `import fs from 'fs';
import OpenAI, { toFile } from 'openai';

${TS_CLIENT}

const generated = await client.images.generate({ model: '${IMAGE}', prompt: '${FOX}', n: 1 });
fs.writeFileSync('fox.webp', Buffer.from(generated.data?.[0]?.b64_json ?? '', 'base64'));

const edited = await client.images.edit({
  model: '${IMAGE}',
  prompt: "add a small red wool hat on the fox's head, keep the snowy forest background",
  image: await toFile(fs.createReadStream('fox.webp'), 'fox.webp', { type: 'image/webp' }),
});
fs.writeFileSync('fox-hat.webp', Buffer.from(edited.data?.[0]?.b64_json ?? '', 'base64'));`,
        curl: `curl -X POST "https://api.meta.ai/v1/images/generations" \\
  -H "Authorization: Bearer $MODEL_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"model": "${IMAGE}", "prompt": "${FOX}", "n": 1}'

curl -X POST "https://api.meta.ai/v1/images/edits" \\
  -H "Authorization: Bearer $MODEL_API_KEY" \\
  -F "model=${IMAGE}" \\
  -F "prompt=add a small red wool hat on the fox's head" \\
  -F "image=@fox.webp"`,
      },
    },
  }),

  "api-reference/images/create-image": demo<PresetConsoleProps>({
    title: "Generate an image with POST /v1/images/generations",
    blurb: "Pick a request (the page's example, a quick one, a shape and format, a signed URL, a stream, two images, planning temperature) and press Send to see the image; $0.01 per image.",
    Component: PresetConsole,
    props: {
      presets: [
        generate,
        {
          label: "Quick",
          note: "$0.01. reasoning_strength low returns after a single pass, and tool_enablement turns off the lookups this prompt doesn't need.",
          method: "POST",
          path: "images/generations",
          body: { model: IMAGE, prompt: FOX, reasoning_strength: "low", tool_enablement: TOOLS_OFF },
        },
        {
          label: "Wide JPEG",
          note: "$0.01. size sets only the aspect ratio: the image comes back at the generator's own resolution. output_format picks the encoding (webp, png or jpeg); a PNG of this size is about 4 MB.",
          method: "POST",
          path: "images/generations",
          body: { model: IMAGE, prompt: FOX, size: "1536x1024", output_format: "jpeg" },
        },
        {
          label: "Signed URL",
          note: "$0.01. response_format url puts a temporary signed link in data[].url instead of b64_json.",
          method: "POST",
          path: "images/generations",
          body: { model: IMAGE, prompt: FOX, response_format: "url" },
        },
        streamGenerate,
        {
          label: "Two images",
          note: "$0.02: n images are billed as n. Meta takes n up to 10; the live docs make at most 2 per call.",
          method: "POST",
          path: "images/generations",
          body: { model: IMAGE, prompt: FOX, n: 2, reasoning_strength: "low" },
        },
        {
          label: "Temperature and user",
          note: "$0.01. temperature (0 to 2) samples the planning step, not the pixels; user is a stable end-user id for abuse detection.",
          method: "POST",
          path: "images/generations",
          body: { model: IMAGE, prompt: FOX, temperature: 0.4, user: "user-1234" },
        },
      ],
    },
    agentPrompt: {
      task:
        "Add a generate_image function to my app that calls POST /v1/images/generations with muse-image-1.0 and a prompt, takes n, size and output_format, and writes each data[].b64_json to a file.",
      facts: [
        'model and prompt are required; n is 1 to 10 (default 1). size "WxH" sets only the aspect ratio, and beyond 16:1 is a 400.',
        "response_format b64_json (default) or url (a temporary signed link); output_format webp (default), png or jpeg.",
        "reasoning_strength high (default) or low (one pass, faster); temperature 0 to 2 tunes only planning; tool_enablement {enable_image_search, enable_web_search, enable_shell}, all on by default; user: an end-user id.",
        "OpenAI SDK: send reasoning_strength and tool_enablement in extra_body. moderation and unknown top-level fields are 400s.",
        "stream: true sends one image_generation.completed event with b64_json and usage. $0.01 per image.",
      ],
      checklist: [
        "generate_image(\"a red fox\", n=1) writes one image file that opens.",
        "size 1536x1024 returns a landscape image, and output_format png writes PNG bytes.",
        "An invalid size or field prints Meta's 400 message with its param.",
      ],
      snippets: {
        python: `import base64
import os

${PY_CLIENT}


def generate_image(prompt, n=1, size=None, output_format="webp"):
    response = client.images.generate(
        model="${IMAGE}",
        prompt=prompt,
        n=n,
        **({"size": size} if size else {}),
        output_format=output_format,
        extra_body={"reasoning_strength": "low"},
    )
    paths = []
    for i, image in enumerate(response.data):
        path = f"image-{i}.{output_format}"
        with open(path, "wb") as f:
            f.write(base64.b64decode(image.b64_json))
        paths.append(path)
    return paths


print(generate_image("${FOX}", size="1536x1024"))`,
        typescript: `import fs from 'fs';
import OpenAI from 'openai';

${TS_CLIENT}

const response = await client.images.generate({
  model: '${IMAGE}',
  prompt: '${FOX}',
  n: 1,
  size: '1536x1024',
});
response.data?.forEach((image, i) => fs.writeFileSync(\`image-\${i}.webp\`, Buffer.from(image.b64_json ?? '', 'base64')));`,
        curl: `curl -X POST "https://api.meta.ai/v1/images/generations" \\
  -H "Authorization: Bearer $MODEL_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
  "model": "${IMAGE}",
  "prompt": "${FOX}",
  "n": 1,
  "size": "1536x1024",
  "output_format": "png"
}'`,
      },
    },
  }),

  "api-reference/images/edit-image": demo<PresetConsoleProps>({
    title: "Edit an image with POST /v1/images/edits",
    blurb: "Send an edit by public URL, your image as a data URL, two images to compose, multipart as the OpenAI SDK sends it, an uploaded file_id, or a stream, and see the edited image; $0.01 per image.",
    Component: PresetConsole,
    props: {
      presets: [
        editByUrl,
        {
          label: "Your image (data URL)",
          note: "$0.01. Pick a sample or your image: it goes in images[0].image_url as a base64 data URL.",
          method: "POST",
          path: "images/edits",
          body: { model: IMAGE, prompt: "Make the sneaker bright orange with white laces, keep the white background", images: [{ image_url: "" }], n: 1 },
          fileSlots: [{ pointer: "/images/0/image_url", label: "Image to edit", accept: IMAGE_ACCEPT, as: "dataUrl" }],
        },
        {
          label: "Compose two images",
          note: "$0.01. Several images fuse into one scene, here the cat into the living room. Pick the cat and the living room samples.",
          method: "POST",
          path: "images/edits",
          body: {
            model: IMAGE,
            prompt: "Place the ginger cat from the first image asleep on the cream sofa in the second image, keep the room as it is",
            images: [{ image_url: "" }, { image_url: "" }],
          },
          fileSlots: [
            { pointer: "/images/0/image_url", label: "First image (the subject)", accept: IMAGE_ACCEPT, as: "dataUrl" },
            { pointer: "/images/1/image_url", label: "Second image (the setting)", accept: IMAGE_ACCEPT, as: "dataUrl" },
          ],
        },
        editMultipart,
        {
          label: "Uploaded file_id",
          note: "$0.01. An image uploaded once with the Files API, edited by its id.",
          method: "POST",
          path: "images/edits",
          body: { model: IMAGE, prompt: "Make the sneaker bright orange with white laces, keep the white background", images: [{ file_id: "file-abc123" }], n: 1 },
          fileId: "/images/0/file_id",
          uploadSampleId: "sneaker",
          uploadAccept: IMAGE_ACCEPT,
        },
        {
          label: "Stream",
          note: "$0.01. stream: true sends one image_edit.completed event carrying the edited image.",
          method: "POST",
          path: "images/edits",
          body: { model: IMAGE, prompt: "Put the avocado halves on a rustic wooden cutting board", images: [{ image_url: AVOCADO }], stream: true },
        },
      ],
    },
    agentPrompt: {
      task:
        "Add an edit_image function to my app that sends POST /v1/images/edits with muse-image-1.0, a prompt and one or more input images (multipart through the OpenAI SDK, or Meta's JSON images array over HTTP) and saves data[].b64_json.",
      facts: [
        "Multipart (client.images.edit): image for one file, or image[0], image[1] for several (never both), and each scalar field once. mask, input_fidelity and partial_images are 400 unsupported_parameter.",
        "JSON (requests or curl): images is 1 to 10 items, each exactly one of image_url (a public URL or a data URL) or file_id. Unknown item members are 400s, and a fetched image_url must be image/*.",
        "Other fields as generations: n 1 to 10, size (aspect ratio), response_format, output_format, reasoning_strength, temperature, user, tool_enablement, stream (image_edit.completed events).",
        "The reply is an ImagesResponse, the same shape as generations. $0.01 per image.",
      ],
      checklist: [
        "Editing a local PNG through the SDK writes a changed image.",
        "The JSON body with an image_url works over plain HTTP.",
        "Two input images compose into one scene.",
      ],
      snippets: {
        python: `import base64
import os

import requests

with open("fox.png", "rb") as f:
    image = "data:image/png;base64," + base64.b64encode(f.read()).decode()

response = requests.post(
    "https://api.meta.ai/v1/images/edits",
    headers={"Authorization": f"Bearer {os.environ['MODEL_API_KEY']}", "Content-Type": "application/json"},
    json={
        "model": "${IMAGE}",
        "prompt": "add a small red wool hat on the fox's head, keep the snowy forest background",
        "images": [{"image_url": image}],
        "n": 1,
    },
)
response.raise_for_status()
with open("edited.webp", "wb") as f:
    f.write(base64.b64decode(response.json()["data"][0]["b64_json"]))`,
        typescript: `import fs from 'fs';

const image = \`data:image/png;base64,\${fs.readFileSync('fox.png').toString('base64')}\`;
const response = await fetch('https://api.meta.ai/v1/images/edits', {
  method: 'POST',
  headers: { Authorization: \`Bearer \${process.env.MODEL_API_KEY}\`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: '${IMAGE}',
    prompt: "add a small red wool hat on the fox's head, keep the snowy forest background",
    images: [{ image_url: image }],
    n: 1,
  }),
});
if (!response.ok) throw new Error(await response.text());
const { data } = await response.json();
fs.writeFileSync('edited.webp', Buffer.from(data[0].b64_json, 'base64'));`,
        curl: `curl -X POST "https://api.meta.ai/v1/images/edits" \\
  -H "Authorization: Bearer $MODEL_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
  "model": "${IMAGE}",
  "prompt": "Put the avocado halves on a rustic wooden cutting board, keep the soft studio light",
  "images": [{"image_url": "${AVOCADO}"}],
  "n": 1
}'`,
      },
    },
  }),

  "api-reference/images/schemas": demo<SchemaExplorerProps>({
    title: "Explore the images schemas and check a body",
    blurb:
      "Browse every schema on this page, edit a request built from its table to see what the API would refuse, then send it and check the real ImagesResponse field by field ($0.01 per image).",
    Component: SchemaExplorer,
    props: {
      schemas: IMAGES_SCHEMAS,
      initial: "create-image-request",
      hints: {
        model: IMAGE,
        prompt: FOX,
        "edit-image-body-json-param.prompt": "Put the avocado halves on a rustic wooden cutting board",
        "create-image-edit-request.prompt": "Put the avocado halves on a rustic wooden cutting board",
        "edit-image-body-json-param.images": [{ image_url: AVOCADO }],
        image_url: AVOCADO,
        file_id: null,
        size: "1024x1024",
        output_format: "webp",
        temperature: 1,
        user: "user-1234",
        // moderation isn't enabled on muse-image-1.0, so an example with it would be refused.
        moderation: null,
        enable_image_search: true,
        enable_web_search: true,
        enable_shell: true,
      },
      live: [
        {
          label: "Send the Create Image Request",
          note: "$0.01. POST /v1/images/generations with your Create Image Request body (the example until you edit it), then the reply checked against ImagesResponse.",
          schema: "create-image-request",
          method: "POST",
          path: "images/generations",
          body: "json",
          reply: "images-response",
        },
        {
          label: "Send the Edit Image Body Json Param",
          note: "$0.01. POST /v1/images/edits with your Edit Image Body Json Param body (the example edits the avocado by URL), checked against ImagesResponse.",
          schema: "edit-image-body-json-param",
          method: "POST",
          path: "images/edits",
          body: "json",
          reply: "images-response",
        },
      ],
    },
    agentPrompt: {
      task:
        "Add types for Meta's images endpoints to my app from this page's schemas (CreateImageRequest, EditImageBodyJsonParam, ImageInputItem, ImageToolEnablement, ImagesResponse, ImageObject, ImageGenUsage and the stream events) and validate requests before sending them.",
      facts: [
        "CreateImageRequest: model and prompt required; n 1 to 10; size; response_format url or b64_json; output_format png, jpeg or webp; reasoning_strength; temperature 0 to 2; tool_enablement. moderation is a 400.",
        "EditImageBodyJsonParam adds images: 1 to 10 items, each exactly one of image_url or file_id. In the multipart CreateImageEditRequest, partial_images is a 400.",
        "ImagesResponse: created and data (ImageObject[]) required, plus output_format, background, usage.",
        "image_generation.completed and image_edit.completed events carry b64_json, created_at, output_index; the last has usage.",
        "JSON bodies: unknown top-level fields are 400s; unknown nested keys are ignored.",
      ],
      checklist: [
        "The types compile and a real images/generations reply parses with them.",
        "Validation rejects n: 11 and an unknown top-level field before sending.",
      ],
      snippets: {
        typescript: `type ImageToolEnablement = { enable_image_search?: boolean; enable_web_search?: boolean; enable_shell?: boolean };

interface CreateImageRequest {
  model: string;
  prompt: string;
  n?: number; // 1 to 10, default 1
  size?: string; // "WxH": aspect ratio only
  response_format?: 'url' | 'b64_json';
  output_format?: 'png' | 'jpeg' | 'webp';
  reasoning_strength?: 'low' | 'high';
  temperature?: number; // 0 to 2
  user?: string;
  stream?: boolean;
  tool_enablement?: ImageToolEnablement;
}

interface ImageObject { b64_json?: string; url?: string; revised_prompt?: string }

interface ImagesResponse {
  created: number;
  data: ImageObject[];
  output_format?: string;
  background?: string;
  usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
}`,
        python: `from typing import Literal, NotRequired, TypedDict


class ImageToolEnablement(TypedDict, total=False):
    enable_image_search: bool
    enable_web_search: bool
    enable_shell: bool


class CreateImageRequest(TypedDict):
    model: str
    prompt: str
    n: NotRequired[int]  # 1 to 10
    size: NotRequired[str]  # "WxH", aspect ratio only
    response_format: NotRequired[Literal["url", "b64_json"]]
    output_format: NotRequired[Literal["png", "jpeg", "webp"]]
    reasoning_strength: NotRequired[Literal["low", "high"]]
    temperature: NotRequired[float]
    user: NotRequired[str]
    stream: NotRequired[bool]
    tool_enablement: NotRequired[ImageToolEnablement]


class ImageObject(TypedDict, total=False):
    b64_json: str
    url: str
    revised_prompt: str`,
        curl: `curl -X POST "https://api.meta.ai/v1/images/generations" \\
  -H "Authorization: Bearer $MODEL_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"model": "${IMAGE}", "prompt": "${FOX}", "n": 1, "output_format": "png"}'`,
      },
    },
  }),

  "api-reference/files": demo<FilesPlaygroundProps>({
    title: "Run the whole Files API lifecycle",
    blurb:
      "Upload a sample or your file, list it, retrieve it, download its content, ask about it by file_id, and delete it, on files you uploaded here; Files calls are free and the question is under a cent on the default model.",
    Component: FilesPlayground,
    props: { sampleId: "field-report", focus: "upload", expiry: true },
    agentPrompt: {
      task:
        "Wrap Meta's Files API in a small module in my app: upload (POST /v1/files), list (GET /v1/files), retrieve (GET /v1/files/{file_id}), download (GET /v1/files/{file_id}/content) and delete (DELETE /v1/files/{file_id}), then use an uploaded file's id in a Responses request.",
      facts: [
        "Upload: multipart purpose (user_data, or batch for Batch input), optional expires_after[anchor]=created_at and expires_after[seconds] (3600 to 2592000), the file part last.",
        'FileObject: {"id": "file-<digits>", "bytes", "created_at", "expires_at", "filename", "object": "file", "purpose", "status"}; expires_at may be null or missing when the file never expires.',
        "GET /v1/files takes purpose, limit (1 to 10,000), order (asc or desc) and after (a file id), and answers {object: list, data, first_id, last_id, has_more}.",
        'Content answers raw bytes, not JSON; delete answers {id, object: file, deleted: true}. Reference an upload as {"type": "input_file", "file_id": ...}.',
      ],
      checklist: [
        "Upload, list, retrieve, download and delete each run once against the real API.",
        "The downloaded bytes match the uploaded file.",
        "A Responses request with the uploaded file_id answers about the file.",
      ],
      snippets: {
        python: `import os

${PY_CLIENT}

with open("document.pdf", "rb") as f:
    file = client.files.create(purpose="user_data", file=f)

print(client.files.list(purpose="user_data").data)
print(client.files.retrieve(file.id))
with open("copy.pdf", "wb") as out:
    out.write(client.files.content(file.id).read())

answer = client.responses.create(
    model="${M}",
    input=[{"type": "message", "role": "user", "content": [
        {"type": "input_text", "text": "Summarize this document."},
        {"type": "input_file", "file_id": file.id},
    ]}],
)
print(answer.output_text)
print(client.files.delete(file.id))`,
        typescript: `import fs from 'fs';
import OpenAI from 'openai';

${TS_CLIENT}

const file = await client.files.create({ purpose: 'user_data', file: fs.createReadStream('document.pdf') });
console.log(await client.files.retrieve(file.id));
fs.writeFileSync('copy.pdf', Buffer.from(await (await client.files.content(file.id)).arrayBuffer()));
console.log(await client.files.delete(file.id));`,
        curl: `curl -X POST "https://api.meta.ai/v1/files" -H "Authorization: Bearer $MODEL_API_KEY" \\
  -F "purpose=user_data" -F "file=@document.pdf"
curl "https://api.meta.ai/v1/files?purpose=user_data" -H "Authorization: Bearer $MODEL_API_KEY"
curl "https://api.meta.ai/v1/files/file-abc123/content" -H "Authorization: Bearer $MODEL_API_KEY" -o copy.pdf
curl -X DELETE "https://api.meta.ai/v1/files/file-abc123" -H "Authorization: Bearer $MODEL_API_KEY"`,
      },
    },
  }),

  "api-reference/files/upload-file": demo<FilesApiConsoleProps>({
    title: "Upload a file with POST /v1/files",
    blurb: "Upload sends a sample or your file with purpose user_data (and expires_after if you set it), then checks the FileObject that comes back against the schema. Free.",
    Component: FilesApiConsole,
    props: { start: "upload", schemas: FILES_SCHEMAS, sampleId: "receipt" },
    agentPrompt: {
      task:
        "Add an upload_file helper to my app that POSTs a local file to https://api.meta.ai/v1/files as multipart with purpose user_data (and an optional expires_after), returns the FileObject, and raises on HTTP errors.",
      facts: [
        "Multipart fields: file and purpose (both required): user_data for files requests reference, batch for Batch input; other purposes (fine-tune) are 400s.",
        "expires_after is optional: expires_after[anchor]=created_at and expires_after[seconds] from 3600 to 2592000, both or neither. Without it the file never expires.",
        "Send purpose and expires_after before the file part (file last) for lower latency.",
        'The reply is a FileObject: {"id": "file-<digits>", "bytes", "created_at", "expires_at", "filename", "object": "file", "purpose", "status"}; expires_at may be null or missing without expires_after.',
        "Up to 1 GiB per file; uploads count toward the team's 100 GiB until deleted.",
      ],
      checklist: [
        "upload_file('photo.png') returns an id that starts with file-.",
        "With expires_after seconds 86400, expires_at equals created_at + 86400.",
      ],
      snippets: {
        python: `import os

import requests


def upload_file(path, expires_seconds=None):
    data = {"purpose": "user_data"}
    if expires_seconds:
        data |= {"expires_after[anchor]": "created_at", "expires_after[seconds]": str(expires_seconds)}
    with open(path, "rb") as f:
        response = requests.post(
            "https://api.meta.ai/v1/files",
            headers={"Authorization": f"Bearer {os.environ['MODEL_API_KEY']}"},
            data=data,
            files={"file": f},
        )
    response.raise_for_status()
    return response.json()


print(upload_file("/path/to/image.png", expires_seconds=86400))`,
        typescript: `import fs from 'fs';
import OpenAI from 'openai';

${TS_CLIENT}

const file = await client.files.create({
  purpose: 'user_data',
  expires_after: { anchor: 'created_at', seconds: 86400 },
  file: fs.createReadStream('/path/to/image.png'),
});
console.log(file.id, file.expires_at);`,
        curl: `curl -X POST "https://api.meta.ai/v1/files" \\
  -H "Authorization: Bearer $MODEL_API_KEY" \\
  -F "purpose=user_data" \\
  -F "expires_after[anchor]=created_at" \\
  -F "expires_after[seconds]=86400" \\
  -F "file=@/path/to/image.png"`,
      },
    },
  }),

  "api-reference/files/list-files": demo<FilesApiConsoleProps>({
    title: "List files with GET /v1/files",
    blurb: "Send lists the files you uploaded here with your purpose, limit, order and after, pages through them with Next page, and checks the ListFilesResponse against the schema. Free.",
    Component: FilesApiConsole,
    props: { start: "list", schemas: FILES_SCHEMAS, sampleId: "receipt" },
    agentPrompt: {
      task:
        "Add a list_files helper to my app that calls GET https://api.meta.ai/v1/files with purpose, limit, order and after, and a generator that walks every page by passing last_id as after while has_more is true.",
      facts: [
        "Query parameters, all optional: purpose (only files with it), limit 1 to 10,000 (default 10,000), order asc (oldest first) or desc (newest first), after (a file id: the page starts after it).",
        "Files are ordered by when each was added, which can differ from created_at.",
        'The reply: {"object": "list", "data": [FileObject], "first_id", "last_id", "has_more"}.',
      ],
      checklist: [
        "list_files(limit=1) returns one file and has_more true when there are more.",
        "Walking the pages returns every file once.",
      ],
      snippets: {
        python: `import os

import requests


def all_files(purpose="user_data", page_size=100):
    after = None
    while True:
        params = {"purpose": purpose, "limit": page_size, "order": "desc"}
        if after:
            params["after"] = after
        response = requests.get(
            "https://api.meta.ai/v1/files",
            headers={"Authorization": f"Bearer {os.environ['MODEL_API_KEY']}"},
            params=params,
        )
        response.raise_for_status()
        page = response.json()
        yield from page["data"]
        if not page["has_more"]:
            return
        after = page["last_id"]


for f in all_files():
    print(f["id"], f["filename"], f["bytes"])`,
        typescript: `async function* allFiles(purpose = 'user_data') {
  let after: string | undefined;
  while (true) {
    const params = new URLSearchParams({ purpose, limit: '100', order: 'desc', ...(after ? { after } : {}) });
    const response = await fetch(\`https://api.meta.ai/v1/files?\${params}\`, {
      headers: { Authorization: \`Bearer \${process.env.MODEL_API_KEY}\` },
    });
    if (!response.ok) throw new Error(await response.text());
    const page = await response.json();
    yield* page.data;
    if (!page.has_more) return;
    after = page.last_id;
  }
}

for await (const file of allFiles()) console.log(file.id, file.filename);`,
        curl: `curl -X GET "https://api.meta.ai/v1/files?purpose=user_data&limit=2&order=desc" \\
  -H "Authorization: Bearer $MODEL_API_KEY"`,
      },
    },
  }),

  "api-reference/files/retrieve-file": demo<FilesApiConsoleProps>({
    title: "Retrieve a file's metadata",
    blurb: "Upload a sample or pick one of your files, then Send gets its FileObject with GET /v1/files/{file_id} and checks each field against the schema. Free.",
    Component: FilesApiConsole,
    props: { start: "retrieve", schemas: FILES_SCHEMAS, sampleId: "receipt" },
    agentPrompt: {
      task:
        "Add a get_file helper to my app that calls GET https://api.meta.ai/v1/files/{file_id} and returns the FileObject, returning None (or null) for a 404 instead of raising.",
      facts: [
        "file_id is a required path parameter, such as file-842549258569145.",
        'The reply is a FileObject: {"id", "bytes", "created_at", "expires_at", "filename", "object": "file", "purpose", "status"}. expires_at may be null or missing when the file never expires; status and status_details are deprecated.',
        "A deleted or unknown id answers 404. For the bytes, call GET /v1/files/{file_id}/content.",
      ],
      checklist: ["get_file on a fresh upload returns its filename and bytes.", "get_file on a deleted id returns None."],
      snippets: {
        python: `import os

import requests


def get_file(file_id):
    response = requests.get(
        f"https://api.meta.ai/v1/files/{file_id}",
        headers={"Authorization": f"Bearer {os.environ['MODEL_API_KEY']}"},
    )
    if response.status_code == 404:
        return None
    response.raise_for_status()
    return response.json()


print(get_file("file_abc123"))`,
        typescript: `import OpenAI from 'openai';

${TS_CLIENT}

const file = await client.files.retrieve('file_abc123');
console.log(file.filename, file.bytes, file.expires_at);`,
        curl: `curl -X GET "https://api.meta.ai/v1/files/file_abc123" \\
  -H "Authorization: Bearer $MODEL_API_KEY"`,
      },
    },
  }),

  "api-reference/files/retrieve-file-content": demo<FilesApiConsoleProps>({
    title: "Download a file's content",
    blurb: "Upload a sample or pick one of your files, then Send fetches its raw bytes with GET /v1/files/{file_id}/content and previews them. Free.",
    Component: FilesApiConsole,
    props: { start: "content", schemas: FILES_SCHEMAS, sampleId: "receipt" },
    agentPrompt: {
      task: "Add a download_file helper to my app that streams GET https://api.meta.ai/v1/files/{file_id}/content to a local path as raw bytes.",
      facts: [
        "The reply is the file's raw bytes (application/octet-stream in the reference), not JSON: write it in binary mode and stream large files.",
        "file_id is a required path parameter. The metadata (filename, bytes) comes from GET /v1/files/{file_id}.",
        "A deleted or unknown id answers 404.",
      ],
      checklist: ["download_file writes a file whose size matches the FileObject's bytes.", "The downloaded file opens like the original."],
      snippets: {
        python: `import os

import requests


def download_file(file_id, path):
    with requests.get(
        f"https://api.meta.ai/v1/files/{file_id}/content",
        headers={"Authorization": f"Bearer {os.environ['MODEL_API_KEY']}"},
        stream=True,
    ) as response:
        response.raise_for_status()
        with open(path, "wb") as f:
            for chunk in response.iter_content(chunk_size=1 << 16):
                f.write(chunk)


download_file("file_abc123", "copy.bin")`,
        typescript: `import fs from 'fs';

const response = await fetch('https://api.meta.ai/v1/files/file_abc123/content', {
  headers: { Authorization: \`Bearer \${process.env.MODEL_API_KEY}\` },
});
if (!response.ok) throw new Error(\`HTTP \${response.status}\`);
fs.writeFileSync('copy.bin', Buffer.from(await response.arrayBuffer()));`,
        curl: `curl -X GET "https://api.meta.ai/v1/files/file_abc123/content" \\
  -H "Authorization: Bearer $MODEL_API_KEY" \\
  -o copy.bin`,
      },
    },
  }),

  "api-reference/files/delete-file": demo<FilesApiConsoleProps>({
    title: "Delete a file",
    blurb: "Upload a sample or pick one of your files, then Delete removes it with DELETE /v1/files/{file_id} and checks the DeleteFileResponse; retrieving it afterwards answers 404. Free.",
    Component: FilesApiConsole,
    props: { start: "delete", schemas: FILES_SCHEMAS, sampleId: "receipt" },
    agentPrompt: {
      task:
        "Add a delete_file helper to my app that calls DELETE https://api.meta.ai/v1/files/{file_id} and checks deleted is true, plus a cleanup command that lists files with GET /v1/files and deletes those older than a cutoff.",
      facts: [
        'The reply is a DeleteFileResponse: {"id", "object": "file", "deleted": true}.',
        "Uploaded files don't expire unless expires_after was set at upload, and they count toward the team's 100 GiB, so delete what you no longer need.",
        "After a delete, GET /v1/files/{file_id} answers 404.",
      ],
      checklist: ["delete_file on a fresh upload returns deleted true.", "The cleanup deletes only files created before the cutoff."],
      snippets: {
        python: `import os
import time

${PY_CLIENT}


def cleanup(max_age_seconds=86400):
    cutoff = time.time() - max_age_seconds
    for f in client.files.list(purpose="user_data"):
        if f.created_at < cutoff:
            result = client.files.delete(f.id)
            print(f.id, "deleted" if result.deleted else "kept")


print(client.files.delete("file_abc123"))`,
        typescript: `import OpenAI from 'openai';

${TS_CLIENT}

const result = await client.files.delete('file_abc123');
if (!result.deleted) throw new Error(\`Not deleted: \${result.id}\`);`,
        curl: `curl -X DELETE "https://api.meta.ai/v1/files/file_abc123" \\
  -H "Authorization: Bearer $MODEL_API_KEY"`,
      },
    },
  }),

  "api-reference/files/schemas": demo<SchemaExplorerProps>({
    title: "Explore the Files schemas and check real replies",
    blurb:
      "Browse the five Files schemas, build an upload body and see what's refused, then upload, list, retrieve and delete for real and check each reply against FileObject, ListFilesResponse and DeleteFileResponse. Free.",
    Component: SchemaExplorer,
    props: {
      schemas: FILES_SCHEMAS,
      initial: "file-object",
      hints: { file: "<file>", purpose: "user_data" },
      live: [
        {
          label: "Upload with the Create File Request",
          note: "Free. The body's fields go as multipart parts, the file last; the reply is checked against FileObject.",
          schema: "create-file-request",
          method: "POST",
          path: "files",
          body: "multipart",
          fileField: "file",
          sampleId: "receipt",
          reply: "file-object",
        },
        { label: "List your files", note: "Free. Checked against ListFilesResponse.", method: "GET", path: "files?purpose=user_data&order=desc", body: "none", reply: "list-files-response" },
        { label: "Retrieve your newest file", note: "Free. Checked against FileObject.", method: "GET", path: "files/{file_id}", body: "none", reply: "file-object" },
        { label: "Delete your newest file", note: "Free. Checked against DeleteFileResponse.", method: "DELETE", path: "files/{file_id}", body: "none", reply: "delete-file-response" },
      ],
    },
    agentPrompt: {
      task:
        "Add types for Meta's Files API to my app from this page's schemas (CreateFileRequest, FileExpiresAfter, FileObject, ListFilesResponse, DeleteFileResponse) and validate real replies against them.",
      facts: [
        "CreateFileRequest (multipart): file (binary) and purpose (user_data or batch) required, expires_after (FileExpiresAfter) optional.",
        "FileExpiresAfter: anchor created_at and seconds 3600 to 2592000, both required.",
        "FileObject: id (file-<digits>), bytes, created_at, expires_at, filename, object file, purpose (batch, fine-tune, evals or user_data), status (deprecated), status_details (optional).",
        "expires_at: an integer, or null for a file that never expires (this page); file-handling says it's left out then, so type it optional.",
        "ListFilesResponse: object list, data (FileObject[]), first_id, last_id, has_more. DeleteFileResponse: id, object file, deleted.",
      ],
      checklist: ["The types compile, and a real upload, list and delete reply each parse with them.", "expires_at is optional: a number, null or missing all parse."],
      snippets: {
        typescript: `interface FileExpiresAfter {
  anchor: 'created_at';
  seconds: number; // 3600 to 2592000
}

interface FileObject {
  id: string; // file-<digits>
  bytes: number;
  created_at: number;
  expires_at?: number | null; // null or missing when the file never expires
  filename: string;
  object: 'file';
  purpose: 'batch' | 'fine-tune' | 'evals' | 'user_data';
  status: 'uploaded' | 'processed' | 'error'; // deprecated
  status_details?: string;
}

interface ListFilesResponse {
  object: 'list';
  data: FileObject[];
  first_id: string;
  last_id: string;
  has_more: boolean;
}

interface DeleteFileResponse {
  id: string;
  object: 'file';
  deleted: boolean;
}`,
        python: `from typing import Literal, NotRequired, Optional, TypedDict


class FileObject(TypedDict):
    id: str  # file-<digits>
    bytes: int
    created_at: int
    expires_at: NotRequired[Optional[int]]  # None or missing when the file never expires
    filename: str
    object: Literal["file"]
    purpose: Literal["batch", "fine-tune", "evals", "user_data"]
    status: Literal["uploaded", "processed", "error"]  # deprecated
    status_details: NotRequired[str]


class ListFilesResponse(TypedDict):
    object: Literal["list"]
    data: list[FileObject]
    first_id: str
    last_id: str
    has_more: bool


class DeleteFileResponse(TypedDict):
    id: str
    object: Literal["file"]
    deleted: bool`,
        curl: `curl -X POST "https://api.meta.ai/v1/files" \\
  -H "Authorization: Bearer $MODEL_API_KEY" \\
  -F "purpose=user_data" \\
  -F "expires_after[anchor]=created_at" \\
  -F "expires_after[seconds]=3600" \\
  -F "file=@receipt.png"`,
      },
    },
  }),
};
