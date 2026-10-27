export interface ResizeOptions {
  /** Longest side in pixels. Default 1600. */
  maxSide?: number;
  /** JPEG quality from 0 to 1. Default 0.85. */
  quality?: number;
}

/**
 * Resizes a photo in the browser and returns a JPEG blob, so uploads stay well under the 4.5 MB function body limit.
 *
 * TODO(kickoff, day 2): implement with createImageBitmap and a canvas. Respect EXIF orientation.
 */
export async function resizeImage(file: File, opts: ResizeOptions = {}): Promise<Blob> {
  void file;
  void opts;
  throw new Error("resizeImage is not implemented yet. This repo is a scaffold until kickoff.");
}
