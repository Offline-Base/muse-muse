// @ts-check
// One product in a WebView, with window.MuseNative wired up and navigation pinned to the product's origin.

import * as Crypto from "expo-crypto";
import { File, Paths } from "expo-file-system";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BackHandler, Linking, Platform, StyleSheet, View } from "react-native";
import { WebView as NativeWebView } from "react-native-webview";

import { createGlassesBridge } from "../bridge/glasses";
import { buildDelivery, buildShim } from "../bridge/inject";
import { MUSE_NATIVE_VERSION } from "../bridge/protocol";
import { createRouter } from "../bridge/router";
import { AUTOPILOT_LOG, buildAutopilotScript, cleanCheckpoint } from "../glasses/autopilot";
import { GlassesPreview } from "../glasses/Preview";
import { deviceHandlers } from "../native/device";
import { decideNavigation } from "../navigation";
import { buildSelftestScript, cleanPageObservations, finishReport, postSelftestReport } from "../selftest";
import { currentPlatform, readSettings } from "../settings";
import { Message } from "./Message";

// Its published prop types reduce to never (the platform prop sets conflict), so they can't check anything here.
const WebView = /** @type {import("react").ComponentType<any>} */ (/** @type {unknown} */ (NativeWebView));

/** How long a selftest waits for the page before it reports what it has. */
const SELFTEST_WATCHDOG_MS = 60_000;

/** @param {string} url */
function openExternally(url) {
  Linking.openURL(url).catch(() => {});
}

/**
 * @param {{
 *   url: string;
 *   selftest?: { token: string | null; platformUrl: string | null } | null;
 *   glasses?: { mock: boolean; autopilot: boolean } | null;
 * }} props
 */
export function ProductScreen({ url, selftest, glasses }) {
  const settings = useMemo(readSettings, []);
  const origin = useMemo(() => new URL(url).origin, [url]);
  const webView = useRef(/** @type {{ injectJavaScript(script: string): void; goBack(): void; reload(): void } | null} */ (null));
  const currentUrl = useRef(/** @type {string | null} */ (url));
  const canGoBack = useRef(false);
  const [previewing, setPreviewing] = useState(false);
  const [failure, setFailure] = useState(/** @type {string | null} */ (null));
  const [attempt, setAttempt] = useState(0);

  // What the WebView's own events saw, for the selftest. See selftest.ts on why these outweigh what the page says.
  const seen = useRef({
    startedAt: Date.now(),
    loadMs: /** @type {number | null} */ (null),
    httpStatus: /** @type {number | null} */ (null),
    crashed: false,
    loadError: /** @type {string | null} */ (null),
    reported: false,
  });

  const platform = currentPlatform();
  const capabilities = useMemo(
    () => ({
      haptics: true,
      share: true,
      camera: true,
      notifications: true,
      glasses: settings.glasses,
      frames: settings.glasses,
    }),
    [settings.glasses],
  );

  /** Sends the final health report once. */
  const report = useCallback(
    (/** @type {unknown} */ rawPage) => {
      if (!selftest || seen.current.reported) return;
      seen.current.reported = true;
      const result = finishReport(
        {
          variant: settings.variant,
          shellVersion: settings.shellVersion,
          platform,
          capabilities,
          url,
          finalUrl: currentUrl.current,
          productOrigin: origin,
          httpStatus: seen.current.httpStatus,
          loadMs: seen.current.loadMs,
          crashed: seen.current.crashed,
          loadError: seen.current.loadError,
        },
        cleanPageObservations(rawPage),
        new Date(),
      );
      // The lab reads this line from the device log, so a lost network post isn't fatal.
      console.log(`MUSE_SELFTEST ${JSON.stringify(result)}`);
      postSelftestReport({
        platformUrl: selftest.platformUrl ?? settings.platformUrl,
        token: selftest.token,
        report: result,
      }).catch(() => {});
    },
    [capabilities, origin, platform, selftest, settings, url],
  );

  const nonce = useMemo(() => Crypto.randomUUID(), []);
  const bridge = useMemo(() => {
    const glassesBridge = settings.glasses
      ? createGlassesBridge({
          mock: Boolean(glasses?.mock),
          setPreview: setPreviewing,
          emitStatus: (data) =>
            webView.current?.injectJavaScript(buildDelivery({ v: MUSE_NATIVE_VERSION, event: "glasses.status", data })),
        })
      : null;

    const router = createRouter({
      nonce,
      isAllowedOrigin: (candidate) => candidate === origin,
      currentUrl: () => currentUrl.current,
      send: (reply) => webView.current?.injectJavaScript(buildDelivery(reply)),
      handlers: {
        ...deviceHandlers({ version: MUSE_NATIVE_VERSION, platform, capabilities }),
        ...(glassesBridge?.handlers ?? {}),
        ...(selftest
          ? {
              "selftest.report": /** @type {import("../bridge/router").BridgeHandler} */ ((page) => report(page)),
            }
          : {}),
        ...(glasses?.autopilot
          ? {
              "autopilot.checkpoint": /** @type {import("../bridge/router").BridgeHandler} */ (
                (raw) => {
                  const entry = cleanCheckpoint(raw, new Date());
                  if (!entry) return;
                  console.log(`MUSE_AUTOPILOT ${JSON.stringify(entry)}`);
                  const log = new File(Paths.document, AUTOPILOT_LOG);
                  if (!log.exists) log.create();
                  log.write(`${JSON.stringify(entry)}\n`, { append: true });
                }
              ),
            }
          : {}),
      },
    });
    return { router, glassesBridge };
  }, [capabilities, glasses, nonce, origin, platform, report, selftest, settings.glasses]);

  useEffect(
    () => () => {
      bridge.router.dispose();
      bridge.glassesBridge?.dispose();
    },
    [bridge],
  );

  // A page that never reports still has to end the selftest.
  useEffect(() => {
    if (!selftest) return undefined;
    const timer = setTimeout(() => report({}), SELFTEST_WATCHDOG_MS);
    return () => clearTimeout(timer);
  }, [report, selftest]);

  useEffect(() => {
    if (Platform.OS !== "android") return undefined;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      if (!canGoBack.current) return false;
      webView.current?.goBack();
      return true;
    });
    return () => sub.remove();
  }, []);

  const shim = useMemo(
    () =>
      buildShim({
        platform,
        capabilities,
        nonce,
        origin,
        selftest: Boolean(selftest),
        autopilot: Boolean(glasses?.autopilot),
      }),
    [capabilities, glasses?.autopilot, nonce, origin, platform, selftest],
  );

  if (failure && !selftest) {
    return (
      <Message
        title="This didn't open"
        body={failure}
        action={{
          label: "Try again",
          onPress: () => {
            setFailure(null);
            setAttempt((n) => n + 1);
          },
        }}
      />
    );
  }

  return (
    <View style={styles.page}>
      <GlassesPreview visible={previewing} />
      <WebView
        key={attempt}
        ref={webView}
        style={styles.web}
        source={{ uri: url }}
        // Every URL has to reach onShouldStartLoadWithRequest, which makes the real decision.
        originWhitelist={["*"]}
        javaScriptEnabled
        domStorageEnabled
        allowsInlineMediaPlayback
        allowsBackForwardNavigationGestures
        mediaPlaybackRequiresUserAction
        mediaCapturePermissionGrantType="grantIfSameHostElsePrompt"
        allowFileAccess={false}
        allowFileAccessFromFileURLs={false}
        allowUniversalAccessFromFileURLs={false}
        mixedContentMode="never"
        setSupportMultipleWindows
        injectedJavaScriptBeforeContentLoaded={shim}
        injectedJavaScriptBeforeContentLoadedForMainFrameOnly
        onMessage={(/** @type {{ nativeEvent: any }} */ { nativeEvent }) => {
          bridge.router.receive(nativeEvent.data, nativeEvent.url).catch(() => {});
        }}
        onShouldStartLoadWithRequest={(/** @type {{ url: string; isTopFrame?: boolean }} */ request) => {
          const decision = decideNavigation({ url: request.url, productOrigin: origin, isTopFrame: request.isTopFrame });
          if (decision === "external") openExternally(request.url);
          return decision === "allow";
        }}
        onOpenWindow={(/** @type {{ nativeEvent: any }} */ { nativeEvent }) => {
          const decision = decideNavigation({ url: nativeEvent.targetUrl, productOrigin: "" });
          if (decision === "external") openExternally(nativeEvent.targetUrl);
        }}
        onNavigationStateChange={(/** @type {{ url: string; canGoBack: boolean }} */ state) => {
          currentUrl.current = state.url;
          canGoBack.current = state.canGoBack;
        }}
        onLoadStart={(/** @type {{ nativeEvent: any }} */ { nativeEvent }) => {
          currentUrl.current = nativeEvent.url;
        }}
        onLoadEnd={(/** @type {{ nativeEvent: any }} */ { nativeEvent }) => {
          if (seen.current.loadMs === null) seen.current.loadMs = Date.now() - seen.current.startedAt;
          currentUrl.current = nativeEvent.url;
          if (selftest) webView.current?.injectJavaScript(buildSelftestScript());
          if (glasses?.autopilot) webView.current?.injectJavaScript(buildAutopilotScript());
        }}
        onHttpError={(/** @type {{ nativeEvent: any }} */ { nativeEvent }) => {
          if (nativeEvent.url === currentUrl.current || nativeEvent.url === url) {
            seen.current.httpStatus = nativeEvent.statusCode;
          }
        }}
        onError={(/** @type {{ nativeEvent: any }} */ { nativeEvent }) => {
          seen.current.loadError = nativeEvent.description || "The page failed to load.";
          if (selftest) report({});
          else setFailure("Check your connection, then try again.");
        }}
        onContentProcessDidTerminate={() => {
          seen.current.crashed = true;
          if (selftest) report({});
          else webView.current?.reload();
        }}
        onRenderProcessGone={() => {
          seen.current.crashed = true;
          if (selftest) report({});
          else setAttempt((n) => n + 1);
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: "#fff" },
  web: { flex: 1, backgroundColor: "#fff" },
});
