/**
 * What the Muse Muse phone and desktop apps add to a product, each with a web fallback, so the same code works in the
 * apps and in a browser. Call these from client components, on a person's action. They never throw for a missing
 * feature: read the result instead.
 *
 * Each call looks for window.MuseNative when it runs. Never save the answer at module load: on Android the app's bridge can
 * arrive after a page's first script, so a call made before the page has loaded waits for the load event before it settles
 * on the web fallback.
 */
import type { HapticKind, MuseCapabilities, MuseNativeV1, MusePlatform, NotifyInput, PhotoResult, ShareInput, TakePhotoInput } from "./protocol";

export type { HapticKind, NotifyInput, PhotoResult, ShareInput, TakePhotoInput };

/** Longest a call waits for the page to load. A slow image shouldn't hold a button press for long. */
const LOAD_WAIT_MS = 5_000;
const DEFAULT_PHOTO_SIZE = 1600;

/** The app's bridge as it is right now, or null in a browser and on the server. */
function bridgeNow(): MuseNativeV1 | null {
  if (typeof window === "undefined") return null;
  const native = (window as unknown as { MuseNative?: Partial<MuseNativeV1> }).MuseNative;
  return native?.version === 1 ? (native as MuseNativeV1) : null;
}

/** The bridge, once its answer is final: Android's can still arrive until the page has loaded. */
async function bridge(): Promise<MuseNativeV1 | null> {
  const now = bridgeNow();
  if (now || typeof document === "undefined") return now;
  if (document.readyState === "complete" || !/Android/i.test(navigator.userAgent)) return null;
  await new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      window.removeEventListener("load", done);
      resolve();
    };
    const timer = setTimeout(done, LOAD_WAIT_MS);
    window.addEventListener("load", done);
  });
  return bridgeNow();
}

function codeOf(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

/** Which app this is, or null in a browser. Only for wording: the calls below work the same either way. */
export async function nativeApp(): Promise<{ platform: MusePlatform; capabilities: MuseCapabilities } | null> {
  const native = await bridge();
  return native ? { platform: native.platform, capabilities: native.capabilities } : null;
}

const VIBRATION_MS: Record<HapticKind, number | number[]> = {
  light: 10,
  selection: 10,
  medium: 20,
  heavy: 35,
  success: [15, 40, 15],
  warning: [25, 50, 25],
  error: [40, 60, 40],
};

/** A small buzz. True when one was asked for, false when this device has none. Purely a nicety, so it never throws. */
export async function haptic(kind: HapticKind = "light"): Promise<boolean> {
  try {
    const native = await bridge();
    if (native) {
      await native.haptic(kind);
      return true;
    }
  } catch {
    // Desktop apps answer `unsupported`. Fall through.
  }
  return typeof navigator !== "undefined" && typeof navigator.vibrate === "function" ? navigator.vibrate(VIBRATION_MS[kind]) : false;
}

/** How a share went: through the app or the browser's sheet, copied to the clipboard, or not at all. */
export type ShareOutcome = { shared: boolean; via: "app" | "browser" | "clipboard" | "none" };

/** Opens the share sheet, or copies the link or text where there is none. Canceling isn't an error. */
export async function share(input: ShareInput): Promise<ShareOutcome> {
  const native = await bridge();
  if (native) {
    try {
      const { shared } = await native.share(input);
      return { shared, via: "app" };
    } catch (err) {
      if (codeOf(err) === "canceled") return { shared: false, via: "app" };
      if (codeOf(err) !== "unsupported") throw err;
    }
  }
  if (typeof navigator === "undefined") return { shared: false, via: "none" };
  if (typeof navigator.share === "function") {
    try {
      await navigator.share(input);
      return { shared: true, via: "browser" };
    } catch (err) {
      if ((err as Error).name === "AbortError") return { shared: false, via: "browser" };
    }
  }
  const text = input.url ?? input.text ?? input.title;
  if (text && navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text);
      return { shared: true, via: "clipboard" };
    } catch {
      // Clipboard access can be blocked. Say nothing was shared.
    }
  }
  return { shared: false, via: "none" };
}

function pickFile(input: TakePhotoInput): Promise<File | null> {
  return new Promise((resolve) => {
    const el = document.createElement("input");
    el.type = "file";
    el.accept = "image/*";
    if ((input.source ?? "camera") === "camera") el.capture = "environment";
    el.addEventListener("change", () => resolve(el.files?.[0] ?? null));
    el.addEventListener("cancel", () => resolve(null));
    el.click();
  });
}

async function fileToPhoto(file: File, maxSize: number): Promise<PhotoResult> {
  const image = await createImageBitmap(file);
  const scale = Math.min(1, maxSize / Math.max(image.width, image.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(image.width * scale);
  canvas.height = Math.round(image.height * scale);
  canvas.getContext("2d")?.drawImage(image, 0, 0, canvas.width, canvas.height);
  image.close();
  return { dataUrl: canvas.toDataURL("image/jpeg", 0.85), width: canvas.width, height: canvas.height };
}

/**
 * A photo as a JPEG data URL, from the camera or the library, or null when the person cancels. Call it from a button's
 * click, because a browser only opens its file picker on a person's action. It rejects when the app refuses the camera,
 * so show what to do next.
 */
export async function takePhoto(input: TakePhotoInput = {}): Promise<PhotoResult | null> {
  const native = await bridge();
  if (native) {
    try {
      return await native.takePhoto(input);
    } catch (err) {
      if (codeOf(err) === "canceled") return null;
      if (codeOf(err) !== "unsupported") throw err;
    }
  }
  const file = await pickFile(input);
  return file ? fileToPhoto(file, input.maxSize ?? DEFAULT_PHOTO_SIZE) : null;
}

/**
 * Shows a notification, now or after delaySeconds. True when it was shown or scheduled, false when this device has none, the
 * person said no or the app couldn't. It never rejects. In a browser a delayed one is lost if the tab closes, and on desktop
 * if the app closes. A phone's browser pauses a page's timers and may have no page notifications at all, so a delayed one
 * there is false.
 */
export async function notify(input: NotifyInput): Promise<boolean> {
  const native = await bridge();
  if (native) {
    try {
      await native.notify(input);
      return true;
    } catch (err) {
      if (codeOf(err) !== "unsupported") return false;
    }
  }
  if (typeof Notification === "undefined") return false;
  try {
    const permission = Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission;
    if (permission !== "granted") return false;
  } catch {
    return false;
  }
  // Chrome on Android has the Notification name but throws when a page calls it.
  const show = () => {
    try {
      new Notification(input.title, input.body ? { body: input.body } : undefined);
      return true;
    } catch {
      return false;
    }
  };
  if (!input.delaySeconds || input.delaySeconds <= 0) return show();
  if (/Android|iPhone|iPad/i.test(navigator.userAgent)) return false;
  setTimeout(show, input.delaySeconds * 1000);
  return true;
}
