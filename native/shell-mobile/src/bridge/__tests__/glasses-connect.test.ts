import assert from "node:assert/strict";
import { before, beforeEach, describe, it, mock } from "node:test";

type Listener = (event: never) => void;

/** A small fake of the wearables module, which fires its events a moment after each call. */
const fake = {
  created: [] as string[],
  stopped: [] as string[],
  listeners: new Map<string, Set<Listener>>(),
  emit(name: string, event: unknown) {
    for (const listener of this.listeners.get(name) ?? []) listener(event as never);
  },
  reset() {
    this.created = [];
    this.stopped = [];
    this.listeners = new Map();
  },
};

const wearables = {
  configure: async () => {},
  getRegistrationStateAsync: async () => "registered",
  requestPermission: async () => "granted",
  getDevices: async () => [{ name: "Mock", batteryLevel: 80, donState: "donned" }],
  addListener(name: string, listener: Listener) {
    if (!fake.listeners.has(name)) fake.listeners.set(name, new Set());
    fake.listeners.get(name)?.add(listener);
    return { remove: () => fake.listeners.get(name)?.delete(listener) };
  },
  createSession: async () => {
    const id = `s${fake.created.length + 1}`;
    fake.created.push(id);
    return id;
  },
  startSession: async (id: string) => {
    setTimeout(() => fake.emit("onDeviceSessionStateChange", { sessionId: id, state: "started" }), 1);
  },
  addCameraToSession: async () => {
    setTimeout(() => fake.emit("onStreamStateChange", { state: "streaming" }), 1);
  },
  stopSession: async (id: string) => {
    fake.stopped.push(id);
  },
};

type GlassesStatus = { state: string };
type Bridge = { handlers: { "glasses.connect"(): Promise<GlassesStatus> }; dispose(): void };
let createGlassesBridge: (options: { mock: boolean; emitStatus(status: GlassesStatus): void; setPreview(show: boolean): void }) => Bridge;

before(async () => {
  mock.module("expo", { namedExports: { requireOptionalNativeModule: () => ({}) } });
  mock.module("expo-audio", {
    namedExports: { AudioModule: {}, IOSOutputFormat: {}, requestRecordingPermissionsAsync: async () => ({}), setAudioModeAsync: async () => {} },
  });
  mock.module("expo-file-system", { namedExports: { File: class {}, Paths: {} } });
  mock.module("expo-speech", { namedExports: { speak() {}, stop: async () => {} } });
  mock.module("expo-image-manipulator", { namedExports: {} });
  mock.module("@chrisgocode/expo-meta-wearables-dat", { defaultExport: wearables, namedExports: wearables });
  // A variable path keeps the root typecheck, which can't read this .js file's imports, out of it.
  const path = "../glasses.js";
  ({ createGlassesBridge } = await import(path));
});

beforeEach(() => fake.reset());

function bridge() {
  const statuses: GlassesStatus[] = [];
  const made = createGlassesBridge({ mock: false, emitStatus: (status) => statuses.push(status), setPreview: () => {} });
  return { made, statuses };
}

describe("glasses.connect", () => {
  it("makes one session for calls that overlap", async () => {
    const { made } = bridge();
    const [a, b] = await Promise.all([made.handlers["glasses.connect"](), made.handlers["glasses.connect"]()]);
    assert.equal(a.state, "ready");
    assert.equal(b.state, "ready");
    assert.deepEqual(fake.created, ["s1"]);
    assert.deepEqual(fake.stopped, []);
  });

  it("does nothing more once it's ready", async () => {
    const { made } = bridge();
    await made.handlers["glasses.connect"]();
    await made.handlers["glasses.connect"]();
    assert.deepEqual(fake.created, ["s1"]);
  });

  it("ends the running session before reconnecting after a passing error", async () => {
    const { made } = bridge();
    await made.handlers["glasses.connect"]();
    fake.emit("onStreamError", { type: "thermalHot" });
    const status = await made.handlers["glasses.connect"]();
    assert.equal(status.state, "ready");
    assert.deepEqual(fake.created, ["s1", "s2"]);
    assert.deepEqual(fake.stopped, ["s1"]);
  });

  it("can connect again after a connect fails", async () => {
    const { made } = bridge();
    const realCreate = wearables.createSession;
    wearables.createSession = async () => {
      throw new Error("noEligibleDevice");
    };
    try {
      await assert.rejects(made.handlers["glasses.connect"]());
    } finally {
      wearables.createSession = realCreate;
    }
    assert.equal((await made.handlers["glasses.connect"]()).state, "ready");
  });
});
