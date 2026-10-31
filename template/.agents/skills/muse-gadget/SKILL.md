---
name: muse-gadget
description: Use only when the brief lists muse-gadget. A physical board connected to Muse Muse that can take a photo or record a few seconds of sound, so the product can see or hear the real world.
---

# Muse Gadget

## What it is

A small computer, such as a Raspberry Pi or a Jetson, with a camera and a microphone, connected to Muse Muse. The product asks it to take a photo or record sound through the gateway, then hands what it captured to a model. A gadget isn't a model: pair it with the model that reads the capture, such as Muse Wonder for a photo or Muse Voice Transcribe for sound.

## The helpers

Server code only, in a route handler or a server action. Pass the incoming request, as with every gateway call.

```ts
import { takePhoto, recordSound, isGadgetOffline } from "@/lib/meta/gadget";
import { imagePart } from "@/lib/meta/parts";
import { transcribeFile } from "@/lib/meta/voice";

const photo = await takePhoto({ request });            // { dataUrl, simulated }
// send imagePart(photo.dataUrl) to Muse Wonder with respondJson, as in the meta-reasoning skill

const sound = await recordSound({ seconds: 5, request }); // { wav, dataUrl, simulated }
const { text } = await transcribeFile({ bytes: sound.wav, request });
```

`takePhoto` returns a JPEG data URL, about 1280 by 720 unless you ask for another size. `recordSound` takes 1 to 30 seconds and returns 16 kHz mono WAV, the format Muse Voice Transcribe needs.

## During the build

The gateway answers builds with a simulated board, so tests are the same every run:

- `takePhoto` always returns the same photo of a store receipt.
- `recordSound` always returns three seconds of someone saying "Hi, this is a short test recording".
- `simulated` is true on both.

Write the smoke test against those. Don't show the word "simulated" or the sample's contents as if they were real: the live product gets the real board.

## When no board is connected

Live, the board can be off or not connected yet. The helpers then throw an error for which `isGadgetOffline(err)` is true. The product must still be useful:

- Say so plainly, next to the button: "Your gadget isn't connected right now."
- Offer the same job with an upload, using the FilePicker from the product-ui skill, so the product works without the board.
- Never retry in a loop. One press, one capture.

## Product copy

- Name what happens in the real world: "Takes a photo with your gadget's camera", "Listens for 5 seconds".
- Say where it goes: "The photo is sent to Muse Wonder to read it. This app doesn't keep it."
- Show the capture to the user before or beside the result, so they can see what the model saw or heard.
- A capture takes a few seconds: show a loading state with what's happening ("Taking a photo...").

## Limits

- One photo or one recording per call, and about 30 calls a minute per product. Don't stream or poll.
- Recordings are 30 seconds at most.
- No shell, files or other hardware: products get the camera and microphone only.
