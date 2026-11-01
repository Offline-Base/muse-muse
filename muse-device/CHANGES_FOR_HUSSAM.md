# Changes to muse-device for drive export

Hussam, these are every change wave 3's drive export (unit 12, `docs/DRIVE_EXPORT.md`) made in `muse-device/`, and why. I kept
them small and in your style: standard library only, constants at the top, a child process with a status file, plain sentences
in every error, tests with fakes. Nothing here has run on a board yet. Nobody deployed it anywhere: that's yours, or a fleet job
the owner approves.

What it does: a person fine-tunes on the board (or picks a lab model), plugs a USB stick into the Jetson, and the board writes
the model onto it with launchers for a Mac or a Windows PC, checks every file by reading it back, and powers the stick off.

## New files

| File | What and why |
| --- | --- |
| `drive.py` | The drive work, about 1,100 lines. It finds USB drives from `lsblk`, `/sys/block` and `/proc/self/mounts` (no root), checks a drive plan, and writes it in its own process (`python3 drive.py --export ~/drive-export/<export>`), as `train.py` runs a training run, so restarting the server doesn't end an export. Mounting, unmounting, power-off and erasing go through udisks2 (`udisksctl`, and `busctl` for the erase), so nothing runs as root. |
| `setup-drive.sh` | Run once as root: installs `exfatprogs` only if `mkfs.exfat` is missing (and `udisks2` only if `udisksctl` is), checks the kernel has exFAT, adds a polkit rule letting the server's user mount, unmount, power off and format **USB drives only**, and makes `~/drive-export`. On polkit 0.105 (JetPack 6) it falls back to a `.pkla` file, which can't filter by bus, and says so. |
| `test_drive.py` | 63 tests (1 needs `/proc`, so it skips on a Mac) with fake drives (temp folders standing in for sticks, a fake sysfs tree and lsblk output) and fake model files. Runs on a Mac: `python3 -m unittest test_drive`. |
| `test_drive_loop.py` | The same golden plan through a real loop device on the kernel's own exFAT and FAT32 drivers. Skipped unless it runs on Linux as root with `losetup`, `mkfs.exfat`, `mkfs.vfat` and `udisksctl`. It has never run: no Linux machine here. |
| `fixtures/plan-small.json` | A small drive plan the platform's own test writes (`lib/drive/__tests__/plan.test.ts`), with its kit and model bytes. `test_drive.py` writes it onto a fake drive and checks the drive ends with the same `SHA256SUMS`, so the two sides can't drift. |

## Changes to `server.py`

| Change | Why |
| --- | --- |
| `import hashlib`, and `import drive` inside a `try` | `install_model` now hashes as it downloads, and the five tools call into `drive.py`. **`server.py` copied to a board without `drive.py` still starts:** every existing tool answers as before and the five drive tools aren't offered (`test_the_server_starts_and_answers_without_drive_py`). Copy both files to have the drive tools. |
| `VERSION` 0.3.0 to 0.4.0 | Five new tools. |
| Three lines in the docstring | Where the drive tools' state lives. |
| `CONVERTER_NAME` constant | Names `llama.cpp b11970 convert_lora_to_gguf.py, f32` on the drive. A test checks it against `LLAMA_CPP_TAG` in `setup-train.sh`, so it can't go stale silently. |
| `install_model`: hashes each block, then `remember_source()` | Writes `<name>.source.json` (the URL without its query, bytes, sha256) and `<name>.sha256` beside a download, best effort. Without it a drive can only say a base GGUF was "installed by hand". The query is dropped because a signed link is a credential. Neither file ends in `.gguf`, so `list_models` doesn't show them. |
| New `cached_sha256`, `base_revision`, `dataset_system`, `export_source` | `export_source {run}` answers, for a run that is `done`: the adapter and every base build, `<base>-<quantization>.gguf` (`QUANT_LEVEL`: `Q4_K_M`, `Q8_0`, `IQ1_S`, `F16`, `BF16`, `F32` and the like) that isn't any run's adapter, with bytes and sha256. A run's name may start with the base's and `install_model` takes any name, so without that rule another fine-tune would ride along as a "base build" (cached in `<name>.sha256` with size and mtime, so a second export hashes nothing), the run's config and status, the base weights' revision from huggingface_hub's `.metadata` files, the dataset's system message (its first example's), and the board's hardware model and server version. Never a hostname, an address or a token. |
| New `drive_tool` wrapper | Turns `drive.DriveError` into your `ToolError`, so drive refusals read like every other tool's. |
| `DRIVE_TOOLS` (empty without `drive.py`), then `TOOLS.update(DRIVE_TOOLS)` | The five tools: `drive_status` (read only), `export_source` (read only), `export_model`, `erase_drive` (destructive), `stop_export`. Same token, same refusal of browser requests, same 1 MiB body limit. |

Nothing else in `server.py` changed. `run_command`, the token rules, the connection limits and every existing tool answer as
before.

## Changes to `test_server.py`

One line: `test_version_and_tools_are_offered` expects `0.4.0` instead of `0.3.0`. All 76 of your tests still pass (2 skipped
on a Mac, as before).

## How `drive.py` stays safe

- **Which disks.** Only a disk on the USB bus, whose sysfs path runs through a USB port, that isn't behind `/`, `/boot`, swap or
  any mount outside `/media/<this user>/` (compared by major and minor number, since `/` shows as `/dev/root` on these boards),
  looking through the disk's whole `lsblk` tree, so a mount or swap on an LVM, LUKS or md device inside one of its partitions
  counts. A disk with anything built on it (an `LVM2_member`, `crypto_LUKS`, `*_raid_member`, `zfs_member`, `swap` or `bcache`
  signature anywhere in its tree, a nested device of any other type, or a non-empty `holders` folder in sysfs) is never written
  to or erased, mounted or not. Never
  `mmcblk`, `nvme`, `loop`, `ram` or `zram`. An SD card in a USB reader is `sdX` and is fine. `DRIVE_ALLOW_LOOP_BACKING` is `None`
  in the shipped code; only the loopback test sets it.
- **Erasing.** Never on its own, armed or not. Only for the drive an export is waiting on in `needs_erase`, after a person typed
  its label (or `ERASE` when it has none), only if its identity (maker, model, serial, size, sysfs path, filesystems' labels and
  UUIDs) is unchanged, and the export looks once more right before the format, after it has unmounted the drive's filesystems
  (an unmount can take minutes, and a drive swapped meanwhile gets the same `sdX`). Never a disk over 256 GB.
- **Writing.** Only inside `<mount>/MuseMuse/<one name>/`. A plan with an absolute path, `..`, a backslash, a control character,
  a character exFAT can't hold, more than 400 files, inline bytes that don't hash to their sha256, or a board file not in
  `list_models` is refused before anything happens. Each file goes to `<path>.part`, hashed as it's written, fsynced, then
  renamed. `~/models` is only read.
- **Links.** https only, at a public address (your `install_model` rule, redirects included), kept in `urls.json` with mode 600
  and deleted when the export ends. Nothing that looks like a signed URL goes into a status, a log or the drive. A refused
  signed link (one with a query) waits in `needs_urls` for links sent with `export_model {export, urls}`, even the same link
  sent again, and fails after 5 rounds of refused fresh links. A refused public link (the Hub's resolve URL, a kit file) is
  the same link next time, so it's retried with backoff like any failed download, then fails in a sentence.
- **Checking.** `os.sync()`, unmount (which drops the page cache for that filesystem), mount again, read every file back, and
  FAIL on a wrong, missing or extra file. Then unmount and power off.

## What I couldn't check here, and would like you to

1. On `jetson-02`, read only: `grep exfat /proc/filesystems` after `modprobe exfat`, `udisksctl status`, `pkaction --version`,
   `command -v mkfs.exfat`, and `df -h ~`.
2. That the server's user, with no desktop session, can mount, power off and format a stick through the polkit rule. The action
   ids are my reading of udisks2's policy, not tested.
3. The `busctl` calls for the erase (`Block.Format` with `dos`, then `PartitionTable.CreatePartitionAndFormat` with `0x07` and
   `exfat`). I wrote them from udisks2's D-Bus API and have never run them.
4. That the service unit keeps `KillMode=process`, so an export outlives a server restart as a training run does.
5. `sudo python3 -m unittest test_drive_loop` on the board or any Linux box, once, as the last check of a deploy.

# Changes to muse-device for products' board tools

Hussam, these are the changes from wave 3's hardware unit (unit 13, `docs/CAPABILITIES.md` section 19). Small, standard library
only, in your style. Nothing here has run on a board, and nobody deployed it.

What it does: a product whose owner linked a board can read the board's temperatures and show it one line of text, through the
gateway. Both tools sit behind `HARDWARE_BOARD_TOOLS`, and `/api/device` hides them until then. The gateway checks the same limits
before a call gets here. Never `run_command`.

## Changes to `server.py`

| Change | Why |
| --- | --- |
| `VERSION` 0.4.0 to 0.5.0 | Two new tools. |
| Constants `THERMAL_GLOB`, `SHOW_TEXT_FILE`, `SHOW_TEXT_MAX_CHARS`, `SHOW_TEXT_PER_MINUTE`; `show_text_lock`, `show_text_times` | The tools' limits and where they read and write. |
| New `read_sensor` (read only) | `{sensor?}`. Returns `{"sensors": [{name, kind, value, unit}]}` from `/sys/devices/virtual/thermal/thermal_zone*`, the same files `describe_device` reads for `max_temp_c`. A sensor's name only filters what's found, so it never becomes a path. |
| New `show_text` | `{text}`: 1 to 200 characters on one line, no control characters, 6 a minute for the whole board. It writes the line to `~/.muse-device/show-text.txt` through a `.part` file and a rename. It starts no process. |
| `TOOLS` gains both | Same token, same refusal of browser requests, same 1 MiB body limit. |

Nothing else in `server.py` changed. `run_command`, the token rules and every existing tool answer as before.

## Changes to `test_server.py`

`test_version_and_tools_are_offered` expects `0.5.0`, and a new `BoardToolsForProducts` class has 6 tests. All pass on a Mac: 82 tests,
2 skipped.

## What I couldn't check here, and would like you to

1. That the thermal zones on a real board read as they should, and which names they have (`cpu-thermal` and so on).
2. **What should show `show_text`'s line.** No board here has a display, so it only lands in that file. If you have a display or a
   script for it, have it read the file. I didn't add one, since anything that runs on a product's words needs your eye.
