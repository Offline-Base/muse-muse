import { env } from "@/lib/env";
import type { SandboxHostApi } from "@/lib/sandbox/host/types";
import { vercelHost } from "@/lib/sandbox/host/vercel";

export type { HostCommand, HostSandbox, SandboxHostApi } from "@/lib/sandbox/host/types";

const MIN = 60_000;
/** A Modal sandbox can't be extended, so it starts with this much: past a first build with its fix rounds. */
const MODAL_TIMEOUT_MS = 3 * 60 * MIN;
/** How long a stopped product's image is kept on Modal, as Vercel keeps its last snapshots. */
const MODAL_IMAGE_TTL_MS = 30 * 24 * 60 * MIN;

let modalHost: SandboxHostApi | null = null;

/** The build host SANDBOX_HOST picks: Vercel Sandbox unless it says "modal". */
export function sandboxHost(): SandboxHostApi {
  if (env.sandboxHost !== "modal") return vercelHost;
  return (modalHost ??= lazyModal());
}

/** True when builds run on Modal. */
export function onModal(): boolean {
  return env.sandboxHost === "modal";
}

/** Loads the Modal module (and its SDK) only when a build first asks for it, so the default host never imports it. */
function lazyModal(): SandboxHostApi {
  const real = import("@/lib/sandbox/host/modal").then((m) =>
    m.createModalHost(() => m.loadModalSdk(env.modalAppName), { timeoutMs: MODAL_TIMEOUT_MS, imageTtlMs: MODAL_IMAGE_TTL_MS }),
  );
  return {
    name: "modal",
    get: async (p) => (await real).get(p),
    getOrCreate: async (p) => (await real).getOrCreate(p),
    fork: async (p) => (await real).fork(p),
    isNotFound: (err) => {
      const name = (err as { name?: string } | null)?.name ?? "";
      return name === "NotFoundError" || name === "ModalHostNotFound" || name === "SandboxFilesystemNotFoundError";
    },
  };
}

/** Either host's "not found", so code that may see both (a build started before the flag changed) handles each. */
export function isHostNotFound(err: unknown): boolean {
  return vercelHost.isNotFound(err) || (onModal() && sandboxHost().isNotFound(err));
}
