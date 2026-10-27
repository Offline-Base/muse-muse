/**
 * Runs the platform on this machine: `npm run dev:local`, then open http://localhost:3000.
 *
 *   Database  PGlite in .data/pglite (DATABASE_URL=pglite:.data/pglite) unless DATABASE_URL is set.
 *   Files     .data/files, served at /api/files, unless BLOB_READ_WRITE_TOKEN is set (lib/local-files.ts).
 *   Sign-in   Off for localhost (OPEN_ACCESS=admin unless set).
 *   Builds    Still run in Vercel Sandbox. The sandbox can't reach this machine, so products call Meta directly through
 *             the build firewall's brokered key instead of the gateway (env.gatewayUrl), and media Meta can't
 *             download from localhost goes inline (lib/brief/media.ts inlineMedia).
 *
 * Needs MODEL_API_KEY, VERCEL_OIDC_TOKEN (from `vercel env pull`, good for 12 hours) and BUILDER_SNAPSHOT_ID in
 * .env.local. Products aren't published to their own link from here, even with VERCEL_TOKEN set (env.publishOffReason).
 */
import { spawn, spawnSync } from "node:child_process";

const PORT = Number(process.env.PORT || 3000);
const childEnv: NodeJS.ProcessEnv = { ...process.env, PORT: String(PORT) };
childEnv.DATABASE_URL ||= "pglite:.data/pglite";
childEnv.OPEN_ACCESS ||= "admin";
childEnv.PLATFORM_URL = `http://localhost:${PORT}`;
if (!childEnv.BLOB_READ_WRITE_TOKEN) childEnv.NEXT_PUBLIC_LOCAL_FILES = "1";
for (const name of ["MODEL_API_KEY", "VERCEL_OIDC_TOKEN", "BUILDER_SNAPSHOT_ID"]) {
  if (!childEnv[name]) console.warn(`dev:local: ${name} is not set in .env.local, so builds won't run.`);
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
