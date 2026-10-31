// @ts-check
// The live view from the glasses, drawn by the shell in a strip above the page. Pixels never reach the page.

import { StyleSheet, View } from "react-native";

/**
 * Loaded on demand, because importing the wearables module crashes a build that doesn't link it.
 *
 * @param {{ visible: boolean }} props
 */
export function GlassesPreview({ visible }) {
  if (!visible) return null;
  const { EMWDATStreamView } = require("@chrisgocode/expo-meta-wearables-dat");
  return (
    <View style={styles.strip} testID="glasses-preview">
      <EMWDATStreamView isActive resizeMode="contain" style={styles.video} />
    </View>
  );
}

const styles = StyleSheet.create({
  strip: { height: 180, backgroundColor: "#000" },
  video: { flex: 1 },
});
