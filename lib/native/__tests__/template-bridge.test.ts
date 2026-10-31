/**
 * template-native/lib/native/bridge.ts against a fake window: the shell's bridge when it's there, each web fallback when it
 * isn't, the rule that the bridge is looked for at each call and never cached, and Android's wait for the load event
 * (docs/NATIVE_SHELLS.md, "When the bridge appears").
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { haptic, nativeApp, notify, share, takePhoto } from "@/template-native/lib/native/bridge";

type Bag = Record<string, unknown>;
const globals = globalThis as unknown as Bag;
const SAVED = ["window", "document", "navigator", "Notification"].map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)] as const);

function put(name: string, value: unknown) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

/** A browser page. */
function page(opts: { userAgent?: string; readyState?: string; navigator?: Bag } = {}) {
  const listeners = new Set<() => void>();
  const win: Bag = {
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
  };
  const doc: Bag = { readyState: opts.readyState ?? "complete" };
  put("window", win);
  put("document", doc);
  put("navigator", { userAgent: opts.userAgent ?? "Mozilla/5.0 (iPhone)", ...opts.navigator });
  return {
    win,
    doc,
    fireLoad() {
      doc.readyState = "complete";
      for (const fn of [...listeners]) fn();
    },
    listeners,
  };
}

function unsupported() {
  return Promise.reject(Object.assign(new Error("Not here"), { code: "unsupported" }));
}

const shell = (over: Bag = {}) => ({
  version: 1,
  platform: "android",
  capabilities: { haptics: true, share: true, camera: true, notifications: true, glasses: false, frames: false },
  haptic: async () => undefined,
  share: async () => ({ shared: true }),
  takePhoto: async () => ({ dataUrl: "data:image/jpeg;base64,AA", width: 1, height: 1 }),
  notify: async () => undefined,
  ...over,
});

beforeEach(() => mock.timers.reset());
afterEach(() => {
  mock.timers.reset();
  for (const [name, desc] of SAVED) {
    if (desc) Object.defineProperty(globalThis, name, desc);
    else delete globals[name];
  }
});

describe("the bridge", () => {
  it("does nothing on the server", async () => {
    delete globals.window;
    delete globals.document;
    assert.equal(await nativeApp(), null);
  });

  it("uses the app's bridge when there is one", async () => {
    const calls: string[] = [];
    const p = page();
    p.win.MuseNative = shell({
      haptic: async (kind: string) => void calls.push(`haptic ${kind}`),
      notify: async () => void calls.push("notify"),
    });
    assert.equal(await haptic("success"), true);
    assert.deepEqual(await share({ url: "https://a.example" }), { shared: true, via: "app" });
    assert.deepEqual(await takePhoto(), { dataUrl: "data:image/jpeg;base64,AA", width: 1, height: 1 });
    assert.equal(await notify({ title: "Hi" }), true);
    assert.deepEqual(calls, ["haptic success", "notify"]);
    assert.equal((await nativeApp())?.platform, "android");
  });

  it("ignores a bridge of another version", async () => {
    const p = page();
    p.win.MuseNative = shell({ version: 2 });
    assert.equal(await nativeApp(), null);
  });

  it("looks again at every call, so a late bridge is found", async () => {
    const p = page();
    assert.equal(await nativeApp(), null);
    p.win.MuseNative = shell();
    assert.equal((await nativeApp())?.platform, "android");
  });

  it("on Android, waits for the load event before settling on a fallback", async () => {
    const p = page({ userAgent: "Mozilla/5.0 (Linux; Android 15)", readyState: "loading" });
    const asked = nativeApp();
    assert.equal(p.listeners.size, 1, "it is waiting");
    p.win.MuseNative = shell();
    p.fireLoad();
    assert.equal((await asked)?.platform, "android");
    assert.equal(p.listeners.size, 0);
  });

  it("on Android, stops waiting after a few seconds if the page never finishes loading", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const p = page({ userAgent: "Mozilla/5.0 (Linux; Android 15)", readyState: "interactive" });
    const asked = nativeApp();
    mock.timers.tick(5_000);
    assert.equal(await asked, null);
    assert.equal(p.listeners.size, 0);
  });

  it("doesn't wait anywhere else, or after the page has loaded", async () => {
    const iphone = page({ readyState: "loading" });
    assert.equal(await nativeApp(), null);
    assert.equal(iphone.listeners.size, 0);
    const android = page({ userAgent: "Android", readyState: "complete" });
    assert.equal(await nativeApp(), null);
    assert.equal(android.listeners.size, 0);
  });

  it("falls back to web APIs when a desktop app answers unsupported", async () => {
    const p = page({ navigator: { vibrate: () => true, clipboard: { writeText: async () => undefined } } });
    p.win.MuseNative = shell({ platform: "mac", haptic: unsupported, share: unsupported, notify: unsupported });
    assert.equal(await haptic(), true, "the browser vibrates");
    assert.deepEqual(await share({ url: "https://a.example" }), { shared: true, via: "clipboard" });
    assert.equal(await notify({ title: "Hi" }), false, "no Notification here");
  });

  it("treats canceling as a result, and passes on any other failure", async () => {
    const canceled = () => Promise.reject(Object.assign(new Error("No"), { code: "canceled" }));
    const denied = () => Promise.reject(Object.assign(new Error("No"), { code: "denied" }));
    const p = page();
    p.win.MuseNative = shell({ share: canceled, takePhoto: canceled, notify: denied });
    assert.deepEqual(await share({ text: "x" }), { shared: false, via: "app" });
    assert.equal(await takePhoto(), null);
    assert.equal(await notify({ title: "Hi" }), false);
    p.win.MuseNative = shell({ takePhoto: denied, share: denied });
    await assert.rejects(takePhoto(), { code: "denied" });
    await assert.rejects(share({ text: "x" }), { code: "denied" });
  });

  it("never lets a haptic throw", async () => {
    const p = page();
    p.win.MuseNative = shell({ haptic: () => Promise.reject(new Error("boom")) });
    assert.equal(await haptic(), false);
  });
});

describe("the web fallbacks", () => {
  it("share uses the browser's sheet, then the clipboard, and says which", async () => {
    const shared: unknown[] = [];
    page({ navigator: { share: async (d: unknown) => void shared.push(d) } });
    assert.deepEqual(await share({ title: "T", url: "https://a.example" }), { shared: true, via: "browser" });
    assert.deepEqual(shared, [{ title: "T", url: "https://a.example" }]);

    page({ navigator: { share: () => Promise.reject(Object.assign(new Error("x"), { name: "AbortError" })) } });
    assert.deepEqual(await share({ url: "u" }), { shared: false, via: "browser" }, "canceling isn't a failure");

    const copied: string[] = [];
    page({ navigator: { clipboard: { writeText: async (t: string) => void copied.push(t) } } });
    assert.deepEqual(await share({ text: "words", url: "https://a.example" }), { shared: true, via: "clipboard" });
    assert.deepEqual(copied, ["https://a.example"]);

    page({ navigator: { clipboard: { writeText: () => Promise.reject(new Error("blocked")) } } });
    assert.deepEqual(await share({ url: "u" }), { shared: false, via: "none" });
    page();
    assert.deepEqual(await share({ url: "u" }), { shared: false, via: "none" });
  });

  it("haptic is false where the browser can't vibrate", async () => {
    page();
    assert.equal(await haptic(), false);
  });

  it("notify asks first, and respects a no", async () => {
    page();
    const shown: string[] = [];
    let permission = "default";
    const Fake = Object.assign(
      function (this: unknown, title: string) {
        shown.push(title);
      },
      { requestPermission: async () => permission, get permission() { return "default"; } },
    );
    put("Notification", Fake);
    permission = "denied";
    assert.equal(await notify({ title: "No" }), false);
    permission = "granted";
    assert.equal(await notify({ title: "Yes" }), true);
    assert.deepEqual(shown, ["Yes"]);
  });

  it("notify waits for a delay", async () => {
    page();
    const shown: string[] = [];
    put("Notification", Object.assign(function (this: unknown, title: string) { shown.push(title); }, { permission: "granted" }));
    mock.timers.enable({ apis: ["setTimeout"] });
    assert.equal(await notify({ title: "Later", delaySeconds: 60 }), true);
    assert.deepEqual(shown, []);
    mock.timers.tick(60_000);
    assert.deepEqual(shown, ["Later"]);
  });

  it("takePhoto opens a file picker, on the camera by default, and a cancel is null", async () => {
    const p = page();
    const inputs: Array<Bag & { fire: (name: string) => void }> = [];
    p.doc.createElement = () => {
      const handlers = new Map<string, () => void>();
      const el = {
        files: null,
        addEventListener: (name: string, fn: () => void) => handlers.set(name, fn),
        click() {
          inputs.push(el as never);
          handlers.get("cancel")?.();
        },
      } as unknown as Bag & { fire: (name: string) => void };
      return el;
    };
    assert.equal(await takePhoto(), null);
    assert.equal(inputs[0]?.type, "file");
    assert.equal(inputs[0]?.accept, "image/*");
    assert.equal(inputs[0]?.capture, "environment");
    assert.equal(await takePhoto({ source: "library" }), null);
    assert.equal(inputs[1]?.capture, undefined);
  });
});
