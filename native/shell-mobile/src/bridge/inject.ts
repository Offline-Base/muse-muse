// Builds the JavaScript the shell puts into the page.
//
// On iOS it runs before any of the page's own code. On Android it does not: react-native-webview 14 calls
// evaluateJavascript from onPageStarted, which is asynchronous, so a page's first inline script can run ahead of it. The
// product side must look for window.MuseNative when it's about to use it, and never cache a "no" from early in the load.

import { METHOD_TIMEOUT_MS, MUSE_NATIVE_VERSION } from "./protocol";
import type { BridgeEvent, BridgeReply, MuseCapabilities, MusePlatform } from "./protocol";

export interface ShimConfig {
  platform: MusePlatform;
  capabilities: MuseCapabilities;
  /** A random value per WebView. Only the top frame gets it, so an embedded page can't call the bridge. */
  nonce: string;
  /** The product's origin. The shim does nothing on any other page, so that page never sees the nonce. */
  origin: string;
  /** Also collects page errors and adds the selftest report call. Lab variant only. */
  selftest?: boolean;
  /** Also adds the autopilot checkpoint call. Lab glasses checks only. */
  autopilot?: boolean;
}

/** The page's own timer outlasts the shell's, so the shell's answer normally arrives first. */
const PAGE_TIMEOUT_MARGIN_MS = 5_000;

/** JSON that is safe to place inside a script: these two characters end a line in older JavaScript engines. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

export function buildShim(config: ShimConfig): string {
  const setup = {
    version: MUSE_NATIVE_VERSION,
    platform: config.platform,
    capabilities: config.capabilities,
    nonce: config.nonce,
    origin: config.origin,
    timeouts: Object.fromEntries(
      Object.entries(METHOD_TIMEOUT_MS).map(([method, ms]) => [method, ms + PAGE_TIMEOUT_MARGIN_MS]),
    ),
    selftest: Boolean(config.selftest),
    autopilot: Boolean(config.autopilot),
  };

  return `(function () {
  if (window.top !== window.self) return;
  if (window.__museNative) return;
  var setup = ${scriptJson(setup)};
  if (window.location.origin !== setup.origin) return;
  var pending = Object.create(null);
  var statusListeners = [];
  var counter = 0;

  function call(method, params) {
    return new Promise(function (resolve, reject) {
      var transport = window.ReactNativeWebView;
      if (!transport) {
        reject(Object.assign(new Error("This app can't do that."), { code: "unsupported" }));
        return;
      }
      counter += 1;
      var id = "m" + counter + "_" + Date.now().toString(36);
      var timer = setTimeout(function () {
        delete pending[id];
        reject(Object.assign(new Error("That took too long. Please try again."), { code: "timeout" }));
      }, setup.timeouts[method] || 30000);
      pending[id] = { resolve: resolve, reject: reject, timer: timer };
      transport.postMessage(
        JSON.stringify({ v: setup.version, id: id, method: method, params: params, nonce: setup.nonce }),
      );
    });
  }

  function receive(message) {
    if (!message || message.v !== setup.version) return;
    if (message.event === "glasses.status") {
      statusListeners.slice().forEach(function (listener) {
        try {
          listener(message.data);
        } catch (error) {
          console.error(error);
        }
      });
      return;
    }
    var entry = pending[message.id];
    if (!entry) return;
    delete pending[message.id];
    clearTimeout(entry.timer);
    if (message.ok) {
      entry.resolve(message.result === null ? undefined : message.result);
    } else {
      var failure = message.error || {};
      entry.reject(Object.assign(new Error(failure.message || "Something went wrong."), { code: failure.code || "failed" }));
    }
  }

  function freeze(value) {
    return Object.freeze(value);
  }

  var api = {
    version: setup.version,
    platform: setup.platform,
    capabilities: freeze(setup.capabilities),
    hello: function () {
      return call("hello");
    },
    haptic: function (kind) {
      return call("haptic", { kind: kind });
    },
    share: function (input) {
      return call("share", input);
    },
    takePhoto: function (input) {
      return call("takePhoto", input);
    },
    notify: function (input) {
      return call("notify", input);
    },
  };

  if (setup.capabilities.glasses) {
    api.glasses = freeze({
      status: function () {
        return call("glasses.status");
      },
      onStatus: function (listener) {
        statusListeners.push(listener);
        return function () {
          var at = statusListeners.indexOf(listener);
          if (at >= 0) statusListeners.splice(at, 1);
        };
      },
      connect: function () {
        return call("glasses.connect");
      },
      capturePhoto: function (options) {
        return call("glasses.capturePhoto", options);
      },
      preview: function (options) {
        return call("glasses.preview", options);
      },
      startRecording: function (options) {
        return call("glasses.startRecording", options);
      },
      stopRecording: function () {
        return call("glasses.stopRecording");
      },
      speak: function (text) {
        return call("glasses.speak", { text: text });
      },
    });
  }

  var internal = { receive: receive };

  if (setup.selftest) {
    var pageErrors = [];
    var note = function (text) {
      if (pageErrors.length < 50) pageErrors.push(String(text).slice(0, 300));
    };
    window.addEventListener("error", function (event) {
      note(event.message);
    });
    window.addEventListener("unhandledrejection", function (event) {
      note(event.reason && event.reason.message ? event.reason.message : event.reason);
    });
    var consoleError = console.error;
    console.error = function () {
      note(Array.prototype.join.call(arguments, " "));
      return consoleError.apply(console, arguments);
    };
    internal.pageErrors = function () {
      return pageErrors.slice();
    };
    internal.report = function (report) {
      return call("selftest.report", report);
    };
  }

  if (setup.autopilot) {
    internal.checkpoint = function (entry) {
      return call("autopilot.checkpoint", entry);
    };
  }

  Object.defineProperty(window, "MuseNative", { value: freeze(api), enumerable: true });
  Object.defineProperty(window, "__museNative", { value: freeze(internal) });
})();
true;`;
}

/** The script that hands a reply or an event to the page. */
export function buildDelivery(message: BridgeReply | BridgeEvent): string {
  return `window.__museNative && window.__museNative.receive(${scriptJson(message)});true;`;
}
