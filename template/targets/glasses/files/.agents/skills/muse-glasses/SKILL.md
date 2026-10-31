---
name: muse-glasses
description: Use when this product runs on Meta glasses (the brief's targets list glasses). The wearer's glasses take a photo and hear a short question through the Muse Muse iPhone app, and the answer is spoken back. In a browser it uses the phone's camera or a sample view.
---

# Muse Glasses

## What it is

A normal web product, with the same pages, action routes and gateway calls as any other. The glasses add a way to see and hear. Inside the Muse Muse iPhone app they take the photo and hear the question. Anywhere else, the same code uses this device's camera and microphone, or a sample view, so every visitor can try the product.

## The three sources

`useGlasses` starts on the first one the device has, and the wearer can switch.

| Source | When | Photo | Question | Answer |
|---|---|---|---|---|
| `glasses` | Inside the iPhone app | The glasses' camera | The glasses' microphone, or the phone's | Spoken in the glasses |
| `phone` | A browser with a camera | This device's camera | This device's microphone | Spoken by the browser |
| `sample` | No camera, or the wearer chose it | Your photos in `public/samples/` | Your recording in `public/samples/` | Spoken by the browser |

Copy your eye-level photos and the question from `fixtures/` to `public/samples/` so the sample view works for visitors.

## The flow

Connect, press the main button, take the photo, ask, answer, speak. Show the photo next to the answer, under "What your glasses saw".

```tsx
"use client";

import { useState } from "react";
import { GlassesPanel } from "@/components/glasses/GlassesPanel";
import { HoldToAsk } from "@/components/glasses/HoldToAsk";
import { useGlasses } from "@/lib/glasses/client";

const SAMPLES = { photos: ["/samples/pov-1.jpg"], question: "/samples/question.wav" };

export function Ask() {
  const glasses = useGlasses({ samples: SAMPLES });
  const [answer, setAnswer] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  return (
    <>
      <GlassesPanel glasses={glasses} />
      <HoldToAsk
        glasses={glasses}
        onAsk={async ({ photo, question }) => {
          setProblem(null);
          const res = await fetch("/api/actions/ask", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ photo: photo.dataUrl, question: question.wavDataUrl }),
          });
          if (!res.ok) {
            setProblem("Couldn't get an answer. Try again.");
            return;
          }
          const { answer } = (await res.json()) as { answer: string };
          setAnswer(answer);
          void glasses.say(answer); // don't wait: the answer shows while it's spoken
        }}
      />
      {problem ? <div className="error" role="alert">{problem}</div> : null}
      {answer ? <section className="card" data-result>{/* "What your glasses saw", the photo and the answer */}</section> : null}
    </>
  );
}
```

The server code is what you already know. A photo and a question of up to a minute both fit in the JSON body:

```ts
import { z } from "zod";
import { respondJson } from "@/lib/meta/json";
import { imagePart } from "@/lib/meta/parts";
import { transcribeFile } from "@/lib/meta/voice";

export async function POST(request: Request) {
  const { photo, question } = (await request.json()) as { photo: string; question: string };
  const bytes = Buffer.from(question.slice(question.indexOf(",") + 1), "base64");
  const { text } = await transcribeFile({ bytes, request });
  const { answer } = await respondJson({
    schema: z.object({ answer: z.string().describe("One to three short sentences, to be read aloud.") }),
    schemaName: "answer",
    instructions: "You answer a question about what the wearer is looking at. They will hear the answer and can't see a screen, so use one to three short sentences. No lists, no markdown.",
    input: [{ role: "user", content: [{ type: "input_text", text }, imagePart(photo)] }],
    request,
  });
  return Response.json({ answer, question: text });
}
```

Handle model errors with a plain message, as in any product.

## useGlasses

Client components only. `useGlasses({ samples })` returns:

| Field | What it does |
|---|---|
| `source`, `setSource(source)` | Where photos and questions come from |
| `status` | The glasses' status. `status.state` is `"ready"` once connected, and `"unavailable"` in a browser without the app |
| `inApp` | True inside the iPhone app |
| `ready` | True when the current source can take a photo |
| `connect()` | Connects the glasses. The first time, the Meta AI app opens to ask for permission |
| `capture({ maxSize })` | Takes a photo: `{ dataUrl, width, height, source }`. A JPEG of at most 1600 px |
| `listen({ maxSeconds })`, `stop()` | Records, then returns `{ wavDataUrl, seconds, source }`, 16 kHz WAV ready for `transcribeFile` |
| `say(text)` | Speaks. Don't wait for it before showing the answer |
| `preview(show)`, `previewing`, `stream` | The live view. Glasses draw it above the page. For the phone camera, `stream` feeds a `<video>`, and GlassesPanel does that for you |
| `photo`, `recording` | The last photo, and whether it's listening right now |

Everything throws a `GlassesClientError`. Show `glassesMessage(err)` from `@/lib/glasses/client`: it's already a plain sentence about what to do next. GlassesPanel and HoldToAsk show their own errors.

## The parts

- `GlassesPanel`: the status chip, a button named "Connect your glasses", the Glasses, Phone and Sample switch, the live view, and the last photo.
- `HoldToAsk`: the main button. Hold it, ask, let go. It records, takes the photo and calls `onAsk({ photo, question })`. A tap or a key press also works, for anyone who can't hold a button: it listens until the next one. It also stops by itself after `maxSeconds`, 20 by default. Pass `label` for the button's words.

If your main button doesn't listen, like "What am I looking at?", use a normal button with `data-glasses-primary` that calls `capture()`.

Tests and the iPhone app's checks find these by contract, so keep them: the main button has `data-glasses-primary`, the panel's buttons have `data-glasses-action` (both parts do this), and the result on screen has `data-result` (you add it).

## What Meta's glasses can't do

Design around these. Don't promise any of them.

- **Sessions start on the phone.** The glasses can't open the product, so the app must be open on the phone first.
- **The temple is taken.** Taps and swipes on the glasses belong to the system. Your only buttons are on the phone screen.
- **The microphone is phone-call quality.** 8 kHz, good for a short question and poor for music or a noisy room. Keep questions short.
- **There is no screen on the glasses.** The wearer hears the answer. One to three short sentences, no lists. The phone shows the photo and the full answer.

## Testing

The smoke test gets a pair of fake glasses, the same way a gadget gets a simulated board. The product runs the code it runs in the iPhone app, and the model calls stay real. verify fails unless the smoke test takes at least one photo through them.

Call `installGlasses` before `page.goto`:

```ts
import { test, expect } from "@playwright/test";
import { judgeShot } from "./judge-shot";
import { glasses, installGlasses } from "./glasses";

test("asks about what the glasses see", async ({ page }) => {
  await installGlasses(page, { photos: ["fixtures/pov-1.jpg"], question: "fixtures/question.wav" });

  await test.step("Open the app", async () => {
    await page.goto("/");
    await judgeShot(page, "01-start");
  });

  await test.step("Connect your glasses", async () => {
    await page.getByRole("button", { name: "Connect your glasses" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Ready" })).toBeVisible();
  });

  await test.step("Hold the button and ask", async () => {
    await page.getByRole("button", { name: "Hold to ask" }).click({ delay: 1500 });
    await expect(page.locator("[data-result]")).toBeVisible({ timeout: 90_000 });
    await judgeShot(page, "02-result");
  });

  await expect.poll(() => glasses.spoken(page)).toHaveLength(1);
});
```

- `fixtures/pov-1.jpg` is a photo at the wearer's eye level of what they'd look at. `fixtures/question.wav` is the spoken question, made as in the meta-voice skill. It must be 16 kHz mono.
- `glasses.spoken(page)` lists what was said, and `glasses.calls(page)` lists every call, also written to `test-results/glasses/calls.jsonl`.
- `glasses.set(page, { state: "paused" })` changes the glasses mid-test. Use `{ fail: { method: "capturePhoto", code: "capture_failed" } }` to make the next call fail. Use this in a second test for "glasses not connected" and a failed photo. Leave that test out of the first test in the file, since the first one becomes the demo video.
- The console check loads the product with no fake glasses, so the page must work without them: no error when `MuseNative` is missing.
- The `sample` source works the same in tests, for anything that doesn't need the glasses.

## Product copy

- Never show "mock", "fake" or "simulated" on screen. In tests the glasses just work.
- Say where a photo goes: "The photo and your question are sent to Muse Wonder and Muse Voice Transcribe to answer you. This app doesn't keep them."
- Show the photo next to the answer, so the wearer sees what the model saw.
- Say these limits once, next to what they limit: "Start it on your phone. The glasses can't open it." and "Needs the Muse Muse iPhone app and Meta glasses. Without them it uses your phone's camera."
- Never say the product is made by or for Meta, or use Meta's marks.

## Don't edit

`lib/glasses/*` and `tests/glasses.ts`. They're restored before every verify. `components/glasses/*` are yours to restyle or replace, as long as the contract above holds.
