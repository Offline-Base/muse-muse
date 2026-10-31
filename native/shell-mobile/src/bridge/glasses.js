// @ts-check
// window.MuseNative.glasses, mapped onto the wearables module, expo-audio and expo-speech.

import { requireOptionalNativeModule } from "expo";
import { AudioModule, IOSOutputFormat, requestRecordingPermissionsAsync, setAudioModeAsync } from "expo-audio";
import { File } from "expo-file-system";
import * as Speech from "expo-speech";

import { enableMockGlasses, mockRecording } from "../glasses/mock";
import { deviceSummary, initialStatus, problemFromSessionError, problemFromStreamError, problemFromThrown } from "../glasses/status";
import { photoToDataUrl } from "../native/photo";
import { BridgeError } from "./router";

/** @typedef {import("./protocol").GlassesStatus} GlassesStatus */
/** @typedef {import("../glasses/status").GlassesProblem} GlassesProblem */

const CONNECT_LIMIT_MS = 110_000;
const CAPTURE_LIMIT_MS = 18_000;
const CREATE_SESSION_TRIES = 5;
const CREATE_SESSION_WAIT_MS = 1_000;

/** 16 kHz mono 16-bit PCM in a WAV file, which is what the platform's speech-to-text takes. */
const WAV_RECORDING = {
  extension: ".wav",
  sampleRate: 16_000,
  numberOfChannels: 1,
  bitRate: 256_000,
  android: { outputFormat: /** @type {const} */ ("default"), audioEncoder: /** @type {const} */ ("default") },
  ios: {
    outputFormat: IOSOutputFormat.LINEARPCM,
    audioQuality: 127,
    linearPCMBitDepth: 16,
    linearPCMIsBigEndian: false,
    linearPCMIsFloat: false,
  },
  web: {},
};

/**
 * Resolves once `isDone` says yes or `failed` receives a problem, whichever comes first.
 *
 * @template T
 * @param {(finish: (value: T) => void, fail: (error: Error) => void) => (() => void)} start Returns its own cleanup.
 * @param {number} limitMs
 * @param {GlassesProblem} onTimeout
 * @returns {Promise<T>}
 */
function waitFor(start, limitMs, onTimeout) {
  return new Promise((resolve, reject) => {
    let cleanup = () => {};
    let done = false;
    const settle = (/** @type {() => void} */ action) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      cleanup();
      action();
    };
    const timer = setTimeout(() => settle(() => reject(new BridgeError(onTimeout.code, onTimeout.message))), limitMs);
    cleanup = start(
      (value) => settle(() => resolve(value)),
      (error) => settle(() => reject(error)),
    );
    if (done) cleanup();
  });
}

/**
 * Glasses show up as a Bluetooth input once the phone routes audio to them. The native call is synchronous, whatever
 * its type says, and can throw, so a failure here just means the phone's microphone.
 *
 * @param {{ getCurrentInput(): unknown }} recorder
 * @returns {Promise<"glasses" | "phone">}
 */
async function currentInputSource(recorder) {
  try {
    const input = /** @type {{ type?: string; name?: string } | null} */ (await recorder.getCurrentInput());
    return input && /bluetooth/i.test(`${input.type} ${input.name}`) ? "glasses" : "phone";
  } catch {
    return "phone";
  }
}

/** @param {GlassesProblem} problem */
const toError = (problem) => new BridgeError(problem.code, problem.message);

const CONNECT_TIMEOUT = { code: /** @type {const} */ ("timeout"), message: "Your glasses took too long to connect. Please try again." };
const CAPTURE_TIMEOUT = { code: /** @type {const} */ ("timeout"), message: "Your glasses took too long to take the photo." };

/**
 * @param {{
 *   mock: boolean;
 *   emitStatus(status: GlassesStatus): void;
 *   setPreview(show: boolean): void;
 * }} options
 */
export function createGlassesBridge({ mock, emitStatus, setPreview }) {
  /** @type {GlassesStatus} */
  let status = initialStatus(mock ? "mock" : "real");
  /** @type {string | null} */
  let sessionId = null;
  let configured = false;
  /** @type {Array<{ remove(): void }>} */
  const subscriptions = [];
  /** @type {any} */
  let recorder = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let recordingLimit = null;
  let recordingStarted = 0;
  let mockRecordingStarted = 0;
  let recordingSource = /** @type {"glasses" | "phone"} */ ("phone");

  /**
   * Loaded on demand, because importing it crashes a build that doesn't link the module, and the crash can't be caught.
   * So this checks first.
   */
  function wearables() {
    if (!requireOptionalNativeModule("EMWDAT")) {
      setStatus({ state: "unavailable", error: null });
      throw new BridgeError("unsupported", "This app can't reach glasses.");
    }
    return /** @type {typeof import("@chrisgocode/expo-meta-wearables-dat")} */ (require("@chrisgocode/expo-meta-wearables-dat"));
  }

  /** @param {Partial<GlassesStatus>} next */
  function setStatus(next) {
    status = { ...status, ...next };
    emitStatus(status);
    return status;
  }

  /** @param {GlassesProblem} problem */
  function setProblem(problem) {
    setStatus({
      state: problem.code === "meta_ai_missing" ? "needs-meta-ai" : problem.code === "no_eligible_device" ? "no-glasses" : "error",
      error: problem,
    });
  }

  function listen() {
    if (subscriptions.length > 0) return;
    const w = wearables();
    /** @param {ReturnType<typeof w.addListener>} sub */
    const keep = (sub) => {
      if (sub) subscriptions.push(sub);
    };
    keep(
      w.addListener("onDeviceSessionError", ({ error }) => {
        setProblem(problemFromSessionError(error));
      }),
    );
    keep(
      w.addListener("onStreamError", (error) => {
        setProblem(problemFromStreamError(error.type));
      }),
    );
    keep(
      w.addListener("onDeviceSessionStateChange", ({ sessionId: id, state }) => {
        if (id !== sessionId) return;
        if (state === "paused" && status.state === "ready") setStatus({ state: "paused" });
        if (state === "started" && status.state === "paused") setStatus({ state: "ready", error: null });
        if (state === "stopped") {
          sessionId = null;
          if (status.state === "ready" || status.state === "paused") setStatus({ state: "no-glasses" });
        }
      }),
    );
    keep(
      w.addListener("onDevicesChange", ({ devices }) => {
        if (status.device && devices[0]) setStatus({ device: deviceSummary(devices[0]) });
      }),
    );
  }

  async function ensureRegistered() {
    const w = wearables();
    if ((await w.getRegistrationStateAsync()) === "registered") return;
    setStatus({ state: "registering", error: null });
    await waitFor(
      (finish, fail) => {
        const sub = w.addListener("onRegistrationStateChange", ({ state }) => {
          if (state === "registered") finish(undefined);
        });
        // Meta AI opens here, and the answer comes back through the app link.
        w.startRegistration().catch(fail);
        return () => sub?.remove();
      },
      CONNECT_LIMIT_MS,
      CONNECT_TIMEOUT,
    );
  }

  /**
   * The paired device can take a moment to become selectable, so creating the session gets a few tries.
   *
   * @param {string | undefined} deviceId
   */
  async function createSessionWithRetry(deviceId) {
    const w = wearables();
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await w.createSession(deviceId);
      } catch (error) {
        if (attempt >= CREATE_SESSION_TRIES) throw error;
        await new Promise((resolve) => setTimeout(resolve, CREATE_SESSION_WAIT_MS));
      }
    }
  }

  /** @param {string | undefined} deviceId */
  async function startCamera(deviceId) {
    const w = wearables();
    const id = await createSessionWithRetry(deviceId);
    sessionId = id;
    // The camera can only be added to a session that has started.
    await waitFor(
      (finish, fail) => {
        const sub = w.addListener("onDeviceSessionStateChange", ({ sessionId: changed, state }) => {
          if (changed === id && state === "started") finish(undefined);
        });
        const failed = w.addListener("onDeviceSessionError", ({ sessionId: changed, error }) => {
          if (changed === id) fail(toError(problemFromSessionError(error)));
        });
        w.startSession(id).catch(fail);
        return () => {
          sub?.remove();
          failed?.remove();
        };
      },
      CONNECT_LIMIT_MS,
      CONNECT_TIMEOUT,
    );
    await waitFor(
      (finish, fail) => {
        const sub = w.addListener("onStreamStateChange", ({ state }) => {
          if (state === "streaming") finish(undefined);
        });
        const failed = w.addListener("onStreamError", (error) => fail(toError(problemFromStreamError(error.type))));
        w.addCameraToSession(id, { resolution: "medium", frameRate: 15 }).catch(fail);
        return () => {
          sub?.remove();
          failed?.remove();
        };
      },
      CONNECT_LIMIT_MS,
      CONNECT_TIMEOUT,
    );
  }

  /** A stopped session can't restart, and a leftover one blocks the next connect. */
  function endSession() {
    if (!sessionId) return;
    wearables()
      .stopSession(sessionId)
      .catch(() => {});
    sessionId = null;
  }

  async function connect() {
    if (status.state === "ready" && sessionId) return status;
    const w = wearables();
    try {
      if (!configured) {
        await w.configure();
        configured = true;
      }
      listen();
      const mockDeviceId = mock ? await enableMockGlasses(w) : undefined;
      await ensureRegistered();

      setStatus({ state: "connecting", error: null });
      const permission = await w.requestPermission("camera");
      if (permission !== "granted") throw toError(problemFromSessionError("capabilityDenied"));

      await startCamera(mockDeviceId);
      const devices = await w.getDevices();
      return setStatus({ state: "ready", device: deviceSummary(devices[0]), error: null });
    } catch (error) {
      // The module's own wording stays in the device log, for the lab. The page gets the plain message.
      console.warn(`MUSE_GLASSES connect failed: ${error instanceof Error ? error.message : String(error)}`);
      endSession();
      const problem = error instanceof BridgeError ? { code: /** @type {GlassesProblem["code"]} */ (error.code), message: error.message } : problemFromThrown(error);
      setProblem(problem);
      throw toError(problem);
    }
  }

  /** @param {{ maxSize: number }} params */
  async function capturePhoto({ maxSize }) {
    if (status.state !== "ready" || !sessionId) throw new BridgeError("no_eligible_device", "Connect your glasses first.");
    const w = wearables();
    const photo = await waitFor(
      (finish, fail) => {
        const sub = w.addListener("onPhotoCaptured", finish);
        const failed = w.addListener("onStreamError", (error) => {
          if (error.type === "photoCaptureFailed") fail(toError(problemFromStreamError(error.type)));
        });
        w.capturePhoto("jpeg").catch(() => fail(toError(problemFromStreamError("photoCaptureFailed"))));
        return () => {
          sub?.remove();
          failed?.remove();
        };
      },
      CAPTURE_LIMIT_MS,
      CAPTURE_TIMEOUT,
    );
    return photoToDataUrl(photo.filePath.startsWith("file:") ? photo.filePath : `file://${photo.filePath}`, maxSize);
  }

  /** @param {{ show: boolean }} params */
  async function preview({ show }) {
    if (show && status.state !== "ready") throw new BridgeError("no_eligible_device", "Connect your glasses first.");
    setPreview(show);
  }

  async function stopRecorderNow() {
    if (recordingLimit) clearTimeout(recordingLimit);
    recordingLimit = null;
    if (recorder?.isRecording) await recorder.stop();
  }

  /** @param {{ maxSeconds: number }} params */
  async function startRecording({ maxSeconds }) {
    if (mock) {
      mockRecordingStarted = Date.now();
      return;
    }
    if (recorder?.isRecording) throw new BridgeError("busy", "A recording is already running.");
    const permission = await requestRecordingPermissionsAsync();
    if (!permission.granted) throw new BridgeError("denied", "Microphone access is off. You can turn it on in Settings.");
    await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });

    recorder = new AudioModule.AudioRecorder(WAV_RECORDING);
    await recorder.prepareToRecordAsync();
    recordingSource = await currentInputSource(recorder);
    recorder.record();
    recordingStarted = Date.now();
    recordingLimit = setTimeout(() => {
      stopRecorderNow().catch(() => {});
    }, maxSeconds * 1_000);
  }

  async function stopRecording() {
    if (mock) {
      if (!mockRecordingStarted) throw new BridgeError("bad_request", "Nothing is recording.");
      const seconds = (Date.now() - mockRecordingStarted) / 1_000;
      mockRecordingStarted = 0;
      return mockRecording(seconds);
    }
    if (!recorder) throw new BridgeError("bad_request", "Nothing is recording.");
    const seconds = recorder.isRecording ? (Date.now() - recordingStarted) / 1_000 : recorder.currentTime;
    await stopRecorderNow();
    const uri = recorder.uri;
    recorder = null;
    await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });
    if (!uri) throw new BridgeError("failed", "That recording didn't work. Please try again.");
    const file = new File(uri);
    const base64 = await file.base64();
    file.delete();
    return { wavDataUrl: `data:audio/wav;base64,${base64}`, seconds, source: recordingSource };
  }

  /** @param {{ text: string }} params */
  function speak({ text }) {
    return new Promise((resolve, reject) => {
      Speech.speak(text, {
        onDone: () => resolve(null),
        onStopped: () => resolve(null),
        onError: () => reject(new BridgeError("failed", "That couldn't be spoken.")),
      });
    });
  }

  return {
    /** @type {import("./router").BridgeHandlers} */
    handlers: /** @type {any} */ ({
      "glasses.status": () => status,
      "glasses.connect": connect,
      "glasses.capturePhoto": capturePhoto,
      "glasses.preview": preview,
      "glasses.startRecording": startRecording,
      "glasses.stopRecording": stopRecording,
      "glasses.speak": speak,
    }),

    /** Ends the camera, the microphone and speech when the page goes away. */
    dispose() {
      for (const sub of subscriptions.splice(0)) sub.remove();
      stopRecorderNow().catch(() => {});
      Speech.stop().catch(() => {});
      setPreview(false);
      endSession();
    },
  };
}
