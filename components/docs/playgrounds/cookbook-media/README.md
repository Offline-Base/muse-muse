# Cookbook media demos

The live demos for the Muse Image, Muse Voice Transcribe and SAM cookbook pages (`lib/docs/demos/cookbook-media.ts`). They are built on the docs kit (`components/docs/kit`) and the media kit (`components/docs/media`): every call goes through `useDocsRun` and the docs proxy, errors show in `ErrorBox`, and "Show code" uses `CodeView`. Styles are in `cookbook-media.module.css`.

| Component | Pages | What it does |
|---|---|---|
| `ImageRecipe` | image-generation-basics, image-editing-with-reasoning, anchored-image-series, search-grounded-image-generation | A recipe as steps of one Muse Image conversation: each step starts a conversation or continues an earlier one (`previous_response_id`, or `store: false` with the prior `image_generation_call` replayed). Per step: the image, the recipe's checks, token usage, the response id; Run all; stale results after a re-run (named only for steps that have an image); optional compare (`ImageCompare`), contact sheet, bare-list 400 and search switches. Prompts sit in `AutoTextArea`, which grows to fit the text at any width. Props: `steps` (`ImageStep[]`), `stateModes`, `compare`, `sheet`, `bareList`, `searchSwitches`, `caution`. |
| `RecipeBrowser` | muse-image, muse-voice-transcribe, sam | A category's recipes: filter by need, read how each works and what it costs, and run its first step (`quick`: an image turn, a transcription, or a SAM image or clip). |
| `TranscribeRecipe` | voice-api-fundamentals | Preset pills over the media kit's `TranscribePlayground` (remounted per preset), plus `PacingSimulator` for the realtime cutoff rules. |
| `VoiceChess` | voice-chess-cua | Realtime or file transcription with keyword biasing, a deterministic move parser (`chess-voice.ts`) and a rules engine (`chess.ts`, perft-tested) on an on-page `Chessboard`; HUD, dry run, Black replies, typed input. It starts on the recipe's exact grammar (`grammar: "exact"`), so the piece-name sample fails closed, as the page says it must; "Plus piece moves" is the demo's opt-in wider grammar. |
| `HeadlockedCaptions` | headlocked-speech-bubble-captions | Diarization and SAM "people" in parallel (the clip uploaded with `purpose=user_data` and segmented by `file_id`, the photo inline, `one_bit` masks), speaker-to-person mapping, a canvas preview with bubbles placed by `captions.ts`, PNG and recorded video export. |
| `SamBasics` | sam-api-basics | An image by data URL, or a clip uploaded with `purpose=user_data` and segmented by `file_id`; one request per concept, parsed with the kit's SAM parser into the recipe's summary.json and SVG masks (`sam-summary.ts`). |
| `StickerPack` | video-to-sticker-pack | Tracks a subject through the clip (`one_bit` masks), cuts out the longest-lived track with its masks (`sticker.ts`), and encodes transparent animated WebP stickers (`webp-anim.ts`) with GIF previews (`gif.ts`), a tray icon, contents.json and report.json. `stickerLength` keeps a sticker to three quarters of a third at most, so on a short clip (the 5 s sample) the motion score still has windows to choose from; report.json says when a sticker was shortened. |

The SAM demos record their runs for the copy prompt by hand (`samRunOutcome` in `sam-summary.ts`): the result line says what SAM found ("7 matches, each a box and a one_bit mask") instead of quoting the start of the wire text.

The copy prompts (`agentPrompt` in `lib/docs/demos/cookbook-media.ts`) are sized so they fit beside the reader's last run, since "Include what I just ran" is on by default. `__tests__/prompt-records.ts` builds every kind of run each demo records, with the demos' own request builders and the id lengths of live replies, and `render.test.tsx` checks that every page, language and coding agent keeps all its facts and its whole starter code after each one.

Pure modules have tests in `__tests__/`, several on real replies saved in `__tests__/fixtures/` (ids redacted, images replaced by a 1 x 1 WebP):

```
npx tsx --test --experimental-test-module-mocks components/docs/playgrounds/cookbook-media/__tests__/*.test.ts components/docs/playgrounds/cookbook-media/__tests__/*.test.tsx
```
