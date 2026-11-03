/**
 * The kill switch for the owner's shared accounts (docs/BUILD_KEYS.md). Removes every shared key's var from every
 * product's Vercel project (musemuse-*). A dry run by default: it lists what it would remove and changes nothing.
 *
 *   npx tsx --env-file=.env.local scripts/keys/revoke-shared.ts                   dry run over every product
 *   npx tsx --env-file=.env.local scripts/keys/revoke-shared.ts --apply           remove them
 *   npx tsx --env-file=.env.local scripts/keys/revoke-shared.ts --apply musemuse-a musemuse-b   only these projects
 *
 * It needs the platform's VERCEL_TOKEN and VERCEL_TEAM_ID (the team the products deploy to), reads them in memory only
 * and prints project and var names, never a value. A product keeps running on its last deployment until it redeploys,
 * and that deployment still has the old values, so revoke each key at its service too: that is what stops it working.
 * Set BUILD_SHARED_KEYS off (or unset) first, so no new build gets them while this runs.
 */
import { revokeShared, vercelRevokeApi } from "@/lib/keys/revoke";
import { sharedKeysOn } from "@/lib/keys/shared";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const only = args.filter((a) => !a.startsWith("--"));
  const token = process.env.VERCEL_TOKEN?.trim();
  if (!token) throw new Error("VERCEL_TOKEN isn't set. It is the platform's token for the team the products deploy to.");
  if (sharedKeysOn()) console.warn("BUILD_SHARED_KEYS is still on here, so new builds would get the keys again. Turn it off on the platform too.");
  const api = vercelRevokeApi(token, process.env.VERCEL_TEAM_ID?.trim() || null);
  const result = await revokeShared(api, { apply, only, log: (line) => console.log(line) });
  const vars = result.plan.reduce((n, p) => n + p.vars.length, 0);
  console.log(
    apply
      ? `Removed ${result.removed} of ${vars} shared var(s) from ${result.plan.length} of ${result.checked} product project(s).`
      : `Dry run: ${vars} shared var(s) on ${result.plan.length} of ${result.checked} product project(s). Run again with --apply to remove them.`,
  );
  for (const f of result.failed) console.error(`couldn't finish ${f.project}: ${f.reason}`);
  console.log("Next: revoke each key at its service, since live deployments keep the old values until they redeploy.");
  if (result.failed.length) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
