// @ts-check
// The one plain screen for waiting and for things that went wrong.

import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";

/** @param {{ title?: string; body?: string; busy?: boolean; action?: { label: string; onPress(): void } | null }} props */
export function Message({ title, body, busy, action }) {
  return (
    <View style={styles.box}>
      {busy ? <ActivityIndicator size="large" color="#0064e0" /> : null}
      {title ? <Text style={styles.title}>{title}</Text> : null}
      {body ? <Text style={styles.body}>{body}</Text> : null}
      {action ? (
        <Pressable accessibilityRole="button" style={styles.button} onPress={action.onPress}>
          <Text style={styles.buttonText}>{action.label}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12, padding: 24, backgroundColor: "#fff" },
  title: { fontSize: 20, fontWeight: "600", color: "#1c2b33", textAlign: "center" },
  body: { fontSize: 16, lineHeight: 22, color: "#465a69", textAlign: "center" },
  button: { minHeight: 44, justifyContent: "center", paddingHorizontal: 24, borderRadius: 22, backgroundColor: "#0064e0" },
  buttonText: { fontSize: 16, fontWeight: "600", color: "#fff" },
});
