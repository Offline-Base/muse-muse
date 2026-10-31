// @ts-check
// Meta's mock glasses, for the simulator-only build. The module only compiles them where with-mock-glasses-in-release.js
// or a Debug build allows it. Anywhere else these calls throw, and the shell reports it as an error.
//
// The lab copies its media into the app's Documents folder before launch: mock-feed.mov (H.265) and mock-photo.jpg.

import { File, Paths } from "expo-file-system";

export const MOCK_FEED_FILE = "mock-feed.mov";
export const MOCK_PHOTO_FILE = "mock-photo.jpg";

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
