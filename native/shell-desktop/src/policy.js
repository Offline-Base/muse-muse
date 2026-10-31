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

/** A page that keeps navigating away can't open more browser tabs than this. */
const EXTERNAL_OPEN_LIMIT = { max: 3, perMs: 10_000 };

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

/** will-redirect also fires for inner frames, which stay in place. Only the page itself is pinned to the product. */
function decideRedirect(url, isMainFrame, productOrigin) {
  return isMainFrame ? decideNavigation(url, productOrigin) : "allow";
}

/** Says yes at most `max` times in any `perMs`. */
function createRateLimiter({ max, perMs } = EXTERNAL_OPEN_LIMIT, now = Date.now) {
  const times = [];
  return function allow() {
    const cutoff = now() - perMs;
    while (times.length > 0 && times[0] <= cutoff) times.shift();
    if (times.length >= max) return false;
    times.push(now());
    return true;
  };
}

function allowPermission(permission, requestingUrl, productOrigin) {
  return ALLOWED_PERMISSIONS.has(permission) && originOf(requestingUrl) === productOrigin;
}

/** A file only saves when the product's own page started it. */
function allowDownload(pageUrl, productOrigin) {
  return originOf(pageUrl) === productOrigin;
}

/** What the person has to agree to first, in the order the question names them. Other permissions need no question. */
function promptKinds(permission, mediaTypes) {
  if (permission === "geolocation") return ["location"];
  if (permission !== "media") return [];
  const types = Array.isArray(mediaTypes) ? mediaTypes.filter((type) => type === "audio" || type === "video") : [];
  // A request that doesn't say which device could get either one, so it asks about both.
  const wants = types.length > 0 ? types : ["audio", "video"];
  return [...(wants.includes("video") ? ["camera"] : []), ...(wants.includes("audio") ? ["microphone"] : [])];
}

function permissionQuestion(productName, kinds) {
  if (kinds.includes("location")) return `${productName} wants to use your location.`;
  return `${productName} wants to use your ${kinds.join(" and ")}.`;
}

/**
 * Camera, microphone and location need the person's yes. An answer lasts until the app quits, whichever way it went, so
 * a page can't keep asking. Only one question shows at a time.
 */
function createPermissionGate({ productOrigin, ask }) {
  const answers = new Map();
  let lastQuestion = Promise.resolve();

  const saved = (kinds) => {
    if (kinds.some((kind) => answers.get(kind) === false)) return false;
    return kinds.every((kind) => answers.get(kind) === true) ? true : null;
  };

  return {
    /** Answers at once and never asks. A question nobody has answered yet reads as no. */
    check(permission, requestingUrl, mediaType) {
      if (!allowPermission(permission, requestingUrl, productOrigin)) return false;
      const kinds = promptKinds(permission, mediaType ? [mediaType] : undefined);
      return kinds.length === 0 || saved(kinds) === true;
    },

    /** Resolves true or false, asking the person when it has to. */
    request(permission, requestingUrl, mediaTypes) {
      if (!allowPermission(permission, requestingUrl, productOrigin)) return Promise.resolve(false);
      const kinds = promptKinds(permission, mediaTypes);
      if (kinds.length === 0) return Promise.resolve(true);
      const answer = lastQuestion.then(async () => {
        const known = saved(kinds);
        if (known !== null) return known;
        const allowed = (await ask(kinds)) === true;
        for (const kind of kinds) answers.set(kind, allowed);
        return allowed;
      });
      lastQuestion = answer.catch(() => {});
      return answer;
    },
  };
}

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** What the window shows when the product won't load. It has no script, and its one link is checked like any other. */
function failurePage(retryUrl) {
  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>This didn't open</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px -apple-system, system-ui, "Segoe UI", sans-serif; display: grid; place-content: center; min-height: 100vh; margin: 0; text-align: center; }
  h1 { font-size: 20px; margin: 0 0 8px; }
  p { margin: 0 0 20px; }
</style>
</head>
<body>
<h1>This didn't open</h1>
<p>Check your connection, then try again.</p>
<p><a href="${escapeHtml(retryUrl)}">Try again</a></p>
</body>
</html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

const MAX_TITLE_CHARS = 120;
const MAX_BODY_CHARS = 500;
const NOTIFY_LIMIT = { max: 6, perMs: 60_000 };
const MAX_DELAY_SECONDS = 86_400;
const MAX_WAITING_NOTIFICATIONS = 64;

function bridgeError(code, message) {
  return { ok: false, error: { code, message } };
}

/**
 * The desktop side of window.MuseNative. Every call comes from the renderer, so it's untrusted. It is answered only for
 * the main frame on the product's origin. Haptics, share and camera stay unsupported here, and products fall back to
 * their web versions.
 */
function createBridge({
  productOrigin,
  hello,
  showNotification,
  notificationsSupported = true,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  const sent = [];
  const waiting = new Set();

  function handle(sender, request) {
    if (!sender.isMainFrame || originOf(sender.url) !== productOrigin) return null;
    const { method, params } = typeof request === "object" && request !== null ? request : {};

    if (method === "hello") return { ok: true, result: hello };
    if (method !== "notify" || !notificationsSupported) return bridgeError("unsupported", "This app can't do that.");

    const options = typeof params === "object" && params !== null ? params : {};
    const { title, body, delaySeconds = 0 } = options;
    if (typeof title !== "string" || !title || title.length > MAX_TITLE_CHARS) {
      return bridgeError("bad_request", "A notification needs a title of 120 characters or fewer.");
    }
    if (body !== undefined && (typeof body !== "string" || body.length > MAX_BODY_CHARS)) {
      return bridgeError("bad_request", "Notification text is too long.");
    }
    if (typeof delaySeconds !== "number" || !Number.isFinite(delaySeconds) || delaySeconds < 0 || delaySeconds > MAX_DELAY_SECONDS) {
      return bridgeError("bad_request", "delaySeconds must be between 0 and 86400.");
    }
    if (delaySeconds > 0 && waiting.size >= MAX_WAITING_NOTIFICATIONS) {
      return bridgeError("rate_limited", "Too many notifications are waiting.");
    }
    const cutoff = now() - NOTIFY_LIMIT.perMs;
    while (sent.length > 0 && sent[0] <= cutoff) sent.shift();
    if (sent.length >= NOTIFY_LIMIT.max) return bridgeError("rate_limited", "That was too many times. Please wait a minute.");
    sent.push(now());
    const notification = { title, body: body ?? "" };
    if (delaySeconds === 0) {
      showNotification(notification);
    } else {
      const timer = setTimer(() => {
        waiting.delete(timer);
        showNotification(notification);
      }, delaySeconds * 1_000);
      waiting.add(timer);
    }
    return { ok: true, result: null };
  }

  /** A notification still waiting when the app quits is lost. */
  handle.dispose = () => {
    for (const timer of waiting) clearTimer(timer);
    waiting.clear();
  };

  return handle;
}

module.exports = {
  allowDownload,
  allowPermission,
  canOpenExternally,
  createBridge,
  createPermissionGate,
  createRateLimiter,
  decideNavigation,
  decideRedirect,
  failurePage,
  originOf,
  permissionQuestion,
  promptKinds,
};
