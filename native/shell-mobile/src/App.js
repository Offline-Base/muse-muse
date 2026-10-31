// @ts-check
// Decides what to open, then shows it. Each product gets its own WebView, so a new link never inherits the old page.

import { StatusBar } from "expo-status-bar";
import { useEffect, useMemo, useState } from "react";
import { Linking, StyleSheet } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";

import { chooseLaunchTarget, parseDeepLink, targetForRunningApp } from "./launch";
import { createResolveClient, createStubResolveClient, ResolveError } from "./resolve";
import { Message } from "./screens/Message";
import { ProductList } from "./screens/ProductList";
import { ProductScreen } from "./screens/ProductScreen";
import { readLaunchArgs, readSettings } from "./settings";

/** @typedef {import("./launch").LaunchTarget} LaunchTarget */

/** Opens a product by slug, once the platform vouches for its URL. @param {{ slug: string; client: import("./resolve").ResolveClient; onFail(notice: string): void }} props */
function SlugScreen({ slug, client, onFail }) {
  const [resolved, setResolved] = useState(/** @type {import("./resolve").ResolvedProduct | null} */ (null));

  useEffect(() => {
    let live = true;
    setResolved(null);
    client.resolve(slug).then(
      (product) => {
        if (live) setResolved(product);
      },
      (error) => {
        if (live) onFail(error instanceof ResolveError ? error.message : "We couldn't open that product.");
      },
    );
    return () => {
      live = false;
    };
  }, [client, onFail, slug]);

  if (!resolved) return <Message busy />;
  return <ProductScreen key={resolved.url} url={resolved.url} />;
}

export default function App() {
  const settings = useMemo(readSettings, []);
  const env = useMemo(
    () => ({ variant: settings.variant, glasses: settings.glasses, productUrl: settings.productUrl }),
    [settings],
  );
  const client = useMemo(
    () => (settings.resolveStub ? createStubResolveClient() : createResolveClient({ platformUrl: settings.platformUrl })),
    [settings],
  );
  const [target, setTarget] = useState(/** @type {LaunchTarget | null} */ (null));

  useEffect(() => {
    let live = true;
    const launchArgs = readLaunchArgs();
    Linking.getInitialURL()
      .catch(() => null)
      .then((initial) => {
        if (live) setTarget(chooseLaunchTarget(env, { launchArgs, deepLink: parseDeepLink(initial) }));
      });
    const sub = Linking.addEventListener("url", ({ url }) => {
      const next = targetForRunningApp(env, url);
      if (next) setTarget(next);
    });
    return () => {
      live = false;
      sub.remove();
    };
  }, [env]);

  const showList = useMemo(() => (/** @type {string} */ notice) => setTarget({ kind: "list", notice }), []);

  return (
    <SafeAreaProvider>
      <StatusBar style="auto" />
      <SafeAreaView style={styles.safe}>
        {!target ? <Message busy /> : null}
        {target?.kind === "list" ? (
          <ProductList client={client} notice={target.notice} onOpen={(slug) => setTarget({ kind: "slug", slug })} />
        ) : null}
        {target?.kind === "slug" ? (
          <SlugScreen key={target.slug} slug={target.slug} client={client} onFail={showList} />
        ) : null}
        {target?.kind === "url" ? (
          <ProductScreen key={target.url} url={target.url} selftest={target.selftest} glasses={target.glasses} />
        ) : null}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#fff" },
});
