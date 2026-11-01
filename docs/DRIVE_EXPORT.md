# Drive export: a fine-tuned model onto a USB drive, from a Jetson

Unit 12 of wave 3 (`~/mm-wt/_plan/wave3.md`). The owner's ask, Oct 31: "fine tune, then plug a flashdrive into a jetson and
have it export the fine tuned model whether it be fine tuned on the jetson or one of the cloud gpus".

Built on branch `tg-cap-drive` (Oct 31 to Nov 1), behind `DRIVE_EXPORT_ENABLED`, off. Not deployed to any board, and the
drive kit isn't uploaded: "Built" below says what exists, what was measured, and what only the owner's real test can show.
The rest of this page is the design it was built from, corrected where the build found it wrong. Marks, as in the other
docs: [V] verified in code or by a real run, [I] inferred or estimated, [S] from a source outside this repo. Flag names and
migration numbers follow `docs/CAPABILITIES.md` (unit 0) where the two differ.

## Built

### What exists

| Part | Files | Tests, and what they show |
| --- | --- | --- |
| One layout for bench drives and exports | `lib/drive/layout.ts`, `kit.ts`, `plan.ts`, and `image.ts` (now the kit plus a plan written into a folder) | `plan.test.ts`, 15: the bench's image is byte for byte what it was before the split, for five fixture models, against `golden/bench-image.json` captured from the old code [V]. A board plan has the adapter, Qwen's license and notice and no Meta words; a lab plan has Meta's; the owner's file is named without its link; the Mac launcher really runs on a board drive and passes `--lora`, copies the adapter and checks it [V, on macOS]; a build's level is escaped in Start Here |
| The drive kit | `lib/drive/kit-files.json` (real, generated Oct 31), `scripts/drive-kit.ts` | 82 files, 120.1 MB once each, from the pinned llama.cpp b11669 archives, Meta's two files and Qwen's license, each checked against its pin [V]. **Not uploaded**: `baseUrl` is null, so the routes answer `drive_kit_missing` until the owner runs `--upload`, commits the `lib/drive/kit-files.json` it writes, and deploys. The routes read the deployed copy, not the laptop's |
| Links | `lib/drive/sources.ts` | `sources.test.ts`, 4: resolve links for public repos, Hub-signed links for private ones asked with `redirect: "manual"`, kit links from Blob, and redaction |
| Board calls and plans | `lib/device/drive.ts`, `lib/device/drive-sim.ts` | `drive.test.ts`, 5: which sources a request may name; a board plan with the **real** kit is 99 files (80 from the kit) and an 87 KB `export_model` call, against the board's 1 MiB [V]; the simulated board ends in PASS |
| Routes | `app/api/device/drive/route.ts`, `app/api/device/drive/erase/route.ts` | `drive-route.test.ts`, 14: 404 and nothing touched with the flag off (not even the session); admin only; a private model's links signed only for Export now, never armed; fresh signed links on GET in `needs_urls`, and nothing sent for a public model's link, which never changes; the owner's file level checked; Carry on's body accepted; no link, token or board address in any answer or log line (this test caught a failure log that carried the board's address). `route.test.ts`: the generic `/api/device` route lists and calls none of the five drive tools, flag off or on (the review's finding 2). `drive-export-script.test.ts`, 1: the owner's script stops before signing anything without `--origin` |
| The card and links | `components/device/DeviceDrive.tsx`, `DriveExportLink.tsx`, `app/device/page.tsx`, `DeviceTrain.tsx`, `app/fine-tuning/[jobId]/page.tsx`, `lib/device/drive-card.ts` | `drive-card.test.ts`, 4: Carry on for an export that failed, stopped or ended in FAIL, on its own drive when it's back or the one picked, and the owner's script for the owner's file. The card itself is type-checked, not seen in a browser: there is no board for it to talk to here |
| The board | `muse-device/drive.py` (about 1,100 lines), five tools in `server.py`, `setup-drive.sh` | `test_drive.py`, 63 (1 skipped off Linux): detection (with LVM, LUKS, md and sysfs holders inside a USB disk, after the review found the old one-level check missed them), plan refusals, the golden plan ending on a fake drive with the same `SHA256SUMS` as Node's, FAT32 and a 5 GB file, NTFS, locked, full, too small, over 256 GB, armed exports that ignore sticks already in and never erase, copies, resume with `Range`, a 200 that starts over, a refused signed link that waits for a fresh one (or the same one sent again), a refused public link retried and then failed instead of waiting, fresh links refused 5 times failing, a hash mismatch, a flipped byte, a missing and an extra file, an unplug mid-write (failed when not armed, resumed when armed), a killed export that carries on, a drive swapped during the unmount before an erase, `export_source` listing only real base builds, the server starting without `drive.py`, and the tools. Ten runs in a row pass, after the tests found a real race (an export finishing while its status was read was recorded as failed). `test_server.py`: Hussam's 76 still pass |
| Loopback | `muse-device/test_drive_loop.py` | **Never ran**: it needs Linux as root |
| The product tools | `lib/device/drive-product.ts`, `drive-product-deps.ts`, the drive branch in `lib/gateway/gadget.ts`, `lib/platform/board.ts` and the skill in the `hardware` overlay | `drive-product.test.ts` and `drive-product-route.test.ts`: see "From a product". Fake boards only: nothing has run on a real board |
| Owner and deploy scripts | `scripts/drive-export.ts` (the owner's S3 file), `scripts/device-bundle.ts` | Never run: one signs with the owner's AWS session, the other uploads to Blob |

Every change in `muse-device/` is listed for Hussam in `muse-device/CHANGES_FOR_HUSSAM.md`.

### Where the build differs from the design below

- **The kit is bigger.** 120 MB once each, and 169 MB written onto each drive, since the two Windows builds each carry their
  own copies of the shared libraries. A board fine-tune's drive is about 0.72 GB, not 0.6 [V, measured from the plan].
- **`DRIVE_IMAGE_VERSION` stays `2026.10.28-b11669`.** Moving it would change the footer of every bench drive's Start Here,
  and bench drives had to stay byte for byte the same. `muse-drive-plan/1` and `PROVENANCE.json`'s `export` tell an export
  from a bench drive.
- **Adapter support in the launchers sits in marked blocks** (`# >>> adapter` to `# <<< adapter`) that a drive without an
  adapter loses whole, so a bench drive's launchers are what they were.
- **`drive_status` also lists the board's finished runs**, since no tool listed runs and the card picks from them.
- **`export_model {export}`** with no plan carries on an export that failed or was stopped, from the plan the board kept.
  The card's **Carry on** button does that (`POST {resume, drive, identity}`): the same export id and folder, keeping every
  file that already hashes right. The owner's own file is carried on by its script (`--resume`), the only place its link
  can be signed again.
- **Only signed links wait in `needs_urls`.** A refused link with no query (the Hub's resolve URL, a kit file) is the same
  link next time, so the board retries it with backoff and then fails in a sentence. `GET` sends only links `freshUrls`
  signed.
- **The erase happens in the export's own process.** `erase_drive` checks the typed word and the identity and leaves a
  confirmation; the export reads the drive once more and formats only if it is still the same one. It works only for an
  export waiting in `needs_erase`.
- **The card lists board runs.** A lab model reaches it through "Put it on a drive" on its admin page, not a list.
- **The owner's script signs in with a session cookie.** Every drive route uses `requireAdmin`, which needs a session, so
  `scripts/drive-export.ts` sends an admin's `mm_session` cookie from `MUSE_SESSION`. It never prints it.
- **The product tools came after unit 13**, behind `DRIVE_EXPORT_PRODUCTS` and the owner check, both off. See "From a product".

### Before the owner's real test

1. The owner uploads the kit: `npx tsx --env-file-if-exists=.env.local scripts/drive-kit.ts --upload` (writes about 120 MB
   to the public Blob store under `drive-kit/`). It writes `baseUrl` into `lib/drive/kit-files.json` in the local checkout:
   commit that file and deploy, since the routes read the deployed copy and answer `drive_kit_missing` until then.
2. Hussam (or a fleet job the owner approves) puts this `muse-device/` on `jetson-02`, runs `setup-drive.sh`, restarts the
   service, and runs `test_drive_loop.py` there once. `scripts/device-bundle.ts` makes the tarball and prints its sha256.
3. `DRIVE_EXPORT_ENABLED=1` on the deployment the owner uses for the test (a preview, by decision 6), then "The one real
   test" below. `scripts/drive-export.ts` has no default site: pass `--origin` with that preview's address. Whether a
   preview's deployment protection lets the script's cookie-only request through is untested; if it answers with Vercel's
   login page, the script needs the preview's protection bypass or a test on the local site.

## What the person does

1. Fine-tunes a model: on the board (`/device`, "Fine-tune on this board") or on a cloud GPU (the lab, `/fine-tuning`).
2. Picks it in the new "Flash drive" card on `/device`, and presses **Export now**, or arms **Export when a drive is
   plugged in**.
3. Plugs a USB stick into the Jetson.
4. Watches the card: drive found, writing, checking, done. When it says "Safe to unplug", the board has powered the drive
   off, so its light goes out.
5. Plugs the stick into a Mac or a Windows PC, opens `Start Here.html`, and double-clicks Start. The model runs there,
   offline, the same way a drive from the bench runs (`docs/VIBE_TUNING.md`, Feature 6).

The board never erases a drive unless the person confirms it in the card. Without that, it only adds one folder.

## What exists today that can be exported

The export never starts a GPU run. It uses files that already exist.

| Model | Where it is | Files | Exportable | Notes |
|---|---|---|---|---|
| Hussam's board fine-tunes on `jetson-02` | `~/models/<run>.gguf` beside `~/models/Qwen3.5-0.8B-<quant>.gguf` | A LoRA adapter GGUF (f32) and the base GGUF | Yes, once this unit lands | Real runs happened there: `server.py` cites a 442-token step at 1.91 GiB and a 60-step run beside `jetson-02`'s LFM3-1.7B [V, comments]. Their names aren't recorded here. `list_models` and `training_status` on the board show them. About 0.6 GB in all [I]. Fits FAT32. |
| Knowledge run r30b, Muse Glimmer 30B (the owner's pick, Oct 31) | The owner's private S3 bucket, `knowledge/models/stage-b-r30b/glimmer-stage-b-r30b-IQ1_S.gguf` | One GGUF, 6,526,418,912 bytes, sha256 `6fbd323c1c9947bcd9f678bdda106fafcc7485aa3c7dd9759ac4250d56a7e561` | Yes, onto the owner's own stick (decision 18), with its duties as a Derivative of Muse Spark Open | Over 4 GiB, so it needs exFAT. 55.3% made up on the held-out honesty test: see "Derivatives of Muse Spark Open". |
| Knowledge run stage 2, Muse Glimmer 30B | The owner's private S3 bucket, `knowledge/models/stage2/glimmer-stage2-IQ1_S.gguf` | One GGUF, 6,526,418,880 bytes, sha256 `23fef56a3bb9c7f3f2e513044cf11c88bf2d3cb3adfbc727c49288cea4fbafb4` [V, `~/muse-muse-devices/lib/devices/subjects.ts`] | Yes, if the owner lets it leave S3 (decision 2) | Over 4 GiB, so it needs exFAT. At IQ1_S it is a pipeline test, not a product: `KNOWLEDGE_UPDATE.md` says 1 to 2 bit Glimmer files aren't usable. |
| Lab Glimmer adapters (run 1, and run 2, job `83d71f74`) | Lambda cache filesystems, `models/<jobId>/`, and the adapter tarball on Blob | Safetensors only | Not yet | llama.cpp can't run a Glimmer LoRA (`VIBE_TUNING.md`, fact 3), and no `glimmer-quantize` job has run on a real GPU (`TRAINING.md`, "Not proven yet"). One quantize job on run 2 (estimated 110 minutes, $3.70) would give real Q3_K_M, Q4_K_M and Q6_K files (decision 3). |
| Meta's base GGUFs, bartowski's quants, the fleet's Bolt and LFM files | Hugging Face, `/opt/jetson-gguf/models` | GGUF | No | Not fine-tunes. A drive of them would carry a false `CHANGES.md`. |

The first real test uses a board fine-tune, so it needs no GPU and no download over 100 MB.

## The flow

```text
platform (Vercel)                                   board (muse-device on a Jetson)
  /device card, lab link, product tool
        |
  POST /api/device/drive {source, mode}
        |-- board source: export_source {run} --------> hashes ~/models files, reads the run's config
        |-- cloud source: localFilesFor(jobId), signs the file URLs
        |-- planDriveImage(...) -> the drive plan (lib/drive/plan.ts)
        |-- export_model {plan, wait_for_drive} ------> drive.py child: wait for a drive, check it,
        |                                                write every file (copy, cache or download),
  GET /api/device/drive (polled every 3 s)               hash as it writes, fsync, unmount, mount again,
        |-- drive_status ----------------------------->  read every file back, unmount, power off
        |-- needs_urls? re-sign, export_model {urls} ->
        |-- needs_erase? the card asks; erase_drive -->
```

The platform calls the board. The board never calls the platform and holds no platform credential.

## Sources

### Tuned on the board

A finished `train_model` run leaves `~/models/<run>.gguf`, an f32 LoRA adapter made by `convert_lora_to_gguf.py` from
llama.cpp b11970 [V, `train.py`, `setup-train.sh`]. It loads only on top of its base's GGUF, `~/models/<base>-<quant>.gguf`,
which `train_model` insists exists before it trains [V].

v1 ships the base GGUF and the adapter side by side, and the launchers pass `--lora`. That is exactly what `start_model`
ran on the board, so what the person tried on the board is what runs on the laptop. Nothing is converted or merged.

A merged file is a later option. The board already has what it takes: PEFT's `merge_and_unload` in `~/train/venv` and
`convert_hf_to_gguf.py` in `~/train/llama.cpp`, which writes `q8_0` without `llama-quantize`. That adds a CPU step and a new
failure mode, and whether the converter handles a merged Qwen3.5 checkpoint is unchecked, so it waits.

The new board tool `export_source {run}` answers, for a run whose state is `done`:

- the adapter: name, bytes, sha256;
- every `<base>-*.gguf` on the board: name, level (the quant in the name), bytes, sha256, and its `.source.json` when
  `install_model` wrote one (below);
- the run's `config.json` (base, dataset name, steps, rank, lr, max_length) and its `status.json` (examples, skipped,
  loss, seconds, peak_gpu_gib);
- the base weights' revision, read from what huggingface_hub records beside them
  (`~/train/models/<base>/.cache/huggingface/download/*.metadata`). `setup-train.sh` pins it to `23c69c53...` [V].

Each sha256 is cached in `~/models/<name>.sha256` with the file's size and mtime, as the bench caches its downloads
[V, `bench.ts` `cachedModelFile`], so a second export hashes nothing. A 0.6 GB hash from an SD card takes about 7 s at
90 MB/s [I].

`install_model` gains one small change: after a download it writes `<name>.source.json` with the URL (query removed), the
bytes and the sha256. Without it, the drive can't say where a base GGUF came from, and says "installed by hand" instead.

### Tuned on a cloud GPU

Lab models reach a drive only as GGUF files that passed their checks: `localFilesFor(adapterJobId)`
[V, `lib/train/local-files-server.ts`], the same contract drive orders use. Those files live in the model's GGUF repo on
the Hugging Face Hub, at a commit, with bytes and sha256 for each. The lab's adapter tarball on Blob is safetensors, which
no laptop launcher runs, so it is never a source.

A private file from the owner (stage 2 in S3) is a third kind of source: `{kind: "url"}` with name, bytes, sha256 and a
provenance block. Only an admin route takes it, and only from the owner's own script (`scripts/drive-export.ts --s3`), which
signs the URL on the laptop with the owner's AWS session. The platform passes it straight to the board and stores it
nowhere.

### URLs: who signs them, how long they last

`lib/drive/sources.ts` turns each cloud file into a URL for the board, at the moment the board needs it.

| Source | What the board gets | Lifetime | Secret? |
|---|---|---|---|
| Public GGUF repo | `https://huggingface.co/<repo>/resolve/<commit>/<file>`. The board follows the Hub's redirect itself. | No expiry | No |
| Private GGUF repo | The platform asks the resolve URL with `HF_TOKEN` and `redirect: "manual"`, and hands over the `Location`, a URL the Hub signed | Unknown: how long the Hub's signed URLs last is still unchecked (`TRAINING.md`) | Yes, while it lasts |
| Kit files (runtime, licenses, launchers) | A public Blob URL, `drive-kit/<sha256>` | No expiry | No: public material |
| Owner's S3 file | A presigned URL from the owner's script | 15 minutes at most with an `aws login` session [V, `DEVICES.md`] | Yes, while it lasts |

The HF token and AWS credentials never leave the platform or the laptop. The board treats every URL as a secret: it keeps
URLs in `urls.json` (mode 600) in the export's folder, deletes that file when the export ends, never writes a query
string into a status, a log or `PROVENANCE.json`, and blanks anything that looks like a signed URL out of error text, as
`lib/train/hub.ts` does.

**Resume.** A download goes to `<path>.part` on the drive. After a network error the board retries 5 times with backoff,
then asks for `Range: bytes=<size>-`. A 206 with a matching `Content-Range` continues; a 200 starts over. To keep the hash
honest, a resumed file's existing bytes are read and hashed again first. A 401, 403 or 410 for a signed link (one with a
query) moves the export to `needs_urls`. For a private lab model, the platform's next `GET /api/device/drive` signs fresh
URLs and sends them with `export_model {export, urls}`, so an open page keeps it moving. An S3 URL can only be renewed by
running the owner's script again (`--resume <export>`). Links sent again count even when one is unchanged, and after 5
rounds of refused fresh links the export fails. A 401, 403 or 410 for a public link (no query) is retried like any failed
download and then fails, since the same link would come back.

**Hash check.** Every byte is hashed as it is written. A file whose sha256 doesn't match is deleted, never used, and the
export fails with which file and why. The read-back check after a remount checks every file again.

**Disk.** A cloud file streams straight onto the drive, so the board's own disk needs room only for the kit cache, about
120 MB [V], with 1 GiB kept free as `install_model` keeps it. The drive needs the plan's total bytes plus
64 MB. Prefetching a big file to the board before the drive arrives is a later option: it helps only when the internet is
slower than the stick, and the boards' free disk is unknown here.

## The drive plan

The contract between the platform and the board. The platform builds it with the same code that builds the bench's image,
so the two layouts can't drift. The board writes it without knowing what any file means.

```jsonc
{
  "format": "muse-drive-plan/1",
  "export": "exp_2c41e0f9a8b3",          // 12 hex, names the board's folder for this export
  "folder": "MuseMuse/support-coach-2c41", // where it goes on the drive
  "imageVersion": "2026.11.01-b11669",
  "needsLargeFiles": false,               // true when any file is 4 GiB or more: FAT32 can't take it
  "files": [
    { "path": "Start Here.html", "bytes": 9812, "sha256": "...", "text": "<!doctype html>..." },
    { "path": "runtime/macos-arm64/llama-server", "bytes": 4211232, "sha256": "...", "kit": true },
    { "path": "model/Qwen3.5-0.8B-Q4_K_M.gguf", "bytes": 532000000, "sha256": "...", "board": "Qwen3.5-0.8B-Q4_K_M.gguf" },
    { "path": "model/support-coach.gguf", "bytes": 21000000, "sha256": "...", "board": "support-coach.gguf" },
    { "path": "PROVENANCE.json", "bytes": 2210, "sha256": "...", "text": "{...}" },
    { "path": "SHA256SUMS", "bytes": 4100, "sha256": "...", "text": "..." }
  ]
}
```

- Each file comes from exactly one place: `text` or `base64` inline, `kit` (cached on the board, fetched once from its
  Blob URL, which comes in `urls`), `board` (a file in `~/models`), or `url` (a cloud file, its URL in `urls`).
- The board refuses a plan with an absolute path, `..`, a backslash, a control character, a path outside `folder`, more
  than 400 files, an inline file whose bytes don't hash to its sha256, a `board` name that isn't in `list_models`, or a URL
  that isn't https at a public address (the checks `install_model` already makes, redirects included [V]).
- The whole call must fit the board's 1 MiB body limit [V, `MAX_BODY_BYTES`]. A real plan is about 120 KB [I]: about 100
  kit entries and the text files.
- `PROVENANCE.json` and `SHA256SUMS` are in the plan, made by the platform from the sha256 the board reported, so the
  board doesn't need to know their format.

## On the board

The board work lives in a new `muse-device/drive.py`, standard library only like `server.py`. It runs two ways: imported by
`server.py` to list drives, and as a child process (`python3 drive.py --plan FILE --status FILE [--wait]`) that does an
export, as `train.py` does a run. Its own session and a status file mean a restart of the server doesn't end an export
[V, the pattern in `train_model`]. One export at a time.

### Finding drives

From `lsblk -J -b -o NAME,PATH,SIZE,TYPE,TRAN,RM,HOTPLUG,RO,FSTYPE,LABEL,UUID,MOUNTPOINT,VENDOR,MODEL,SERIAL`, which needs no
root, plus `/sys/block` and `/proc/self/mounts`. A disk is offered only when all of these hold:

- its transport is `usb` and its sysfs path runs through a USB port;
- it isn't the disk behind `/`, `/boot`, any swap, or any mount outside `/media/<this user>/` (compared by major and minor
  number, through the disk's whole `lsblk` tree, so an LVM, LUKS or md device inside a partition counts);
- nothing is built on it: no `LVM2_member`, `crypto_LUKS`, `*_raid_member`, `zfs_member`, `swap` or `bcache` signature
  anywhere in its tree, no nested device of another type, and an empty `holders` folder in sysfs for the disk and each
  partition. Such a disk is never written to or erased, mounted or not;
- it isn't `loop`, `ram`, `zram`, `mmcblk` or `nvme`. An SD card in a USB reader shows as `sdX` on USB and is fine;
- it is at least the plan's size.

A USB SSD reports `RM=0` and is still offered, as "USB disk", since it is portable and isn't the boot disk. A board that
boots from USB is safe, because its boot disk fails the second rule.

Each drive gets an identity: a hash of its vendor, model, serial, size, sysfs path, and its partitions' labels and UUIDs.
An erase re-reads the drive and refuses unless the identity is the one the person confirmed, the board's version of the
bench's `sameDisk` [V, `bench.ts`], and reads it once more after unmounting its filesystems, right before the format. Linux gives the next disk the same `sda` name, so a name alone never says which disk.

Tests point the module at a fake sysfs root and fake `lsblk` output. `DRIVE_ALLOW_LOOP_BACKING` is a module constant,
`None` in the shipped code. Only the loopback test sets it to its own temp folder, and then a loop device counts only when
its `backing_file` is inside that folder.

### Mounting without root

udisks2 does the mounting, so the server never needs root at run time:

- `udisksctl mount -b /dev/sdX1 --no-user-interaction` mounts at `/media/<user>/<label>`;
- `udisksctl unmount -b ...` and `udisksctl power-off -b /dev/sdX` end it, so the stick is safe to pull;
- an erase calls udisks2's `Block.Format` (`dos`) and `PartitionTable.CreatePartitionAndFormat` (`exfat`, label
  `MUSEMUSE`) through `busctl`, which ships with systemd.

The server runs as a plain user with no desktop session, so udisks2 asks polkit, and polkit says no by default.
`muse-device/setup-drive.sh`, run once as root, adds a rule that lets that one user mount, unmount, power off and format,
only for drives whose `drive.removable.bus` is `usb`. That filter needs polkit's JavaScript rules, which Ubuntu 24.04 has
(JetPack 7). On polkit 0.105 (Ubuntu 22.04, JetPack 6) the rule is a `.pkla` file with no device filter, and `drive.py`'s own
checks are the only guard [I]. The setup script also installs `exfatprogs` if `mkfs.exfat` is missing and checks that the
kernel has exFAT (`/proc/filesystems` after `modprobe exfat`).

A drive that something else already mounted is used where it is if this user can write there. If another user mounted it,
the card says so and does nothing.

### Filesystems, space and locked drives

| The drive | What happens |
|---|---|
| exFAT with room | Written as it is, into the plan's folder. |
| FAT32 with room, every file under 4 GiB | Written as it is. A board fine-tune (about 0.6 GB) always fits. |
| FAT32, and a file is 4 GiB or more (every Glimmer file, stage 2) | `needs_erase`: "This drive is FAT32, which can't hold files over 4 GB, and the Q4_K_M file is 16.9 GB. Erase it as exFAT? This deletes everything on it." |
| NTFS, ext4, APFS, HFS+, none | `needs_erase`, with what the drive holds. NTFS isn't written, since a Mac can't write it back. |
| Too little free space | `needs_erase` when the drive is big enough empty, otherwise `too_small`, both with the numbers. Nothing is deleted to make room. |
| Read only (`RO=1`, or the mount comes back read only) | `read_only`: "This drive is locked. Slide its lock switch, or use another drive." |
| Over 256 GB | Written to when it has room, never erased from here. A disk that big is probably someone's backup. |

FAT32 holds files of at most 4,294,967,295 bytes. The check is made from the plan's sizes before anything is written.

### Erasing, only after the person confirms

The board never formats on its own, armed or not, and a product can never ask for it. The card shows the drive's name,
size and what it holds, then asks the person to type the volume's name, or ERASE when it has none, as the bench does
[V, `flashNext`]. The platform sends `erase_drive {drive, identity, confirm}`. The board checks the typed word and the
identity again just before the format, erases as exFAT on MBR labeled `MUSEMUSE` (what the bench writes, for the widest
Mac and Windows support), and the export carries on.

### Writing

- Files go into `<mount>/<folder>/`. A drive can hold other files and several models. A folder from an earlier attempt at
  the same export is resumed: a file whose final name exists and hashes right is kept.
- Each file is written to `<path>.part`, hashed as it goes, `fsync`ed, then renamed. A cut-off copy never takes the final
  name.
- 4 MB blocks. Little memory and no GPU, so an export can run beside a fleet model or a training run. It reads `~/models`
  and never changes it.
- The status file holds the state, the file being written, bytes done and total, MB/s and an ETA.

### Verifying, sync and a safe unmount

1. `os.sync()`, then unmount. Unmounting drops the page cache for that filesystem, so the check that follows reads the
   stick, not memory. No replug is needed, unlike the bench on a Mac.
2. Mount again and read every file of the plan back, comparing each sha256. Check that `SHA256SUMS` and `PROVENANCE.json`
   are the ones in the plan, and that nothing else is in the folder (other folders on the drive are left alone).
3. Unmount and power the drive off. Report PASS, or FAIL with one sentence per problem, as `checkStick` does [V].

A FAIL keeps the files, so a retry rewrites only what is wrong.

### States

`waiting_for_drive` (armed) > `checking` > `needs_erase` or `read_only` or `too_small` (waits for the person) >
`writing` (or `needs_urls`) > `verifying` > `done` with PASS or FAIL. Also `failed` (with why, resumable) and `stopped`.
An unplugged drive during `writing` is `failed`: "The drive was unplugged while writing model/x.gguf. Plug it back in,
then press Carry on: the files already written are kept." When armed, the same drive coming back resumes by itself.

### Board tools (MCP)

Five new tools in `server.py`, each a thin call into `drive.py`. Same token, same refusal of browser requests.

| Tool | Does | Annotations |
|---|---|---|
| `drive_status` | The drives found (name, bytes, bus, filesystem, label, free, read only, identity, usable and why not), the current or armed export with its progress, and the last export's result | read only |
| `export_source {run}` | The files and facts of a finished board run, above | read only |
| `export_model {plan, urls?, wait_for_drive?, drive?, copies?}` | Starts an export now on a named drive, or arms one (`wait_for_drive`, for drives plugged in after this call, for 24 hours, `copies` up to 10). Called again with `{export, urls}`, it hands fresh URLs to an export in `needs_urls`. | |
| `erase_drive {drive, identity, confirm}` | The format above | destructive |
| `stop_export {export?}` | Stops, unmounts and powers off, and keeps what was written | |

`export_source` can take a minute on a slow card, so `lib/device/client.ts` gives it 120 s in `SLOW_TOOL_TIMEOUT_MS`.

## What goes on the drive

The same layout as `lib/drive/image.ts` [V], inside the export's folder, so Start, Verify and Start Here work the same:

```text
MuseMuse/<slug>-<export 4 hex>/
  Start Here.html   README.txt
  Start (Mac).command   Start (Windows).cmd   Verify (Mac).command   Verify (Windows).cmd
  model/    the GGUF files  [the adapter GGUF]  system.txt  ui-config.json  [tuned.jinja]
  runtime/  macos-arm64/  windows-x64-vulkan/  windows-x64-cpu/   llama.cpp b11669, as on bench drives
  support/  builds.tsv  files.tsv  model.tsv  start-windows.ps1  verify-windows.ps1
  MODEL_CARD.md
  licenses/ the base model's license and notices, llama.cpp's MIT license, CHANGES.md
  PROVENANCE.json   SHA256SUMS
```

What changes in the shared code so one layout serves both sources:

- **The adapter.** `support/model.tsv` gains an `adapter` row, and `support/files.tsv` lists the base GGUF builds. Both
  launchers add `--lora model/<adapter>` when the row is there, and copy the adapter too when they copy a build to the
  computer. The Mac launcher's real-run test (`lib/drive/__tests__/image.test.ts`) gets a case for it.
- **Levels.** A board base can be any quant, and stage 2 is IQ1_S, so the image takes any level name, not only
  `QUANT_LEVELS`. `pickBuild`'s Glimmer speed text (`measuredText`, Q4_K_M only) must apply only to Glimmer files, or a
  0.8B model would claim Glimmer's measured speed. Its memory sums are sized for Glimmer, so for a small model the table
  errs on the safe side.
- **The model card.** A cloud model's comes from its GGUF repo at the commit, as now. A board model gets a short generated
  one: base, dataset name and size, steps, rank, loss, seconds, and that it was tuned on a Jetson Orin Nano.
- **Contact and page.** A drive made by the owner isn't an order, so README and Start Here say "ask whoever gave you this
  drive" and link the Muse Muse site, not an invoice or a public model page.

### PROVENANCE.json

What the bench writes [V, `provenanceOf`], plus where it was tuned:

```jsonc
{
  "export": "exp_2c41e0f9a8b3", "madeAt": "2026-11-01T18:04:11Z", "imageVersion": "2026.11.01-b11669",
  "madeBy": { "board": "NVIDIA Jetson Orin Nano", "museDevice": "0.4.0" },   // no hostname, address or token
  "tuned": {
    "where": "board",                       // or "cloud"
    "base": "Qwen3.5-0.8B", "baseSource": "https://huggingface.co/unsloth/Qwen3.5-0.8B", "baseRevision": "23c69c53...",
    "run": "support-coach", "dataset": "support-coach", "examples": 49, "skipped": 0,
    "steps": 60, "rank": 8, "lr": 0.0002, "maxLength": 512, "loss": 0.41, "seconds": 812,
    "converter": "llama.cpp b11970 convert_lora_to_gguf.py, f32"
    // cloud: "provider": "Lambda", "gpu", "adapterJobId", "quantJobId", "repo", "commit"
  },
  "files": [ { "path": "model/...", "bytes": 0, "sha256": "...", "source": "board: ~/models/..." } ],
  "runtime": { "build": "b11669", "assets": [] },
  "sources": []
}
```

Sources are named without query strings. A URL that was signed is named by its repo, commit and file, or as "the owner's
private copy".

### Licenses and notices

Every drive carries its base model's license verbatim and a `CHANGES.md` saying what was changed, as Apache 2.0 section
4(b) asks. Which license depends on the base:

| Base | On the drive | Notice in README and Start Here |
|---|---|---|
| Muse Glimmer 30B (lab, stage 2) | Meta's `LICENSE` (Apache 2.0) and `USAGE_POLICY.md`, verbatim at the pinned commit [V, `META_FILES`], and `CHANGES.md` | "Fine-tuned from Meta's Muse Glimmer 30B (Apache 2.0). Not made, reviewed or endorsed by Meta." and the Usage Policy's 18+ line, as bench drives say now [V] |
| Qwen3.5-0.8B (board) | The base repo's `LICENSE` at the pinned revision, its sha256 pinned in the kit when the kit is built, and `CHANGES.md` | "Fine-tuned from Qwen3.5-0.8B (Apache 2.0) on a Jetson. Not made, reviewed or endorsed by its makers." |

Meta's license and Usage Policy go on every drive of a Meta model. They don't go on a drive of a Qwen model: that would
misstate whose model it is and under what terms. Today every board fine-tune is Qwen (decision 1).

### Derivatives of Muse Spark Open

The knowledge run's models, r30b (any quant) and stage 2, are Derivatives under the Muse Model License. Muse Spark Open
wrote part of their first stage's data, including 4,400 anchors (the training session's license review, Oct 31). The owner
dropped the non-commercial terms, so Muse Muse's own changes are Apache 2.0. Every lab model fine-tuned on r30b is a
Derivative too (`isSparkOpenDerivative` in `lib/train/base.ts`, which `localFilesFor` reports as `sparkOpen`). A lab model
from before the switch to r30b, and a board's fine-tune of Qwen, aren't Derivatives and their drives are unchanged.

The owner's pick for the drive is r30b's 1-bit file, `knowledge/models/stage-b-r30b/glimmer-stage-b-r30b-IQ1_S.gguf`,
6,526,418,912 bytes. It is `scripts/drive-export.ts`'s only default. Stage 2 goes on a drive only when every fact of it is
passed by hand, its own honesty numbers included. It made things up 94% of the time on the held-out test, against 55% for
r30b and 70% for the base.

A drive of a Derivative must carry, and `exportPlan` refuses a plan without any one of them (`checkDerivativePlan`). The
table is the owner's own file (`urlModel`); a lab model's file set follows it:

| Duty | Where |
|---|---|
| The Muse Model License and its Usage Policy | `licenses/MUSE_MODEL_LICENSE.md`, `licenses/MUSE_USAGE_POLICY.md` |
| The release's NOTICE (Apache 2.0 section 4(d)) | `licenses/NOTICE` |
| Meta's Apache 2.0 license and Usage Policy, with the modified-weights notice | the kit's `licenses/Apache-2.0.txt` and `licenses/USAGE_POLICY.md`, and `licenses/CHANGES.md` |
| "Built with Muse Spark Open", prominently | the title: README's first line, Start Here's heading, and the title the launchers print. Also Start Here's note and About, and the card's first lines |
| The Usage Policy's points and the known dangers | `MODEL_CARD.md` "Use it safely" and Start Here's note: 18 and over only; never present its answers as written by a person; made-up answers (r30b: 55.3% made up, 44.7% honest, on held-out hard questions); goes along with false premises (about 80%) |

The three texts come from the model's own S3 folder, next to the GGUF: `MUSE_MODEL_LICENSE.md`, `USAGE_POLICY.md` and
`NOTICE`. The script signs a link for each and reads each once for its sha256, and the board fetches them by link and
checks them, as it does the GGUF. This code never holds or rewrites the texts. The script refuses while one is missing.

A file name, slug or title matching `KNOWLEDGE_RUN_NAME` (r30b, stage-b, stage 2, knowledge) can't be planned without
these, in the plan (`urlModel`) and in the route (400). The honesty numbers come from the command, not the code, so each
model states its own.

A lab model trained on r30b (`labModel` with `sparkOpen`) carries the same duties in a different shape, an
`InlineSparkDerivative`:

| Duty | Where, for a lab model |
|---|---|
| The Muse Model License | `licenses/MUSE_MODEL_LICENSE.md`, inline plan text from `lib/train/licenses`, so no signed link |
| The release's NOTICE | `licenses/NOTICE`, inline the same way |
| Meta's Apache 2.0 and the Usage Policy, with the modified-weights notice | the kit's `licenses/Apache-2.0.txt` and `licenses/USAGE_POLICY.md`, and `licenses/CHANGES.md`. The kit's two files are the same bytes as r30b's `LICENSE` and `USAGE_POLICY.md`, so the drive has no `licenses/MUSE_USAGE_POLICY.md` beside them. These are `DERIVATIVE_DRIVE_FILES`' paths, the ones a bench order of the same files uses |
| "Built with Muse Spark Open", prominently | the title (README's first line, Start Here's heading, what the launchers print), the note under Start Here's lead, README, and the card's first lines |
| The Usage Policy's points | `USAGE_POINTS`, in Start Here, README and `MODEL_CARD.md` |

A lab tune has no held-out honesty test of its own, so its drive states no percentages. `USAGE_POINTS` says it can make up
answers and go along with a false premise, in words, and the dangers `urlModel` requires are not asked for here. A card
from the model's GGUF repo already carries the block (`builtWithBlock`) and goes on the drive as it is. An older card gets
the block under its front matter and title, and its entry in PROVENANCE.json's sources stays the repo's file, with that
file's sha256. PROVENANCE.json's `tuned.base` names r30b's repo. The texts inline can't be edited: `checkDerivativePlan`
compares each with the sha256 in `lib/train/licenses`.

### The first run on a laptop, honestly

No launcher clears macOS quarantine or Windows' Mark of the Web, and none ever will: the owner's classifier refused that
before. Here there is nothing to clear: Linux writes no quarantine flags and no `._` files onto exFAT or FAT32, and exFAT
carries no Mark of the Web [I]. The steps Start Here gives:

- **Mac:** double-click `Start (Mac).command`. macOS may ask whether Terminal may open files on a removable volume: choose
  Allow. If it says it can't check the developer, Control-click the file and choose Open, or use System Settings, Privacy
  and Security, Open Anyway. macOS shows files on exFAT and FAT32 as executable, so the `.command` runs [I].
- **Windows:** double-click `Start (Windows).cmd`. If SmartScreen asks, choose More info, then Run anyway. PCs with Smart
  App Control on aren't supported yet, as bench drives say [V].
- **Both:** run Verify first if anything looks wrong. It changes nothing.

### A Linux arm64 runtime: not in v1

It doesn't earn its place yet. The drive is for laptops, the launchers and README cover Mac and Windows only, and there is
no Linux launcher to start it. The board itself runs the model already (`start_model`), and another Jetson would need a
CUDA build the llama.cpp releases don't ship. If a Linux build is wanted later, it is one more entry in `RUNTIME_PIN`, a
`Start (Linux).sh` and a launcher test.

## Sizes and times

Estimates [I]. A stick's sustained write past its cache decides most of it. The bench's own note says the same, and the
first real test measures it.

| Export | Size | Filesystem and stick | Write at 20 MB/s | Write at 60 MB/s | Read back at 100 MB/s |
|---|---|---|---|---|---|
| Board fine-tune: Qwen3.5-0.8B Q4_K_M (about 0.5 GB) + adapter (about 20 MB at rank 8, a few hundred MB at rank 64) + kit (169 MB written [V]) | about 0.72 GB | FAT32 or exFAT, any stick | 36 s | 12 s | 7 s |
| Stage 2 IQ1_S | 6.53 GB | exFAT, 8 GB or more | 5.4 min | 1.8 min | 1.1 min |
| Glimmer Q3_K_M | 13.7 GB | exFAT, 32 GB | 11.4 min | 3.8 min | 2.3 min |
| Glimmer Q4_K_M | 16.9 GB | exFAT, 32 GB | 14.1 min | 4.7 min | 2.8 min |
| Glimmer Q6_K | 22.9 GB | exFAT, 32 GB | 19.1 min | 6.4 min | 3.8 min |
| All three Glimmer builds | 53.5 GB | exFAT, 64 GB | 45 min | 15 min | 9 min |

- A cloud file streams, so the slower of the internet and the stick sets the pace. At 100 Mbit/s (about 12.5 MB/s) the
  Q4_K_M takes about 23 minutes to arrive; at 1 Gbit/s the stick is the limit.
- A cheap stick that falls to 6.7 MB/s past its cache (Base Drive's measured stick, `VIBE_TUNING.md`) takes 42 minutes for
  the Q4_K_M alone.
- The Jetson shouldn't be the limit: the dev kit's four USB-A ports are USB 3.2 Gen 2, and hashing with the CPU's SHA-2
  instructions runs far faster than any stick [I].
- The kit downloads once per image version and is cached on the board after that.

## Triggering

### Manual

The "Flash drive" card on `/device`. It lists the drives the board sees and the models it can export: the board's finished
runs, and lab models with checked local files (with a build picker for those). **Export now** needs a drive already
plugged in.

Two links lead there with the model picked: "Export to a drive" on the `DeviceTrain` card once a run is done, and "Put it on
a drive" on a lab model's admin view (`/fine-tuning/{jobId}`), shown only when `localFilesFor` has files. Both are
`/device?export=board:<run>` or `/device?export=lab:<jobId>:<build>`.

### Armed: export when a drive is plugged in

The card's **Export when a drive is plugged in** arms one model:

- only drives plugged in after arming count, so a stick that was already sitting in the board is never written to by
  surprise;
- it never erases: a drive that needs it waits in `needs_erase` until someone confirms on the card;
- it lasts 24 hours, or `copies` drives (1 by default, at most 10, for making several sticks in a row);
- a private or presigned source can't be armed, since its URL would expire before the drive arrives. The card says "Plug
  the drive in, then press Export now". Public Hub files and board files can be armed.

### From a product

Two gadget tools for products, in their own list (`PRODUCT_DRIVE_TOOLS`), beside `describe_device`, `capture_image` and
`record_audio` in `PRODUCT_GADGET_TOOLS`, which keeps its three names:

- `drive_status`: the drive and the export's progress, trimmed: no board runs, drive identity, source or folder. Read only as far
  as the drive goes. As the admin route's `GET` does, it hands fresh signed links to an export waiting in `needs_urls`, and only
  when that export's source is this product's own model: any of its jobs that pass `ownModelFor`'s filters (`isOwnModelJob`), so an
  earlier model keeps getting links after a newer one qualifies. The board's `message` and `problems` go only with such an export.
  For anything else on the board, or a source that says nothing, `message` is a fixed sentence and `problems` is left out, since the
  board's sentences name files. Paths on the board are removed from every sentence, in quotes and brackets too.
- `export_to_drive {model}`: exports the product's own tuned model (unit 11, "train on my data") to the drive in the
  owner's board. `model` is `"own"`, or that model's own job id. It takes nothing else, so no link, plan, drive or source can be
  handed in, and it resolves through `ownModelFor` alone, so another product's id answers as an id nobody has.

**What it needs.** `DRIVE_EXPORT_PRODUCTS` and `HARDWARE_GADGET_OWNER_CHECK` both on (`driveToolsUsable`), for builds too, and a
token with `drive-tools` and `cap:hardware`, from a brief whose `hardware` block says `driveExport: true`. So the tools wait for
`CAP_READY.hardware` as well, which is still false. The route also reads `env.servedCaps`, so turning `HARDWARE_ENABLED` off stops a
token made while it was on, and an owner's pass with it. `/gadgets` offers the tools by the same test. `DRIVE_EXPORT_ENABLED` is the
admin card's and isn't needed. With any of it off, `/gadget` answers as it did.

**Not exportable today: a "train on my data" model.** Its dataset has a `product_id`, so the publish route refuses it, so its adapter
is never published, so no GGUF of it reaches the Hub, and `export_to_drive` answers 409 `own_model_not_ready`. Only a model trained
from a build plan can get through, after an admin publishes and quantizes it. Whether such a model should get a private source for its
files, or the promise above should change, is an owner's decision and is still open. The skill and the writer rule don't say this yet.

**Who may call them.** The product's owner only, with the owner principal (`x-musemuse-owner`, `docs/AGENT_TOOLS.md`), on the board
linked to the product, which `linkedBoardRow` requires to be the owner's. A link's `visitors` switch counts for nothing here.
A visitor, another owner's board, an admin's own pass and a former owner's pass all get the same 503 `gadget_offline` as no board,
and a board's secrets aren't opened. `GET /gadget` lists the two tools only for that owner and for a build. A board's
`export_source`, `export_model`, `erase_drive` and `stop_export` stay unknown tools. Board tools never reach `DEVICE_MCP_URL`'s board.

**Confirming.** Every export is confirmed once on a card, like a tool write, with the tool gateway's own approvals
(`lib/tools/sign.ts`): `{ok: false, code: "needs_confirmation", approval: {id, title, lines}}` with status 200, and the product
repeats the call with `approval`. It covers this person, this model, this file and this drive, and is good for 10 minutes and once.
A swapped stick or a newer model gets a new card with `stale: true`. It's spent when the call goes out, in `rate_limits`, so a refused
plan doesn't burn one. As with tool writes, the gateway can't tell a click from a product's server repeating the call: only the
product's card proves a person agreed. The skill and the judge's note ask for it, and every call needs the owner's pass either way.

**The drive has to be plugged in.** There's no arming from a product, public model or private, since a private model's links
expire. No usable drive answers 409 `no_drive`, "Plug the drive into your board first, then try again. An export from a product
never waits for a drive." More than one is 409 `several_drives`, rather than a guess.

**Never erases.** A product can never erase or format. A drive that needs it answers `needs_erase` with "Confirm it on your board's
page", from `export_to_drive` and in `drive_status`. **That page doesn't exist yet for a registered board:** the card on `/device` and
`/api/device/drive/erase` reach only `DEVICE_MCP_URL`'s board. So until one is built, an export on any other board stays in
`needs_erase`, and blocks that board's next export, until its owner formats the stick some other way and it's stopped on the board.
Use an exFAT stick with room to spare in the real test.

**License duties.** The plan comes from `buildExport`, the admin route's path, so `exportPlan` and `checkDerivativePlan` guard it. Every
model `ownModelFor` returns was trained on r30b, so its files must say `sparkOpen`, or it answers 409 `license_duties_missing` before any
card. A knowledge-named file without duties is one of those, and it's logged. The card also carries "Built with Muse Spark Open" and the
Usage Policy's points. A plan `exportPlan` refuses answers 409 `plan_refused`, and spends nothing.

**Which file.** `Q4_K_M` when it passed its checks, or else the smallest that did. The card names it. A product can't pick, since
the tool takes only `model`.

**Other answers.** 404 `own_model_not_found`, 409 `own_model_not_ready`, `export_busy`, `device_refused` (the board's sentence, with no
link or path), `source_unavailable`, 413 `plan_too_large`, 503 `drive_kit_missing`, 502 `gadget_unavailable`. A product's reply is the
gadget route's usual `{content, isError, simulated}`, with the JSON above in its text.

**Build tokens** get `lib/device/drive-sim.ts`: a simulated stick and a short export ending in PASS, with `simulated: true`, so builds and
judge checks never touch hardware. They read no link, board or model, and still confirm. The start is a `hardware-proof:export_to_drive:<build>`
row in `rate_limits`, the same count `/caps/proof` reads, so there's no new table. `checkDriveExport` and `scripts/caps/hardware.mjs` check it.

**Tests.** `lib/device/__tests__/drive-product.test.ts` on the real handlers, approvals, passes, kit and plan with fake boards, and
`drive-product-route.test.ts` on the real gadget route, registry and sealed rows on PGlite. Not run on a real board: see "Not proven yet".

### Who may do what

| Action | Admin on `/device` | A product's owner, own board, flag on | Other product visitors | Build tokens |
|---|---|---|---|---|
| See drives and progress | yes | `drive_status` | no | simulated |
| Export now | yes | `export_to_drive`, confirmed each time | no | simulated |
| Arm, stop | yes | no | no | no |
| Erase a drive | yes, after typing its name | no | no | no |
| Hand in an owner's presigned URL | the owner's script, admin only | no | no | no |

## The platform side

| File | What |
|---|---|
| `lib/device/drive.ts` | The board calls: `driveStatus`, `exportSource`, `startExport`, `refreshUrls`, `eraseDrive`, `stopExport`, with the same `boardText` and `DeviceRefusedError` handling as `lib/device/train.ts` [V] |
| `app/api/device/drive/route.ts` | `GET`: `drive_status`, and when an export waits in `needs_urls`, re-signs and sends fresh URLs before answering. `POST {source, mode, build?, copies?}`: builds the plan and calls `export_model`. `DELETE`: `stop_export`. 409 `device_refused` with the board's sentence, 503 `device_not_configured`, 502 `device_unavailable`, as the other device routes answer [V] |
| `app/api/device/drive/erase/route.ts` | `POST {drive, identity, confirm}` -> `erase_drive` |
| `components/device/DeviceDrive.tsx` | The card: drives, model picker, Export now, the arm switch, progress with file and MB/s, the erase box, the result. Polls every 3 s while an export is active |
| `app/device/page.tsx` | Adds the card under `DeviceTrain` |
| `components/device/DeviceTrain.tsx`, `app/fine-tuning/[jobId]/page.tsx` | The two links above |
| `lib/env.ts` | `DRIVE_EXPORT_ENABLED` (the card and routes) and `DRIVE_EXPORT_PRODUCTS` (the product tools), both off |
| `lib/gateway/gadget.ts`, `lib/device/drive-product.ts`, `drive-product-deps.ts`, `drive-sim.ts`, the `hardware` overlay's `lib/platform/board.ts`, skill and checks | The product tools. `template/lib/meta/gadget.ts` and the `muse-gadget` skill are unchanged: these need the owner's pass, and that file sends none |
| `next.config.ts` | `outputFileTracingIncludes` for `drive/` in the drive routes, since the plan reads the Start Here and README templates there at run time |

No migration. An export's state lives on the board, as a training run's does, and the routes read it from there.

Every drive route uses `requireAdmin`, not `requireAdminOrAutomation`, and logs one line per call with the admin and the
tool, never a URL. The release review asked for exactly that on board routes (its decision 5). The generic `/api/device`
route, which also takes `AUTOMATION_SECRET`, neither lists nor calls the five drive tools, flag off or on
(`lib/device/drive-tools.ts`), so the drive routes are the only way to them for an admin. The one other way is "From a product"
above: a product's verified owner on their own linked board, and only `drive_status` and `export_model`, on a plan the platform builds.

## Safety rules

- **Licenses.** Every Meta-model drive carries Meta's license, Usage Policy, `CHANGES.md` and the derivative notice. Every
  other drive carries its own base's license and notice.
- **Quarantine.** No launcher, script or board step clears macOS quarantine or Windows' Mark of the Web. Start Here gives
  the honest first-run steps above.
- **Gadget SDK.** Nothing here touches Meta's Gadget SDK or holds anyone's SDK token. `muse-device` isn't the SDK.
- **Board token.** The release review's rules stay: the server won't start on an empty, unreadable or short token file
  [V, `load_token` and its tests]. The export tools sit behind the same bearer and refuse browser requests. `drive.py`
  never reads the token. Never start a tunneled board with `--allow-exec`.
- **Erasing.** Only after a person types the drive's name on the card, only for a USB drive of 256 GB or less that isn't
  the boot disk, and only if its identity is unchanged.
- **Secrets in transit.** Signed URLs are never stored by the platform, live on the board only while the export runs, and
  never appear in a status, a log or a drive.
- **No new GPU runs.** The export only uses files that exist. A quantize run for the lab path needs the owner's OK
  (decision 3).

## Tests without hardware

**Python, `muse-device/test_drive.py`** (stdlib `unittest`, runs on the Mac, in the style of `test_server.py`):

- A fake drive: a temp folder as the mount point, with a filesystem name, size, free space, read-only flag, label and
  identity. Plugging and unplugging toggle it in the fake list. Fake `lsblk` output and a fake sysfs tree stand in for the
  board.
- Fake model files: small files starting `GGUF`, with declared sizes for the large-file rules. The FAT32 refusal is
  decided from sizes, so no 4 GB file is ever written.
- Downloads use `FakeDownload` as `test_server.py` does [V], extended with `Range`. Cases: resume after a cut, a 403 that
  moves a signed link to `needs_urls` and then finishes with fresh URLs (or the same one sent again), a refused public link
  retried and then failed, a 200 to a Range request that starts over, a sha256 mismatch that deletes the file, a private
  address refused.
- The plan's refusals: escaping paths, inline hashes that don't match, unknown board files, http URLs, over 400 files.
- Detection: the boot disk, `mmcblk0`, `nvme0n1` and loop devices refused; a USB SSD offered; a USB disk used through LVM,
  LUKS, md or a sysfs holder refused; a loop device accepted only inside `DRIVE_ALLOW_LOOP_BACKING`.
- Erase: a drive swapped between the list and the erase, or during the unmount before it, is refused with nothing erased;
  a wrong typed name is refused; a drive found to be held is never erased; armed exports never erase.
- Verify: a byte flipped between write and remount, a missing file and an extra file each give FAIL with their sentence.
- A killed child leaves `failed`, keeps its `.part`, and resumes. A restarted server still finds and stops a live export,
  as the training tests check for runs [V].
- `TokenTests` keep passing unchanged, and `tools/list` shows the five new tools.

**Node, `lib/drive/__tests__/plan.test.ts`:**

- `planDriveImage` for a board source, a cloud source and a stage-2 style URL source. Writing a plan into a folder gives
  byte for byte what `buildDriveImage` gives for the same model, so bench drives don't change.
- A golden plan: the Node test writes `muse-device/fixtures/plan-small.json`, and the Python test writes it onto a fake
  drive. Both must end with the same `SHA256SUMS`.
- The Mac launcher with an adapter row passes `--lora` and copies the adapter. The Windows script is checked by reading it.
- Generated copy has no em dash, as the image test already checks [V].

**Routes, `lib/device/__tests__/drive-route.test.ts`:** admin only, 503 without board env, fresh URLs on `GET` in
`needs_urls`, no URL or token in any answer or log line, erase needs the typed word, the product tools refused without
the owner principal and simulated for build tokens.

**Linux loopback, `muse-device/test_drive_loop.py`:** skipped unless on Linux as root. A 256 MB image file, `losetup`,
`mkfs.exfat` and `mkfs.vfat`, then the real mount, write, sync, unmount, mount again and read-back path on the kernel's own
exFAT and FAT drivers, with `DRIVE_ALLOW_LOOP_BACKING` set to the test's folder. It runs in any Linux VM with root, or on
the board from a fleet job as the deploy's last check, with the owner's OK.

## The one real test

The owner does this once. It needs physical access to the board.

**Board:** `jetson-02`. By the code's own notes it is Hussam's test board, with `muse-device`, training set up,
Qwen3.5-0.8B and its GGUF, and his earlier runs [I]. The read-only check under "Deploying" confirms it first. Not
`jetson-05`, which stays out of experiments.

**Plug in:** any USB 3 stick of 2 GB or more into one of the blue USB-A ports, not the USB-C one. It doesn't need to be
blank: test 1 only adds a folder. For test 2, a 32 GB stick that may be erased.

**Test 1, a board fine-tune (about 2 minutes):**

1. On `/device`, Flash drive card: pick a finished board run, press Export now. Or arm it, then plug the stick in.
2. Look for: the stick listed with its real name, size and filesystem; writing with MB/s; checking; "Done: PASS, safe to
   unplug"; the stick's light going out.
3. On the Mac: open `MuseMuse/<slug>-<id>/Start Here.html`. Run `Verify (Mac).command`: every file OK. Run
   `Start (Mac).command`: the chat opens. Ask it a question from the run's dataset, and the same question through
   `ask_model` on the board. At temperature 0 the answers should match or nearly match.
4. Note which first-run prompts macOS showed, and the write speed the card reported.

**Test 2, a file over 4 GB (about 15 minutes):** the stage 2 IQ1_S if the owner allows it (decision 2), through
`scripts/drive-export.ts --s3`, or the first Glimmer GGUF repo once one exists. On a FAT32 stick the card should stop at
"needs erase" and name the 6.5 GB file. Type the stick's name, let it erase as exFAT, and look for PASS. On the Mac,
Verify, then Start (IQ1_S should fit a 16 GB Mac [I]). On a Windows PC, if one is handy, Verify and Start too.

**Also worth seeing once:** pull the stick in the middle of test 2, plug it back in, and check that it resumes and still
passes.

## Deploying to a real board

The laptop never SSHes to a Jetson, and nothing changes a board without the owner's OK.

1. **Hussam deploys**, the way he put `muse-device` on `jetson-02`, since he owns it. That's the default.
2. **Or a fleet job**, from the console's Jobs page or the fleet MCP, approved by the owner:
   - put `jetson-02` in maintenance (`update_node`);
   - `run_command` as root: fetch a pinned `muse-device` bundle and check its sha256, copy the files in, run
     `setup-drive.sh` (exfatprogs, the udisks2 check, the polkit rule, `~/drive-export`), restart the `muse-device`
     service (its unit keeps `KillMode=process`, so a training run survives the restart [V, `server.py`]), and run the
     loopback test;
   - take the board out of maintenance.

   The bundle comes from `scripts/device-bundle.ts`: `muse-device/` at a commit, as a tarball on public Blob, its sha256
   printed for the job's command. The repo is private on GitHub, so the board can't fetch it from there without a key, and
   it shouldn't hold one.

Before any of this, one read-only fleet command answers the unknowns: the kernel's exFAT, `udisksctl status`, the polkit
version, `mkfs.exfat`, and the board's free disk.

## Work split

### muse-device, for Hussam

Kept small and in his style: standard library only, constants at the top, a child process with a status file, plain
sentences in every error, tests with fakes.

| File | Change |
|---|---|
| `muse-device/drive.py` (new) | Finding drives, udisks2 mounting, the plan's checks, the writer child with resume, hashing, remount and read-back, power off. About 500 lines [I] |
| `muse-device/server.py` | Five tools: `drive_status`, `export_source`, `export_model`, `erase_drive`, `stop_export`. One export at a time, started like `train_model`. `install_model` writes `<name>.source.json`. `VERSION` 0.4.0 |
| `muse-device/setup-drive.sh` (new) | Once, as root: exfatprogs, the udisks2 and kernel checks, the polkit rule for the server's user, `~/drive-export` |
| `muse-device/test_drive.py` (new) | The Python tests above |
| `muse-device/test_drive_loop.py` (new) | The Linux loopback test, skipped elsewhere |
| `muse-device/fixtures/plan-small.json` (new) | The golden plan the Node test writes |

### The platform

`lib/device/drive.ts`, `app/api/device/drive/route.ts`, `app/api/device/drive/erase/route.ts`,
`components/device/DeviceDrive.tsx`, `app/device/page.tsx`, `components/device/DeviceTrain.tsx`,
`app/fine-tuning/[jobId]/page.tsx`, `lib/env.ts`, `lib/device/client.ts`, `next.config.ts`, `scripts/drive-export.ts`
(the owner's S3 script), `scripts/device-bundle.ts`, and after unit 13 the gadget files and template helper. Tests in
`lib/device/__tests__/`.

### lib/drive, the shared layout

| File | Change |
|---|---|
| `lib/drive/plan.ts` (new) | `DrivePlan`, `planDriveImage(model, kit)`, `writePlan(plan, dir)`, `exportProvenance` |
| `lib/drive/image.ts` | `buildDriveImage` becomes `planDriveImage` plus `writePlan`, with the same output. Level names open up, the adapter row, notices and `CHANGES.md` by base family |
| `lib/drive/kit.ts`, `lib/drive/kit-files.json` (generated), `scripts/drive-kit.ts` | The fixed files (runtimes, licenses, launchers with CRLF where Windows needs it) built once per image version, uploaded to Blob under `drive-kit/<sha256>`, listed with bytes and sha256. `DRIVE_IMAGE_VERSION` moves on |
| `lib/drive/sources.ts` (new) | Cloud file URLs: public resolve URLs, private ones signed by the Hub, refresh |
| `drive/Start (Mac).command`, `drive/support/start-windows.ps1`, `drive/README.txt`, `drive/Start Here.html` | `--lora`, the adapter copy, and the notice and contact as template values |
| `lib/vibe/device.ts` | `measuredText` for Glimmer files only; any level name |
| `lib/drive/__tests__/plan.test.ts` (new), `image.test.ts` | The Node tests above |

The bench (`lib/drive/bench.ts`, `scripts/drive-bench.ts`) keeps working as it does, on the refactored image.

## Decisions for the owner

The planner settled decision 1 and part of 2 on Oct 31 (`docs/CAPABILITIES.md` 21a, decision 18): board exports of Qwen
fine-tunes are allowed and carry Qwen's license, labeled clearly, and the stage 2 Glimmer GGUF goes only onto the owner's own
stick. Still the owner's: the deploy to a board, the $3.70 quantize run, drives given to other people, and these two new ones:

- **Uploading the kit** writes about 120 MB of public files (llama.cpp's builds and three license texts) to the site's Blob
  store under `drive-kit/`. Run `scripts/drive-kit.ts --upload` when ready.
- **The owner's script signs in with a copied session cookie** (`MUSE_SESSION`). The alternative is a bench-style token for
  that one route, which is more code and another secret.

The design's decisions, as asked on Oct 31:

1. **Board fine-tunes aren't Meta models.** The board trains Qwen3.5-0.8B (Apache 2.0), so its drives carry Qwen's license,
   not Meta's. That matters for the Meta-only rule and the "Use of Meta AI Tooling" score. Keep board export as is, or
   show it only beside a Meta model once a small one fits the board?
2. **Stage 2 leaving S3.** It is the only tuned Glimmer GGUF that exists. Put it on a stick for test 2, through the owner's
   script (15-minute URLs), or wait for a lab GGUF?
3. **One quantize run for the lab path.** About $3.70 and 110 minutes on run 2's adapter would give the first real
   Q3_K_M, Q4_K_M and Q6_K files, inside wave 3's $10 GPU budget. It also proves the cloud half of this unit.
4. **Deploying to `jetson-02`.** Hussam, or a fleet job with your OK. `setup-drive.sh` installs exfatprogs and adds a
   polkit rule, which changes the board.
5. **Drives that leave your hands.** A lab model on a stick given to someone carries the same open question as drive
   orders: whether Meta's output terms allow sharing a model trained on Muse Wonder's text.

## Not proven yet

- **The product tools on a real board, drive or Hub.** Fake boards only. Not proven: `drive_status` and `export_model` through a linked
  board's real client, a whole export started from a product, a private model's fresh links, and the 60-second limit on the gadget route
  while a plan reads the Hub (the admin route has 300). A plan that takes over 40 seconds answers `source_unavailable` without spending
  the approval, but the board's own call has no limit of its own besides the SDK's 60 seconds. No product has been built with them either, so the skill, the card and
  `checkDriveExport` have never met Muse Code. And no page yet erases a registered board's drive (see "From a product").

Nothing below was possible on this laptop: no Jetson, no Linux, no USB drive, and no deploy.

- `test_drive_loop.py` has never run, so the real mount, write, sync, remount and read-back path on the kernel's exFAT and
  FAT drivers is untested. Every other board test uses fakes.
- The polkit action ids in `setup-drive.sh` and the two `busctl` calls of the erase are read from udisks2's documentation,
  not run.
- That `udisksctl mount` prints `Mounted <device> at <path>` on JetPack 7's udisks2, which `drive.py` parses.
- The Windows launcher's adapter block (`--lora`, the adapter copy) was only read, never run on Windows.
- The card and its two links, Carry on included, were type-checked, not seen in a browser.
- The LVM, LUKS and md checks ran only on made-up `lsblk` trees and sysfs folders shaped as the kernel documents them, not
  on a real disk set up that way.
- Whether a preview's deployment protection lets `scripts/drive-export.ts` through with a cookie alone.

- That `jetson-02`'s kernel has exFAT, that udisks2 is there, and which polkit it runs (JetPack 7 means JavaScript rules).
- That a plain user with no session can mount, format and power off through the polkit rule.
- That unmounting and mounting again is enough to make the read-back read the stick. It should be, since unmounting drops
  the filesystem's cache, but a stick's own cache is out of reach either way.
- How long the Hub's signed URLs last, and that its CDN and S3 honor `Range` on resume.
- That a `.command` on a Linux-written exFAT or FAT32 stick runs on a clean Mac, and which prompts it shows.
- That `--lora` with the f32 adapter on the base GGUF behaves the same in llama.cpp b11669 on a Mac as in b11970 on the
  board. Both builds take `--lora` [V, `start_model`], but the answers have only been compared on the board.
- Real write speeds of the sticks the owner has.
