import { randomBytes } from "node:crypto";
import { del } from "@vercel/blob";
import { codeBlock } from "@/lib/caps/code/brief";
import type { MuseCodeDeps } from "@/lib/caps/code/musecode/handler";
import { secretValues } from "@/lib/caps/code/musecode/redact";
import { briefOfToken, codeSessionStore, familySpendToday, sessionSpendUsd } from "@/lib/caps/code/musecode/store";
import { launchLongSession, openSession } from "@/lib/caps/code/session";
import { capProduct, capToken } from "@/lib/caps/store";
import { buildTestModel, env } from "@/lib/env";
import { acquireInFlight, hitRateLimits, releaseInFlight, reserveSpend, settleSpend } from "@/lib/gateway/store";
import { revokeTokenById, storeCodeSessionToken } from "@/lib/gateway/tokens";
import { localFilesEnabled } from "@/lib/local-files";
import { blobAuth, putFile } from "@/lib/storage";
import { builderSpendToday } from "@/lib/trust/spend";
import { platformSpendToday } from "@/lib/usage";

/** Muse Code sessions' real wiring (docs/CAPABILITIES.md, 15b): Postgres, Vercel Sandbox, Blob and the flags, per request. */
export function museCodeDeps(): MuseCodeDeps {
  return {
    servedCaps: () => env.servedCaps,
    findToken: capToken,
    product: capProduct,
    adminEmails: env.adminEmails,
    hitRateLimits,
    acquireInFlight,
    releaseInFlight,
    platformSpendToday,
    builderSpendToday: (userId) => builderSpendToday(userId),
    builderDailyUsd: env.trustSignedInCaps ? env.trustBuilderDailyUsd : null,
    dailySpendCapUsd: env.dailySpendCapUsd,
    reserveSpend,
    settleSpend,
    museCodeOn: () => env.museCodeEnabled,
    visitorsOn: () => env.museCodeVisitors,
    snapshotId: () => env.builderSnapshotId ?? null,
    platformUrl: () => env.platformUrl,
    bypass: () => env.previewBypass ?? null,
    pepper: () => env.gatewayTokenPepper,
    testModel: buildTestModel,
    secrets: (extra) => secretValues(extra),
    briefAllows: async (token) => codeBlock((await briefOfToken(token)) as object | null)?.museCode === true,
    sessions: codeSessionStore,
    launch: launchLongSession,
    open: openSession,
    storeToken: storeCodeSessionToken,
    revokeToken: (id, now) => revokeTokenById(id, now),
    familySpendToday: (id) => familySpendToday(id),
    sessionSpendUsd,
    putResult: (sessionId, zip) => putFile("caps", `code/${sessionId}/${randomBytes(16).toString("hex")}.zip`, zip, "application/zip"),
    fetchFile,
  };
}

/** Deletes one result zip. Local runs keep their files, as deleteOlderThan does. */
export async function deleteResult(url: string): Promise<void> {
  if (localFilesEnabled()) return;
  await del(url, blobAuth());
}

/** A file the task brought by URL: no redirects, at most `maxBytes`, read as a stream so a big one is never read whole. */
async function fetchFile(url: string, maxBytes: number): Promise<Buffer> {
  const res = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(20_000) });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error("too big");
  const parts: Buffer[] = [];
  let total = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.length;
    if (total > maxBytes) throw new Error("too big");
    parts.push(Buffer.from(chunk));
  }
  return Buffer.concat(parts);
}
