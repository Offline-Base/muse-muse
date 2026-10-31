// @ts-check
// Turns a photo on disk into the JPEG data URL a product receives.

import { ImageManipulator, SaveFormat } from "expo-image-manipulator";

/**
 * @param {string} uri
 * @param {number} maxSize The longest side in pixels.
 * @param {{ width?: number; height?: number }} [known] The size, if the caller has it, to save a decode.
 */
export async function photoToDataUrl(uri, maxSize, known) {
  const context = ImageManipulator.manipulate(uri);
  const first = await context.renderAsync();
  const width = known?.width ?? first.width;
  const height = known?.height ?? first.height;
  const longest = Math.max(width, height);
  const image =
    longest > maxSize
      ? await ImageManipulator.manipulate(first)
          .resize(width >= height ? { width: maxSize } : { height: maxSize })
          .renderAsync()
      : first;
  const saved = await image.saveAsync({ base64: true, compress: 0.85, format: SaveFormat.JPEG });
  if (!saved.base64) throw new Error("The photo came back empty.");
  return { dataUrl: `data:image/jpeg;base64,${saved.base64}`, width: saved.width, height: saved.height };
}
