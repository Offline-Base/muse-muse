/**
 * Flashes paid flash drive orders on the owner's Mac (docs/VIBE_TUNING.md, Feature 6, "Fulfillment"), one per run. Plug
 * the sticks into a powered USB hub, so the hub doesn't brown them out.
 *
 *   npx tsx --env-file-if-exists=.env.local scripts/drive-bench.ts          flash the next paid order
 *   npx tsx --env-file-if-exists=.env.local scripts/drive-bench.ts disks    list the sticks it would offer, changing nothing
 *   npx tsx --env-file-if-exists=.env.local scripts/drive-bench.ts token    print a new bench token and its hash
 *
 * Settings, in .env.local on the bench Mac. The bench needs no platform secret, so keep only these there (never a
 * `vercel env pull`):
 *   DRIVE_BENCH_TOKEN     the bench token. The platform keeps only its hash, as DRIVE_BENCH_TOKEN_HASH.
 *   DRIVE_BENCH_PLATFORM  the platform's origin, such as https://muse-muse.vercel.app (PLATFORM_URL when unset). https
 *                         only, so the token never crosses the network in the clear (plain http only on localhost).
 *   DRIVE_BENCH_CACHE     where model files and llama.cpp downloads are kept (~/MuseMuseDrives by default). A new
 *                         model is a 54 GB download once; each file is checked against its sha256 every time.
 *
 * It lists only removable USB disks the size of a stick, with what each holds, erases one only after you type its disk
 * id (and, when it holds files, its volume's name), writes the image, the model files, PROVENANCE.json and SHA256SUMS,
 * strips extended attributes, ejects it, and once you have unplugged it and plugged it back in, reads every file back
 * and reports PASS or FAIL. A FAIL never ships.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { cachedModelFile, diskLine, flashNext, imageModelOf, macDiskOps, offerableDisks, platformClient } from "@/lib/drive/bench";
import { buildDriveImage } from "@/lib/drive/image";
import { benchTokenHash, newBenchToken } from "@/lib/drive/token";
import { env } from "@/lib/env";

function cacheDir(): string {
  return process.env.DRIVE_BENCH_CACHE?.trim() || path.join(os.homedir(), "MuseMuseDrives");
}

function newToken(): void {
  // Its plain SHA-256 is the hash (lib/drive/token.ts), so making a pair needs no platform secret on this Mac.
  const token = newBenchToken();
  console.log("On this Mac, in .env.local (keep it secret):");
  console.log(`DRIVE_BENCH_TOKEN=${token}`);
  console.log("");
  console.log("On the platform (Vercel), only the hash:");
  console.log(`DRIVE_BENCH_TOKEN_HASH=${benchTokenHash(token)}`);
}

async function listSticks(): Promise<void> {
  const disks = await macDiskOps().listDisks();
  const offered = new Set(offerableDisks(disks, 0).map((d) => d.id));
  if (!disks.length) console.log("No external disks are plugged in.");
  for (const d of disks) {
    const why = offered.has(d.id) ? "would be offered" : "never offered: not a removable USB stick of 32 or 64 GB";
    console.log(`${diskLine(d)}  ${d.protocol}  ${why}`);
  }
}

async function flash(): Promise<number> {
  const token = process.env.DRIVE_BENCH_TOKEN?.trim();
  if (!token) throw new Error("DRIVE_BENCH_TOKEN isn't set. `scripts/drive-bench.ts token` makes one.");
  const origin = process.env.DRIVE_BENCH_PLATFORM?.trim() || env.platformUrl;
  const cache = cacheDir();
  const workDir = path.join(cache, "work");
  await fs.mkdir(workDir, { recursive: true });
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const outcome = await flashNext({
      platform: platformClient(origin, token),
      disks: macDiskOps(),
      ask: (q) => rl.question(q),
      say: (line) => console.log(line),
      modelFile: (order, file) => cachedModelFile(cache, order, file),
      buildImage: (order, dir) =>
        buildDriveImage(imageModelOf(order), { outDir: dir, cacheDir: cache, log: (l) => console.log(l), contact: order.contact ?? null }),
      workDir,
    });
    console.log("");
    if (outcome.result === "none") return 0;
    if (outcome.result === "stopped") {
      console.log(outcome.reason);
      return 1;
    }
    if (outcome.result === "PASS") {
      console.log(`PASS. Label the stick ${outcome.serial} and ship it, then enter the tracking number at ${origin}/fine-tuning/orders.`);
      return 0;
    }
    console.log("FAIL. Don't ship this stick. The order is back in the queue: run this again with another stick.");
    for (const p of outcome.problems.slice(0, 20)) console.log(`  ${p}`);
    return 2;
  } finally {
    rl.close();
  }
}

async function main(): Promise<number> {
  if (process.platform !== "darwin") throw new Error("The bench runs on a Mac: it uses diskutil.");
  const command = process.argv[2] ?? "flash";
  if (command === "token") {
    newToken();
    return 0;
  }
  if (command === "disks") return listSticks().then(() => 0);
  if (command === "flash") return flash();
  throw new Error(`Unknown command ${command}. Use flash, disks or token.`);
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
