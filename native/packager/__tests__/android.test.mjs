import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { appJson, escapeAndroidString, manifestProblems, patchManifest, patchStrings, repackSpawn } from "../lib/android.mjs";

const product = { name: "Fern & Moss", url: "https://fern.vercel.app/", packageId: "ai.musemuse.p0123456789abcdef", version: "1.0.0" };

const MANIFEST = `<manifest package="${product.packageId}">
  <application android:name="${product.packageId}.MainApplication">
    <meta-data android:name="expo.modules.updates.ENABLED" android:value="true"/>
    <meta-data android:name="expo.modules.updates.EXPO_UPDATE_URL" android:value="https://u.expo.dev/x"/>
    <meta-data android:name="expo.modules.updates.UPDATES_CONFIGURATION_REQUEST_HEADERS_KEY" android:value="{}"/>
    <meta-data android:name="expo.modules.updates.EXPO_RUNTIME_VERSION" android:value="exposdk:58.0.0"/>
    <activity android:name=".MainActivity">
      <intent-filter><action android:name="android.intent.action.MAIN"/><category android:name="android.intent.category.LAUNCHER"/></intent-filter>
      <intent-filter><action android:name="android.intent.action.VIEW"/><data android:scheme="musemuse"/></intent-filter>
      <intent-filter><action android:name="android.intent.action.VIEW"/><data android:scheme="exp+muse-hackathon"/></intent-filter>
    </activity>
  </application>
</manifest>`;

describe("the product's config", () => {
  it("turns updates off and names the one site it opens", () => {
    const { expo } = appJson(product);
    assert.equal(expo.updates.enabled, false);
    assert.equal(expo.extra.productUrl, product.url);
    assert.equal(expo.extra.variant, "production");
    assert.equal(expo.android.package, product.packageId);
  });
  it("gives repack-app a name it can't choke on", () => {
    assert.doesNotMatch(appJson(product).expo.name, /[&<>'"\\]/);
  });
});

describe("patchManifest", () => {
  const out = patchManifest(MANIFEST);
  it("forces updates off", () => {
    assert.match(out, /expo\.modules\.updates\.ENABLED" android:value="false"/);
    assert.doesNotMatch(out, /ENABLED" android:value="true"/);
  });
  it("adds the setting when the manifest doesn't have it", () => {
    const without = MANIFEST.replace(/\s*<meta-data[^>]*ENABLED[^>]*\/>/, "");
    assert.match(patchManifest(without), /<application[^>]*>\s*<meta-data android:name="expo\.modules\.updates\.ENABLED" android:value="false"\/>/);
  });
  it("removes where updates would come from", () => {
    assert.doesNotMatch(out, /EXPO_UPDATE_URL|REQUEST_HEADERS_KEY/);
  });
  it("gives up the generic shell's links, and keeps the launcher", () => {
    assert.doesNotMatch(out, /android:scheme/);
    assert.match(out, /intent\.category\.LAUNCHER/);
  });
});

describe("the app's name", () => {
  it("escapes what Android resources treat specially", () => {
    assert.equal(escapeAndroidString(`Tom's "A&B" <c> \\`), `Tom\\'s \\"A&amp;B\\" &lt;c&gt; \\\\`);
    assert.equal(escapeAndroidString("@home"), "\\@home");
    assert.equal(escapeAndroidString("?why"), "\\?why");
  });
  it("replaces app_name, and takes a name with a replacement pattern as it is", () => {
    const xml = '<resources><string name="app_name">x</string><string name="other">y</string></resources>';
    assert.equal(patchStrings(xml, "$& Moss"), '<resources><string name="app_name">$&amp; Moss</string><string name="other">y</string></resources>');
  });
  it("throws when there's no app_name to replace", () => {
    assert.throws(() => patchStrings("<resources/>", "x"), /app_name/);
  });
});

describe("manifestProblems", () => {
  const badging = `package: name='${product.packageId}' versionCode='1'\napplication-label:'Fern & Moss'\n`;
  const good = `E: meta-data (line=1)\n  A: android:name(0x01010003)="expo.modules.updates.ENABLED" (Raw: "x")\n  A: android:value(0x01010024)="false" (Raw: "false")\n`;
  it("passes a right APK", () => assert.deepEqual(manifestProblems(badging, good, product), []));
  it("catches updates left on, and the S6 failure of an update URL still there", () => {
    assert.deepEqual(manifestProblems(badging, good.replaceAll('"false"', '"true"'), product), ["expo.modules.updates.ENABLED isn't false"]);
    assert.deepEqual(manifestProblems(badging, `${good}  A: android:name="expo.modules.updates.EXPO_UPDATE_URL"\n`, product), ["the update URL is still there"]);
    assert.deepEqual(manifestProblems(badging, "", product), ["expo.modules.updates.ENABLED is missing"]);
  });
  it("catches the wrong package or name", () => {
    assert.deepEqual(manifestProblems(`package: name='ai.musemuse.app'\napplication-label:'Fern & Moss'\n`, good, product), ["wrong package"]);
    assert.deepEqual(manifestProblems(`package: name='${product.packageId}'\napplication-label:'Muse'\n`, good, product), ["wrong name"]);
    assert.deepEqual(manifestProblems(`package: name='${product.packageId}'\n`, good, product), ["no label"]);
  });
  it("catches a provider still under the shell's id, which would stop a second app installing", () => {
    const tree = `${good}  A: android:authorities(0x01010018)="ai.musemuse.app.fileprovider" (Raw: "x")\n`;
    assert.deepEqual(manifestProblems(badging, tree, product), ["a provider still has the shell's id"]);
  });
});

describe("repackSpawn", () => {
  it("answers repack-app's entry file question without running expo", async () => {
    const spawn = repackSpawn({ workDir: "/nope", patch: async () => {} });
    assert.equal((await spawn("node", ["-e", "x"])).stdout, "index.js\n");
  });
  it("runs our edits before the rebuild and passes other tools through", async () => {
    let patched = 0;
    const spawn = repackSpawn({ workDir: "/nope", patch: async () => void patched++ });
    await assert.rejects(spawn("java", ["-jar", "apktool.jar", "build"]));
    assert.equal(patched, 1);
    assert.match((await spawn("echo", ["hi"])).stdout, /hi/);
    await assert.rejects(spawn("false", []));
    assert.equal(patched, 1);
  });
});
