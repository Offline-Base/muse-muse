/**
 * Spike 5: how fast a sandbox from the builder snapshot is ready to build.
 *   npx tsx --env-file=.env.local scripts/dev/sandbox-spike5.ts <snapshotId>
 * Times create, `muse --version`, and `npm run dev` answering 200 locally and on the public preview URL.
 */
import { Sandbox, Snapshot } from "@vercel/sandbox";
import { PRODUCT_DIR } from "@/lib/sandbox/paths";
import { sh } from "@/lib/sandbox/shell";

const snapshotId = process.argv[2] || process.env.BUILDER_SNAPSHOT_ID;
if (!snapshotId) throw new Error("usage: sandbox-spike5.ts <snapshotId>");

const t0 = Date.now();
const s = (t = t0) => `${((Date.now() - t) / 1000).toFixed(1)} s`;

const snap = await Snapshot.get({ snapshotId });
console.log(`snapshot ${snap.snapshotId}: ${snap.status}, ${Math.round(snap.sizeBytes / 1e6)} MB, expires ${snap.expiresAt?.toISOString() ?? "never"}`);

const sandbox = await Sandbox.create({
  source: { type: "snapshot", snapshotId },
  persistent: false,
  resources: { vcpus: 4 },
  ports: [3000],
  timeout: 10 * 60_000,
  tags: { app: "musemuse", role: "spike5" },
});
console.log(`create: ${s()}  (${sandbox.name})`);
try {
  let t = Date.now();
  const v = await sh(sandbox, 'PATH="$HOME/.local/bin:$PATH" MUSE_NO_AUTO_UPDATE=1 MUSE_LOGIN=0 muse --version; echo HOME=$HOME; whoami; cat /vercel/musemuse/builder.json');
  console.log(`muse --version: ${s(t)} after create, ${s()} total\n${v.stdout.trim()}`);

  t = Date.now();
  await sandbox.runCommand({ cmd: "npm", args: ["run", "dev"], cwd: PRODUCT_DIR, detached: true });
  const wait = await sh(
    sandbox,
    'for i in $(seq 1 120); do c=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 http://localhost:3000/); [ "$c" = 200 ] && { echo "200 after $i tries"; exit 0; }; sleep 0.5; done; echo "last $c"; exit 1',
  );
  console.log(`npm run dev -> 200 on localhost: ${s(t)} after start, ${s()} total (${wait.stdout.trim()})`);

  t = Date.now();
  const res = await fetch(sandbox.domain(3000));
  const html = await res.text();
  console.log(`public ${sandbox.domain(3000)} -> ${res.status} in ${s(t)}, footer present: ${html.includes("Built with Muse Muse")}`);
} finally {
  await sandbox.stop().catch(() => {});
  await sandbox.delete().catch((e) => console.warn("delete:", String(e)));
  console.log(`stopped and deleted, ${s()} total`);
}
