# Voice and SAM demos

The live demos for the voice-sam page group (`lib/docs/demos/voice-sam.ts`): speech-to-text, media-segmentation, the
four SAM pages and the Voice API reference. Each is a client component configured by plain JSON props, built on the
core kit (`components/docs/kit`) and the media kit (`components/docs/media`). Import from
`@/components/docs/playgrounds/voice-sam`.

All calls go through the docs proxy (`/api/docs/v1/...`) or Muse Muse's realtime relay (`/api/docs/asr-realtime`),
never with a key. Every API run is recorded for "Copy prompt for your coding agent"; SegmentLab's optional "Ask Muse
Spark" step is not, so the prompt keeps describing the SAM request. Neither SAM 3.1 nor Muse Voice Transcribe is a
Contributor model; the Spark step uses the kit's model menu, which shows the Contributor notice.

The copy prompts in `lib/docs/demos/voice-sam.ts` are sized to stay whole with a recorded run included (the default):
`__tests__/demos.test.tsx` builds every one, for every agent and language, with the longest requests each page's demo
records, and checks that the task, every fact and the snippet survive untrimmed. Every page has a snippet in all three
languages, so a recorded run is never turned into starter code (which can't express a WebSocket or a multipart body).

## Components

| Export | Pages | What it does |
|---|---|---|
| `TranscribeLab` | speech-to-text, api-reference/voice, voice/transcribe, voice/realtime | POST /v1/asr/transcribe with the two-part multipart body and each `Accept` (JSON, event stream, plain text), or a realtime session through the relay; modes, keywords, languageBias, CUMULATIVE or DELTA partials, emitAudioProgress, sessionId; event timeline, turn table, "Show the HTTP exchange", code for curl, Python and TypeScript (or a WebSocket client) |
| `VoiceSchemaExplorer` | voice/schemas | Every Voice schema and field; paste messages to identify and check them; check a live event stream against the schemas |
| `SegmentLab` | media-segmentation, sam/overview, sam/segmenting | SAM 3.1 with concept prompts (the page's prompt rules as warnings), box and point prompts drawn on an image or several video frames, or raw input_text; mask encoding, confidence, tracking direction, streaming, Files API upload by file_id; presets in groups, including ones the API rejects with a 400; panels for the request and response anatomy, cut out / blur / measure, and tracks across frames |
| `WireInspector` | sam/reading-segmentation | The raw wire beside the parsed frames, ids, boxes, confidence and decoded masks, from the page's examples, pasted text or a live call |
| `ParserLab` | sam/client-libraries | Meta's `@meta-sam/parser` on a live stream (snapshots, outcome, records), the three mask conversions, an overlay with the renderer's options, `buildObjectPrompt` with its error codes, and the stream lifecycle scenarios |

### `TranscribeLab` props

`endpoints` (`["transcribe", "realtime"]`), `accepts` (`["json", "sse", "text"]`), `presets`, `sampleId`
(`"speech-paragraph"`), `mode`, `modes`, `accept`, `keywords`, `languageBias`, `partialMode`, `emitAudioProgress`,
`sessionId`, `microphone` (true), `view` (`"guide"` or `"reference"`, which opens the HTTP exchange).

A preset is `{ label, group?, endpoint?, sampleId?, mode?, accept?, keywords?, languageBias?, partialMode?,
emitAudioProgress?, sessionId?, requestOverride?, acceptOverride?, note? }`. `requestOverride` and `acceptOverride`
send a request the API rejects, to show its error. A preset without `endpoint` never keeps the one the reader was on:
it runs on asr/transcribe when it sets `accept`, else on the demo's first endpoint (`presetEndpoint`).

The realtime "Server frames" pane prints each frame exactly as Meta sent it (the relay passes frames on unchanged),
so every field shows, `final` and an error's `sessionId` included. A stream that ends on an error event shows as failed
even though its HTTP status was 200.

### `VoiceSchemaExplorer` props

`schemaId` (`"TranscribeRequest"`), `sampleId` (`"chess-moves"`, for the live check), `mode` (`"ENDPOINTING"`).

### `SegmentLab` props

`media` (`["image", "video"]`), `sampleId` (`"street"`), `videoSampleId` (`"street-pan"`), `prompt` (`"dog"`),
`kinds` (`["concept", "objects", "text"]`), `presets`, `maskEncoding` (`"one_bit"`), `includeConfidence` (true),
`propagation` (`"both"`), `stream` (true), `upload` (false: offer the Files API for clips), `panels` (`"anatomy"`,
`"useCases"`, `"rules"`, `"tracks"`), `pairWithSpark` (false), `useCases` (`["cutout", "blur", "measure"]`), `showRaw`.

A preset is `{ label, group?, media?, sampleId?, kind?, prompt?, objects?, maskEncoding?, includeConfidence?,
propagation?, stream?, send?, metadata?, note? }`. `objects` are kit `SamPromptObject`s in the sample's own pixels, with
`frame` for video; `metadata` is merged over the built metadata to show a 400.

A streamed request can fail after its HTTP 200: an `error` event, then `response.failed`. useSamRun keeps that in
`out.error`, and SegmentLab, WireInspector and ParserLab show it as a failure (a red status, the error, a note), never
as zero matches; the copy prompt records it the same way (`samOutcome`).

### `WireInspector` props

`source` (`"examples"`, `"live"` or `"paste"`), `sampleId`, `videoSampleId`, `prompt`.

### `ParserLab` props

`sampleId`, `videoSampleId`, `prompt`, `tab` (`"parse"`, `"decode"`, `"render"`, `"build"`, `"lifecycle"`).

## Helpers

| Module | Exports |
|---|---|
| `voice-events.ts` | `voiceStep`, `foldVoiceEvents`, `emptyVoiceView`, `voiceText`, `shownTurns`, `parsePlainTranscript`, `billedSeconds`, `transcribeCostUsd`, `CLOSE_CODES` |
| `voice-request.ts` | `transcribeRequestJson`, `transcribePath`, `presetEndpoint`, `realtimeHandshakeFrame`, `relayQuery`, `transcribeSnippets`, `realtimeSnippets`, `multipartPreview`, `VOICE_LANGUAGES`, `splitList`, `unknownLanguages` |
| `voice-schemas.ts` | `VOICE_SCHEMAS`, `voiceSchema`, `searchSchemas`, `identifyVoiceMessage`, `validateAgainst`, `checkVoiceMessage`, `readMessages` |
| `sam-wire.ts` | `wireSpans`, `maskDataSummary`, `shortPayload`, `shortMaskToken` (shortens by slicing: base85 holds `$`, `&`, `'` and a backtick, which a String.replace replacement would read as patterns), `objectTracks`, `frameOrder`, `trackedFrames`, `samCostUsd`, `maskAreaPx`, `lintConcept`, `earliestPromptFrame`, `promptFrames` |
| `parser-scenarios.ts` | `SCENARIOS` (14: every outcome and 8 of the 9 error codes; parser_error needs an internal parser failure), `runScenario`, `PARSER_ERRORS`, `DOC_VIDEO_LINE`, `DOC_CONFIDENCE_LINE` |
| `event-channel.ts` | `createEventChannel`: an async iterable fed by pushes, for the parser |
| `useVoiceRun.ts` | `useVoiceRun`, `voiceCall`: useDocsRun plus an Accept header |
| `useSamRun.ts` | `useSamRun`, `samOutcome`, `samStreamError`, `samResultView`, `failureEvents`: one SAM call, parsed line by line as it streams, with a failure inside the stream kept apart from zero matches |

## What the live API did (Oct 30, 2026)

- DIARIZATION returned labeled turns for the two-voice sample; an earlier spike got none, so the demos say turns can come
  back empty.
- ENDPOINTING and DIARIZATION streams end with an empty `final: true` transcript event; the fold doesn't turn it into a
  turn.
- Box and point prompts returned lossless masks when `mask_encoding` was omitted and one_bit when asked for, so the demos
  read each mask's marker.
- A streamed request whose `w` and `h` don't match the image's aspect ratio came back HTTP 200, then an `error` event
  (`invalid_prompt`) and `response.failed` (fixture `sam-aspect-failed.sse`); unstreamed, the same request got a 400. The
  other prompt checks on sam/segmenting answered 400 before any stream. sam/segmenting has both aspect-ratio presets.
- Without keywords the paragraph sample came back with "use voice transcribe" and "Calcutta"; one run heard Anaya
  right, an earlier one didn't.

## Tests

`npx tsx --test --experimental-test-module-mocks components/docs/playgrounds/voice-sam/__tests__/*.test.ts components/docs/playgrounds/voice-sam/__tests__/*.test.tsx`

`__tests__/fixtures/` holds small real replies captured through the docs proxy (no keys, the per-visitor safety
identifier removed).
