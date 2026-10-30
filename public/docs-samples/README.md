# Docs demo samples

Files the live demos on `/docs/*` offer next to every file picker. Demos fetch them from this origin and send them inline, so they work on localhost too. Every file is under 1.5 MB. The catalog, with a description of each file (the chart's numbers, each transcript, where the buttons are), is `DOCS_SAMPLES` in `lib/docs/media/samples.ts`.

Remake them with:

```
npx tsx --env-file-if-exists=.env.local scripts/docs/make-samples.ts            # only what's missing
npx tsx --env-file-if-exists=.env.local scripts/docs/make-samples.ts --force    # everything (photos come from the cache in .data/)
npx tsx scripts/docs/make-samples.ts --no-paid                                  # no Muse Image calls
```

The photos are the only paid part: $0.01 each, at most 8 calls a run, and each raw reply is cached in `.data/docs-samples-work/raw/`, so a rerun reuses it. The first run made 5 photos for $0.05 (Oct 30, 2026).

| File | What it is | Source | License |
|---|---|---|---|
| `street.jpg` | A sidewalk with a woman walking two dogs, bicycles at a rack and people behind (1280 x 853) | Generated with Muse Image (`muse-image-1.0`) for Muse Muse, Oct 30, 2026, resized with `sips` | Output of Meta's Model API, used under the [Model API Terms](https://dev.meta.ai/legal/terms-of-service). Fine for demos and tests; the Terms bar using Outputs to train competing models |
| `fridge.jpg` | An open fridge with labeled food (853 x 1280) | Muse Image, as above | As above |
| `cat-sofa.jpg` | A ginger cat asleep on a grey sofa (1280 x 853) | Muse Image, as above | As above |
| `sneaker.jpg` | A logo-free sneaker on white, for edits (1280 x 1280) | Muse Image, as above | As above |
| `living-room.jpg` | An empty living room, for edits (1280 x 853) | Muse Image, as above | As above |
| `street-pan.mp4` | 5 s, 24 fps, 120 frames, 1280 x 720 H.264, no audio: a pan across `street.jpg` | Made with ffmpeg from the street photo | As for the photo |
| `bar-chart.png` | A bar chart with exact values (1200 x 800) | Rendered with headless Chrome from HTML in `scripts/docs/make-samples.ts` | Made for Muse Muse; use freely. Names and numbers are fictional |
| `error-screenshot.png` | A browser showing a TypeError overlay with its stack trace (1280 x 800) | Headless Chrome, as above | As above |
| `receipt.png` | A grocery receipt with line items, tax and total (800 x 830) | Headless Chrome, as above | As above |
| `signup-screen.png` | An app's sign-up form with fields and buttons, for computer use (1280 x 800) | Headless Chrome, as above | As above |
| `field-report.pdf` | A 2-page report with tables, for PDF input | Headless Chrome `--print-to-pdf`, as above | As above |
| `speech-paragraph.wav` | One voice reading a short paragraph with names and product terms (14.6 s) | macOS `say` (voice Samantha), converted with `afconvert` and rewritten as 16 kHz mono 16-bit WAV by `lib/docs/media/wav.ts` | Synthesized speech made for Muse Muse; use freely |
| `two-voices.wav` | A two-voice phone call, for diarization (25.3 s) | macOS `say` (voices Samantha and Daniel), as above | As above |
| `chess-moves.wav` | Four spoken chess moves with pauses (9.2 s) | macOS `say` (voice Daniel), as above | As above |
| `alice-chapters-1-3.txt` | Chapters I to III of *Alice's Adventures in Wonderland* (about 6,000 words), for long-context and caching demos | Lewis Carroll (1865), from Project Gutenberg eBook #11, with the Project Gutenberg header, footer and license removed, and its em dashes written `--` as plain-text editions do | Public domain in the US. With Project Gutenberg's text and trademark removed, the file is a plain public-domain text |

All WAVs are mono 16-bit PCM at 16 kHz with a plain 44-byte header, the format Muse Voice Transcribe takes (docs/SPIKES.md).

`thumbs/` holds a 96 px JPEG of each image and a poster frame of the clip, made by the same script, for the pickers' sample chips. They are derived from the files above and carry the same terms.
