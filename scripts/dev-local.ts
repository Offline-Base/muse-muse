/**
 * Runs the platform on this machine: `npm run dev:local`, then open http://localhost:3000.
 *
 *   Database  PGlite in .data/pglite (DATABASE_URL=pglite:.data/pglite) unless DATABASE_URL is set.
 *   Files     .data/files, served at /api/files, unless BLOB_READ_WRITE_TOKEN or BLOB_STORE_ID is set (lib/local-files.ts).
 *   Sign-in   Off for localhost (OPEN_ACCESS=admin unless set).
 *   Builds    Still run in Vercel Sandbox. The sandbox can't reach this machine, so products call Meta directly through
 *             the build firewall's brokered key instead of the gateway (env.gatewayUrl), and media Meta can't
 *             download from localhost goes inline (lib/brief/media.ts inlineMedia).
 *
 * Browsing needs nothing. A build needs MODEL_API_KEY and Vercel Sandbox credentials: VERCEL_OIDC_TOKEN in .env.local
 * (`npx vercel link`, then `npx vercel env pull .env.vercel.local` and copy the line over, good for 12 hours; a plain
 * `vercel env pull` writes over .env.local). Without either, the Make page says so and builds
 * are refused before anything is paid for (lib/quota.ts buildSetupRefusal). BUILDER_SNAPSHOT_ID is optional here:
 * without it the first build installs the toolchain itself, which is slower (lib/sandbox/builder.ts provisionSandbox).
 * Products aren't published to their own link from here, even with VERCEL_TOKEN set (env.publishOffReason).
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const PORT = Number(process.env.PORT || 3000);
const childEnv: NodeJS.ProcessEnv = { ...process.env, PORT: String(PORT) };
childEnv.DATABASE_URL ||= "pglite:.data/pglite";
childEnv.OPEN_ACCESS ||= "admin";
childEnv.PLATFORM_URL = `http://localhost:${PORT}`;
if (!childEnv.BLOB_READ_WRITE_TOKEN?.trim() && !childEnv.BLOB_STORE_ID?.trim()) childEnv.NEXT_PUBLIC_LOCAL_FILES = "1";
if (!childEnv.MODEL_API_KEY?.trim()) console.warn("dev:local: MODEL_API_KEY is not set in .env.local, so builds are off. Browsing works.");
if (!childEnv.VERCEL_OIDC_TOKEN?.trim() && !childEnv.VERCEL_OIDC_TOKEN_FILE?.trim() && !linkedVercelProject()) {
  console.warn("dev:local: no Vercel Sandbox credentials, so builds are off. See the README's Judge path (npx vercel link, then npx vercel env pull .env.vercel.local).");
}
if (!childEnv.BUILDER_SNAPSHOT_ID) console.log("dev:local: no BUILDER_SNAPSHOT_ID, so the first build installs its toolchain itself (slower).");

/** A .vercel/project.json in the nearest folder up with .vercel, the same search lib/quota.ts sandboxCredentialsAvailable makes. */
function linkedVercelProject(): boolean {
  let dir = process.cwd();
  while (dir !== path.dirname(dir)) {
    if (existsSync(path.join(dir, ".vercel"))) return existsSync(path.join(dir, ".vercel", "project.json"));
    dir = path.dirname(dir);
  }
  return false;
}

const migrate = spawnSync("npx", ["tsx", "scripts/migrate.ts"], { env: childEnv, stdio: "inherit" });
if (migrate.status !== 0) process.exit(migrate.status ?? 1);

const next = spawn("npx", ["next", "dev", "-H", "localhost", "-p", String(PORT)], { env: childEnv, stdio: "inherit" });
const stop = (code: number) => {
  next.kill("SIGTERM");
  process.exit(code);
};
process.on("SIGINT", () => stop(130));
process.on("SIGTERM", () => stop(143));
next.on("exit", (code) => process.exit(code ?? 0));

console.log(`\ndev:local: open http://localhost:${PORT} (sign-in is off). Database ${childEnv.DATABASE_URL}.\n`);
