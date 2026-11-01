// Platform file (Muse Muse platform services). Don't edit: call it from route handlers and server actions.
//
// The product owner's own keys for outside services, kept by Muse Muse ({GATEWAY_URL}/vault). The product never holds
// a key: `call` names the key, and the gateway adds it to the call on its own servers, only to that service's own
// host and the calls it allows. Saving and listing are the owner's (opened from Muse Muse). In a build a call answers
// with a made-up sample in the service's shape.
import type { RequestLike } from "@/lib/meta/client";
import { CapError, gatewayCall } from "@/lib/platform/connect";

export { CapError };

export interface SavedKey {
  name: string;
  service: string;
  label: string;
  savedAt: string;
}

export interface WantedService {
  service: string;
  label: string;
  /** What kind of key to paste, in plain words. */
  keyHint: string;
  docs: string;
  why: string;
}

export interface KeyList {
  keys: SavedKey[];
  /** The services this product was built to use, for KeySettings. */
  services: WantedService[];
}

export interface CallAnswer<T = unknown> {
  status: number;
  data: T;
  simulated?: boolean;
}

export function secrets(request?: RequestLike | null) {
  return {
    /** Which keys are saved. Names and dates only: a key is never shown again. The owner's only. */
    list(): Promise<KeyList> {
      return gatewayCall<KeyList>(request, "GET", "/vault");
    },
    /** Saves the owner's key for a service. The owner's only. */
    async save(service: string, value: string, name?: string): Promise<{ name: string; label: string }> {
      return gatewayCall(request, "POST", "/vault", { service, value, ...(name ? { name } : {}) });
    },
    /** Removes a saved key. The owner's only. */
    async remove(name: string): Promise<void> {
      await gatewayCall(request, "DELETE", `/vault/${encodeURIComponent(name)}`);
    },
    /**
     * Calls a service with the owner's saved key, named by its service ("github"). Throws CapError `needs_key` when
     * none is saved yet: show the owner where to add it.
     */
    async call<T = unknown>(name: string, opts: { method?: "GET" | "POST"; path: string; body?: Record<string, unknown> }): Promise<CallAnswer<T>> {
      const reply = await gatewayCall<CallAnswer<T> & { ok: boolean; code?: string; label?: string }>(request, "POST", "/vault/call", {
        name,
        method: opts.method ?? "GET",
        path: opts.path,
        ...(opts.body ? { body: opts.body } : {}),
      });
      if (reply.code === "needs_key") throw new CapError("needs_key", 409, `Add a ${reply.label ?? name} key in this product's settings first.`);
      return { status: reply.status, data: reply.data, ...(reply.simulated ? { simulated: true } : {}) };
    },
  };
}
