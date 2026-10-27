/** Turns bytes into a base64 data URL for image_url, video_url or Muse Image inputs. */
export function toDataUrl(bytes: ArrayBuffer | Uint8Array, mimeType: string): string {
  const buf = bytes instanceof ArrayBuffer ? Buffer.from(new Uint8Array(bytes)) : Buffer.from(bytes);
  return `data:${mimeType};base64,${buf.toString("base64")}`;
}
