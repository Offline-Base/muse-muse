// Platform file (Muse Muse platform services). Don't edit: video.ts, midi.ts and sam-tiles.ts use it.
//
// The media helpers' shared error, and the list of large files the helpers may load from the Muse Muse gateway: none.
// Every model a product calls is a Meta model through the gateway. A platform test keeps the list in step with
// lib/caps/assets.json.

export interface MediaAsset {
  /** The platform's name for the file, as lib/caps/assets.json lists it. */
  name: string;
  bytes: number;
  sha256: string;
}

/** Every file the media helpers may load from the gateway: none. */
export const MEDIA_ASSETS: readonly MediaAsset[] = [];

/** A media helper's failure, in plain words the product can show as it is. */
export class MediaError extends Error {
  readonly code: "unsupported" | "unavailable" | "too_large" | "invalid" | "failed" | "stopped";
  constructor(code: MediaError["code"], message: string) {
    super(message);
    this.name = "MediaError";
    this.code = code;
  }
}
