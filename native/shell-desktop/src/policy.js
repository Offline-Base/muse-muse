// What the window may do. Plain functions, so the rules can be tested without Electron.

/** Links the system can open safely. Anything else (file:, custom app schemes) goes nowhere. */
const EXTERNAL_SCHEMES = new Set(["https:", "http:", "mailto:", "tel:"]);

/** What a product can ask for, on its own origin only. Everything else is refused. */
const ALLOWED_PERMISSIONS = new Set([
  "media",
  "notifications",
  "fullscreen",
  "pointerLock",
  "clipboard-sanitized-write",
  "geolocation",
]);

function originOf(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.origin : null;
  } catch {
    return null;
  }
}

/** Stays on the product's origin, or leaves for the system browser, or goes nowhere. */
function decideNavigation(url, productOrigin) {
  if (originOf(url) === productOrigin) return "allow";
  try {
    return EXTERNAL_SCHEMES.has(new URL(url).protocol) ? "external" : "block";
  } catch {
    return "block";
  }
}

/** window.open never makes a new window, so every popup leaves for the system browser or goes nowhere. */
function canOpenExternally(url) {
  try {
    return EXTERNAL_SCHEMES.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

function allowPermission(permission, requestingUrl, productOrigin) {
  return ALLOWED_PERMISSIONS.has(permission) && originOf(requestingUrl) === productOrigin;
}

const MAX_TITLE_CHARS = 120;
const MAX_BODY_CHARS = 500;
const NOTIFY_LIMIT = { max: 6, perMs: 60_000 };

function bridgeError(code, message) {
  return { ok: false, error: { code, message } };
}

/**
 * The desktop side of window.MuseNative. Every call comes from the renderer, so it's untrusted. It is answered only for
 * the main frame on the product's origin. Haptics, share and camera stay unsupported here, and products fall back to
 * their web versions.
 */
function createBridge({ productOrigin, hello, showNotification, now = Date.now }) {
  const sent = [];

  return function handle(sender, request) {
    if (!sender.isMainFrame || originOf(sender.url) !== productOrigin) return null;
    const { method, params } = typeof request === "object" && request !== null ? request : {};

    if (method === "hello") return { ok: true, result: hello };
    if (method !== "notify") return bridgeError("unsupported", "This app can't do that.");

    const options = typeof params === "object" && params !== null ? params : {};
    const { title, body } = options;
    if (typeof title !== "string" || !title || title.length > MAX_TITLE_CHARS) {
      return bridgeError("bad_request", "A notification needs a title of 120 characters or fewer.");
    }
    if (body !== undefined && (typeof body !== "string" || body.length > MAX_BODY_CHARS)) {
      return bridgeError("bad_request", "Notification text is too long.");
    }
    const cutoff = now() - NOTIFY_LIMIT.perMs;
    while (sent.length > 0 && sent[0] <= cutoff) sent.shift();
    if (sent.length >= NOTIFY_LIMIT.max) return bridgeError("rate_limited", "That was too many times. Please wait a minute.");
    sent.push(now());
    showNotification({ title, body: body ?? "" });
    return { ok: true, result: null };
  };
}

module.exports = { allowPermission, canOpenExternally, createBridge, decideNavigation, originOf };
