// Presses through a glasses product on the iPhone Simulator, so the lab can record the real path with mock glasses.
// It relies on the automation contract from the glasses template: [data-glasses-action="connect"],
// [data-glasses-primary] and [data-result]. The template's button listens from the first script click until the second,
// so after a moment the main button gets a second click, if it's still there, not disabled, and there's no result yet.
// The muse-glasses skill tells products the same thing.

export const AUTOPILOT_LOG = "autopilot.jsonl";
export const AUTOPILOT_LIMIT_MS = 120_000;
/** How long the question "lasts" between the two taps. */
export const AUTOPILOT_LISTEN_MS = 1_500;

export interface AutopilotEntry {
  step: string;
  ok: boolean;
  detail?: string;
  /** The page's uncaught errors and console.error calls so far, on the steps that end a run. */
  errors?: string[];
  at: string;
}

const STEPS = new Set(["start", "connect", "primary", "result", "timeout", "error"]);
const MAX_ERRORS = 20;
const MAX_ERROR_CHARS = 300;

/** Page input is untrusted, so only a known step and short text reach the log. */
export function cleanCheckpoint(raw: unknown, at: Date): AutopilotEntry | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { step, ok, detail, errors } = raw as Record<string, unknown>;
  if (typeof step !== "string" || !STEPS.has(step)) return null;
  return {
    step,
    ok: ok === true,
    ...(typeof detail === "string" ? { detail: detail.slice(0, 300) } : {}),
    ...(Array.isArray(errors) && errors.length > 0
      ? { errors: errors.slice(0, MAX_ERRORS).map((error) => String(error).slice(0, MAX_ERROR_CHARS)) }
      : {}),
    at: at.toISOString(),
  };
}

/** Runs in the page after it loads. */
export function buildAutopilotScript(limitMs: number = AUTOPILOT_LIMIT_MS, listenMs: number = AUTOPILOT_LISTEN_MS): string {
  return `(function () {
  var internal = window.__museNative;
  if (!internal || !internal.checkpoint || window.__museAutopilotStarted) return;
  window.__museAutopilotStarted = true;
  var deadline = Date.now() + ${Math.max(0, Math.floor(limitMs))};
  function mark(step, ok, detail, errors) {
    return internal.checkpoint({ step: step, ok: ok, detail: detail, errors: errors }).catch(function () {});
  }
  function pageErrors() {
    return internal.pageErrors ? internal.pageErrors() : [];
  }
  function find(selector) {
    return document.querySelector(selector);
  }
  function waitFor(selector) {
    return new Promise(function (resolve, reject) {
      (function look() {
        var found = find(selector);
        if (found) return resolve(found);
        if (Date.now() > deadline) return reject(new Error("timeout: " + selector));
        setTimeout(look, 250);
      })();
    });
  }
  function ready() {
    return new Promise(function (resolve, reject) {
      var glasses = window.MuseNative && window.MuseNative.glasses;
      if (!glasses) return reject(new Error("no glasses bridge"));
      (function look() {
        glasses.status().then(function (status) {
          if (status.state === "ready") return resolve(status);
          if (Date.now() > deadline) return reject(new Error("timeout: glasses are " + status.state));
          setTimeout(look, 500);
        }, reject);
      })();
    });
  }
  mark("start", true);
  waitFor('[data-glasses-action="connect"]')
    .then(function (button) {
      button.click();
      return ready();
    })
    .then(function (status) {
      return mark("connect", true, status.mode);
    })
    .then(function () {
      return waitFor("[data-glasses-primary]:not([disabled])");
    })
    .then(function (button) {
      button.click();
      return new Promise(function (resolve) {
        setTimeout(resolve, ${Math.max(0, Math.floor(listenMs))});
      });
    })
    .then(function () {
      var button = find("[data-glasses-primary]");
      if (button && !button.disabled && !find("[data-result]")) button.click();
      return mark("primary", true);
    })
    .then(function () {
      return waitFor("[data-result]");
    })
    .then(function (result) {
      return mark("result", true, (result.innerText || "").slice(0, 200), pageErrors());
    })
    .catch(function (error) {
      var text = error && error.message ? error.message : String(error);
      return mark(text.indexOf("timeout") === 0 ? "timeout" : "error", false, text, pageErrors());
    });
})();
true;`;
}
