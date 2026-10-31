// @ts-check
// The bridge methods every shell has: haptics, share, photo and notifications.

import * as Haptics from "expo-haptics";
import * as ImagePicker from "expo-image-picker";
import * as Notifications from "expo-notifications";
import { Share } from "react-native";

import { BridgeError } from "../bridge/router";
import { photoToDataUrl } from "./photo";

const { ImpactFeedbackStyle, NotificationFeedbackType } = Haptics;

/** @type {Record<string, () => Promise<void>>} */
const HAPTICS = {
  light: () => Haptics.impactAsync(ImpactFeedbackStyle.Light),
  medium: () => Haptics.impactAsync(ImpactFeedbackStyle.Medium),
  heavy: () => Haptics.impactAsync(ImpactFeedbackStyle.Heavy),
  selection: () => Haptics.selectionAsync(),
  success: () => Haptics.notificationAsync(NotificationFeedbackType.Success),
  warning: () => Haptics.notificationAsync(NotificationFeedbackType.Warning),
  error: () => Haptics.notificationAsync(NotificationFeedbackType.Error),
};

// A product's notification should show even while the product is on screen.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldPlaySound: false,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

/** @param {{ kind: string }} params */
async function haptic({ kind }) {
  await HAPTICS[kind]();
}

/** @param {{ title?: string; text?: string; url?: string }} params */
async function share({ title, text, url }) {
  // iOS shares `url` on its own, and Android only reads `message`, so Android gets the link inside the text.
  const message = [text, url].filter(Boolean).join("\n") || title || "";
  const content = url ? { title, message, url } : { title, message };
  const result = await Share.share(content);
  return { shared: result.action === Share.sharedAction };
}

/** @param {{ source: "camera" | "library"; maxSize: number }} params */
async function takePhoto({ source, maxSize }) {
  const permission =
    source === "camera"
      ? await ImagePicker.requestCameraPermissionsAsync()
      : await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted) throw new BridgeError("denied", "Photo access is off. You can turn it on in Settings.");

  const options = { mediaTypes: /** @type {ImagePicker.MediaType[]} */ (["images"]), quality: 1, exif: false };
  const picked =
    source === "camera"
      ? await ImagePicker.launchCameraAsync(options)
      : await ImagePicker.launchImageLibraryAsync(options);
  if (picked.canceled || !picked.assets?.[0]) throw new BridgeError("canceled", "No photo was chosen.");
  const asset = picked.assets[0];
  return photoToDataUrl(asset.uri, maxSize, { width: asset.width, height: asset.height });
}

/** @param {{ title: string; body?: string; delaySeconds: number }} params */
async function notify({ title, body, delaySeconds }) {
  const permission = await Notifications.requestPermissionsAsync();
  if (!permission.granted) throw new BridgeError("denied", "Notifications are off. You can turn them on in Settings.");
  await Notifications.scheduleNotificationAsync({
    content: { title, body: body ?? "" },
    trigger:
      delaySeconds > 0
        ? { type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL, seconds: delaySeconds, repeats: false }
        : null,
  });
}

/**
 * @param {import("../bridge/protocol").HelloResult} hello
 * @returns {import("../bridge/router").BridgeHandlers}
 */
export function deviceHandlers(hello) {
  return {
    hello: () => hello,
    haptic: /** @type {import("../bridge/router").BridgeHandler} */ (haptic),
    share: /** @type {import("../bridge/router").BridgeHandler} */ (share),
    takePhoto: /** @type {import("../bridge/router").BridgeHandler} */ (takePhoto),
    notify: /** @type {import("../bridge/router").BridgeHandler} */ (notify),
  };
}
