// Runs sandboxed, before the page. It exposes window.MuseNative and nothing else from Electron.

const { contextBridge, ipcRenderer } = require("electron");

const PREFIX = "--muse-bridge=";
const raw = process.argv.find((item) => item.startsWith(PREFIX));
const setup = raw ? JSON.parse(decodeURIComponent(raw.slice(PREFIX.length))) : null;

/** Only the product's own page gets the bridge. */
if (setup && window.location.origin === setup.origin) {
  async function call(method, params) {
    const reply = await ipcRenderer.invoke("muse:call", { method, params });
    if (reply && reply.ok) return reply.result === null ? undefined : reply.result;
    const failure = (reply && reply.error) || { code: "failed", message: "Something went wrong." };
    throw Object.assign(new Error(failure.message), { code: failure.code });
  }

  contextBridge.exposeInMainWorld("MuseNative", {
    version: setup.version,
    platform: setup.platform,
    capabilities: setup.capabilities,
    hello: () => call("hello"),
    haptic: (kind) => call("haptic", { kind }),
    share: (input) => call("share", input),
    takePhoto: (input) => call("takePhoto", input),
    notify: (input) => call("notify", input),
  });
}
