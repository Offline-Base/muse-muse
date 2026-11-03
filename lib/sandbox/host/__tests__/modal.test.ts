/**
 * Unit tests for the Modal build host (lib/sandbox/host/modal.ts), against a fake of the slice of Modal's SDK it uses.
 * The live check is scripts/dev/modal-smoke.ts.
 *   npx tsx --test lib/sandbox/host/__tests__/modal.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BASE_IMAGE,
  CMD_DIR,
  commandFilesScript,
  createModalHost,
  detachedScript,
  imageNameFor,
  isDeletedImage,
  type ModalApi,
  type ModalCreateParams,
  modalEgress,
  type ModalImage,
  type ModalSb,
  parseCommandFiles,
  STATE_FILE,
} from "@/lib/sandbox/host/modal";
import { builderNetworkPolicy, placeholderKey } from "@/lib/sandbox/policy";

const KEY = "sk-meta-real-key-0123456789";
const NAME = "product-bird-finder-0123abcd";

function lockedPolicy(bypass = false) {
  return builderNetworkPolicy({
    modelApiKey: KEY,
    placeholderKey: placeholderKey(KEY, NAME),
    platformHost: "muse-muse.vercel.app",
    blobUploads: true,
    capHosts: ["pypi.org"],
    platformBypass: bypass ? { host: "muse-muse.vercel.app", secret: "bypass-secret-123" } : null,
  });
}

class NotFoundError extends Error {
  override name = "NotFoundError";
}

class FakeSb implements ModalSb {
  files = new Map<string, Buffer>();
  tags: Record<string, string>;
  ended = false;
  policies: Array<{ outboundCidrAllowlist: string[]; outboundDomainAllowlist: string[] }> = [];
  execs: string[][] = [];
  execResult: (argv: string[]) => { code: number; out?: string; err?: string } = () => ({ code: 0 });
  constructor(
    readonly sandboxId: string,
    readonly params: ModalCreateParams,
    private readonly world: FakeModal,
  ) {
    this.tags = { ...(params.tags ?? {}) };
  }
  async exec(argv: string[]) {
    this.execs.push(argv);
    const r = this.execResult(argv);
    return { stdout: { readText: async () => r.out ?? "" }, stderr: { readText: async () => r.err ?? "" }, wait: async () => r.code };
  }
  filesystem = {
    readBytes: async (path: string) => {
      const f = this.files.get(path);
      if (!f) throw Object.assign(new Error(`no ${path}`), { name: "SandboxFilesystemNotFoundError" });
      return new Uint8Array(f);
    },
    writeBytes: async (data: Uint8Array, path: string) => {
      this.files.set(path, Buffer.from(data));
    },
  };
  async setTags(tags: Record<string, string>) {
    this.tags = { ...tags };
  }
  async getTags() {
    return { ...this.tags };
  }
  async tunnels() {
    return { 3000: { url: `https://${this.sandboxId}.modal.host` } };
  }
  async snapshotFilesystem() {
    const id = `im-${this.world.images.size + 1}`;
    this.world.images.set(id, new Map(this.files));
    return { imageId: id, publish: async (name: string) => void this.world.published.set(name, id) };
  }
  async terminate(params?: { wait: true }) {
    assert.deepEqual(params, { wait: true }, "terminate waits, so a lookup by name right after sees it gone");
    this.ended = true;
  }
  async poll() {
    return this.ended ? 0 : null;
  }
  async updateNetworkPolicy(p: { outboundCidrAllowlist: string[]; outboundDomainAllowlist: string[] }) {
    this.policies.push(p);
  }
}

class FakeModal implements ModalApi {
  created: Array<{ image: unknown; params: ModalCreateParams; sb: FakeSb }> = [];
  images = new Map<string, Map<string, Buffer>>();
  published = new Map<string, string>();
  deletedImages = new Set<string>();
  async create(image: unknown, params: ModalCreateParams) {
    if (typeof image === "object" && image && "imageId" in image && this.deletedImages.has((image as ModalImage).imageId)) {
      throw new Error(`/modal.client.ModalClient/SandboxCreateV2 NOT_FOUND: image ${(image as ModalImage).imageId} not found`);
    }
    const sb = new FakeSb(`sb-${this.created.length + 1}`, params, this);
    const fromId = (image as { id?: string; imageId?: string } | null)?.imageId ?? (image as { id?: string } | null)?.id;
    for (const [k, v] of this.images.get(fromId ?? "") ?? []) sb.files.set(k, v);
    this.created.push({ image, params, sb });
    return sb;
  }
  async fromName(name: string) {
    const live = [...this.created].reverse().find((c) => c.params.name === name && !c.sb.ended);
    if (!live) throw new NotFoundError(`no running ${name}`);
    return live.sb;
  }
  async imageFromId(id: string) {
    return { id };
  }
  async imageFromName(name: string): Promise<ModalImage> {
    const id = this.published.get(name);
    if (!id) throw new NotFoundError(`no image ${name}`);
    return { imageId: id, publish: async () => {} };
  }
  imageFromRegistry(tag: string) {
    return { registry: tag };
  }
  async deleteImage(id: string) {
    this.deletedImages.add(id);
  }
}

function setup() {
  const modal = new FakeModal();
  const host = createModalHost(async () => modal, { timeoutMs: 3 * 3600_000, imageTtlMs: 1000 });
  return { modal, host };
}

const createParams = (extra: Record<string, unknown> = {}) => ({
  name: NAME,
  resume: true,
  persistent: true,
  resources: { vcpus: 4 },
  ports: [3000],
  timeout: 3600_000,
  tags: { app: "musemuse", role: "product", product: "p1" },
  source: { type: "snapshot" as const, snapshotId: "im-builder" },
  networkPolicy: lockedPolicy(true),
  ...extra,
});

test("egress: host names only, never a header rule, and api.meta.ai left out", () => {
  const e = modalEgress(lockedPolicy(true));
  assert.deepEqual(e.domains, ["*.blob.vercel-storage.com", "muse-muse.vercel.app", "pypi.org", "registry.npmjs.org", "vercel.com"]);
  assert.deepEqual(e.cidrs, []);
  const text = JSON.stringify(e);
  assert.ok(!text.includes(KEY) && !text.includes("bypass-secret-123") && !text.includes("mm_sandbox_"));
  assert.deepEqual(modalEgress("allow-all"), { domains: null, cidrs: null });
  assert.deepEqual(modalEgress(undefined), { domains: null, cidrs: null });
  assert.deepEqual(modalEgress("deny-all"), { domains: [], cidrs: [] });
  assert.deepEqual(modalEgress({ allow: ["Example.COM", "api.meta.ai"], subnets: { allow: ["10.0.0.0/8"] } }), { domains: ["example.com"], cidrs: ["10.0.0.0/8"] });
});

test("create: from the builder image, 4 vCPUs (2 Modal cores) with 8 GB, a tunnel on 3000, the longer timeout, locked egress, no secrets", async () => {
  const { modal, host } = setup();
  const sb = await host.getOrCreate(createParams());
  assert.equal(modal.created.length, 1);
  const { image, params } = modal.created[0]!;
  assert.deepEqual(image, { id: "im-builder" });
  assert.equal(params.name, NAME);
  assert.equal(params.cpu, 2);
  assert.equal(params.memoryMiB, 8192);
  assert.deepEqual(params.encryptedPorts, [3000]);
  assert.equal(params.timeoutMs, 3 * 3600_000);
  assert.equal(params.blockNetwork, undefined);
  assert.ok(params.outboundDomainAllowlist?.includes("muse-muse.vercel.app"));
  assert.ok(!params.outboundDomainAllowlist?.includes("api.meta.ai"));
  assert.deepEqual(params.outboundCidrAllowlist, []);
  const all = JSON.stringify(params);
  assert.ok(!all.includes(KEY) && !all.includes("bypass-secret-123"), "no key or secret goes to Modal");
  assert.equal(sb.status, "running");
  assert.deepEqual(sb.tags, { app: "musemuse", role: "product", product: "p1" }, "the host's own tags are hidden");
  assert.ok(sb.expiresAt && sb.expiresAt.getTime() > Date.now());
  assert.equal(await sb.domain(3000), "https://sb-1.modal.host");
  await assert.rejects(() => sb.extendTimeout(60_000), /can't extend/);
});

test("create with no snapshot starts from the stock image with open egress; a second getOrCreate finds the running one", async () => {
  const { modal, host } = setup();
  await host.getOrCreate(createParams({ source: undefined, networkPolicy: "allow-all" }));
  assert.deepEqual(modal.created[0]!.image, { registry: BASE_IMAGE });
  assert.equal(modal.created[0]!.params.outboundDomainAllowlist, undefined);
  await host.getOrCreate(createParams());
  assert.equal(modal.created.length, 1);
});

test("update: tags keep the host's own, and a policy becomes Modal egress", async () => {
  const { modal, host } = setup();
  const sb = await host.getOrCreate(createParams());
  await sb.update({ tags: { ...sb.tags, product: "p2" } });
  const fake = modal.created[0]!.sb;
  assert.equal(fake.tags.product, "p2");
  assert.ok("mm_egress" in fake.tags && "mm_expires" in fake.tags);
  await sb.update({ networkPolicy: "allow-all" });
  assert.deepEqual(fake.policies.at(-1), { outboundDomainAllowlist: ["*"], outboundCidrAllowlist: ["0.0.0.0/0"] });
  await sb.update({ networkPolicy: lockedPolicy() });
  assert.ok(fake.policies.at(-1)!.outboundDomainAllowlist.includes("registry.npmjs.org"));
  assert.ok(!JSON.stringify(fake.policies).includes(KEY));
});

test("files: written with modes, a missing one reads as null, other errors throw", async () => {
  const { modal, host } = setup();
  const sb = await host.getOrCreate(createParams());
  await sb.writeFiles([{ path: "/vercel/app/a.txt", content: "hi" }, { path: "/vercel/musemuse/run/x.sh", content: Buffer.from("#!/bin/bash"), mode: 0o755 }]);
  const fake = modal.created[0]!.sb;
  assert.equal(fake.files.get("/vercel/app/a.txt")?.toString(), "hi");
  assert.deepEqual(fake.execs.at(-1), ["bash", "-c", "chmod 755 '/vercel/musemuse/run/x.sh'"]);
  assert.equal((await sb.readFileToBuffer({ path: "/vercel/app/a.txt" }))?.toString(), "hi");
  assert.equal(await sb.readFileToBuffer({ path: "/nope" }), null);
  fake.filesystem.readBytes = async () => {
    throw Object.assign(new Error("denied"), { name: "SandboxFilesystemPermissionError" });
  };
  await assert.rejects(() => sb.readFileToBuffer({ path: "/vercel/app/a.txt" }), /denied/);
});

test("commands: run to the end, or detached and found again by id", async () => {
  const { modal, host } = setup();
  const sb = await host.getOrCreate(createParams());
  const fake = modal.created[0]!.sb;
  fake.execResult = (argv) => (argv[0] === "ls" ? { code: 2, out: "o", err: "e" } : { code: 0 });
  const done = await sb.runCommand({ cmd: "ls", args: ["-la"], cwd: "/vercel/app", env: { A: "1" } });
  assert.deepEqual([done.exitCode, await done.stdout(), await done.stderr()], [2, "o", "e"]);

  let exitFile = "";
  fake.execResult = (argv) => {
    const script = argv[2] ?? "";
    if (script.includes("setsid")) return { code: 0 };
    if (script.includes(".pid")) return { code: 0, out: `pid=42\nexit=${exitFile}\n` };
    return { code: 0 };
  };
  const cmd = await sb.runCommand({ cmd: "bash", args: ["/vercel/musemuse/run/dev.sh"], detached: true });
  assert.match(cmd.cmdId, /^mmc_[0-9a-f]{24}$/);
  assert.equal((await sb.getCommand(cmd.cmdId)).exitCode, null);
  await cmd.kill("SIGTERM");
  assert.deepEqual(fake.execs.at(-1), ["bash", "-c", "kill -s TERM 42 2>/dev/null; true"]);
  exitFile = "143";
  assert.equal((await sb.getCommand(cmd.cmdId)).exitCode, 143);
  assert.deepEqual(await cmd.wait(), { exitCode: 143 });

  fake.execResult = () => ({ code: 3 });
  await assert.rejects(() => sb.getCommand(cmd.cmdId), (err: Error) => host.isNotFound(err));
  await assert.rejects(() => sb.getCommand("not-an-id; rm -rf /"), (err: Error) => host.isNotFound(err));
});

test("a wait that is aborted rejects", async () => {
  const { modal, host } = setup();
  const sb = await host.getOrCreate(createParams());
  modal.created[0]!.sb.execResult = (argv) => ((argv[2] ?? "").includes(".pid") ? { code: 0, out: "pid=9\nexit=\n" } : { code: 0 });
  const cmd = await sb.runCommand({ cmd: "sleep", args: ["100"], detached: true });
  await assert.rejects(() => cmd.wait({ signal: AbortSignal.timeout(50) }), /Stopped waiting/);
});

test("stop saves state and publishes an image; resume brings back the files, tags and egress, egress shut until then", async () => {
  const { modal, host } = setup();
  const sb = await host.getOrCreate(createParams());
  await sb.writeFiles([{ path: "/vercel/app/page.tsx", content: "page" }]);
  await sb.stop();
  const first = modal.created[0]!.sb;
  assert.ok(first.ended);
  assert.ok(first.files.has(STATE_FILE));
  assert.ok(modal.published.has(imageNameFor(NAME)));

  const stopped = await host.get({ name: NAME });
  assert.equal(stopped.status, "stopped");

  const back = await host.get({ name: NAME, resume: true });
  const second = modal.created[1]!;
  assert.equal(second.params.name, NAME);
  assert.deepEqual(second.params.outboundDomainAllowlist, ["egress-shut.invalid"], "starts with nothing let out");
  assert.ok(second.sb.policies.at(-1)!.outboundDomainAllowlist.includes("muse-muse.vercel.app"), "then gets its saved egress");
  assert.equal(back.status, "running");
  assert.equal(back.tags?.product, "p1");
  assert.equal((await back.readFileToBuffer({ path: "/vercel/app/page.tsx" }))?.toString(), "page");
  // getOrCreate finds it running now and makes nothing new.
  await host.getOrCreate(createParams());
  assert.equal(modal.created.length, 2);
});

test("a resume without the saved state keeps egress shut", async () => {
  const { modal, host } = setup();
  const sb = await host.getOrCreate(createParams());
  await sb.stop();
  modal.images.get(modal.published.get(imageNameFor(NAME))!)!.delete(STATE_FILE);
  const warn = console.warn;
  console.warn = () => {};
  try {
    await host.get({ name: NAME, resume: true });
  } finally {
    console.warn = warn;
  }
  assert.equal(modal.created[1]!.sb.policies.length, 0);
  assert.deepEqual(modal.created[1]!.params.outboundDomainAllowlist, ["egress-shut.invalid"]);
});

test("delete ends it and deletes its image; a deleted one isn't resumed, and getOrCreate makes a new one", async () => {
  const { modal, host } = setup();
  const sb = await host.getOrCreate(createParams());
  await sb.stop();
  const back = await host.get({ name: NAME, resume: true });
  await back.delete();
  assert.equal(modal.deletedImages.size, 1);
  await assert.rejects(() => host.get({ name: NAME, resume: true }), (err: Error) => host.isNotFound(err));
  await host.getOrCreate(createParams());
  assert.deepEqual(modal.created.at(-1)!.image, { id: "im-builder" });
});

test("a copy that isn't persistent never publishes an image; nothing by that name is not found", async () => {
  const { modal, host } = setup();
  await host.getOrCreate(createParams());
  const copy = await host.fork({ sourceSandbox: NAME, name: "prove-abc-x", persistent: false, timeout: 3600_000, networkPolicy: lockedPolicy(), tags: { role: "prove" } });
  assert.equal(modal.created.length, 2);
  assert.match(String((modal.created[1]!.image as { id: string }).id), /^im-/, "from a fresh snapshot of the source");
  await copy.stop();
  assert.ok(!modal.published.has(imageNameFor("prove-abc-x")));
  await assert.rejects(() => host.get({ name: "prove-abc-x" }), (err: Error) => host.isNotFound(err));
});

test("command scripts", () => {
  const s = detachedScript("mmc_000000000000000000000001", ["bash", "/vercel/musemuse/run/it's.sh"]);
  assert.ok(s.includes("setsid nohup bash -c"));
  assert.ok(s.includes(`${CMD_DIR}/mmc_000000000000000000000001.exit`));
  assert.ok(s.includes("it'\\''"), "quoted for bash");
  assert.ok(commandFilesScript("mmc_000000000000000000000001").includes("exit 3"));
  assert.deepEqual(parseCommandFiles("pid=12\nexit=\n"), { pid: 12, exitCode: null });
  assert.deepEqual(parseCommandFiles("pid=12\nexit=7\n"), { pid: 12, exitCode: 7 });
  assert.deepEqual(parseCommandFiles("pid=12\nexit=x\n"), { pid: 12, exitCode: null });
  assert.ok(isDeletedImage(new Error("/modal.client.ModalClient/SandboxCreateV2 NOT_FOUND: image im-1 not found")));
  assert.ok(!isDeletedImage(new Error("NOT_FOUND: sandbox")));
});
