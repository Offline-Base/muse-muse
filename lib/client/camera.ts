/** The pure parts of taking a photo (components/camera/CameraCapture). */

/** Longest side of a photo. Enough for the models, and small enough to upload quickly on a phone. */
export const CAMERA_MAX_SIDE = 2048;

/** The photo's size: the camera's, scaled down to fit when it's larger, never up. */
export function fitPhoto(width: number, height: number, maxSide: number): { width: number; height: number } {
  const scale = Math.min(1, maxSide / Math.max(width, height));
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

/** "camera-20261030-171205.jpg". Each name differs, so taking two photos doesn't look like one file twice. */
export function cameraFileName(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `camera-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.jpg`;
}

/** What the reader sees when the camera won't open. */
export function cameraError(err: unknown): string {
  const name = err instanceof Error ? err.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "Allow the camera for this site to take a photo.";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "No camera found.";
  if (name === "NotReadableError") return "Another app is using the camera.";
  return "The camera didn't open. Try again, or choose a file instead.";
}
