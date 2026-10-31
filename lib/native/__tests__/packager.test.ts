import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { apkSigner, readApkKey, type ApkKey } from "@/lib/native/apk-sign";
import { macTemplateFile } from "@/lib/native/shells";
import {
  checkShellPathname,
  collectPackages,
  fetchProductIcon,
  isIconPicture,
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
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

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

describe("macTemplateFile", () => {
  const old = "Muse Muse-1.0.0-universal-mac.zip";
  const current = "Muse Muse-1.0.1-universal-mac.zip";
  it("takes this version's zip, whatever else is left in dist", () => {
    assert.equal(macTemplateFile([old, current, "builder-debug.yml"], "1.0.1"), current);
  });
  it("won't stand an older build in for this version", () => assert.equal(macTemplateFile([old], "1.0.1"), null));
});

describe("isIconPicture", () => {
  it("knows PNG, JPEG and WebP by their first bytes", () => {
    assert.ok(isIconPicture(PNG));
    assert.ok(isIconPicture(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])));
    assert.ok(isIconPicture(Buffer.from("RIFF\0\0\0\0WEBPVP8 ", "latin1")));
  });
  it("refuses anything else", () => {
    for (const other of ["<svg xmlns='http://www.w3.org/2000/svg'/>", "GIF89a", "RIFF\0\0\0\0WAVEfmt ", "%PDF-1.7", "", "\x89PNG"]) {
      assert.ok(!isIconPicture(Buffer.from(other, "latin1")), other);
    }
  });
});

describe("fetchProductIcon", () => {
  const answering = (body: BodyInit | null, type: string, status = 200) => (async () => new Response(body, { status, headers: { "content-type": type } })) as unknown as typeof fetch;
  it("asks for the product's own 512 icon, with no redirects", async () => {
    let asked: { url: string; redirect?: string } | null = null;
    const icon = await fetchProductIcon("https://fern.vercel.app/some/page", (async (url: URL, init: RequestInit) => {
      asked = { url: String(url), redirect: init.redirect };
      return new Response(PNG, { headers: { "content-type": "image/png" } });
    }) as unknown as typeof fetch);
    assert.deepEqual(icon, PNG);
    assert.deepEqual(asked, { url: "https://fern.vercel.app/icon/512", redirect: "error" });
  });
  it("says null for a page, an error, an SVG or anything that throws", async () => {
    assert.equal(await fetchProductIcon("https://a.b/", answering("<html>", "text/html")), null);
    assert.equal(await fetchProductIcon("https://a.b/", answering(PNG, "image/png", 404)), null);
    assert.equal(await fetchProductIcon("https://a.b/", answering("<svg/>", "image/svg+xml")), null);
    assert.equal(await fetchProductIcon("https://a.b/", (async () => { throw new Error("no"); }) as unknown as typeof fetch), null);
  });
  it("says null for other bytes that call themselves a PNG, so they never reach sharp", async () => {
    assert.equal(await fetchProductIcon("https://a.b/", answering("<svg xmlns='http://www.w3.org/2000/svg'/>", "image/png")), null);
  });

  /** A body that never ends, counting what's been pulled from it. */
  function endless() {
    const state = { sent: 0, cancelled: false };
    const chunk = new Uint8Array(1024 * 1024);
    chunk.set(PNG);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        state.sent += chunk.length;
        controller.enqueue(chunk);
      },
      cancel() {
        state.cancelled = true;
      },
    });
    return { body, state };
  }
  it("stops reading past the limit, whatever the size it was told", async () => {
    const { body, state } = endless();
    assert.equal(await fetchProductIcon("https://a.b/", answering(body, "image/png")), null);
    assert.ok(state.cancelled);
    assert.ok(state.sent < 12 * 1024 * 1024, `read ${state.sent} bytes`);
  });
  it("doesn't read a body that says it's too big", async () => {
    const { body, state } = endless();
    const res = new Response(body, { headers: { "content-type": "image/png", "content-length": String(600 * 1024 * 1024) } });
    assert.equal(await fetchProductIcon("https://a.b/", (async () => res) as unknown as typeof fetch), null);
    assert.ok(state.cancelled);
    assert.ok(state.sent <= 1024 * 1024 * 2, `read ${state.sent} bytes`);
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

  const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  /** What the sandbox says about bytes it really made. */
  const claim = (bytes: Buffer, ms?: number) => ({ ok: true, bytes: bytes.length, sha256: sha(bytes), ...(ms ? { ms } : {}) });
  const ZIP = Buffer.from("zip bytes");

  /** A store holding `held` at each path that has no entry of its own. Nothing in it is ever on the sandbox's say so. */
  function fakes(overrides: Partial<CollectDeps> = {}, held: Buffer = emptyZip()) {
    const puts: Array<{ pathname: string; bytes: Buffer }> = [];
    const removed: string[] = [];
    const headed: string[] = [];
    const deps: CollectDeps = {
      head: async (pathname) => {
        headed.push(pathname);
        return { url: `${BLOB}/${pathname}`, size: held.length };
      },
      sha256: async () => sha(held),
      fetchBytes: async () => held,
      readKept: async () => null,
      put: async (pathname, bytes) => {
        puts.push({ pathname, bytes });
        return `${BLOB}/${pathname}`;
      },
      remove: async (url) => void removed.push(url),
      apkKey: () => key,
      ...overrides,
    };
    return { deps, puts, removed, headed };
  }

  it("signs the APK with the platform's key, moves it to its real path and removes the stop on the way", async () => {
    const { deps, puts, removed } = fakes();
    const out = await collectPackages(handle([android]), { v: 1, packages: { android: claim(emptyZip(), 5) } }, deps);
    assert.deepEqual(out.failures, {});
    const [file] = out.files;
    assert.equal(file.signedWith, "platform");
    assert.equal(file.url, `${BLOB}/${android.pathname}`);
    assert.equal(file.artifactKind, "android_apk");
    assert.equal(puts[0].pathname, android.pathname);
    assert.equal(apkSigner(puts[0].bytes), createHash("sha256").update(key.certificate.raw).digest("hex"));
    assert.equal(file.bytes, puts[0].bytes.length);
    assert.equal(file.sha256, createHash("sha256").update(puts[0].bytes).digest("hex"));
    assert.deepEqual(removed, [`${BLOB}/${android.uploadPathname}`]);
  });

  it("offers a debug-signed APK as that, with no key set, and moves nothing", async () => {
    const slot = { ...android, uploadPathname: android.pathname };
    const { deps, puts } = fakes({ apkKey: () => null }, ZIP);
    const out = await collectPackages(handle([slot]), { v: 1, packages: { android: claim(ZIP) } }, deps);
    assert.equal(out.files[0].signedWith, "debug");
    assert.equal(out.files[0].url, `${BLOB}/${slot.pathname}`);
    assert.equal(puts.length, 0);
  });

  it("offers a desktop zip where it landed, without holding it in memory", async () => {
    const { deps, puts } = fakes({ fetchBytes: async () => assert.fail("a 200 MB file shouldn't sit in a function's memory") }, ZIP);
    const out = await collectPackages(handle([mac]), { v: 1, packages: { mac: claim(ZIP, 3) } }, deps);
    assert.deepEqual(out.files[0], { kind: "mac", artifactKind: "mac_zip", pathname: mac.pathname, shellVersion: "1.0.0", ms: 3, url: `${BLOB}/${mac.pathname}`, bytes: ZIP.length, sha256: sha(ZIP), signedWith: null });
    assert.equal(puts.length, 0);
  });

  it("copies out what a local run kept in the sandbox", async () => {
    const { deps, puts } = fakes({ readKept: async () => Buffer.from("zip bytes"), apkKey: () => null });
    const out = await collectPackages(handle([{ ...mac, kept: true }]), { v: 1, packages: { mac: { ok: true, keptAt: "/tmp/out/mac" } } }, deps);
    assert.equal(out.files[0].bytes, 9);
    assert.equal(puts[0].pathname, mac.pathname);
  });

  it("keeps one kind's failure from stopping the others", async () => {
    const { deps } = fakes({ fetchBytes: async () => { throw new Error("Download failed"); } });
    const out = await collectPackages(handle([android, mac], { windows: "No template." }), { v: 1, packages: { android: claim(emptyZip()), mac: claim(emptyZip()) } }, deps);
    assert.deepEqual(out.files.map((f) => f.kind), ["mac"]);
    assert.deepEqual(out.failures, { windows: "No template.", android: "Download failed" });
  });

  it("reports a failed package and one the run never reached", async () => {
    const { deps } = fakes();
    const out = await collectPackages(handle([android, mac]), { v: 1, packages: { android: { ok: false, error: "aapt2 failed" } } }, deps);
    assert.deepEqual(out.failures, { android: "aapt2 failed", mac: "The packager didn't get to it." });
  });

  describe("a sandbox's answer it can't vouch for", () => {
    /** The review's forged result, reaching for the fields a page and a lab would trust. */
    const forged = { ok: true, url: "https://attackers-own-store.public.blob.vercel-storage.com/native/products/a/b/c-mac.zip", pathname: mac.pathname, bytes: ZIP.length, sha256: sha(ZIP) };

    it("takes the URL from the platform's store at the slot's path, never from the sandbox", async () => {
      const { deps, headed } = fakes({}, ZIP);
      const out = await collectPackages(handle([mac]), { v: 1, packages: { mac: forged } }, deps);
      assert.deepEqual(headed, [mac.uploadPathname]);
      assert.equal(out.files[0].url, `${BLOB}/${mac.pathname}`);
      assert.ok(!JSON.stringify(out).includes("attackers"));
    });
    it("fetches an APK to sign from the platform's store too", async () => {
      const fetched: string[] = [];
      const { deps } = fakes({ fetchBytes: async (url) => (fetched.push(url), emptyZip()) });
      const out = await collectPackages(handle([android]), { v: 1, packages: { android: { ...claim(emptyZip()), url: forged.url } as never } }, deps);
      assert.deepEqual(fetched, [`${BLOB}/${android.uploadPathname}`]);
      assert.deepEqual(out.failures, {});
    });
    it("fails a package that isn't in the store", async () => {
      const { deps } = fakes({ head: async () => null });
      const out = await collectPackages(handle([mac]), { v: 1, packages: { mac: forged } }, deps);
      assert.deepEqual(out.files, []);
      assert.match(out.failures.mac ?? "", /isn't in the store/);
    });
    it("fails when the size differs", async () => {
      const { deps } = fakes({}, ZIP);
      const out = await collectPackages(handle([mac]), { v: 1, packages: { mac: { ...forged, bytes: 1 } } }, deps);
      assert.deepEqual(out.files, []);
      assert.match(out.failures.mac ?? "", /size/);
    });
    it("fails when the hash differs, reading the zip's own bytes", async () => {
      const { deps } = fakes({}, ZIP);
      const out = await collectPackages(handle([mac]), { v: 1, packages: { mac: { ...forged, sha256: "not-a-hash" } } }, deps);
      assert.deepEqual(out.files, []);
      assert.match(out.failures.mac ?? "", /isn't the one/);
    });
    it("fails when an APK's bytes aren't the ones it claimed, before signing them", async () => {
      const { deps, puts } = fakes();
      const out = await collectPackages(handle([android]), { v: 1, packages: { android: { ...claim(emptyZip()), sha256: "a".repeat(64) } } }, deps);
      assert.deepEqual(out.files, []);
      assert.match(out.failures.android ?? "", /isn't the one/);
      assert.equal(puts.length, 0);
    });
    it("records the platform's hash, not the sandbox's", async () => {
      const { deps } = fakes({ sha256: async () => "platform-hash" }, ZIP);
      const out = await collectPackages(handle([mac]), { v: 1, packages: { mac: { ...forged, sha256: "platform-hash" } } }, deps);
      assert.equal(out.files[0].sha256, "platform-hash");
    });
    it("won't read a kept file from the sandbox when the slot was a Blob one", async () => {
      const { deps, puts } = fakes({ readKept: async () => assert.fail("only a local run keeps files"), head: async () => null });
      const out = await collectPackages(handle([mac]), { v: 1, packages: { mac: { ok: true, keptAt: "/etc/passwd" } } }, deps);
      assert.deepEqual(out.files, []);
      assert.equal(puts.length, 0);
    });
  });
});
