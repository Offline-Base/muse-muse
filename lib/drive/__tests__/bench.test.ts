/**
 * The bench (lib/drive/bench.ts) against a fake platform and a temporary folder standing in for the stick, behind a fake
 * DiskOps: no real disk is listed, erased, written or ejected here. Only removable USB disks of a stick's size are
 * offered (never the Mac's own disk, read from this Mac's real diskutil answer), and nothing is erased unless the owner
 * types a listed id. A flashed stick holds the image, the model files, PROVENANCE.json with the order's serial and
 * SHA256SUMS, which shasum checks; the order is claimed before the erase and reported after a replug. A file that reads
 * back wrong, an extra file and an interrupted copy are all FAIL, and a FAIL is never reported as PASS. The model cache
 * downloads a file once, checked against its sha256. The platform client sends the bench token and keeps it out of
 * errors. Each stick is listed with what it holds, and one that isn't blank also needs its volume's name typed. The
 * claim comes before the last look at the disk, so a disk swapped in under the stick's id while the claim was in
 * flight (the review's external SSD) is never erased. The token only goes over https, and a call that hangs gives up.
 *
 *   npx tsx --test lib/drive/__tests__/bench.test.ts
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import {
  cachedModelFile,
  checkStick,
  DiskChangedError,
  diskFromInfo,
  diskLine,
  filledVolumes,
  flashNext,
  imageModelOf,
  offerableDisks,
  originProblem,
  platformClient,
  sameDisk,
  volumesFromList,
  type DiskOps,
  type PlatformClient,
  type UsbDisk,
} from "../bench";
import { buildDriveImage, listFiles, sha256File } from "../image";
import { DRIVE_IMAGE_VERSION, type BenchOrder } from "../logic";
import { fakeExtract, fakeFetch, ggufBytes, imageModel, sha, TEST_META, TEST_PIN } from "./fixtures";

const darwin = process.platform === "darwin";
let tmp: string;

/** This Mac's internal SSD as `diskutil info -plist disk0` described it on Oct 28 (only the keys the bench reads). */
const INTERNAL_INFO = {
  DeviceIdentifier: "disk0",
  WholeDisk: true,
  VirtualOrPhysical: "Unknown",
  TotalSize: 1000555581440,
  MediaName: "APPLE SSD AP1024Z",
  BusProtocol: "Apple Fabric",
  RemovableMedia: false,
  Removable: false,
  Ejectable: false,
  Internal: true,
};

/** A new stick, as its maker formatted it: one volume that holds almost nothing. */
const STICK: UsbDisk = {
  id: "disk4",
  name: "SanDisk Ultra",
  bytes: 61_530_439_680,
  protocol: "USB",
  removable: true,
  internal: false,
  identity: "IODeviceTree:/arm-io/usb-drd1@2280000/port1|",
  volumes: [{ name: "SANDISK", usedBytes: 2_490_368 }],
};

const usb = (id: string, name: string, bytes: number, over: Partial<UsbDisk> = {}): UsbDisk => ({
  id,
  name,
  bytes,
  protocol: "USB",
  removable: true,
  internal: false,
  identity: `IODeviceTree:/${id}|`,
  volumes: [],
  ...over,
});

const DISKS: UsbDisk[] = [
  diskFromInfo(INTERNAL_INFO)!,
  STICK,
  usb("disk5", "Big stick", 128_000_000_000),
  usb("disk6", "Small stick", 15_500_000_000),
  usb("disk7", "USB SSD", 64_000_000_000, { removable: false }),
  usb("disk8", "Thunderbolt stick", 64_000_000_000, { protocol: "Thunderbolt" }),
];

function order(over: Partial<BenchOrder> = {}): BenchOrder {
  const m = imageModel();
  return {
    id: "0a1b2c3d-4e5f-4061-8071-8091a0b1c2d3",
    status: "paid",
    serial: "MM-0A1B2C3D4E5F",
    imageVersion: DRIVE_IMAGE_VERSION,
    build: "all",
    trainingJobId: m.adapterJobId,
    repo: m.repo,
    commit: m.commit,
    files: m.files,
    model: { title: m.title, slug: m.slug, systemLine: m.systemLine, needsTunedTemplate: false, quantJobId: m.quantJobId },
    ...over,
  };
}

interface FakePlatform extends PlatformClient {
  calls: Array<{ fn: string; args: unknown[] }>;
  queue: BenchOrder[];
}

function fakePlatform(queue: BenchOrder[] = [order()]): FakePlatform {
  const calls: FakePlatform["calls"] = [];
  return {
    calls,
    queue,
    next: async () => {
      calls.push({ fn: "next", args: [] });
      return queue[0] ?? null;
    },
    claim: async (...args) => void calls.push({ fn: "claim", args }),
    report: async (...args) => void calls.push({ fn: "report", args }),
  };
}

interface FakeDisks extends DiskOps {
  stickDir: string;
  calls: string[];
  /** Runs while the stick is "unplugged", to change what it holds when it comes back. */
  onReplug?: (dir: string) => Promise<void>;
}

/** DiskOps over a folder: erasing empties it, ejecting and the replug only record that they happened. */
function fakeDisks(stickDir: string, disks: UsbDisk[] = DISKS): FakeDisks {
  const calls: string[] = [];
  const ops: FakeDisks = {
    stickDir,
    calls,
    listDisks: async () => {
      calls.push("list");
      return disks;
    },
    info: async (id) => disks.find((d) => d.id === id) ?? null,
    erase: async (disk, label) => {
      calls.push(`erase ${disk.id} ${label}`);
      assert.equal(disk.id, STICK.id, "only the stick is ever erased");
      await fs.rm(stickDir, { recursive: true, force: true });
      await fs.mkdir(stickDir);
      return stickDir;
    },
    strip: async (mount) => {
      calls.push(`strip ${mount}`);
      for (const rel of await listFiles(mount)) if (path.basename(rel).startsWith("._")) await fs.rm(path.join(mount, rel));
    },
    eject: async (id) => void calls.push(`eject ${id}`),
    waitForReplug: async (id, label) => {
      calls.push(`replug ${id} ${label}`);
      await ops.onReplug?.(stickDir);
      return { id, mountPoint: stickDir };
    },
  };
  return ops;
}

async function freshDir(name: string): Promise<string> {
  return fs.mkdtemp(path.join(tmp, `${name}-`));
}

/** Everything flashNext needs, with the model files written small into a cache. */
async function deps(platform: FakePlatform, disks: FakeDisks, answer: string | string[] = STICK.id) {
  const cache = await freshDir("cache");
  const said: string[] = [];
  const asked: string[] = [];
  // One answer for every question, or one per question in turn.
  const answers = Array.isArray(answer) ? [...answer] : null;
  return {
    said,
    asked,
    deps: {
      platform,
      disks,
      ask: async (q: string) => {
        asked.push(q);
        return answers ? (answers.shift() ?? "") : (answer as string);
      },
      say: (line: string) => void said.push(line),
      modelFile: async (_o: BenchOrder, f: BenchOrder["files"][number]) => {
        const file = path.join(cache, f.name);
        await fs.writeFile(file, ggufBytes(f.level));
        return file;
      },
      buildImage: (o: BenchOrder, dir: string) =>
        buildDriveImage(imageModelOf(o), { outDir: dir, cacheDir: cache, fetchImpl: fakeFetch(), extract: fakeExtract, pin: TEST_PIN, metaFiles: TEST_META }),
      workDir: await freshDir("work"),
      now: () => new Date("2026-10-30T15:00:00Z"),
    },
  };
}

describe("the bench", () => {
  before(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "drive-bench-"));
  });
  after(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  let stickDir: string;
  beforeEach(async () => {
    stickDir = await freshDir("stick");
    // Something left on the stick from before, which the erase must clear.
    await fs.writeFile(path.join(stickDir, "old-photo.jpg"), "old");
  });

  describe("which disks it offers", () => {
    it("offers only removable USB disks of a stick's size, never the Mac's own disk", () => {
      const internal = diskFromInfo(INTERNAL_INFO)!;
      assert.equal(internal.internal, true);
      assert.equal(internal.removable, false);
      assert.deepEqual(offerableDisks(DISKS, 54e9).map((d) => d.id), ["disk4"]);
      assert.deepEqual(offerableDisks(DISKS, 62e9).map((d) => d.id), [], "nothing too small for the files");
      const thirtyTwo = { ...STICK, id: "disk9", bytes: 30_750_000_000 };
      assert.deepEqual(offerableDisks([thirtyTwo], 17e9).map((d) => d.id), ["disk9"], "a 32 GB stick for one size");
      assert.deepEqual(offerableDisks([thirtyTwo], 54e9), [], "but not for all three");
    });

    it("reads a disk from diskutil's answer, treating anything unclear as internal", () => {
      assert.equal(diskFromInfo({ ...INTERNAL_INFO, DeviceIdentifier: "disk0s1", WholeDisk: false }), null, "partitions aren't disks");
      assert.equal(diskFromInfo({ ...INTERNAL_INFO, VirtualOrPhysical: "Virtual" }), null, "disk images aren't sticks");
      const usb = diskFromInfo({ DeviceIdentifier: "disk4", WholeDisk: true, TotalSize: 61_530_439_680, MediaName: "SanDisk Ultra", BusProtocol: "USB", Removable: true, Ejectable: true, Internal: false })!;
      assert.deepEqual(offerableDisks([usb], 54e9).map((d) => d.id), ["disk4"]);
      const unclear = diskFromInfo({ DeviceIdentifier: "disk4", WholeDisk: true, TotalSize: 61_530_439_680, BusProtocol: "USB", Removable: true })!;
      assert.equal(unclear.internal, true, "no Internal key: not offered");
      assert.deepEqual(offerableDisks([unclear], 54e9), []);
    });
  });

  describe("flashNext", () => {
    it("writes the image, the model files, PROVENANCE.json and SHA256SUMS, and reports PASS after the replug", async () => {
      const platform = fakePlatform();
      const disks = fakeDisks(stickDir);
      const { deps: d, said } = await deps(platform, disks);
      const outcome = await flashNext(d);
      assert.equal(outcome.result, "PASS", JSON.stringify(outcome));

      assert.deepEqual(platform.calls.map((c) => c.fn), ["next", "claim", "report"], "claimed before the erase, reported after the check");
      assert.deepEqual(platform.calls[1].args, [order().id, "MM-0A1B2C3D4E5F"]);
      assert.deepEqual(disks.calls, ["list", "erase disk4 MUSEMUSE", `strip ${stickDir}`, "eject disk4", "replug disk4 MUSEMUSE", "eject disk4"]);
      const reported = platform.calls[2].args[1] as { serial: string; manifestSha256: string; result: string; imageVersion: string };
      assert.equal(reported.result, "PASS");
      assert.equal(reported.serial, "MM-0A1B2C3D4E5F");
      assert.equal(reported.manifestSha256, await sha256File(path.join(stickDir, "SHA256SUMS")));
      assert.equal(reported.imageVersion, DRIVE_IMAGE_VERSION);

      const files = await listFiles(stickDir);
      assert.equal(files.includes("old-photo.jpg"), false, "erased first");
      for (const f of order().files) assert.ok(files.includes(`model/${f.name}`), f.name);
      for (const name of ["Start Here.html", "Start (Mac).command", "Start (Windows).cmd", "PROVENANCE.json", "SHA256SUMS", "runtime/macos-arm64/llama-server"]) {
        assert.ok(files.includes(name), name);
      }
      const provenance = JSON.parse(await fs.readFile(path.join(stickDir, "PROVENANCE.json"), "utf8"));
      assert.equal(provenance.serial, "MM-0A1B2C3D4E5F");
      assert.equal(provenance.madeAt, "2026-10-30T15:00:00.000Z");
      assert.doesNotMatch(JSON.stringify(provenance), /Ada|ada@|Austin/, "nothing about the buyer goes on the stick");
      if (darwin) {
        const check = spawnSync("/usr/bin/shasum", ["-a", "256", "-c", "SHA256SUMS"], { cwd: stickDir, encoding: "utf8" });
        assert.equal(check.status, 0, check.stdout);
      }
      assert.ok(said.some((l) => l.includes("Unplug the stick, then plug it back in")));
    });

    it("erases nothing unless the owner types a listed disk id", async () => {
      for (const typed of ["", "disk0", "disk5", "DISK4", "/dev/disk4", "disk4 and disk0"]) {
        const platform = fakePlatform();
        const disks = fakeDisks(stickDir);
        const { deps: d, asked } = await deps(platform, disks, typed);
        const outcome = await flashNext(d);
        assert.equal(outcome.result, "stopped", typed);
        assert.match(asked[0], /Type the disk id to ERASE it/);
        assert.equal(disks.calls.some((c) => c.startsWith("erase")), false, `nothing erased for ${JSON.stringify(typed)}`);
        assert.deepEqual(platform.calls.map((c) => c.fn), ["next"], "never claimed");
        assert.ok(await fs.stat(path.join(stickDir, "old-photo.jpg")));
      }
      // Spaces around the id are trimmed: that is still the listed one.
      const { deps: d } = await deps(fakePlatform(), fakeDisks(stickDir), " disk4 ");
      assert.equal((await flashNext(d)).result, "PASS");
    });

    it("stops when the listed stick changed before the erase, or when no stick fits", async () => {
      const platform = fakePlatform();
      const disks = fakeDisks(stickDir);
      disks.info = async () => ({ ...STICK, name: "Another stick" });
      const { deps: d } = await deps(platform, disks);
      const outcome = await flashNext(d);
      assert.equal(outcome.result, "stopped");
      assert.equal(disks.calls.some((c) => c.startsWith("erase")), false);
      assert.deepEqual(platform.calls.map((c) => c.fn), ["next", "claim"], "the claim comes before the last look at the disk");
      assert.match((outcome as { reason: string }).reason, /Nothing was erased\. The order stays claimed for this bench/);

      // The review's race: the owner swaps the stick for an external SSD while the claim is in flight, and macOS gives
      // the SSD the stick's disk id. The last look comes after the claim, so the SSD is never erased.
      const ssd = { ...STICK, name: "Samsung T7 (photos)", bytes: 500_107_862_016, identity: "IODeviceTree:/arm-io/usb-drd1@2280000/port1|7D1A", volumes: [{ name: "PHOTOS", usedBytes: 211e9 }] };
      let plugged: UsbDisk = STICK;
      const swapped = fakeDisks(stickDir, [STICK]);
      swapped.info = async (id) => (plugged.id === id ? plugged : null);
      const racing = fakePlatform();
      racing.claim = async () => void (plugged = ssd);
      const { deps: d3 } = await deps(racing, swapped);
      assert.equal((await flashNext(d3)).result, "stopped");
      assert.equal(swapped.calls.some((c) => c.startsWith("erase")), false, "the SSD that took the stick's id isn't erased");
      // The same stick model swapped in the same port: its identity or volumes differ.
      for (const other of [{ ...STICK, identity: "IODeviceTree:/arm-io/usb-drd1@2280000/port1|5F2C" }, { ...STICK, volumes: [{ name: "CAMERA", usedBytes: 2e6 }] }]) {
        const twin = fakeDisks(stickDir, [STICK]);
        twin.info = async () => other;
        const { deps: d4 } = await deps(fakePlatform(), twin);
        assert.equal((await flashNext(d4)).result, "stopped");
        assert.equal(twin.calls.some((c) => c.startsWith("erase")), false);
      }
      // And the erase's own look, right before diskutil runs, stops it too.
      const late = fakeDisks(stickDir);
      late.erase = async (disk) => {
        late.calls.push(`erase ${disk.id}`);
        throw new DiskChangedError(`${disk.id} isn't the disk that was picked any more.`);
      };
      const { deps: d5 } = await deps(fakePlatform(), late);
      const refused = await flashNext(d5);
      assert.equal(refused.result, "stopped");
      assert.match((refused as { reason: string }).reason, /isn't the disk that was picked any more\. Nothing was erased/);
      assert.ok(await fs.stat(path.join(stickDir, "old-photo.jpg")));

      const none = fakeDisks(stickDir, DISKS.filter((x) => x.id !== "disk4"));
      const { deps: d2 } = await deps(fakePlatform(), none);
      const nothing = await flashNext(d2);
      assert.equal(nothing.result, "stopped");
      assert.match((nothing as { reason: string }).reason, /No USB stick that fits/);
    });

    it("lists what each stick holds, and asks for a volume's name before erasing one that isn't blank", async () => {
      const full = { ...STICK, volumes: [{ name: "PHOTOS", usedBytes: 12_300_000_000 }] };
      for (const typed of ["", "photos", "disk4"]) {
        const disks = fakeDisks(stickDir, [full]);
        const { deps: d, asked, said } = await deps(fakePlatform(), disks, ["disk4", typed]);
        const outcome = await flashNext(d);
        assert.equal(outcome.result, "stopped", typed);
        assert.ok(said.some((l) => l.includes('disk4  SanDisk Ultra  61.5 GB  holds "PHOTOS" (12.3 GB used)')), said.join("\n"));
        assert.match(asked[1], /disk4 isn't blank: it holds "PHOTOS"\. Type PHOTOS to erase it anyway/);
        assert.equal(disks.calls.some((c) => c.startsWith("erase")), false, `nothing erased for ${JSON.stringify(typed)}`);
      }
      const { deps: d } = await deps(fakePlatform(), fakeDisks(stickDir, [full]), ["disk4", "PHOTOS"]);
      assert.equal((await flashNext(d)).result, "PASS", "its name typed: erased");
      // A volume that isn't mounted can't be read, so it counts as holding files; one with no name asks for ERASE.
      const unread = { ...STICK, volumes: [{ name: "", usedBytes: null }] };
      const { deps: d2, asked } = await deps(fakePlatform(), fakeDisks(stickDir, [unread]), ["disk4", "ERASE"]);
      assert.equal((await flashNext(d2)).result, "PASS");
      assert.match(asked[1], /a volume with no name\. Type ERASE/);
      // A blank stick asks once.
      const { deps: d3, asked: once } = await deps(fakePlatform(), fakeDisks(stickDir));
      assert.equal((await flashNext(d3)).result, "PASS");
      assert.equal(once.length, 1);
    });

    it("fails a stick whose file reads back wrong after the replug, and never reports it as PASS", async () => {
      const platform = fakePlatform();
      const disks = fakeDisks(stickDir);
      disks.onReplug = async (dir) => {
        const file = path.join(dir, "model", order().files[1].name);
        const bytes = await fs.readFile(file);
        bytes[10] ^= 0xff;
        await fs.writeFile(file, bytes);
      };
      const { deps: d } = await deps(platform, disks);
      const outcome = await flashNext(d);
      assert.equal(outcome.result, "FAIL");
      assert.deepEqual((outcome as { problems: string[] }).problems, [`model/${order().files[1].name} doesn't match its sha256.`]);
      const reports = platform.calls.filter((c) => c.fn === "report");
      assert.equal(reports.length, 1);
      assert.equal((reports[0].args[1] as { result: string }).result, "FAIL");
    });

    it("fails a stick that comes back with a file nobody wrote, but not for what an OS adds by itself", async () => {
      const platform = fakePlatform();
      const disks = fakeDisks(stickDir);
      disks.onReplug = async (dir) => {
        await fs.mkdir(path.join(dir, ".fseventsd"));
        await fs.writeFile(path.join(dir, ".fseventsd", "fseventsd-uuid"), "x");
        await fs.writeFile(path.join(dir, ".DS_Store"), "x");
        await fs.writeFile(path.join(dir, "autorun.inf"), "[autorun]");
      };
      const { deps: d } = await deps(platform, disks);
      const outcome = await flashNext(d);
      assert.equal(outcome.result, "FAIL");
      assert.deepEqual((outcome as { problems: string[] }).problems, ["autorun.inf isn't on the list."]);
    });

    it("fails an interrupted copy, ejects the stick and reports it", async () => {
      const platform = fakePlatform();
      const disks = fakeDisks(stickDir);
      const { deps: d } = await deps(platform, disks);
      let copies = 0;
      const outcome = await flashNext({
        ...d,
        copy: async (from, to) => {
          copies++;
          if (to.endsWith(".gguf")) {
            await fs.mkdir(path.dirname(to), { recursive: true });
            await fs.writeFile(to, (await fs.readFile(from)).subarray(0, 100));
            throw new Error("EIO: the stick was unplugged");
          }
          await fs.mkdir(path.dirname(to), { recursive: true });
          await fs.copyFile(from, to);
        },
      });
      assert.ok(copies > 1);
      assert.equal(outcome.result, "FAIL");
      assert.match((outcome as { problems: string[] }).problems[0], /The copy stopped: EIO/);
      assert.ok(disks.calls.includes("eject disk4"));
      assert.equal(disks.calls.some((c) => c.startsWith("replug")), false, "nothing to check");
      const report = platform.calls.find((c) => c.fn === "report")!;
      assert.equal((report.args[1] as { result: string }).result, "FAIL");
    });

    it("does nothing when the queue is empty", async () => {
      const disks = fakeDisks(stickDir);
      const { deps: d } = await deps(fakePlatform([]), disks);
      assert.deepEqual(await flashNext(d), { result: "none" });
      assert.deepEqual(disks.calls, []);
    });
  });

  describe("checkStick", () => {
    it("checks SHA256SUMS and PROVENANCE.json are the bench's own", async () => {
      const dir = await freshDir("check");
      await fs.writeFile(path.join(dir, "a.txt"), "a");
      await fs.writeFile(path.join(dir, "SHA256SUMS"), `${sha("a")}  a.txt\n`);
      await fs.writeFile(path.join(dir, "PROVENANCE.json"), JSON.stringify({ serial: "MM-000000000001" }));
      const expected = [
        { path: "a.txt", sha256: sha("a") },
        { path: "PROVENANCE.json", sha256: sha(JSON.stringify({ serial: "MM-000000000001" })) },
      ];
      const manifest = sha(`${sha("a")}  a.txt\n`);
      assert.equal((await checkStick(dir, expected, manifest, "MM-000000000001")).result, "PASS");
      assert.deepEqual((await checkStick(dir, expected, "0".repeat(64), "MM-000000000001")).problems, ["SHA256SUMS isn't the one the bench wrote."]);
      assert.deepEqual((await checkStick(dir, expected, manifest, "MM-000000000002")).problems, ["PROVENANCE.json doesn't name serial MM-000000000002."]);
      await fs.rm(path.join(dir, "a.txt"));
      assert.deepEqual((await checkStick(dir, expected, manifest, "MM-000000000001")).problems, ["a.txt is missing."]);
    });
  });

  describe("the model cache", () => {
    it("downloads a file once from the repo at the order's commit, checked against its sha256", async () => {
      const cache = await freshDir("models");
      const o = order();
      const f = o.files[0];
      const small = { ...f, bytes: ggufBytes(f.level).length };
      const fetchImpl = fakeFetch();
      const file = await cachedModelFile(cache, o, small, fetchImpl);
      assert.equal(await sha256File(file), f.sha256);
      assert.deepEqual(fetchImpl.urls, [`https://huggingface.co/${o.repo}/resolve/${o.commit}/${f.name}`]);
      assert.equal(await cachedModelFile(cache, o, small, fetchImpl), file);
      assert.equal(fetchImpl.urls.length, 1, "the cache answers the second time");

      const wrong = { ...small, sha256: sha("something else") };
      const other = await freshDir("models");
      await assert.rejects(cachedModelFile(other, o, wrong, fakeFetch()), /didn't match its pinned sha256/);
      assert.deepEqual((await listFiles(other)).filter((p) => p.endsWith(".gguf")), [], "nothing left that didn't match");
    });
  });

  describe("telling disks apart", () => {
    it("reads each volume and how much it holds, and counts a stick blank only when nothing in it is the owner's", async () => {
      const list = {
        AllDisksAndPartitions: [
          {
            DeviceIdentifier: "disk4",
            Partitions: [
              { DeviceIdentifier: "disk4s1", Content: "EFI", VolumeName: "EFI" },
              { DeviceIdentifier: "disk4s2", Content: "Microsoft Basic Data", VolumeName: "PHOTOS", MountPoint: "/Volumes/PHOTOS" },
              { DeviceIdentifier: "disk4s3", Content: "Apple_APFS" },
            ],
          },
          { DeviceIdentifier: "disk5", Partitions: [{ DeviceIdentifier: "disk5s1", VolumeName: "SANDISK", MountPoint: "/Volumes/SANDISK" }] },
        ],
      };
      const used = async (mount: string) => (mount === "/Volumes/PHOTOS" ? 12e9 : 2e6);
      const four = await volumesFromList("disk4", list, used);
      assert.deepEqual(four, [{ name: "PHOTOS", usedBytes: 12e9 }, { name: "", usedBytes: null }], "no EFI partition, and an unmounted one is unknown");
      assert.equal(filledVolumes({ volumes: four }).length, 2);
      const five = await volumesFromList("disk5", list, used);
      assert.deepEqual(filledVolumes({ volumes: five }), [], "a new stick's own volume");
      assert.deepEqual(await volumesFromList("disk9", list, used), []);
      assert.equal(diskLine({ ...STICK, volumes: five }), "disk4  SanDisk Ultra  61.5 GB  blank");
    });

    it("takes a disk id for the same disk only with the same name, size, identity and volumes", () => {
      assert.equal(sameDisk(STICK, { ...STICK }), true);
      assert.equal(sameDisk(STICK, { ...STICK, volumes: [{ name: "SANDISK", usedBytes: 9e6 }] }), true, "what a volume holds may change, its name not");
      for (const changed of [null, { ...STICK, id: "disk5" }, { ...STICK, name: "Samsung T7" }, { ...STICK, bytes: 500e9 }, { ...STICK, identity: "x|y" }, { ...STICK, volumes: [] }, { ...STICK, internal: true }]) {
        assert.equal(sameDisk(STICK, changed), false, JSON.stringify(changed));
      }
      const fromInfo = diskFromInfo({ DeviceIdentifier: "disk4", WholeDisk: true, TotalSize: 61_530_439_680, MediaName: "SanDisk Ultra", BusProtocol: "USB", Removable: true, Internal: false, DeviceTreePath: "IODeviceTree:/usb@1", MediaUUID: "AB-CD" })!;
      assert.equal(fromInfo.identity, "IODeviceTree:/usb@1||AB-CD");
    });
  });

  describe("the platform client", () => {
    it("sends the token only over https, and gives up on a platform that doesn't answer", async () => {
      for (const origin of ["http://muse.example.com", "muse.example.com", "https://muse.example.com/path", "ftp://x", ""]) {
        assert.ok(originProblem(origin), origin);
        assert.throws(() => platformClient(origin, "mm_bench_secret", async () => Response.json({})), /isn't an https origin/);
      }
      for (const origin of ["https://muse-muse.vercel.app", "https://muse-muse.vercel.app/", "http://localhost:3000", "http://127.0.0.1:3000"]) {
        assert.equal(originProblem(origin), null, origin);
      }
      // A platform that never answers. AbortSignal.timeout's timer doesn't hold the event loop open, as a real socket
      // would, so the fake holds it until the abort.
      const hung = platformClient("https://muse.example.com", "mm_bench_secret", (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          const open = setTimeout(() => undefined, 10_000);
          init?.signal?.addEventListener("abort", () => {
            clearTimeout(open);
            reject(init.signal!.reason);
          });
        }),
      20);
      await assert.rejects(hung.claim(order().id, "MM-0A1B2C3D4E5F"), (err: Error) => /didn't answer within 0 seconds/.test(err.message) && !err.message.includes("mm_bench_secret"));
    });

    it("sends the bench token to the bench routes and keeps it out of errors", async () => {
      const seen: Array<{ url: string; auth: string | null; body: string | null }> = [];
      const client = platformClient("https://muse.example.com/", "mm_bench_secret", async (url, init) => {
        seen.push({ url: String(url), auth: new Headers(init?.headers).get("authorization"), body: (init?.body as string) ?? null });
        if (String(url).endsWith("/flashed")) return Response.json({ error: "not_flashing", status: "paid" }, { status: 409 });
        if (String(url).endsWith("/next")) return Response.json({ order: order() });
        return Response.json({ order: order() });
      });
      assert.equal((await client.next())?.serial, "MM-0A1B2C3D4E5F");
      await client.claim(order().id, "MM-0A1B2C3D4E5F");
      await assert.rejects(
        client.report(order().id, { serial: "MM-0A1B2C3D4E5F", manifestSha256: "f".repeat(64), result: "PASS", imageVersion: DRIVE_IMAGE_VERSION }),
        (err: Error) => /409 not_flashing/.test(err.message) && !err.message.includes("mm_bench_secret"),
      );
      assert.deepEqual(seen.map((s) => s.url), [
        "https://muse.example.com/api/drive/bench/next",
        `https://muse.example.com/api/drive/bench/${order().id}/flashing`,
        `https://muse.example.com/api/drive/bench/${order().id}/flashed`,
      ]);
      assert.ok(seen.every((s) => s.auth === "Bearer mm_bench_secret"));
      assert.deepEqual(JSON.parse(seen[1].body!), { serial: "MM-0A1B2C3D4E5F" });
    });
  });
});
