import { randomBytes } from "node:crypto";
import type { NetworkPolicy } from "@vercel/sandbox";
import type { HostCommand, HostCommandResult, HostCreateParams, HostForkParams, HostRunParams, HostSandbox, SandboxHostApi } from "@/lib/sandbox/host/types";

/**
 * Modal as a build host (SANDBOX_HOST=modal, docs/MODAL_HOST.md), on Modal's JS SDK (npm `modal`).
 *
 * How the builder's Vercel Sandbox calls map onto Modal:
 * - Named sandboxes: Modal names are unique among an app's running sandboxes. get() finds a running one by name.
 * - Stop and resume: Modal has no persistent sandbox, and a terminated one can't be asked for its tags. So stop() writes
 *   the tags and egress to STATE_FILE, snapshots the filesystem to an image, publishes it as imageNameFor(name), then
 *   terminates. get({ resume: true }) starts a new sandbox with the same name from that image, with egress shut until it
 *   has read STATE_FILE back and applied it. Processes and the preview tunnel's URL don't survive it.
 * - Snapshot start: `source.snapshotId` is a Modal image id (MODAL_BUILDER_IMAGE_ID); with none, a stock Node image.
 * - Detached commands: Modal can't find an exec again by id from another process, so a detached command runs under
 *   setsid with its pid and exit code in files (CMD_DIR). getCommand() reads them, kill() signals the pid.
 * - Preview: port 3000 goes out through an encrypted tunnel, so domain() is the tunnel's https URL.
 * - Timeouts: a Modal sandbox's lifetime is fixed when it is made. extendTimeout() can't change it, so sessions start
 *   at timeoutMs (longer than Vercel's first hour), and builder.ts's ensureTime logs the refusal.
 * - Egress: modalEgress(). Only the host names in the policy, never its header rules, so the real Meta key in a Vercel
 *   rule never reaches Modal. api.meta.ai is left out: Muse Code reaches Meta through the platform's proxy.
 */

/** Tags this module keeps for itself, hidden from `tags`. */
const EGRESS_TAG = "mm_egress";
const EXPIRES_TAG = "mm_expires";
const PERSISTENT_TAG = "mm_persistent";
const INTERNAL_TAGS = [EGRESS_TAG, EXPIRES_TAG, PERSISTENT_TAG];
/** Written by stop() before the snapshot, read by a resume: the sandbox's tags, its egress among them. */
export const STATE_FILE = "/var/tmp/musemuse-host.json";
/** A resumed sandbox's egress until it has read STATE_FILE: one name that resolves nowhere, so nothing gets out. */
const SHUT_EGRESS: ModalEgress = { domains: ["egress-shut.invalid"], cidrs: [] };

/** The published image a stopped product sandbox resumes from. */
export function imageNameFor(sandboxName: string): string {
  return `musemuse-${sandboxName}`;
}
/** Where detached commands keep their pid and exit code. */
export const CMD_DIR = "/var/tmp/musemuse-cmds";
/** The image a sandbox starts from with no builder image: Debian with Node 22, apt and git, like the builder needs. */
export const BASE_IMAGE = "node:22-bookworm";
const WAIT_POLL_MS = 400;
/** Vercel Sandbox gives 2 GB of memory per vCPU. */
const MIB_PER_VCPU = 2048;
/** Modal's `cpu` counts physical cores, two vCPUs each. */
const VCPUS_PER_CORE = 2;

// ---------------------------------------------------------------------------------------------------------------
// The slice of Modal's SDK used here, so tests can hand in a fake.

export interface ModalProc {
  stdout: { readText(): Promise<string> };
  stderr: { readText(): Promise<string> };
  wait(): Promise<number>;
}
export interface ModalSb {
  readonly sandboxId: string;
  exec(argv: string[], params?: { workdir?: string; env?: Record<string, string>; timeoutMs?: number }): Promise<ModalProc>;
  readonly filesystem: { readBytes(path: string): Promise<Uint8Array>; writeBytes(data: Uint8Array, path: string): Promise<void> };
  setTags(tags: Record<string, string>): Promise<void>;
  getTags(): Promise<Record<string, string>>;
  tunnels(timeoutMs?: number): Promise<Record<number, { url: string }>>;
  snapshotFilesystem(params?: { timeoutMs?: number; ttlMs?: number | null }): Promise<ModalImage>;
  /** With wait, resolves once Modal reports it ended, so a lookup by name right after sees it gone. */
  terminate(params?: { wait: true }): Promise<unknown>;
  poll(): Promise<number | null>;
  updateNetworkPolicy(params: { outboundCidrAllowlist: string[]; outboundDomainAllowlist: string[] }): Promise<void>;
}
export interface ModalCreateParams {
  name?: string;
  tags?: Record<string, string>;
  cpu?: number;
  memoryMiB?: number;
  timeoutMs?: number;
  encryptedPorts?: number[];
  blockNetwork?: boolean;
  outboundCidrAllowlist?: string[];
  outboundDomainAllowlist?: string[];
}
export interface ModalImage {
  readonly imageId: string;
  publish(name: string): Promise<void>;
}
export interface ModalApi {
  create(image: unknown, params: ModalCreateParams): Promise<ModalSb>;
  /** A running sandbox by name. Throws NotFoundError when none runs. */
  fromName(name: string): Promise<ModalSb>;
  imageFromId(id: string): Promise<unknown>;
  /** A published image. Throws NotFoundError when there is none. */
  imageFromName(name: string): Promise<ModalImage>;
  imageFromRegistry(tag: string): unknown;
  deleteImage(imageId: string): Promise<void>;
}

export interface ModalHostConfig {
  /** Every sandbox's lifetime, as Modal can't extend one. */
  timeoutMs: number;
  /** How long a stopped product's image is kept. Null keeps it. */
  imageTtlMs: number | null;
}

// ---------------------------------------------------------------------------------------------------------------
// Egress

/** A Modal egress rule set: what create takes, and what updateNetworkPolicy takes. */
export interface ModalEgress {
  /** Domains allowed, or null for no limit. An empty list blocks every domain. */
  domains: string[] | null;
  cidrs: string[] | null;
}

/** Hosts Muse Code and products never reach directly on Modal (they go through the platform). */
const PROXIED_HOSTS = new Set(["api.meta.ai"]);

/**
 * A Vercel NetworkPolicy as Modal egress: the allowed host names only, so header rules (the brokered key, the
 * Protection Bypass secret) stay on this side. "allow-all" opens everything, "deny-all" nothing.
 */
export function modalEgress(policy: NetworkPolicy | undefined): ModalEgress {
  if (policy === undefined || policy === "allow-all") return { domains: null, cidrs: null };
  if (policy === "deny-all") return { domains: [], cidrs: [] };
  const hosts = Array.isArray(policy.allow) ? policy.allow : Object.keys(policy.allow ?? {});
  const domains = [...new Set(hosts.map((h) => h.toLowerCase()).filter((h) => !PROXIED_HOSTS.has(h)))].sort();
  return { domains, cidrs: [...(policy.subnets?.allow ?? [])] };
}

function createEgress(e: ModalEgress): Pick<ModalCreateParams, "blockNetwork" | "outboundCidrAllowlist" | "outboundDomainAllowlist"> {
  if (e.domains === null && e.cidrs === null) return {};
  if (!e.domains?.length && !e.cidrs?.length) return { blockNetwork: true };
  return { outboundDomainAllowlist: e.domains ?? [], outboundCidrAllowlist: e.cidrs ?? [] };
}

function updateEgress(e: ModalEgress): { outboundCidrAllowlist: string[]; outboundDomainAllowlist: string[] } {
  return { outboundDomainAllowlist: e.domains ?? ["*"], outboundCidrAllowlist: e.cidrs ?? ["0.0.0.0/0"] };
}

function encodeEgress(e: ModalEgress): string {
  return JSON.stringify(e);
}

/** The egress saved on a sandbox. A missing or broken tag blocks everything: a restored sandbox never comes back open. */
function decodeEgress(tag: string | undefined): ModalEgress {
  try {
    const e = JSON.parse(tag ?? "") as ModalEgress;
    const ok = (v: unknown) => v === null || (Array.isArray(v) && v.every((x) => typeof x === "string"));
    if (e && ok(e.domains) && ok(e.cidrs)) return { domains: e.domains, cidrs: e.cidrs };
  } catch {
    // fall through
  }
  return { domains: [], cidrs: [] };
}

// ---------------------------------------------------------------------------------------------------------------
// Errors

export class ModalHostNotFound extends Error {
  readonly status = 404;
  constructor(message: string) {
    super(message);
    this.name = "ModalHostNotFound";
  }
}

function isModalNotFound(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name ?? "";
  return name === "NotFoundError" || name === "ModalHostNotFound" || name === "SandboxFilesystemNotFoundError";
}

/**
 * A published name whose image was deleted. Modal keeps resolving the name after images.delete (measured Nov 2), and a
 * create from it fails at once with a gRPC NOT_FOUND for the image.
 */
export function isDeletedImage(err: unknown): boolean {
  const message = String((err as { message?: string } | null)?.message ?? "");
  return /NOT_FOUND/.test(message) && /\bimage\b/i.test(message);
}

// ---------------------------------------------------------------------------------------------------------------
// Shell bits

function q(word: string): string {
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

function cmdIdOk(id: string): boolean {
  return /^mmc_[0-9a-f]{24}$/.test(id);
}

/**
 * Starts argv in its own session, records the pid of the command itself (so kill() signals it and not the wrapper),
 * and writes its exit code when it ends. Returns at once.
 */
export function detachedScript(cmdId: string, argv: string[]): string {
  const base = `${CMD_DIR}/${cmdId}`;
  const inner = [`${argv.map(q).join(" ")} </dev/null &`, "c=$!", `echo "$c" > ${q(`${base}.pid`)}`, 'wait "$c"', `echo $? > ${q(`${base}.exit`)}`].join("\n");
  return `mkdir -p ${q(CMD_DIR)} && setsid nohup bash -c ${q(inner)} >/dev/null 2>&1 </dev/null &\nfor i in $(seq 1 50); do [ -s ${q(`${base}.pid`)} ] && exit 0; sleep 0.1; done; echo "no pid" >&2; exit 1`;
}

/** Prints a detached command's pid and exit code as `pid=` and `exit=` lines. Exits 3 when there is no such command. */
export function commandFilesScript(cmdId: string): string {
  const base = `${CMD_DIR}/${cmdId}`;
  return `[ -s ${q(`${base}.pid`)} ] || exit 3; printf 'pid=%s\\nexit=%s\\n' "$(cat ${q(`${base}.pid`)})" "$(cat ${q(`${base}.exit`)} 2>/dev/null)"`;
}

export function parseCommandFiles(stdout: string): { pid: number; exitCode: number | null } {
  const field = (k: string) => new RegExp(`^${k}=(.*)$`, "m").exec(stdout)?.[1]?.trim() ?? "";
  const exit = field("exit");
  const code = exit === "" ? NaN : Number(exit);
  return { pid: Number(field("pid")), exitCode: Number.isInteger(code) ? code : null };
}

// ---------------------------------------------------------------------------------------------------------------
// A sandbox

class ModalHostSandbox implements HostSandbox {
  constructor(
    private readonly api: ModalApi,
    private readonly sb: ModalSb,
    readonly name: string,
    private allTags: Record<string, string>,
    private readonly running: boolean,
    private readonly imageTtlMs: number | null,
  ) {}

  get tags(): Record<string, string> {
    return Object.fromEntries(Object.entries(this.allTags).filter(([k]) => !INTERNAL_TAGS.includes(k)));
  }

  get status(): string {
    return this.running ? "running" : "stopped";
  }

  get expiresAt(): Date | undefined {
    const ms = Number(this.allTags[EXPIRES_TAG]);
    return Number.isFinite(ms) && ms > 0 ? new Date(ms) : undefined;
  }

  async extendTimeout(): Promise<void> {
    throw new Error("Modal can't extend a running sandbox's timeout. It is set when the sandbox is made.");
  }

  async update(params: { tags?: Record<string, string>; networkPolicy?: NetworkPolicy }): Promise<void> {
    if (params.networkPolicy !== undefined) {
      const egress = modalEgress(params.networkPolicy);
      await this.sb.updateNetworkPolicy(updateEgress(egress));
      this.allTags = { ...this.allTags, [EGRESS_TAG]: encodeEgress(egress) };
      if (!params.tags) await this.sb.setTags(this.allTags);
    }
    if (params.tags) {
      const keep = Object.fromEntries(Object.entries(this.allTags).filter(([k]) => INTERNAL_TAGS.includes(k)));
      this.allTags = { ...params.tags, ...keep };
      await this.sb.setTags(this.allTags);
    }
  }

  async writeFiles(files: Array<{ path: string; content: string | Uint8Array; mode?: number }>): Promise<void> {
    for (const f of files) {
      const data = typeof f.content === "string" ? Buffer.from(f.content, "utf8") : f.content;
      await this.sb.filesystem.writeBytes(data, f.path);
    }
    const modes = files.filter((f) => typeof f.mode === "number").map((f) => `chmod ${(f.mode! & 0o7777).toString(8)} ${q(f.path)}`);
    if (modes.length) {
      const res = await this.exec(["bash", "-c", modes.join(" && ")]);
      if (res.exitCode !== 0) throw new Error(`chmod failed in ${this.name}: ${res.stderr.slice(-300)}`);
    }
  }

  async readFileToBuffer(file: { path: string }): Promise<Buffer | null> {
    try {
      return Buffer.from(await this.sb.filesystem.readBytes(file.path));
    } catch (err) {
      const name = (err as { name?: string } | null)?.name ?? "";
      if (name === "SandboxFilesystemNotFoundError" || name === "SandboxFilesystemIsADirectoryError") return null;
      if (name !== "SandboxFilesystemFileTooLargeError") throw err;
    }
    // Past the SDK's read limit: base64 through a command instead.
    const res = await this.exec(["bash", "-c", `[ -f ${q(file.path)} ] || exit 3; base64 -w0 ${q(file.path)}`]);
    if (res.exitCode === 3) return null;
    if (res.exitCode !== 0) throw new Error(`Reading ${file.path} failed (exit ${res.exitCode}): ${res.stderr.slice(-500)}`);
    return Buffer.from(res.stdout.trim(), "base64");
  }

  private async exec(argv: string[], opts: { cwd?: string; env?: Record<string, string>; timeoutMs?: number } = {}) {
    const proc = await this.sb.exec(argv, {
      ...(opts.cwd ? { workdir: opts.cwd } : {}),
      ...(opts.env ? { env: opts.env } : {}),
      ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.readText(), proc.stderr.readText(), proc.wait()]);
    return { exitCode, stdout, stderr };
  }

  runCommand(params: HostRunParams & { detached: true }): Promise<HostCommand>;
  runCommand(params: HostRunParams): Promise<HostCommandResult>;
  async runCommand(params: HostRunParams & { detached?: boolean }): Promise<HostCommand | HostCommandResult> {
    // Commands run as root on Modal, so `sudo` needs nothing.
    const argv = [params.cmd, ...(params.args ?? [])];
    if (!params.detached) {
      const res = await this.exec(argv, params);
      return { exitCode: res.exitCode, stdout: async () => res.stdout, stderr: async () => res.stderr };
    }
    const cmdId = `mmc_${randomBytes(12).toString("hex")}`;
    const res = await this.exec(["bash", "-c", detachedScript(cmdId, argv)], { cwd: params.cwd, env: params.env });
    if (res.exitCode !== 0) throw new Error(`Starting ${params.cmd} failed (exit ${res.exitCode}): ${res.stderr.slice(-500)}`);
    return this.command(cmdId, null);
  }

  /** Pid and exit code of a detached command, or null when there is no such command. */
  private async commandFiles(cmdId: string): Promise<{ pid: number; exitCode: number | null } | null> {
    const res = await this.exec(["bash", "-c", commandFilesScript(cmdId)]);
    if (res.exitCode === 3) return null;
    if (res.exitCode !== 0) throw new Error(`Reading command ${cmdId} failed: ${res.stderr.slice(-300)}`);
    return parseCommandFiles(res.stdout);
  }

  async getCommand(cmdId: string): Promise<HostCommand> {
    if (!cmdIdOk(cmdId)) throw new ModalHostNotFound(`No command ${cmdId} in ${this.name}`);
    const files = await this.commandFiles(cmdId);
    if (!files) throw new ModalHostNotFound(`No command ${cmdId} in ${this.name}`);
    return this.command(cmdId, files.exitCode);
  }

  private command(cmdId: string, exitCode: number | null): HostCommand {
    const box = this;
    return {
      cmdId,
      exitCode,
      async wait(params?: { signal?: AbortSignal }) {
        for (;;) {
          if (params?.signal?.aborted) throw new Error(`Stopped waiting for ${cmdId}`);
          const files = await box.commandFiles(cmdId);
          if (!files) throw new ModalHostNotFound(`No command ${cmdId} in ${box.name}`);
          if (files.exitCode !== null) return { exitCode: files.exitCode };
          await new Promise((r) => setTimeout(r, WAIT_POLL_MS));
        }
      },
      async kill(signal: "SIGTERM" | "SIGKILL" = "SIGTERM") {
        const files = await box.commandFiles(cmdId);
        if (!files || files.exitCode !== null || !(files.pid > 1)) return;
        await box.exec(["bash", "-c", `kill -s ${signal === "SIGKILL" ? "KILL" : "TERM"} ${files.pid} 2>/dev/null; true`]);
      },
    };
  }

  async domain(port: number): Promise<string> {
    const tunnels = await this.sb.tunnels(30_000);
    const t = tunnels[port];
    if (!t) throw new Error(`Port ${port} has no tunnel in ${this.name}.`);
    return t.url;
  }

  /**
   * Ends the sandbox. A persistent one first writes STATE_FILE, snapshots its filesystem and publishes the image under
   * imageNameFor(name), so get({ resume: true }) can bring it back.
   */
  async stop(): Promise<void> {
    if (this.allTags[PERSISTENT_TAG] !== "0") {
      await this.writeFiles([{ path: STATE_FILE, content: `${JSON.stringify({ tags: this.allTags })}\n` }]);
      const image = await this.sb.snapshotFilesystem({ timeoutMs: 120_000, ttlMs: this.imageTtlMs });
      await image.publish(imageNameFor(this.name));
    }
    await this.sb.terminate({ wait: true });
  }

  /** Ends it for good, with the image a stop() published. */
  async delete(): Promise<void> {
    await this.sb.terminate({ wait: true });
    if (this.allTags[PERSISTENT_TAG] !== "0") await deletePublished(this.api, this.name);
  }

  /** The image a copy starts from: a fresh snapshot of this running sandbox. */
  async imageForCopy(): Promise<unknown> {
    return this.api.imageFromId((await this.sb.snapshotFilesystem({ timeoutMs: 120_000, ttlMs: this.imageTtlMs })).imageId);
  }

  /** After a resume: reads STATE_FILE and puts its tags and egress back. Without it, egress stays shut. */
  async restoreState(): Promise<void> {
    const raw = await this.readFileToBuffer({ path: STATE_FILE }).catch(() => null);
    let saved: Record<string, string> | null = null;
    try {
      const parsed = raw ? (JSON.parse(raw.toString("utf8")) as { tags?: unknown }) : null;
      if (parsed?.tags && typeof parsed.tags === "object") saved = parsed.tags as Record<string, string>;
    } catch {
      saved = null;
    }
    if (!saved) {
      console.warn(`Modal sandbox ${this.name} resumed without ${STATE_FILE}, so its egress stays shut.`);
      return;
    }
    const egress = decodeEgress(saved[EGRESS_TAG]);
    await this.sb.updateNetworkPolicy(updateEgress(egress));
    this.allTags = { ...saved, [EGRESS_TAG]: encodeEgress(egress), [EXPIRES_TAG]: this.allTags[EXPIRES_TAG] ?? "" };
    await this.sb.setTags(this.allTags);
  }
}

/** Deletes the image stop() published for a sandbox. One that isn't there is fine. */
async function deletePublished(api: ModalApi, sandboxName: string): Promise<void> {
  try {
    const image = await api.imageFromName(imageNameFor(sandboxName));
    await api.deleteImage(image.imageId);
  } catch (err) {
    if (!isModalNotFound(err) && !isDeletedImage(err)) throw err;
  }
}

/** A sandbox that isn't running but left a published image: enough to see it is stopped, and to delete it. */
class StoppedModalSandbox implements HostSandbox {
  readonly tags = undefined;
  readonly status = "stopped";
  readonly expiresAt = undefined;
  constructor(
    private readonly api: ModalApi,
    readonly name: string,
  ) {}
  private stopped(): never {
    throw new Error(`Modal sandbox ${this.name} is stopped. Open it with resume to use it.`);
  }
  async extendTimeout(): Promise<void> {
    this.stopped();
  }
  async update(): Promise<void> {
    this.stopped();
  }
  async writeFiles(): Promise<void> {
    this.stopped();
  }
  async readFileToBuffer(): Promise<Buffer | null> {
    this.stopped();
  }
  runCommand(params: HostRunParams & { detached: true }): Promise<HostCommand>;
  runCommand(params: HostRunParams): Promise<HostCommandResult>;
  async runCommand(): Promise<HostCommand | HostCommandResult> {
    this.stopped();
  }
  async getCommand(): Promise<HostCommand> {
    throw new ModalHostNotFound(`Modal sandbox ${this.name} is stopped, so it runs no commands.`);
  }
  domain(): string {
    this.stopped();
  }
  async stop(): Promise<void> {}
  async delete(): Promise<void> {
    await deletePublished(this.api, this.name);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The host

export function createModalHost(load: () => Promise<ModalApi>, config: ModalHostConfig): SandboxHostApi {
  let api: Promise<ModalApi> | null = null;
  const modal = () =>
    (api ??= load().catch((err) => {
      api = null;
      throw err;
    }));

  async function make(
    m: ModalApi,
    image: unknown,
    spec: { name: string; tags: Record<string, string>; vcpus: number; ports: number[]; timeoutMs: number; egress: ModalEgress; persistent: boolean; createEgress?: ModalEgress },
  ): Promise<ModalHostSandbox> {
    const timeoutMs = Math.max(spec.timeoutMs, config.timeoutMs);
    const tags: Record<string, string> = {
      ...spec.tags,
      [EGRESS_TAG]: encodeEgress(spec.egress),
      [EXPIRES_TAG]: String(Date.now() + timeoutMs),
      [PERSISTENT_TAG]: spec.persistent ? "1" : "0",
    };
    const sb = await m.create(image, {
      name: spec.name,
      tags,
      cpu: spec.vcpus / VCPUS_PER_CORE,
      memoryMiB: spec.vcpus * MIB_PER_VCPU,
      timeoutMs,
      encryptedPorts: spec.ports,
      ...createEgress(spec.createEgress ?? spec.egress),
    });
    return new ModalHostSandbox(m, sb, spec.name, tags, true, config.imageTtlMs);
  }

  /** The published image of a stopped sandbox, or null when it has none. */
  async function published(m: ModalApi, name: string): Promise<ModalImage | null> {
    try {
      return await m.imageFromName(imageNameFor(name));
    } catch (err) {
      if (isModalNotFound(err)) return null;
      throw err;
    }
  }

  async function get(params: { name: string; resume?: boolean }): Promise<HostSandbox> {
    const m = await modal();
    try {
      const sb = await m.fromName(params.name);
      const [tags, exit] = await Promise.all([sb.getTags(), sb.poll()]);
      if (exit === null) return new ModalHostSandbox(m, sb, params.name, tags, true, config.imageTtlMs);
    } catch (err) {
      // Not running, or just ended ("The Sandbox is unavailable").
      if (!isModalNotFound(err)) throw err;
    }
    const image = await published(m, params.name);
    if (!image) throw new ModalHostNotFound(`No Modal sandbox named ${params.name}.`);
    if (!params.resume) return new StoppedModalSandbox(m, params.name);
    // Egress starts shut and opens to what the sandbox had once it has read STATE_FILE.
    let box: ModalHostSandbox;
    try {
      box = await make(m, image, { name: params.name, tags: {}, vcpus: 4, ports: [3000], timeoutMs: config.timeoutMs, egress: SHUT_EGRESS, persistent: true });
    } catch (err) {
      if (isDeletedImage(err)) throw new ModalHostNotFound(`Modal sandbox ${params.name} was deleted.`);
      throw err;
    }
    await box.restoreState();
    return box;
  }

  return {
    name: "modal",
    get,
    async getOrCreate(params: HostCreateParams) {
      if (!params.name) throw new Error("A Modal build sandbox needs a name.");
      try {
        return await get({ name: params.name, resume: true });
      } catch (err) {
        if (!isModalNotFound(err)) throw err;
      }
      const m = await modal();
      const source = (params as { source?: { type?: string; snapshotId?: string } }).source;
      const imageId = source?.type === "snapshot" ? source.snapshotId : undefined;
      return make(m, imageId ? await m.imageFromId(imageId) : m.imageFromRegistry(BASE_IMAGE), {
        name: params.name,
        tags: params.tags ?? {},
        vcpus: params.resources?.vcpus ?? 4,
        ports: params.ports ?? [],
        timeoutMs: params.timeout ?? 0,
        egress: modalEgress(params.networkPolicy),
        persistent: (params as { persistent?: boolean }).persistent !== false,
      });
    },
    async fork(params: HostForkParams) {
      const p = params as { sourceSandbox: string; name?: string; persistent?: boolean; timeout?: number; networkPolicy?: NetworkPolicy; tags?: Record<string, string> };
      if (!p.name) throw new Error("A Modal fork needs a name.");
      const m = await modal();
      const source = await get({ name: p.sourceSandbox });
      const image = source instanceof ModalHostSandbox ? await source.imageForCopy() : await published(m, p.sourceSandbox);
      if (!image) throw new ModalHostNotFound(`No Modal sandbox named ${p.sourceSandbox} to copy.`);
      return make(m, image, {
        name: p.name,
        tags: p.tags ?? {},
        vcpus: 4,
        ports: [3000],
        timeoutMs: p.timeout ?? 0,
        egress: modalEgress(p.networkPolicy),
        persistent: p.persistent !== false,
      });
    },
    isNotFound: isModalNotFound,
  };
}

/** The real SDK behind ModalApi. The client reads MODAL_TOKEN_ID and MODAL_TOKEN_SECRET, or the local Modal login. */
export async function loadModalSdk(appName: string): Promise<ModalApi> {
  const { ModalClient } = await import("modal");
  const client = new ModalClient();
  const app = await client.apps.fromName(appName, { createIfMissing: true });
  return {
    create: (image, params) => client.sandboxes.create(app, image as Parameters<typeof client.sandboxes.create>[1], params) as unknown as Promise<ModalSb>,
    fromName: (name) => client.sandboxes.fromName(appName, name) as unknown as Promise<ModalSb>,
    imageFromId: (id) => client.images.fromId(id),
    imageFromName: (name) => client.images.fromName(name),
    imageFromRegistry: (tag) => client.images.fromRegistry(tag),
    deleteImage: (id) => client.images.delete(id),
  };
}
