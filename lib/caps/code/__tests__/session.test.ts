/**
 * The code cap's stand-in launcher (lib/caps/code/session.ts) against a fake @vercel/sandbox: a create that stalls is
 * given up after its own timeout, every later call carries the session's deadline, and stopping never hangs. Without
 * that, a stalled create outlives the route's maxDuration and its slots stay held (docs/CAPABILITIES.md, 15a).
 *
 *   npx tsx --test --experimental-test-module-mocks lib/caps/code/__tests__/session.test.ts
 */
import assert from "node:assert/strict";
import { before, describe, it, mock } from "node:test";
import type { LaunchSession, SessionSpec } from "@/lib/caps/code/session";

const seen: { create: Array<{ signal?: AbortSignal }>; calls: Array<{ what: string; signal?: AbortSignal }> } = { create: [], calls: [] };
let createStalls = false;

/** Waits until the signal aborts, as a request to a stalled API would. */
const hang = (signal?: AbortSignal) =>
  new Promise<never>((_resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  });

class FakeSandbox {
  static async create(params: { signal?: AbortSignal }) {
    seen.create.push(params);
    if (createStalls) return hang(params.signal);
    return new FakeSandbox();
  }
  async writeFiles(_files: unknown, opts?: { signal?: AbortSignal }) {
    seen.calls.push({ what: "writeFiles", signal: opts?.signal });
  }
  async runCommand(params: { signal?: AbortSignal }) {
    seen.calls.push({ what: "runCommand", signal: params.signal });
    return { exitCode: 0, stdout: async () => "", stderr: async () => "" };
  }
  async readFileToBuffer(_file: unknown, opts?: { signal?: AbortSignal }) {
    seen.calls.push({ what: "readFileToBuffer", signal: opts?.signal });
    return Buffer.from("x");
  }
  async stop(opts?: { signal?: AbortSignal }) {
    seen.calls.push({ what: "stop", signal: opts?.signal });
  }
  async delete(opts?: { signal?: AbortSignal }) {
    seen.calls.push({ what: "delete", signal: opts?.signal });
  }
}

let launchSession: LaunchSession;
before(async () => {
  mock.module("@vercel/sandbox", { namedExports: { Sandbox: FakeSandbox } });
  ({ launchSession } = await import("@/lib/caps/code/session"));
});

const spec = (over: Partial<SessionSpec> = {}): SessionSpec => ({
  purpose: "exec",
  snapshotId: null,
  networkPolicy: "deny-all",
  vcpus: 1,
  timeoutMs: 60_000,
  createTimeoutMs: 30_000,
  deadlineMs: 70_000,
  productId: "p1",
  ...over,
});

describe("launchSession", () => {
  it("gives up a create that stalls after createTimeoutMs, so the route's finally blocks still run", async () => {
    createStalls = true;
    const started = Date.now();
    // AbortSignal.timeout doesn't keep the process up on its own; a real create's open request does.
    const alive = setTimeout(() => undefined, 5_000);
    await assert.rejects(launchSession(spec({ createTimeoutMs: 50 })));
    clearTimeout(alive);
    assert.ok(Date.now() - started < 2_000, "well before any route's maxDuration");
    assert.ok(seen.create.at(-1)!.signal, "create got a signal");
    createStalls = false;
  });

  it("passes the session's deadline to every call, and stopping and deleting each get a time limit of their own", async () => {
    seen.calls.length = 0;
    const session = await launchSession(spec());
    await session.writeFiles([{ path: "/tmp/a", content: Buffer.from("1") }]);
    await session.run("bash", ["/tmp/a"], { timeoutMs: 1_000 });
    await session.readFile("/tmp/a");
    for (const what of ["writeFiles", "runCommand", "readFileToBuffer"]) {
      assert.ok(seen.calls.find((c) => c.what === what)?.signal instanceof AbortSignal, what);
    }
    const stop = seen.calls.length;
    await session.stop();
    assert.deepEqual(seen.calls.slice(stop).map((c) => c.what), ["stop", "delete"]);
    assert.ok(seen.calls.slice(stop).every((c) => c.signal instanceof AbortSignal));
  });
});
