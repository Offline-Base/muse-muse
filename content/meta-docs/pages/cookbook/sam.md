# Segment Anything Model {#segment-anything-model}

Use Segment Anything Model to find and cut out objects in images and video from a short noun phrase. SAM 3.1 returns a box and a pixel mask for every match, and in video it follows each object across frames. Return to the [Cookbook](https://dev.meta.ai/docs/cookbook) for other patterns.

- [SAM API basics](https://dev.meta.ai/docs/cookbook/sam-api-basics): Segment an image or an uploaded video in Python or TypeScript, streaming the response and parsing it with the official meta-sam parsers.
- [Video to animated stickers](https://dev.meta.ai/docs/cookbook/video-to-sticker-pack): Track an animal through a clip, cut the background from its longest-lived track, and export transparent animated stickers.
- [Multi-speaker headlocked captions](https://dev.meta.ai/docs/cookbook/headlocked-speech-bubble-captions): Match diarized voices to SAM-tracked people, preview collision-aware speech bubbles, and download the captioned video.
