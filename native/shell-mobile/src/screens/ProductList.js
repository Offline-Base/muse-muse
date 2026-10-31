// @ts-check
// The fallback when the app opens with nothing to show: the live products to choose from.

import { useCallback, useEffect, useState } from "react";
import { FlatList, Pressable, StyleSheet, Text, View } from "react-native";

import { Message } from "./Message";

/** @typedef {import("../resolve").CatalogItem} CatalogItem */

/** @param {{ client: import("../resolve").ResolveClient; notice?: string; onOpen(slug: string): void }} props */
export function ProductList({ client, notice, onOpen }) {
  const [items, setItems] = useState(/** @type {CatalogItem[] | null} */ (null));
  const [failed, setFailed] = useState(false);

  const load = useCallback(() => {
    setFailed(false);
    setItems(null);
    client.catalog().then(setItems, () => setFailed(true));
  }, [client]);

  useEffect(load, [load]);

  if (failed) {
    return (
      <Message
        title="We couldn't load the products"
        body={notice ?? "Check your connection, then try again."}
        action={{ label: "Try again", onPress: load }}
      />
    );
  }
  if (!items) return <Message busy />;

  return (
    <View style={styles.page}>
      <Text accessibilityRole="header" style={styles.heading}>
        Muse Muse
      </Text>
      {notice ? <Text style={styles.notice}>{notice}</Text> : null}
      <FlatList
        data={items}
        keyExtractor={(item) => item.slug}
        ListEmptyComponent={<Text style={styles.empty}>Nothing is live yet.</Text>}
        renderItem={({ item }) => (
          <Pressable accessibilityRole="button" style={styles.row} onPress={() => onOpen(item.slug)}>
            <Text style={styles.name}>{item.name}</Text>
            {item.tagline ? <Text style={styles.tagline}>{item.tagline}</Text> : null}
          </Pressable>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: "#fff", paddingHorizontal: 16 },
  heading: { fontSize: 28, fontWeight: "700", color: "#1c2b33", paddingVertical: 16 },
  notice: { fontSize: 15, color: "#465a69", paddingBottom: 12 },
  empty: { fontSize: 16, color: "#465a69", paddingVertical: 24, textAlign: "center" },
  row: { minHeight: 44, paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: "#dee3e9" },
  name: { fontSize: 17, fontWeight: "600", color: "#1c2b33" },
  tagline: { fontSize: 15, color: "#465a69", marginTop: 2 },
});
