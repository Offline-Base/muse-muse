import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { appConfigProblems, appJson, escapeAndroidString, jarSignatureProblems, libraryProblems, manifestProblems, patchManifest, patchStrings, repackSpawn } from "../lib/android.mjs";

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
  // As aapt2 2.19 printed it on the Oct 31 spike.
  const good = `E: meta-data (line=75)\n  A: http://schemas.android.com/apk/res/android:name(0x01010003)="expo.modules.updates.ENABLED" (Raw: "expo.modules.updates.ENABLED")\n  A: http://schemas.android.com/apk/res/android:value(0x01010024)=false\nE: meta-data (line=76)\n  A: http://schemas.android.com/apk/res/android:name(0x01010003)="expo.modules.updates.ENABLE_BSDIFF_PATCH_SUPPORT" (Raw: "x")\n  A: http://schemas.android.com/apk/res/android:value(0x01010024)=true\n`;
  it("passes a right APK", () => assert.deepEqual(manifestProblems(badging, good, product), []));
  it("also reads the quoted and typed forms of false", () => {
    assert.deepEqual(manifestProblems(badging, good.replace("=false", '="false" (Raw: "false")'), product), []);
    assert.deepEqual(manifestProblems(badging, good.replace("=false", "=(type 0x12)0x0"), product), []);
  });
  it("catches updates left on, and the S6 failure of an update URL still there", () => {
    assert.deepEqual(manifestProblems(badging, good.replace("=false", "=true"), product), ["expo.modules.updates.ENABLED isn't false"]);
    assert.deepEqual(manifestProblems(badging, `${good}  A: android:name="expo.modules.updates.EXPO_UPDATE_URL"\n`, product), ["the update URL is still there"]);
    assert.deepEqual(manifestProblems(badging, "", product), ["expo.modules.updates.ENABLED is missing"]);
  });
  it("reads a name with quotes in it, as aapt2 prints it", () => {
    const hard = { ...product, name: `Tom's "A&B" <C>` };
    const printed = `package: name='${product.packageId}'\napplication-label:'Tom's \\"A&B\\" <C>'\n`;
    assert.deepEqual(manifestProblems(printed, good, hard), []);
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

/** A zip with one file whose data starts at `dataAt`, stored or deflated. */
function zipWith(name, dataAt, method = 0) {
  const nameBytes = Buffer.from(name);
  const pad = dataAt - 30 - nameBytes.length;
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(nameBytes.length, 26);
  local.writeUInt16LE(pad, 28);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(method, 10);
  central.writeUInt16LE(nameBytes.length, 28);
  const entries = Buffer.concat([local, nameBytes, Buffer.alloc(pad)]);
  const directory = Buffer.concat([central, nameBytes]);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(entries.length, 16);
  return Buffer.concat([entries, directory, end]);
}

describe("libraryProblems", () => {
  it("passes a stored library on a 16 KB boundary", () => assert.deepEqual(libraryProblems(zipWith("lib/arm64-v8a/a.so", 16384)), []));
  it("catches one that's only on a 4 KB boundary", () => assert.deepEqual(libraryProblems(zipWith("lib/arm64-v8a/a.so", 4096)), ["lib/arm64-v8a/a.so isn't aligned"]));
  it("catches a compressed one", () => assert.deepEqual(libraryProblems(zipWith("lib/arm64-v8a/a.so", 16384, 8)), ["lib/arm64-v8a/a.so is compressed"]));
  it("doesn't care about other files", () => assert.deepEqual(libraryProblems(zipWith("assets/a.bin", 77)), []));
});

describe("jarSignatureProblems", () => {
  for (const name of ["META-INF/ANDROIDD.SF", "META-INF/ANDROIDD.RSA", "META-INF/CERT.DSA", "META-INF/KEY.EC"]) {
    it(`catches ${name}`, () => assert.deepEqual(jarSignatureProblems(zipWith(name, 100)), [`${name} is an old signature`]));
  }
  it("leaves other files in META-INF alone", () => {
    for (const name of ["META-INF/kotlin.kotlin_module", "META-INF/services/x.RSA", "assets/a.SF"]) assert.deepEqual(jarSignatureProblems(zipWith(name, 100)), []);
  });
});

describe("appConfigProblems", () => {
  it("passes the config this product's package is made from", () => {
    assert.deepEqual(appConfigProblems(JSON.stringify(appJson(product).expo), product), []);
  });
  it("catches a missing or wrong URL, or a file that can't be read", () => {
    assert.deepEqual(appConfigProblems('{"extra":{}}', product), ["assets/app.config doesn't have the product's URL"]);
    assert.deepEqual(appConfigProblems('{"extra":{"productUrl":"https://other.example/"}}', product), ["assets/app.config doesn't have the product's URL"]);
    assert.deepEqual(appConfigProblems("not json", product), ["assets/app.config can't be read"]);
    assert.deepEqual(appConfigProblems("", product), ["assets/app.config can't be read"]);
  });
});

describe("repackSpawn", () => {
  it("signs with v2 alone, with the APK still the last argument", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "apksigner-"));
    try {
      const signer = path.join(dir, "apksigner");
      writeFileSync(signer, '#!/bin/sh\necho "$@"\n');
      chmodSync(signer, 0o755);
      const spawn = repackSpawn({ workDir: "/nope", patch: async () => {} });
      const sign = await spawn(signer, ["sign", "--ks", "k.jks", "--ks-pass", "pass:x", "resigned.apk"]);
      assert.equal(sign.stdout.trim(), "sign --ks k.jks --ks-pass pass:x --v1-signing-enabled false --v3-signing-enabled false resigned.apk");
      const verify = await spawn(signer, ["verify", "a.apk"]);
      assert.equal(verify.stdout.trim(), "verify a.apk");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
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
