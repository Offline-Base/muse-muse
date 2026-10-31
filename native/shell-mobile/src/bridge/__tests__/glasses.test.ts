// window.MuseNative.glasses with the wearables module, audio and speech replaced.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { before, beforeEach, describe, it, mock } from "node:test";

const events = new EventEmitter();
const calls: string[] = [];
let question: { size: number; base64(): Promise<string> } | null = null;
let permission = { granted: true };
/** Holds the next permission answer back, so a test can act while a recording is still starting. */
let permissionGate: Promise<void> | null = null;
let prepareGate: Promise<void> | null = null;

const wearables = {
  configure: async () => {},
  getRegistrationStateAsync: async () => "registered",
  requestPermission: async () => "granted",
  getDevices: async () => [{ name: "Ray-Ban Meta", batteryLevel: 80, donState: "donned" }],
  createSession: async () => {
    calls.push("createSession");
    return `session-${calls.filter((c) => c === "createSession").length}`;
  },
  startSession: async (id: string) => {
    setImmediate(() => events.emit("onDeviceSessionStateChange", { sessionId: id, state: "started" }));
  },
  stopSession: async (id: string) => {
    calls.push(`stopSession:${id}`);
  },
  addCameraToSession: async () => {
    setImmediate(() => events.emit("onStreamStateChange", { state: "streaming" }));
  },
  capturePhoto: async () => {
    setImmediate(() => events.emit("onStreamError", { type: "photoCaptureFailed" }));
  },
  enableMockDeviceKit: async () => {},
  getMockDevices: async () => ["mock-1"],
  mockDevicePowerOn: async () => {},
  mockDeviceUnfold: async () => {},
  mockDeviceDon: async () => {},
  addListener(name: string, listener: (...payload: unknown[]) => void) {
    events.on(name, listener);
    return { remove: () => events.off(name, listener) };
  },
};

class FakeRecorder {
  isRecording = false;
  currentTime = 0;
  uri = "file:///tmp/q.wav";
  async prepareToRecordAsync() {
    await prepareGate;
  }
  async getCurrentInput() {
    return { type: "builtin", name: "mic" };
  }
  record() {
    this.isRecording = true;
    calls.push("record");
  }
  async stop() {
    this.isRecording = false;
    calls.push("recorderStop");
  }
}

class FakeFile {
  size = 44;
  constructor(
    private readonly where: unknown,
    private readonly name?: string,
  ) {}
  get exists() {
    return this.name === "mock-question.wav" ? question !== null : false;
  }
  async base64() {
    if (this.name === "mock-question.wav" && question) {
      this.size = question.size;
      return question.base64();
    }
    return "QUFB";
  }
  delete() {
    calls.push("delete");
  }
}

type Status = { state: string };
type Handlers = Record<string, (params?: unknown) => Promise<unknown>>;
type Made = { handlers: Handlers; pageChanged(): void; dispose(): void };
let createGlassesBridge: (options: { mock: boolean; emitStatus(status: Status): void; setPreview(show: boolean): void }) => Made;

before(async () => {
  mock.module("@chrisgocode/expo-meta-wearables-dat", { namedExports: wearables, defaultExport: wearables });
  mock.module("expo", { namedExports: { requireOptionalNativeModule: () => ({}) } });
  mock.module("expo-audio", {
    namedExports: {
      AudioModule: { AudioRecorder: FakeRecorder },
      IOSOutputFormat: { LINEARPCM: "lpcm" },
      requestRecordingPermissionsAsync: async () => {
        await permissionGate;
        return permission;
      },
      setAudioModeAsync: async ({ allowsRecording }: { allowsRecording: boolean }) => {
        calls.push(`audioMode:${allowsRecording}`);
      },
    },
  });
  mock.module("expo-file-system", { namedExports: { File: FakeFile, Paths: { document: "docs" } } });
  mock.module("expo-speech", { namedExports: { speak: () => {}, stop: async () => calls.push("speechStop") } });
  mock.module("expo-image-manipulator", { namedExports: {} });
  // A variable path keeps the root typecheck, which can't read this .js file's imports, out of it.
  const path = "../glasses.js";
  ({ createGlassesBridge } = await import(path));
});

function bridge({ mockGlasses = false } = {}) {
  const previews: boolean[] = [];
  const made = createGlassesBridge({ mock: mockGlasses, emitStatus: () => {}, setPreview: (show) => previews.push(show) });
  const call = (method: string, params?: unknown) => made.handlers[`glasses.${method}`](params);
  return { ...made, call, previews };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));
/** Only the calls about one thing, so a test doesn't pin the audio mode calls around them. */
const without = (prefix: string) => calls.filter((c) => !c.startsWith(prefix));

describe("the glasses bridge", () => {
  beforeEach(() => {
    calls.length = 0;
    question = null;
    permission = { granted: true };
    permissionGate = null;
    prepareGate = null;
    events.removeAllListeners();
  });

  it("stays ready after a failed photo, so the next press can work", async () => {
    const { call } = bridge();
    await call("connect");
    await assert.rejects(call("capturePhoto", { maxSize: 1600 }), { code: "capture_failed" });
    assert.equal(((await call("status")) as Status).state, "ready");
  });

  it("stays ready after a stream timeout", async () => {
    const { call } = bridge();
    await call("connect");
    events.emit("onStreamError", { type: "timeout" });
    assert.equal(((await call("status")) as Status).state, "ready");
  });

  it("still reports a real stream problem, and reconnecting ends the old session first", async () => {
    const { call } = bridge();
    await call("connect");
    events.emit("onStreamError", { type: "hingesClosed" });
    assert.equal(((await call("status")) as Status).state, "error");
    await call("connect");
    assert.deepEqual(calls, ["createSession", "stopSession:session-1", "createSession"]);
  });

  it("a new page ends the old page's recording and live view, and it can record again", async () => {
    const { call, pageChanged, previews } = bridge();
    await call("startRecording", { maxSeconds: 60 });
    await assert.rejects(call("startRecording", { maxSeconds: 60 }), { code: "busy" });
    pageChanged();
    await settle();
    assert.deepEqual(without("audioMode"), ["record", "speechStop", "recorderStop", "delete"]);
    assert.equal(calls.at(-1), "audioMode:false");
    assert.deepEqual(previews, [false]);
    await assert.rejects(call("stopRecording"), { code: "bad_request" });
    await call("startRecording", { maxSeconds: 60 });
    assert.equal(calls.filter((c) => c === "record").length, 2);
  });

  it("a new page leaves the glasses connected", async () => {
    const { call, pageChanged } = bridge();
    await call("connect");
    pageChanged();
    assert.equal(((await call("status")) as Status).state, "ready");
    assert.ok(!calls.some((c) => c.startsWith("stopSession")));
  });

  it("a recording the old page was still asking permission for never starts", async () => {
    let answer = () => {};
    permissionGate = new Promise((resolve) => {
      answer = resolve;
    });
    const { call, pageChanged } = bridge();
    const starting = call("startRecording", { maxSeconds: 60 });
    pageChanged();
    answer();
    await starting;
    assert.ok(!calls.includes("record"));
    await assert.rejects(call("stopRecording"), { code: "bad_request" });
  });

  it("a recording the old page was still preparing never starts, and doesn't get in the new page's way", async () => {
    let ready = () => {};
    prepareGate = new Promise((resolve) => {
      ready = resolve;
    });
    const { call, pageChanged } = bridge();
    const starting = call("startRecording", { maxSeconds: 60 });
    await settle();
    pageChanged();
    prepareGate = null;
    await call("startRecording", { maxSeconds: 60 });
    assert.equal(calls.filter((c) => c === "record").length, 1);
    calls.length = 0;
    ready();
    await starting;
    await settle();
    assert.ok(!calls.includes("record"));
    assert.ok(!calls.includes("audioMode:false"), "the new page is recording");
    assert.deepEqual(await call("stopRecording").then((r) => (r as { source: string }).source), "phone");
  });

  it("says when the microphone is off", async () => {
    permission = { granted: false };
    await assert.rejects(bridge().call("startRecording", { maxSeconds: 5 }), { code: "denied" });
  });

  it("the mock glasses answer with the lab's question, without the microphone", async () => {
    question = { size: 44 + 32_000, base64: async () => "UVVF" };
    const { call } = bridge({ mockGlasses: true });
    await call("startRecording", { maxSeconds: 2 });
    await assert.rejects(call("startRecording", { maxSeconds: 2 }), { code: "busy" });
    const heard = (await call("stopRecording")) as { wavDataUrl: string; source: string };
    assert.equal(heard.wavDataUrl, "data:audio/wav;base64,UVVF");
    assert.equal(heard.source, "glasses");
    assert.ok(!calls.includes("record") && !calls.includes("delete"));
  });

  it("mock glasses with no question from the lab return silence, still without the microphone", async () => {
    const { call } = bridge({ mockGlasses: true });
    await call("startRecording", { maxSeconds: 2 });
    const heard = (await call("stopRecording")) as { wavDataUrl: string; source: string };
    assert.match(heard.wavDataUrl, /^data:audio\/wav;base64,UklGR/);
    assert.equal(heard.source, "phone");
    assert.ok(!calls.includes("record"));
  });

  it("a new page ends a mock recording too", async () => {
    const { call, pageChanged } = bridge({ mockGlasses: true });
    await call("startRecording", { maxSeconds: 60 });
    pageChanged();
    await assert.rejects(call("stopRecording"), { code: "bad_request" });
    await call("startRecording", { maxSeconds: 60 });
  });

  it("a mock recording past its limit no longer counts as busy", async () => {
    const realNow = Date.now;
    let now = 1_000_000;
    Date.now = () => now;
    try {
      const { call } = bridge({ mockGlasses: true });
      await call("startRecording", { maxSeconds: 1 });
      now += 1_500;
      await call("startRecording", { maxSeconds: 1 });
      now += 5_000;
      assert.equal(((await call("stopRecording")) as { seconds: number }).seconds, 1);
    } finally {
      Date.now = realNow;
    }
  });
});
