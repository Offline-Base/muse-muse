import { connectBlock, connectBuildBlock, type ConnectBrief } from "@/lib/caps/connect/brief";
import type { ConnectDeps } from "@/lib/caps/connect/handler";
import { connectStore } from "@/lib/caps/connect/store";
import { liveBrief } from "@/lib/caps/data/store";
import { buildBrief, capProduct, capToken } from "@/lib/caps/store";
import { env } from "@/lib/env";
import { hitRateLimits, reserveCounter } from "@/lib/gateway/store";
import { holdJobSend } from "@/lib/caps/jobs/held";
import { jobsStore } from "@/lib/caps/jobs/store";
import { parseKeyring } from "@/lib/secrets/box";
import { recordUsage } from "@/lib/usage";

/**
 * What a live product may reach: the brief it shipped with, narrowed by its manifest's `connect` block, which the
 * product wrote and so can only take things away (docs/CAPABILITIES.md, 11a). No block in the manifest leaves the
 * brief's as it is; verify's manifest check keeps the two equal.
 */
export function narrowConnect(brief: ConnectBrief | null, manifest: unknown): ConnectBrief | null {
  if (!brief) return null;
  const m = (manifest as { connect?: { publicApis?: unknown; keys?: unknown; sends?: unknown } } | null)?.connect;
  if (!m || typeof m !== "object") return brief;
  const ids = (v: unknown) => new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  const [apis, keys, sends] = [ids(m.publicApis), ids(m.keys), ids(m.sends)];
  return {
    publicApis: brief.publicApis.filter((a) => apis.has(a)),
    keys: brief.keys.filter((k) => keys.has(k.service)),
    sends: brief.sends.filter((s) => sends.has(s.channel)),
  };
}

/** What a live product may reach: the brief it shipped with, narrowed by its manifest's `connect` block. */
export async function liveConnectRules(productId: string, manifest: unknown): Promise<ConnectBrief | null> {
  return narrowConnect(connectBlock((await liveBrief(productId)) as object | null), manifest);
}

/** The connect cap's real wiring: Postgres, the flags and the outside world, read per request. */
export function connectDeps(): ConnectDeps {
  return {
    servedCaps: () => env.servedCaps,
    findToken: capToken,
    product: capProduct,
    adminEmails: env.adminEmails,
    hitRateLimits,
    reserveCounter,
    recordUsage,
    store: connectStore,
    vaultOn: () => env.connectVault,
    sendsOn: () => env.connectSends,
    // Parsed per call, inside the gateway function, and never logged. A malformed key is a paused vault, not a crash.
    keyring: () => {
      try {
        return parseKeyring(env.connectVaultKey);
      } catch {
        console.error("[connect] CONNECT_VAULT_KEY isn't a 32-byte base64 key, so the vault is paused.");
        return null;
      }
    },
    async rules(token, product) {
      // A build gets what its prompt named: keys and sends switched off since the brief was written are left out.
      if (token.scope === "build") return token.buildId ? connectBuildBlock((await buildBrief(token.buildId)) as object | null) : null;
      return liveConnectRules(token.productId, product.manifest);
    },
    fetch: (input, init) => fetch(input, init),
    userAgent: `MuseMuse/1.0 (+${env.platformUrl}; products built on Muse Muse)`,
    // Unit 6: only while the jobs cap is served. Otherwise a job is refused here like anyone who isn't the owner.
    ...(env.servedCaps.includes("jobs") ? { holdSend: holdJobSend, jobRun: jobsStore.getRun } : {}),
  };
}
