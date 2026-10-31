// Runs sandboxed, before the page. It exposes window.MuseNative and nothing else from Electron.

const { contextBridge, ipcRenderer } = require("electron");

const PREFIX = "--muse-bridge=";
const raw = process.argv.find((item) => item.startsWith(PREFIX));
const setup = raw ? JSON.parse(decodeURIComponent(raw.slice(PREFIX.length))) : null;

/** Only the product's own page gets the bridge. */
if (setup && window.location.origin === setup.origin) {
  // This part runs in the page's world, because an Error crossing the context bridge loses its `code`, which is how a
  // product tells "unsupported" from any other failure.
  contextBridge.executeInMainWorld({
    func: (setup, invoke) => {
      async function call(method, params) {
        const reply = await invoke(method, params);
        if (reply && reply.ok) return reply.result === null ? undefined : reply.result;
        const failure = (reply && reply.error) || { code: "failed", message: "Something went wrong." };
        throw Object.assign(new Error(failure.message), { code: failure.code });
      }

      const api = {
        version: setup.version,
        platform: setup.platform,
        capabilities: Object.freeze(setup.capabilities),
        hello: () => call("hello"),
        haptic: (kind) => call("haptic", { kind }),
        share: (input) => call("share", input),
        takePhoto: (input) => call("takePhoto", input),
        notify: (input) => call("notify", input),
      };
      Object.defineProperty(window, "MuseNative", { value: Object.freeze(api), enumerable: true });
    },
    args: [setup, (method, params) => ipcRenderer.invoke("muse:call", { method, params })],
  });
}
