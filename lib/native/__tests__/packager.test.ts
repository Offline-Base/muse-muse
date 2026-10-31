import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { apkSigner, readApkKey, type ApkKey } from "@/lib/native/apk-sign";
import {
  checkShellPathname,
  collectPackages,
  fetchProductIcon,
  isExpectedUpload,
  PACKAGE_MAX_BYTES,
  packageIdFor,
  packagePathname,
  packagerJob,
  packagerNetworkPolicy,
  parsePackageResult,
  type CollectDeps,
  type PackagingHandle,
} from "@/lib/native/packager";

const req = { runId: "11111111-1111-4111-8111-111111111111", productId: "22222222-2222-4222-8222-222222222222", slug: "fern-moss" };
const BLOB = "https://abc.public.blob.vercel-storage.com";

describe("paths", () => {
  it("names each package as docs/NATIVE.md says", () => {
    assert.equal(packagePathname(req, "android"), `native/products/${req.productId}/${req.runId}/fern-moss.apk`);
    assert.equal(packagePathname(req, "mac"), `native/products/${req.productId}/${req.runId}/fern-moss-mac.zip`);
    assert.equal(packagePathname(req, "windows"), `native/products/${req.productId}/${req.runId}/fern-moss-windows.zip`);
  });
  it("keeps a slug in its folder", () => {
    assert.equal(path.posix.basename(packagePathname({ ...req, slug: "../../x y" }, "android")), "x-y.apk");
    assert.equal(path.posix.basename(packagePathname({ ...req, slug: "///" }, "android")), "app.apk");
  });
  it("gives a product one stable package id the job accepts", () => {
    const id = packageIdFor(req.productId);
    assert.match(id, /^ai\.musemuse\.p[0-9a-f]{16}$/);
    assert.equal(id, packageIdFor(req.productId));
    assert.notEqual(id, packageIdFor(req.runId));
  });
  it("takes a shell upload only at a release's three file names", () => {
    assert.equal(checkShellPathname("native/shells/1.0.0/mac.zip"), null);
    assert.equal(checkShellPathname("native/shells/1.0.0/android.apk"), null);
    for (const bad of ["native/shells/1.0.0/evil.zip", "native/shells/../x/mac.zip", "native/products/a/mac.zip", "native/shells/1.0.0/sub/mac.zip", 7]) {
      assert.ok(checkShellPathname(bad), String(bad));
    }
  });
  it("leaves room in each slot for the real sizes", () => {
    assert.ok(PACKAGE_MAX_BYTES.mac > 216_576_892);
    assert.ok(PACKAGE_MAX_BYTES.windows > 158_265_713);
    assert.ok(PACKAGE_MAX_BYTES.android > 74_096_124);
  });
});

describe("the sandbox's inputs", () => {
  it("allows only Blob's hosts through the firewall", () => {
    assert.deepEqual(packagerNetworkPolicy(), { allow: ["vercel.com", "*.blob.vercel-storage.com"] });
  });
  it("writes a job with no secret and an unchanged name", () => {
    const release = { shellVersion: "1.0.0", templates: { mac: { pathname: "p", url: null, bytes: 1, sha256: "a".repeat(64) } } };
    const job = packagerJob({ ...req, name: 'Fern "$(rm -rf)" & Moss', url: "https://fern.vercel.app/", kinds: ["mac"] }, release, { mac: { name: "mac" } }, false);
    assert.equal(job.product.name, 'Fern "$(rm -rf)" & Moss');
    assert.equal(job.iconPath, null);
    assert.equal(job.shellVersion, "1.0.0");
    assert.deepEqual(Object.keys(job).sort(), ["iconPath", "outputs", "product", "shellVersion", "templates", "v"]);
  });
});

describe("fetchProductIcon", () => {
  const answering = (body: BodyInit | null, type: string, status = 200) => (async () => new Response(body, { status, headers: { "content-type": type } })) as unknown as typeof fetch;
  it("asks for the product's own 512 icon, with no redirects", async () => {
    let asked: { url: string; redirect?: string } | null = null;
    const icon = await fetchProductIcon("https://fern.vercel.app/some/page", (async (url: URL, init: RequestInit) => {
      asked = { url: String(url), redirect: init.redirect };
      return new Response("png", { headers: { "content-type": "image/png" } });
    }) as unknown as typeof fetch);
    assert.equal(icon?.toString(), "png");
    assert.deepEqual(asked, { url: "https://fern.vercel.app/icon/512", redirect: "error" });
  });
  it("says null for a page, an error, an SVG or anything that throws", async () => {
    assert.equal(await fetchProductIcon("https://a.b/", answering("<html>", "text/html")), null);
    assert.equal(await fetchProductIcon("https://a.b/", answering("x", "image/png", 404)), null);
    assert.equal(await fetchProductIcon("https://a.b/", answering("<svg/>", "image/svg+xml")), null);
    assert.equal(await fetchProductIcon("https://a.b/", (async () => { throw new Error("no"); }) as unknown as typeof fetch), null);
  });
});

describe("parsePackageResult", () => {
  it("reads the last line", () => {
    assert.deepEqual(parsePackageResult('noise\n{"v":1,"packages":{"mac":{"ok":true}}}\n'), { v: 1, packages: { mac: { ok: true } } });
  });
  it("says null for anything else", () => {
    for (const text of ["", "not json", '{"v":2,"packages":{}}', '{"v":1}']) assert.equal(parsePackageResult(text), null, text);
  });
});

describe("isExpectedUpload", () => {
  const slot = { kind: "mac" as const, pathname: "native/products/a/b/c.zip", uploadPathname: "native/products/a/b/c.zip" };
  it("takes the slot's own path on Blob", () => assert.ok(isExpectedUpload(`${BLOB}/native/products/a/b/c.zip`, slot.uploadPathname, slot)));
  it("refuses another host, another path or plain http", () => {
    assert.ok(!isExpectedUpload("https://evil.example/native/products/a/b/c.zip", slot.uploadPathname, slot));
    assert.ok(!isExpectedUpload(`${BLOB}/native/products/a/b/other.zip`, slot.uploadPathname, slot));
    assert.ok(!isExpectedUpload(`${BLOB}/native/products/a/b/c.zip`, "native/other.zip", slot));
    assert.ok(!isExpectedUpload(`http://abc.blob.vercel-storage.com/native/products/a/b/c.zip`, slot.uploadPathname, slot));
  });
});

describe("collectPackages", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "collect-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync("openssl", ["req", "-x509", "-nodes", "-newkey", "rsa:2048", "-keyout", `${dir}/k`, "-out", `${dir}/c`, "-days", "2", "-subj", "/CN=t"], { stdio: "ignore" });
  const key: ApkKey = readApkKey(readFileSync(`${dir}/k`, "utf8") + readFileSync(`${dir}/c`, "utf8"));

  /** The smallest valid zip: an end record alone. Enough for a signature. */
  const emptyZip = () => {
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    return end;
  };

  const android = { kind: "android" as const, pathname: "native/products/a/b/c.apk", uploadPathname: "native/products/a/b/unsigned/c.apk" };
  const mac = { kind: "mac" as const, pathname: "native/products/a/b/c-mac.zip", uploadPathname: "native/products/a/b/c-mac.zip" };
  const handle = (slots: PackagingHandle["slots"], skipped: PackagingHandle["skipped"] = {}): PackagingHandle => ({
    sandboxName: "s",
    runId: "b",
    shellVersion: "1.0.0",
    startedAt: 0,
    slots,
    skipped,
  });

  function fakes(overrides: Partial<CollectDeps> = {}) {
    const puts: Array<{ pathname: string; bytes: Buffer }> = [];
    const removed: string[] = [];
    const deps: CollectDeps = {
      fetchBytes: async () => emptyZip(),
      readKept: async () => null,
      put: async (pathname, bytes) => {
        puts.push({ pathname, bytes });
        return `${BLOB}/${pathname}`;
      },
      remove: async (url) => void removed.push(url),
      apkKey: () => key,
      ...overrides,
    };
    return { deps, puts, removed };
  }

  it("signs the APK with the platform's key, moves it to its real path and removes the stop on the way", async () => {
    const { deps, puts, removed } = fakes();
    const url = `${BLOB}/${android.uploadPathname}`;
    const out = await collectPackages(handle([android]), { v: 1, packages: { android: { ok: true, url, pathname: android.uploadPathname, ms: 5 } } }, deps);
    assert.deepEqual(out.failures, {});
    const [file] = out.files;
    assert.equal(file.signedWith, "platform");
    assert.equal(file.url, `${BLOB}/${android.pathname}`);
    assert.equal(file.artifactKind, "android_apk");
    assert.equal(puts[0].pathname, android.pathname);
    assert.equal(apkSigner(puts[0].bytes), createHash("sha256").update(key.certificate.raw).digest("hex"));
    assert.equal(file.bytes, puts[0].bytes.length);
    assert.equal(file.sha256, createHash("sha256").update(puts[0].bytes).digest("hex"));
    assert.deepEqual(removed, [url]);
  });

  it("offers a debug-signed APK as that, with no key set, and moves nothing", async () => {
    const slot = { ...android, uploadPathname: android.pathname };
    const { deps, puts } = fakes({ apkKey: () => null });
    const url = `${BLOB}/${slot.pathname}`;
    const out = await collectPackages(handle([slot]), { v: 1, packages: { android: { ok: true, url, pathname: slot.pathname, bytes: 9, sha256: "s" } } }, deps);
    assert.equal(out.files[0].signedWith, "debug");
    assert.equal(out.files[0].url, url);
    assert.equal(puts.length, 0);
  });

  it("offers a desktop zip where it landed, without downloading it", async () => {
    const { deps, puts } = fakes({ fetchBytes: async () => assert.fail("a 200 MB file shouldn't come through a function") });
    const url = `${BLOB}/${mac.pathname}`;
    const out = await collectPackages(handle([mac]), { v: 1, packages: { mac: { ok: true, url, pathname: mac.pathname, bytes: 9, sha256: "s", ms: 3 } } }, deps);
    assert.deepEqual(out.files[0], { kind: "mac", artifactKind: "mac_zip", pathname: mac.pathname, shellVersion: "1.0.0", ms: 3, url, bytes: 9, sha256: "s", signedWith: null });
    assert.equal(puts.length, 0);
  });

  it("copies out what a local run kept in the sandbox", async () => {
    const { deps, puts } = fakes({ readKept: async () => Buffer.from("zip bytes"), apkKey: () => null });
    const out = await collectPackages(handle([mac]), { v: 1, packages: { mac: { ok: true, keptAt: "/tmp/out/mac", pathname: mac.pathname } } }, deps);
    assert.equal(out.files[0].bytes, 9);
    assert.equal(puts[0].pathname, mac.pathname);
  });

  it("keeps one kind's failure from stopping the others", async () => {
    const { deps } = fakes({ fetchBytes: async () => { throw new Error("Download failed"); } });
    const out = await collectPackages(
      handle([android, mac], { windows: "No template." }),
      {
        v: 1,
        packages: {
          android: { ok: true, url: `${BLOB}/${android.uploadPathname}`, pathname: android.uploadPathname },
          mac: { ok: true, url: `${BLOB}/${mac.pathname}`, pathname: mac.pathname },
        },
      },
      deps,
    );
    assert.deepEqual(out.files.map((f) => f.kind), ["mac"]);
    assert.deepEqual(out.failures, { windows: "No template.", android: "Download failed" });
  });

  it("reports a failed package and one the run never reached", async () => {
    const { deps } = fakes();
    const out = await collectPackages(handle([android, mac]), { v: 1, packages: { android: { ok: false, error: "aapt2 failed" } } }, deps);
    assert.deepEqual(out.failures, { android: "aapt2 failed", mac: "The packager didn't get to it." });
  });

  it("refuses an upload it didn't hand out", async () => {
    const { deps } = fakes();
    const out = await collectPackages(handle([mac]), { v: 1, packages: { mac: { ok: true, url: "https://evil.example/x.zip", pathname: mac.pathname } } }, deps);
    assert.deepEqual(out.files, []);
    assert.match(out.failures.mac ?? "", /wasn't given/);
  });
});
