/**
 * startPackaging and pollPackaging with the sandbox and the Blob API faked: what the sandbox is given, and that the slots it
 * gets are ones the lab's upload client can use. The presigning itself is @vercel/blob's own. The admin route for shell uploads
 * is here too, since it uses the same presigning.
 *
 *   npx tsx --test --experimental-test-module-mocks lib/native/__tests__/packager-start.test.ts
 *
 * Without the flag, node:test has no mock.module and this file skips.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it, mock } from "node:test";

const canMock = typeof (mock as { module?: unknown }).module === "function";
const at = (rel: string) => new URL(rel, import.meta.url).href;
const savedEnv = { ...process.env };
const AUTOMATION = "automation-secret-for-tests";
const ORIGIN = "https://muse.example.com";
const b64url = (s: string) => Buffer.from(s).toString("base64url");

const req = {
  runId: "11111111-1111-4111-8111-111111111111",
  productId: "22222222-2222-4222-8222-222222222222",
  slug: "fern-moss",
  name: "Fern & Moss",
  url: "https://fern.vercel.app/",
  kinds: ["android", "mac", "windows"] as const,
  icon: null as Buffer | null,
};

type Written = { path: string; content: Buffer };
let created: Array<Record<string, unknown>> = [];
let written: Written[] = [];
let commands: Array<{ cmd: string; args: string[]; detached?: boolean }> = [];
let deleted = 0;
let exists = false;
let exitFile = "";
let resultFile = "";
let issued: Array<Record<string, unknown>> = [];

function fakeSandbox() {
  return {
    writeFiles: async (files: Written[]) => void written.push(...files),
    runCommand: async (opts: { cmd: string; args: string[]; detached?: boolean }) => {
      commands.push(opts);
      return { exitCode: 0, stdout: async () => exitFile, stderr: async () => "" };
    },
    fs: { readFile: async () => resultFile },
    stop: async () => {},
    delete: async () => void deleted++,
  };
}

const FakeSandbox = {
  create: async (opts: Record<string, unknown>) => {
    created.push(opts);
    exists = true;
    return fakeSandbox();
  },
  get: async () => {
    if (!exists) throw new Error("not found");
    return fakeSandbox();
  },
};

async function fakeIssue(opts: Record<string, unknown>) {
  issued.push(opts);
  const scope = { storeId: "teststore", pathname: opts.pathname, operations: opts.operations, validUntil: opts.validUntil };
  return { delegationToken: `${b64url(JSON.stringify(scope))}.sig`, clientSigningToken: "test-signing-key", validUntil: opts.validUntil };
}

describe("startPackaging", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  let packager: typeof import("../packager");
  const dir = mkdtempSync(path.join(tmpdir(), "packager-start-"));

  before(async () => {
    const sandbox = await import("@vercel/sandbox");
    mock.module("@vercel/sandbox", { namedExports: { ...sandbox, Sandbox: FakeSandbox } });
    const blob = await import("@vercel/blob");
    mock.module("@vercel/blob", { namedExports: { ...blob, issueSignedToken: fakeIssue } });
    packager = (await import(at("../packager.ts"))) as typeof import("../packager");
  });

  after(() => {
    mock.restoreAll();
    process.env = savedEnv;
    rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    created = [];
    written = [];
    commands = [];
    issued = [];
    deleted = 0;
    exists = false;
    exitFile = "";
    resultFile = "";
    process.env.PLATFORM_URL = ORIGIN;
    process.env.PACKAGER_SNAPSHOT_ID = "snap_test";
    process.env.BLOB_STORE_ID = "store_teststore";
    process.env.VERCEL = "1";
    delete process.env.BLOB_READ_WRITE_TOKEN;
    delete process.env.NATIVE_APK_KEYSTORE_B64;
  });

  const job = () => JSON.parse(written.find((f) => f.path.endsWith("job.json"))!.content.toString());

  it("won't start without a snapshot", async () => {
    delete process.env.PACKAGER_SNAPSHOT_ID;
    await assert.rejects(packager.startPackaging(req), packager.PackagerUnavailableError);
    assert.equal(created.length, 0);
  });

  it("makes a short-lived sandbox from the snapshot, behind the Blob-only firewall", async () => {
    const handle = await packager.startPackaging(req);
    const [opts] = created;
    assert.equal(opts.name, `musemuse-packager-${req.runId}`);
    assert.deepEqual(opts.source, { type: "snapshot", snapshotId: "snap_test" });
    assert.equal(opts.persistent, false);
    assert.deepEqual(opts.networkPolicy, { allow: ["vercel.com", "*.blob.vercel-storage.com"] });
    assert.equal(handle.sandboxName, opts.name);
    assert.equal(commands[0].detached, true);
    assert.ok(!JSON.stringify(commands[0]).includes("Fern"), "the name goes through job.json, never a command");
  });

  it("gives each kind a slot for one exact path, with the size and type limits, in multipart", async () => {
    await packager.startPackaging(req);
    const { outputs } = job();
    assert.deepEqual(Object.keys(outputs).sort(), ["android", "mac", "windows"]);
    assert.equal(outputs.mac.pathname, `native/products/${req.productId}/${req.runId}/fern-moss-mac.zip`);
    assert.equal(outputs.mac.method, "blob");
    assert.equal(outputs.mac.multipart, true);
    const mac = issued.find((o) => o.pathname === outputs.mac.pathname)!;
    assert.deepEqual(mac.operations, ["put"]);
    assert.equal(mac.maximumSizeInBytes, packager.PACKAGE_MAX_BYTES.mac);
    assert.deepEqual(mac.allowedContentTypes, ["application/zip"]);
    const { params } = outputs.mac.presignedUrlPayload;
    assert.equal(params["vercel-blob-allow-overwrite"], "true");
    assert.notEqual(params["vercel-blob-add-random-suffix"], "true");
  });

  it("makes slots the lab's upload client can use", async () => {
    await packager.startPackaging(req);
    // Dynamic, since this is plain JavaScript outside the app.
    const { uploadThroughSlot } = (await import(at("../../../native/lab/lib/blob.mjs"))) as {
      uploadThroughSlot(slot: unknown, file: string, type: string, opts: { fetch: typeof fetch }): Promise<{ url: string; pathname: string }>;
    };
    const file = path.join(dir, "small.zip");
    writeFileSync(file, Buffer.alloc(1024, 1));
    const { outputs } = job();
    const urls: string[] = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      urls.push(url);
      const action = (init.headers as Record<string, string>)["x-mpu-action"];
      const body = action === "create" ? { key: "k", uploadId: "u" } : action === "upload" ? { etag: "e" } : { url: `https://x.public.blob.vercel-storage.com/${outputs.mac.pathname}`, pathname: outputs.mac.pathname };
      return Response.json(body);
    }) as unknown as typeof fetch;
    const stored = await uploadThroughSlot(outputs.mac, file, "application/zip", { fetch: fakeFetch });
    assert.equal(stored.pathname, outputs.mac.pathname);
    assert.equal(urls.length, 3, "create, one part, complete");
    assert.match(urls[0], /vercel-blob-delegation=/);
  });

  it("sends the APK to its stop on the way only when there's a key to sign it, and the key stays out", async () => {
    const pem = path.join(dir, "both.pem");
    execFileSync("openssl", ["req", "-x509", "-nodes", "-newkey", "rsa:2048", "-keyout", pem, "-out", `${pem}.crt`, "-days", "2", "-subj", "/CN=t"], { stdio: "ignore" });
    const encoded = Buffer.from(readFileSync(pem, "utf8") + readFileSync(`${pem}.crt`, "utf8")).toString("base64");
    process.env.NATIVE_APK_KEYSTORE_B64 = encoded;
    const handle = await packager.startPackaging(req);
    const android = handle.slots.find((s) => s.kind === "android")!;
    assert.equal(android.uploadPathname, `native/products/${req.productId}/${req.runId}/unsigned/fern-moss.apk`);
    assert.equal(android.pathname, `native/products/${req.productId}/${req.runId}/fern-moss.apk`);

    const everything = JSON.stringify([created, written.map((f) => f.content.toString()), commands, handle]);
    assert.ok(!everything.includes(encoded));
    assert.ok(!everything.includes("PRIVATE KEY"));
    assert.ok(!JSON.stringify(created[0]).includes("env"));
  });

  it("writes the icon as a file when it has one", async () => {
    await packager.startPackaging({ ...req, icon: Buffer.from("picture") });
    assert.equal(job().iconPath, "/vercel/native/icon-source");
    assert.equal(written.find((f) => f.path === "/vercel/native/icon-source")?.content.toString(), "picture");
  });

  it("replaces an earlier sandbox when a step is retried", async () => {
    exists = true;
    await packager.startPackaging(req);
    assert.equal(deleted, 1);
    assert.equal(created.length, 1);
  });

  describe("pollPackaging", () => {
    const handle = { sandboxName: "s", runId: "r", shellVersion: "1.0.0", startedAt: 1_000, skipped: {}, slots: [{ kind: "mac" as const, pathname: "p", uploadPathname: "p" }] };

    it("says running until the exit file appears", async () => {
      exists = true;
      assert.deepEqual(await packager.pollPackaging(handle, 2_000), { state: "running" });
    });
    it("returns the result once finished", async () => {
      exists = true;
      exitFile = "0\n";
      resultFile = '{"v":1,"packages":{"mac":{"ok":true}}}\n';
      assert.deepEqual(await packager.pollPackaging(handle, 2_000), { state: "finished", result: { v: 1, packages: { mac: { ok: true } } } });
    });
    it("fails when the script couldn't read its job", async () => {
      exists = true;
      exitFile = "2\n";
      resultFile = '{"v":1,"error":"The product needs a name.","packages":{}}\n';
      assert.deepEqual(await packager.pollPackaging(handle, 2_000), { state: "failed", reason: "The product needs a name." });
    });
    it("fails when it left nothing readable", async () => {
      exists = true;
      exitFile = "137\n";
      assert.equal((await packager.pollPackaging(handle, 2_000)).state, "failed");
    });
    it("fails when the sandbox is gone or it took too long", async () => {
      assert.deepEqual(await packager.pollPackaging(handle, 2_000), { state: "failed", reason: "The packager's sandbox is gone." });
      exists = true;
      assert.deepEqual(await packager.pollPackaging(handle, 1_000 + packager.PACKAGING_LIMIT_MS + 1), { state: "failed", reason: "Packaging took too long." });
    });
    it("finishes at once when there was nothing to do", async () => {
      assert.equal((await packager.pollPackaging({ ...handle, slots: [] }, 2_000)).state, "finished");
    });
  });

  it("makes only the kinds it's asked for", async () => {
    const handle = await packager.startPackaging({ ...req, kinds: ["mac"] });
    assert.deepEqual(handle.slots.map((s) => s.kind), ["mac"]);
    assert.deepEqual(Object.keys(job().outputs), ["mac"]);
  });
});

describe("POST /api/admin/native/shell-upload", { skip: canMock ? false : "needs --experimental-test-module-mocks" }, () => {
  let POST: (req: Request) => Promise<Response>;
  const post = (pathname: unknown, headers: Record<string, string> = { authorization: `Bearer ${AUTOMATION}` }) =>
    new Request(`${ORIGIN}/api/admin/native/shell-upload`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ type: "blob.generate-presigned-url", payload: { pathname, multipart: true, clientPayload: null } }),
    });

  before(async () => {
    const realAuth = (await import(at("../../auth.ts"))) as typeof import("../../auth");
    mock.module(at("../../auth.ts"), {
      namedExports: {
        ...realAuth,
        requireAdminOrAutomation: async (r: Request) => {
          if (r.headers.get("authorization") === `Bearer ${AUTOMATION}`) return { id: "admin", email: "a@x", isAdmin: true };
          throw new realAuth.AuthError("Admins only.", 403);
        },
      },
    });
    const blob = await import("@vercel/blob");
    mock.module("@vercel/blob", { namedExports: { ...blob, issueSignedToken: fakeIssue } });
    ({ POST } = await import(at("../../../app/api/admin/native/shell-upload/route.ts")));
  });

  after(() => {
    mock.restoreAll();
    process.env = savedEnv;
  });

  beforeEach(() => {
    issued = [];
    process.env.PLATFORM_URL = ORIGIN;
    process.env.BLOB_STORE_ID = "store_teststore";
    process.env.VERCEL = "1";
    delete process.env.BLOB_READ_WRITE_TOKEN;
  });

  it("signs a release's file for automation", async () => {
    const res = await POST(post("native/shells/1.0.0/mac.zip"));
    assert.equal(res.status, 200);
    assert.equal(issued[0]?.pathname, "native/shells/1.0.0/mac.zip");
    assert.deepEqual(issued[0]?.operations, ["put"]);
  });

  it("refuses any other path", async () => {
    for (const bad of ["native/shells/1.0.0/evil.zip", "native/products/a/b/c.zip", "inspo/x", "native/shells/../x/mac.zip"]) {
      assert.equal((await POST(post(bad))).status, 400, bad);
    }
    assert.equal(issued.length, 0);
  });

  it("refuses anyone else, and another site", async () => {
    assert.equal((await POST(post("native/shells/1.0.0/mac.zip", {}))).status, 403);
    assert.equal((await POST(post("native/shells/1.0.0/mac.zip", { authorization: `Bearer ${AUTOMATION}`, origin: "https://evil.example", "sec-fetch-site": "cross-site" }))).status, 403);
    assert.equal(issued.length, 0);
  });

  it("says so when there's no store", async () => {
    delete process.env.BLOB_STORE_ID;
    const res = await POST(post("native/shells/1.0.0/mac.zip"));
    assert.equal(res.status, 503);
  });
});
