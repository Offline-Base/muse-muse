/**
 * Turns a screen the product draws into a picture a model can read. Meta's API takes PNG, JPEG, WebP and GIF only: a
 * `data:image/svg+xml` image is refused, and the call fails in about a second (the Nov 3 audit's simulated desk sent
 * SVG on every step, so its model never ran). Browser only, no imports, except `imageProblem`, which is pure.
 *
 *   const png = await svgToPng(svgText, { width: 1280, height: 800 });     // an SVG string you built
 *   const png = canvasToPng(canvas);                                       // a canvas you drew on
 *   const problem = imageProblem(png); if (problem) throw new Error(problem);
 */

const MODEL_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

/** Why a data URL or URL can't go to a model as an image, or null when it can. */
export function imageProblem(url: string): string | null {
  const m = /^data:([^;,]*)[;,]/i.exec(url.trim());
  if (!m) return /^https:\/\//i.test(url.trim()) ? null : "Send a data URL or an https URL.";
  const type = m[1].toLowerCase();
  if (type === "image/jpg") return null;
  if (MODEL_IMAGE_TYPES.includes(type)) return null;
  if (type === "image/svg+xml") return "SVG isn't accepted. Draw it on a canvas and send canvas.toDataURL(\"image/png\") (svgToPng does this).";
  return `${type || "That type"} isn't accepted. Send PNG, JPEG, WebP or GIF.`;
}

/** A canvas as a PNG data URL. */
export function canvasToPng(canvas: HTMLCanvasElement): string {
  return canvas.toDataURL("image/png");
}

/**
 * Draws an SVG string on a canvas of the given size and returns it as a PNG data URL. The SVG must hold everything it
 * shows: images inside it as data URLs, and fonts the page already loaded, since an SVG drawn as an image can't fetch.
 * Draw with SVG shapes and text. HTML inside a `<foreignObject>` works in Chrome but Safari refuses to export it, so a
 * screen built from HTML is drawn on a canvas instead.
 */
export async function svgToPng(svg: string, size: { width: number; height: number }, background = "#ffffff"): Promise<string> {
  // A data URL, not a blob URL: Chrome marks a canvas unreadable after drawing a blob-URL SVG that holds a foreignObject.
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  const img = new Image();
  img.decoding = "async";
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("The screen couldn't be drawn as a picture."));
    img.src = url;
  });
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This browser can't draw the screen.");
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, size.width, size.height);
  ctx.drawImage(img, 0, 0, size.width, size.height);
  try {
    return canvasToPng(canvas);
  } catch {
    throw new Error("This browser won't turn the screen into a picture. Draw it on a canvas instead of as HTML in an SVG.");
  }
}
