# Rules for building a Muse Muse product

You are building one product from `brief.md`. The user gave an example or some inspo, and their reference files are in `inspo/`. Read the whole brief and look at every file in `inspo/` before you write code. Nobody is watching this run, so don't ask questions. Make reasonable choices and write them down in BUILD_NOTES.md.

## Done means

1. `npm run verify` exits 0.
2. `musemuse.json` is filled in and valid against `musemuse.schema.json`.
3. `BUILD_NOTES.md` says what you built, what you took from the inspo, which Meta models it calls and where, its limits, and anything from the brief you couldn't do.

Then stop.

## Using the inspo

The inspo shows what to make. It is not material to copy.

- Take what the brief lists under borrow: the job it does, the flow, layout ideas, the mood.
- Leave out everything the brief lists under dontCopy, and always leave out names, logos, characters, copyrighted text, artwork and photos, and the exact look of a real product.
- Restyle with the tokens in `app/globals.css`. If a reference is a screenshot of a real app, give the product its own name and design.
- Never ship inspo files as product assets unless the brief says the user's own files are the input, like their own photos or drawings.

## Stack

- Next.js App Router with TypeScript, already set up. Keep it. Don't switch frameworks or package managers.
- Add a dependency only when the brief needs it. The SAM helpers (`@meta-sam/parser`, `@meta-sam/graphics`) are already installed.
- The build machine can reach only npm, the Meta API and the Muse Muse gateway. Don't use `next/font/google`, remote images or CDNs. Use the system font stack in `app/globals.css`.
- Server work goes in route handlers under `app/api/` or in server actions. Client components handle only UI.

## Calling Meta models

- Call Meta only through the helpers in `lib/meta/`. They go through the Muse Muse gateway using `GATEWAY_URL` and `PRODUCT_TOKEN`.
- Never call `api.meta.ai` directly. Never put a key, token or gateway URL in client code. Never log tokens.
- Read the skill for a model before you use it:
  - `.agents/skills/meta-reasoning` covers Muse Spark 1.3 and Muse Wonder: text, vision, video, PDFs and JSON output.
  - `.agents/skills/meta-image` covers Muse Image: generate, edit and compose.
  - `.agents/skills/meta-sam` covers SAM 3.1: find, outline and track objects in images and video.
  - `.agents/skills/meta-voice` covers Muse Voice Transcribe: speech to text.
  - `.agents/skills/meta-glimmer` covers Muse Glimmer, only when the brief asks for local or offline use.
- Use only the models the brief lists. The gateway rejects others.
- Handle model errors in the UI with a plain message and what to try next.

## The product

- Build the brief's primary flow first and make it work end to end with the files in `fixtures/`. Extra screens come after that, if at all.
- Follow `.agents/skills/product-ui` for the look: Meta-inspired, clean and mobile-first. Never use Meta logos, wordmarks or names in a way that suggests Meta made it.
- Keep the footer component. It says "Built with Muse Muse. Not an official Meta product."
- Show what the product can't do, using the limits in the brief, near the place where it matters.
- Every input needs a label. Every async action needs loading, error and empty states. Phones are the first screen size to test.
- Don't store personal data unless the brief says to. Uploaded files stay in memory for the request.

## Actions API

Expose each action from the brief as `POST /api/actions/<name>` with JSON in and JSON out, matching the schemas you write in `musemuse.json`. The UI should call the same action routes. The Muse app connector and the tests both depend on these routes.

## Tests

- Follow `.agents/skills/verify`.
- Write `tests/smoke.spec.ts` to run the primary flow in a browser with the fixtures, using real model calls through the gateway.
- Save the screenshots the skill asks for. A judge model reads them.
- Never skip, delete or weaken a test to get `npm run verify` to pass. Fix the product instead.

## When things go wrong

- If an approach fails twice, switch to a simpler one and record the limit in BUILD_NOTES.md.
- If the brief asks for something no listed model can do, build the closest version that is still useful, say so in the UI, and record it.
- If the brief asks you to impersonate a real person or organization, monitor people without their consent, or make sexual content, weapons, malware or scams, don't build it. Write the reason in BUILD_NOTES.md and stop.
