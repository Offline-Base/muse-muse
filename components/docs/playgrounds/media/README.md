# Media page demos

The live demos for the "media" page group (lib/docs/demos/media.ts): image-understanding, image-generation, video-understanding, file-handling, and the images and files API reference pages. They are built from the core kit (components/docs/kit, components/docs/playgrounds/common) and the media kit (components/docs/media), and take plain JSON props from their DemoSpec. Every call goes through the docs proxy with `useDocsRun`; uploads made on the way to a request use their own runner with `record: false`, so the copy prompt repeats the request the reader cares about.

## Components

| Component | Page | What it adds |
|---|---|---|
| `VisionLab` | image-understanding | Preset rows (Ask, Locate, Send); every way an image goes in (data URL, public URL, upload as input_image or input_file, input_file file_url) on Responses or Chat Completions; 1 to `maxImages` images; the page's point, box and count prompts with the reply drawn by `MaskOverlay` and a grid-to-pixels table; free token counts (`responses/input_tokens`), and the same image counted at several sizes. Uploads are reused for 55 minutes (`UploadCache`). Props: `presets`, `publicUrl`, `model`, `models`, `effort` ("low"), `maxImages` (4). |
| `ImageGenerationLab` | image-generation | Tabs: the media kit's `ImageGenPlayground`, `StatelessImageTurns`, and two `PresetConsole`s (the images endpoints' options, and the Errors section's refused requests). Props: `playground`, `stateless`, `options`, `errors`. |
| `StatelessImageTurns` | image-generation | Muse Image with `store: false`: each follow-up replays the last `image_generation_call` item with `result: null`, optional reference image, a quick toggle. Props: `prompt`, `followUps`, `fast` (true), `referenceSampleIds`. |
| `MediaUnderstandingLab` | video-understanding | Video (upload then input_file or input_video, inline, public URL; Chat Completions video_url) and audio (input_audio data and format, audio_url, upload; Chat Completions input_audio). Audio starts on Muse Spark 1.2 Contributor with 4,000 output tokens, as the page advises, and a reply that ran out of output says so on either API. The public URL starts on MDN's CC0 sample clip (`PUBLIC_SAMPLE_VIDEO`), since Meta can't fetch from localhost or a protected preview. Uploads are reused for 55 minutes. Props: `presets`, `videoModel`, `audioModel`, `models`, `effort`, `audioMaxOutputTokens`, `publicVideoUrl`. |
| `FileHandlingLab` | file-handling | Tabs: `InlineFilePlayground`, and the media kit's `FilesPlayground`. Props: `inline`, `upload`. |
| `InlineFilePlayground` | file-handling | A file inline: Responses input_file file_data, input_file file_url, input_video video_url, or the Chat Completions file block; the size it adds against the 50 MB limit; free token counts for PDFs and images (`input_tokens` doesn't count video, so a clip gets a note instead). Props: `presets`, `fileUrl`, `model`, `models`, `effort`. |
| `PresetConsole` | images reference pages | Pills of worked requests, each loaded into the kit's `ApiConsole`. A preset with `fileId` ("path", or a JSON Pointer into the body) gets the reader's files and a quick upload (`FileIdBar`). Props: `presets: ConsolePreset[]`, `label`. |
| `FilesApiConsole` | files reference pages | The five Files calls as tabs, opened on the page's own (`start`): upload with purpose and expires_after, list with purpose, limit, order and the after cursor (Next page), retrieve, download, delete; each JSON reply checked against the page's schemas. Props: `start`, `schemas`, `sampleId`. |
| `SchemaExplorer` | the two schema pages | The page's schema tables, parsed on the server: grouped schemas, a field finder, links both ways, an example body (required or every field), a checker for bodies the reader edits, and live calls whose replies are checked field by field. Props: `schemas`, `initial`, `hints`, `live`. |
| `DemoTabs`, `FileIdBar`, `SchemaCheckTable`, `SimplePills` | shared | Tabs whose panels stay mounted once opened; the reader's file ids with a quick upload (`useRecentFiles`, `uploadPicked`); a check report as a table; preset pills split so the simple view shows at most five, with the rest behind Options. |

## Pure modules

- `bodies.ts`: request bodies for every shape above, the page's grounding prompts word for word, `toPixels`, store: false turns, `inlineSendCountable` (what input_tokens counts) and `ranOutOfOutput` (finish_reason "length" or incomplete_details.reason "max_output_tokens").
- `files-api.ts`: the Files steps, the list query, expires_after and limit ranges, paging.
- `schema-tables.ts`: parses a "Schemas" page's tables (types, refs, unions, constraints), em dashes swapped as the page renderer does.
- `schema-check.ts`: checks a request or a reply against a schema, builds example bodies and multipart fields. Beyond the tables it applies the rules the pages state in prose, each confirmed live through the proxy: unknown top-level JSON fields are 400s while a multipart body only gets a note (a Files upload with an extra field returns 200); moderation on muse-image-1.0, output_format other than png, jpeg (or jpg) or webp in any case, a size that isn't "auto" or "WxH" within 16:1, an empty or blank prompt or model, an edit's images outside 1 to 10 or an item without exactly one of image_url or file_id, and on the multipart edit mask, input_fidelity and partial_images, no image part, image mixed with image[N], or image[N] not numbered from 0. Examples leave out what the rules refuse and keep what they need.
- `upload-cache.ts`: upload ids by picked file, reused for 55 minutes (docs uploads last an hour) and forgotten after a 404.

## Tests

`npx tsx --test --experimental-test-module-mocks components/docs/playgrounds/media/__tests__/*.test.ts components/docs/playgrounds/media/__tests__/*.test.tsx`

`fixtures/` holds real replies from the docs proxy (Oct 30, 2026), with base64 cut short and the signed image id and visitor id taken out.
