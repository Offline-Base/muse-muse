// @ts-check
// Meta's mock glasses, for the simulator-only build. The module only compiles them where with-mock-glasses-in-release.js
// or a Debug build allows it. Anywhere else these calls throw, and the shell reports it as an error.
//
// The lab copies its media into the app's Documents folder before launch: mock-feed.mov (H.265), mock-photo.jpg and
// mock-question.wav (16 kHz mono).

import { File, Paths } from "expo-file-system";

import { silentWavBase64 } from "./wav";

export const MOCK_FEED_FILE = "mock-feed.mov";
export const MOCK_PHOTO_FILE = "mock-photo.jpg";
export const MOCK_QUESTION_FILE = "mock-question.wav";

/** @param {string} name */
function documentFile(name) {
  const file = new File(Paths.document, name);
  return file.exists ? file.uri : null;
}

/**
 * Pairs a pair of mock Ray-Ban Meta glasses, switched on, open and worn.
 *
 * @param {typeof import("@chrisgocode/expo-meta-wearables-dat")} wearables
 * @returns {Promise<string>} The mock device's id.
 */
export async function enableMockGlasses(wearables) {
  await wearables.enableMockDeviceKit({ initiallyRegistered: true, initialPermissionsGranted: true });
  const existing = await wearables.getMockDevices();
  const id = existing[0] ?? (await wearables.pairMockDevice("rayBanMeta"));
  await wearables.mockDevicePowerOn(id);
  await wearables.mockDeviceUnfold(id);
  await wearables.mockDeviceDon(id);

  const feed = documentFile(MOCK_FEED_FILE);
  if (feed) await wearables.mockDeviceSetCameraFeed(id, feed);
  const photo = documentFile(MOCK_PHOTO_FILE);
  if (photo) await wearables.mockDeviceSetCapturedImage(id, photo);
  return id;
}

/**
 * What mock glasses "heard". A simulator has no dependable microphone: preparing the recorder there can hang, and that
 * stalls every Expo module's async calls behind it. So mock mode never touches the microphone.
 *
 * @param {number} seconds How long the recording ran, for the silence used when the lab supplied no question.
 */
export async function mockRecording(seconds) {
  const question = new File(Paths.document, MOCK_QUESTION_FILE);
  if (!question.exists) {
    return { wavDataUrl: `data:audio/wav;base64,${silentWavBase64(seconds)}`, seconds, source: /** @type {const} */ ("phone") };
  }
  // What the wearer "says" to the mock glasses: 44 header bytes, then 32,000 bytes a second. The file stays for the next question.
  const length = Math.max(0, ((question.size ?? 44) - 44) / 32_000);
  return { wavDataUrl: `data:audio/wav;base64,${await question.base64()}`, seconds: length, source: /** @type {const} */ ("glasses") };
}
