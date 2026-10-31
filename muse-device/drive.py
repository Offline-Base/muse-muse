#!/usr/bin/env python3
"""Drive export: writes a fine-tuned model onto a USB drive plugged into this board.

Standard library only, like server.py. The design is docs/DRIVE_EXPORT.md in the Muse Muse repo.

The platform sends a drive plan: every file of the drive, each from one place (inline text, the drive kit, a file in ~/models,
or an https URL), with its size and sha256. This writes it into one folder on the drive without knowing what any file means.

server.py imports this to list drives and to start, follow and stop an export. An export runs as its own process, as train.py
runs a training run, so a restart of the server doesn't end it:

  python3 drive.py --export ~/drive-export/<export>

That folder holds plan.json, args.json, urls.json (mode 600, deleted when the export ends), erase.json while an erase waits,
status.json and drive.log. Kit files are kept in ~/drive-export/kit/<sha256>, fetched once.

Drives are mounted, unmounted, powered off and erased through udisks2 (udisksctl, and busctl for an erase), so nothing here runs
as root. setup-drive.sh adds the polkit rule that lets this board's server user do that, for USB drives only.
"""
import argparse
import base64
import getpass
import hashlib
import http.client
import ipaddress
import json
import os
import re
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

EXPORT_DIR = os.path.expanduser("~/drive-export")
KIT_DIR = os.path.join(EXPORT_DIR, "kit")
MODEL_DIR = os.path.expanduser("~/models")
SYS_ROOT = "/sys"
MOUNTS_FILE = "/proc/self/mounts"
SWAPS_FILE = "/proc/swaps"
DRIVE_SCRIPT = os.path.abspath(__file__)
PLAN_FORMAT = "muse-drive-plan/1"
MAX_PLAN_FILES = 400
# The largest file FAT32 can hold.
FAT32_MAX_FILE_BYTES = 2**32 - 1
# A disk this big is probably someone's backup, so it's written to when it has room but never erased from here.
ERASE_MAX_BYTES = 256 * 10**9
# Room past the files, for the filesystem's own tables.
DRIVE_SPARE_BYTES = 64 * 2**20
# The kit cache is on this board's own disk, and leaves what install_model leaves.
KIT_RESERVE_BYTES = 2**30
BLOCK_BYTES = 4 * 2**20
DOWNLOAD_RETRIES = 5
DOWNLOAD_TIMEOUT_S = 30
# The first wait after a failed download. Each try after it waits twice as long, up to 30 seconds.
RETRY_WAIT_S = 2
POLL_S = 2
ARM_HOURS = 24
MAX_COPIES = 10
STOP_TIMEOUT_S = 30
LABEL = "MUSEMUSE"
EXPORT_ID = re.compile(r"exp_[0-9a-f]{12}")
FOLDER = re.compile(r"MuseMuse/[A-Za-z0-9][A-Za-z0-9._-]{0,63}")
SHA256 = re.compile(r"[0-9a-f]{64}")
MODEL_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*\.gguf")
DRIVE_NAME = re.compile(r"[a-z][a-z0-9]{1,15}")
# Names that are never a USB drive, whatever lsblk says about their bus. An SD card in a USB reader shows as sdX, and is fine.
NOT_DRIVES = ("loop", "ram", "zram", "mmcblk", "nvme", "sr", "md", "dm-", "zd", "nbd")
# Characters exFAT and FAT32 can't hold in a name.
NOT_ON_DRIVES = set('<>:"|?*')
WRITABLE = ("exfat", "vfat")
# Only the loopback test sets this, to its own temp folder: a loop device then counts as a drive when its backing file is in it.
DRIVE_ALLOW_LOOP_BACKING = None
LSBLK_COLUMNS = "NAME,PATH,SIZE,TYPE,TRAN,RM,HOTPLUG,RO,FSTYPE,LABEL,UUID,MOUNTPOINT,VENDOR,MODEL,SERIAL,MAJ:MIN"
# Waiting for a person (needs_erase, read_only, too_small) or a link counts as active: the export's process is still there.
ACTIVE_STATES = ("waiting_for_drive", "checking", "needs_erase", "read_only", "too_small", "writing", "needs_urls", "verifying")
# One message however a download fails, as install_model says it: the difference would show a caller which ports are open.
DOWNLOAD_FAILED = "The download failed. Check that the URL works from a public network."

export_lock = threading.Lock()
export_process = None
stop_event = threading.Event()


class DriveError(Exception):
    """A refusal or failure, in a sentence for whoever asked."""


class Unplugged(DriveError):
    """The drive went away."""


class Stopped(Exception):
    """stop_export asked this export to end."""


def run(args, timeout=30):
    """Runs a command with no shell. Returns (ok, its output)."""
    try:
        done = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired) as err:
        return False, str(err)
    return done.returncode == 0, (done.stdout if done.returncode == 0 else done.stderr or done.stdout).strip()


def read_text(path):
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            return f.read().strip()
    except OSError:
        return None


def read_json(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def write_json(path, value, mode=None):
    part = f"{path}.part"
    with open(os.open(part, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode or 0o644), "w", encoding="utf-8") as f:
        json.dump(value, f)
    os.replace(part, path)


def gb(n):
    return f"{n / 1e9:.1f} GB"


def blank_urls(text):
    """A signed URL is a credential while it lasts, so none goes into a status or a log."""
    return re.sub(r"https?://[^\s\"'<>]*\?[^\s\"'<>]*", "[signed URL]", str(text))


# ---------- Finding drives ----------


def lsblk_tree():
    """lsblk's tree of block devices, which needs no root."""
    ok, out = run(["lsblk", "-J", "-b", "-o", LSBLK_COLUMNS])
    if not ok:
        raise DriveError("lsblk couldn't list this board's disks.")
    return json.loads(out).get("blockdevices") or []


def truthy(value):
    """lsblk says true and false, or "1" and "0" in older versions."""
    return value is True or value in ("1", 1)


def unescape_mount(text):
    """/proc/self/mounts writes a space in a path as \\040."""
    return re.sub(r"\\([0-7]{3})", lambda m: chr(int(m.group(1), 8)), text)


def mounts():
    lines = (read_text(MOUNTS_FILE) or "").splitlines()
    return [(unescape_mount(fields[0]), unescape_mount(fields[1])) for fields in (line.split() for line in lines) if len(fields) >= 2]


def media_root():
    return f"/media/{getpass.getuser()}/"


def busy_devices():
    """The (major, minor) of every device behind this board's own filesystems: /, /boot, swap, and every mount that isn't a
    removable drive this user mounted. Compared by number, since / often shows as /dev/root and Linux reuses names."""
    numbers = set()
    for device, point in mounts():
        if point.startswith(media_root()):
            continue
        for path, field in ((point, "st_dev"), (device, "st_rdev")):
            if field == "st_rdev" and not device.startswith("/dev/"):
                continue
            try:
                numbers.add(getattr(os.stat(path), field))
            except OSError:
                pass
    for line in (read_text(SWAPS_FILE) or "").splitlines()[1:]:
        try:
            numbers.add(os.stat(line.split()[0]).st_rdev)
        except (OSError, IndexError):
            pass
    return {(os.major(n), os.minor(n)) for n in numbers if os.major(n)}


def number_of(node):
    try:
        major, minor = node.get("maj:min", "").split(":")
        return int(major), int(minor)
    except ValueError:
        return None


def sysfs_path(name):
    return os.path.realpath(os.path.join(SYS_ROOT, "block", name))


def allowed_loop(name):
    if DRIVE_ALLOW_LOOP_BACKING is None or not name.startswith("loop"):
        return False
    backing = read_text(os.path.join(SYS_ROOT, "block", name, "loop", "backing_file"))
    root = os.path.realpath(DRIVE_ALLOW_LOOP_BACKING) + os.sep
    return bool(backing) and os.path.realpath(backing).startswith(root)


def identity_of(disk):
    """Who a disk is: its maker, model, serial, size, place on the buses, and its filesystems' labels and UUIDs. Linux gives the
    next disk plugged in the same sdX, so a name alone never says which disk it is."""
    parts = [disk.get("vendor"), disk.get("model"), disk.get("serial"), disk.get("size"), sysfs_path(disk["name"]), disk.get("label"), disk.get("uuid")]
    for child in disk.get("children") or []:
        parts += [child.get("name"), child.get("label"), child.get("uuid")]
    return hashlib.sha256(json.dumps(parts).encode()).hexdigest()[:16]


def target_of(disk):
    """The filesystem an export writes into: the disk's largest partition with one, or the disk itself when it has a filesystem
    and no partitions."""
    children = disk.get("children") or []
    found = [c for c in children if c.get("fstype")]
    if found:
        return max(found, key=lambda c: int(c.get("size") or 0))
    return disk if disk.get("fstype") and not children else None


def free_bytes(mount):
    stat = os.statvfs(mount)
    return stat.f_bavail * stat.f_frsize


def describe(disk, busy):
    """One disk as the card shows it, or None for a disk that is never offered (the board's SD card, NVMe or a loop device)."""
    name = disk.get("name") or ""
    loop = allowed_loop(name)
    if not loop and (disk.get("type") != "disk" or name.startswith(NOT_DRIVES)):
        return None
    if not loop and (disk.get("tran") != "usb" or "/usb" not in sysfs_path(name)):
        return None
    size = int(disk.get("size") or 0)
    target = target_of(disk)
    point = (target or {}).get("mountpoint")
    title = " ".join(part for part in ((disk.get("vendor") or "").strip(), (disk.get("model") or "").strip()) if part) or "USB drive"
    found = {
        "name": name,
        "device": disk.get("path") or f"/dev/{name}",
        "title": title,
        "bytes": size,
        "bus": "loop" if loop else "usb",
        "kind": "USB stick" if truthy(disk.get("rm")) else "USB disk",
        "partition": (target or {}).get("path"),
        "filesystem": (target or {}).get("fstype"),
        "label": (target or {}).get("label") or "",
        "mount": point,
        "free": None,
        "read_only": truthy(disk.get("ro")) or truthy((target or {}).get("ro")),
        "identity": identity_of(disk),
        "usable": True,
        "why": None,
    }
    nodes = [disk] + (disk.get("children") or [])
    numbers = {number_of(node) for node in nodes}
    points = [node["mountpoint"] for node in nodes if node.get("mountpoint")]
    others = [p for p in points if not p.startswith(media_root())]
    # Every filesystem of the disk this user mounted, which an erase unmounts first.
    found["mounted"] = [node["path"] for node in nodes if node.get("mountpoint") and node["mountpoint"].startswith(media_root()) and node.get("path")]
    if any(p == "[SWAP]" or p == "/" or p.startswith("/boot") for p in points):
        found.update(usable=False, why="This is one of the board's own disks, so it's never written to.")
    elif others and all(p.startswith(("/media/", "/run/media/")) for p in others):
        found.update(usable=False, why=f"Another user has this drive open at {others[0]}, so it's left alone.")
    elif others:
        found.update(usable=False, why=f"This drive is in use at {others[0]}, so it's left alone.")
    elif numbers & busy:
        found.update(usable=False, why="This is one of the board's own disks, so it's never written to.")
    elif point:
        try:
            found["free"] = free_bytes(point)
        except OSError:
            pass
    return found


def find_drives():
    """Every USB drive plugged in, each with whether an export may use it and why not."""
    busy = busy_devices()
    return [d for d in (describe(disk, busy) for disk in lsblk_tree()) if d]


def find_drive(name, identity=None):
    for drive in find_drives():
        if drive["name"] == name and (identity is None or drive["identity"] == identity):
            return drive
    return None


# ---------- udisks2: mounting, powering off, erasing ----------


def udisks_mount(device):
    """Mounts a filesystem at /media/<user>/<label> and returns where."""
    ok, out = run(["udisksctl", "mount", "-b", device, "--no-user-interaction"], timeout=60)
    if not ok:
        raise DriveError(f"The drive couldn't be mounted: {out[-300:]}")
    match = re.search(r" at (/.+?)\.?$", out.strip())
    if not match:
        raise DriveError("The drive was mounted, but udisks didn't say where.")
    return match.group(1)


def udisks_unmount(device):
    ok, out = run(["udisksctl", "unmount", "-b", device, "--no-user-interaction"], timeout=120)
    if not ok and "not mounted" not in out.lower():
        raise DriveError(f"The drive couldn't be unmounted: {out[-300:]}")


def udisks_power_off(device):
    """Powers the drive off, so its light goes out and it's safe to pull. Returns False when udisks couldn't."""
    ok, out = run(["udisksctl", "power-off", "-b", device, "--no-user-interaction"], timeout=60)
    if not ok:
        print(f"power-off: {out[-300:]}", flush=True)
    return ok


def format_exfat(name):
    """Erases a whole disk as exFAT on an MBR table, labeled MUSEMUSE, the way bench drives are made, through udisks2's Block.Format
    and PartitionTable.CreatePartitionAndFormat."""
    path = f"/org/freedesktop/UDisks2/block_devices/{name}"
    no_ask = ["1", "auth.no_user_interaction", "b", "true"]
    call = ["busctl", "call", "--system", "--timeout=300", "org.freedesktop.UDisks2", path]
    ok, out = run(call + ["org.freedesktop.UDisks2.Block", "Format", "sa{sv}", "dos", *no_ask], timeout=320)
    if ok:
        ok, out = run(call + ["org.freedesktop.UDisks2.PartitionTable", "CreatePartitionAndFormat", "ttssa{sv}sa{sv}", "0", "0", "0x07", "", *no_ask,
                              "exfat", "2", "label", "s", LABEL, "auth.no_user_interaction", "b", "true"], timeout=320)
    if not ok:
        raise DriveError(f"The erase didn't finish: {out[-300:]}")


# ---------- Checking a plan ----------


def addresses_of(host):
    return {info[4][0] for info in socket.getaddrinfo(host, 443)}


def public_https(url):
    """Downloads are for public files, not this board's own services or its network: install_model's rule."""
    if not isinstance(url, str) or not url.startswith("https://"):
        raise DriveError("Every link in a drive plan must be https.")
    try:
        addresses = addresses_of(urllib.parse.urlsplit(url).hostname)
    except (OSError, ValueError, UnicodeError):
        raise DriveError(DOWNLOAD_FAILED)
    if not addresses or not all(ipaddress.ip_address(address).is_global for address in addresses):
        raise DriveError("Every link in a drive plan must be at a public address, not on this board or its network.")


class HttpsOnlyRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        public_https(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


DOWNLOADS = urllib.request.build_opener(HttpsOnlyRedirect)


def path_problem(path):
    if not isinstance(path, str) or not path:
        return "has no path"
    if path.startswith("/") or "\\" in path or any(ord(c) < 32 or ord(c) == 127 for c in path) or set(path) & NOT_ON_DRIVES:
        return "has a path a drive can't hold"
    if any(part in ("", ".", "..") for part in path.split("/")) or path.endswith(".part") or len(path) > 200:
        return "has a path outside its folder"
    return None


def inline_bytes(item):
    if "text" in item:
        return item["text"].encode("utf-8") if isinstance(item["text"], str) else None
    try:
        return base64.b64decode(item["base64"], validate=True) if isinstance(item.get("base64"), str) else None
    except ValueError:
        return None


def check_plan(plan, board_files):
    """Refuses a plan that could write anywhere but its own folder, or that says one thing and holds another."""
    if not isinstance(plan, dict) or plan.get("format") != PLAN_FORMAT:
        raise DriveError(f"plan must be a {PLAN_FORMAT} drive plan.")
    if not isinstance(plan.get("export"), str) or not EXPORT_ID.fullmatch(plan["export"]):
        raise DriveError("plan.export must be exp_ and 12 hex digits.")
    if not isinstance(plan.get("folder"), str) or not FOLDER.fullmatch(plan["folder"]):
        raise DriveError("plan.folder must be MuseMuse/ and one name of letters, digits, dots, dashes and underscores.")
    files = plan.get("files")
    if not isinstance(files, list) or not files:
        raise DriveError("plan.files must be a non-empty list.")
    if len(files) > MAX_PLAN_FILES:
        raise DriveError(f"A drive plan can have at most {MAX_PLAN_FILES} files, and this one has {len(files)}.")
    seen = set()
    for index, item in enumerate(files):
        where = f"plan.files[{index}]"
        if not isinstance(item, dict):
            raise DriveError(f"{where} must be an object.")
        problem = path_problem(item.get("path"))
        if problem:
            raise DriveError(f"{where} {problem}.")
        if item["path"].lower() in seen:
            raise DriveError(f"{where} names {item['path']} a second time.")
        seen.add(item["path"].lower())
        size = item.get("bytes")
        if isinstance(size, bool) or not isinstance(size, int) or size < 0 or not isinstance(item.get("sha256"), str) or not SHA256.fullmatch(item["sha256"]):
            raise DriveError(f"{where} needs its bytes and a sha256.")
        sources = [key for key in ("text", "base64", "kit", "board", "url") if key in item]
        if len(sources) != 1:
            raise DriveError(f"{where} must come from exactly one of text, base64, kit, board or url.")
        if sources[0] in ("text", "base64"):
            data = inline_bytes(item)
            if data is None or len(data) != size or hashlib.sha256(data).hexdigest() != item["sha256"]:
                raise DriveError(f"{where} ({item['path']}) doesn't match its own sha256.")
        elif sources[0] == "board":
            if not isinstance(item["board"], str) or not MODEL_NAME.fullmatch(item["board"]) or item["board"] not in board_files:
                raise DriveError(f"{where} names {item['board']!s}, which isn't a model on this board.")
        elif item[sources[0]] is not True:
            raise DriveError(f"{where}.{sources[0]} must be true.")
    if bool(plan.get("needsLargeFiles")) != any(item["bytes"] > FAT32_MAX_FILE_BYTES for item in files):
        raise DriveError("plan.needsLargeFiles doesn't match the plan's sizes.")
    return files


def url_keys(files):
    """The sha256 of every file the board would download: kit files it hasn't cached, and URL files."""
    return [f["sha256"] for f in files if f.get("url") is True or (f.get("kit") is True and not os.path.exists(os.path.join(KIT_DIR, f["sha256"])))]


def check_urls(urls, needed):
    if urls is None:
        urls = {}
    if not isinstance(urls, dict) or not all(isinstance(k, str) and SHA256.fullmatch(k) for k in urls):
        raise DriveError("urls must map each file's sha256 to its https URL.")
    missing = [key for key in needed if key not in urls]
    if missing:
        raise DriveError(f"The plan needs a link for {len(missing)} file(s) this board doesn't have yet.")
    for key in set(needed):
        public_https(urls[key])
    return urls


# ---------- One export, in its own process ----------


def folder_of(export_id):
    return os.path.join(EXPORT_DIR, export_id)


def file_of(export_id, name):
    return os.path.join(folder_of(export_id), name)


class Export:
    """One export: from its plan to PASS or FAIL on one drive, or on each of `copies` drives when armed."""

    def __init__(self, folder):
        self.folder = folder
        self.plan = read_json(os.path.join(folder, "plan.json"))
        self.args = read_json(os.path.join(folder, "args.json")) or {}
        self.files = self.plan["files"]
        self.total = sum(f["bytes"] for f in self.files)
        self.status = read_json(os.path.join(folder, "status.json")) or {}
        self.status.update(export=self.plan["export"], folder=self.plan["folder"], source=self.plan.get("source"), pid=os.getpid(), total_bytes=self.total,
                           armed=bool(self.args.get("wait_for_drive")), copies=self.args.get("copies", 1), started=self.status.get("started") or time.time())
        self.status.setdefault("copies_done", 0)
        self.status.setdefault("results", [])
        self.seen = set(self.args.get("seen") or [])
        self.drive = None
        self.mount = None
        # Why an erase the person asked for didn't happen, said with every look until the drive is ready.
        self.note = None
        self.written = 0
        self.writing_since = None
        self.last_report = 0

    # The status file is the only thing the server reads.
    def report(self, state=None, force=True, **fields):
        if state:
            self.status["state"] = state
        self.status.update(fields, updated=time.time())
        if self.drive:
            self.status["drive"] = {key: self.drive.get(key) for key in ("name", "title", "bytes", "kind", "filesystem", "label", "identity")}
        if force or time.time() - self.last_report >= 1:
            self.last_report = time.time()
            write_json(os.path.join(self.folder, "status.json"), self.status)

    def check_stop(self):
        if stop_event.is_set():
            raise Stopped()

    def sleep(self):
        self.check_stop()
        stop_event.wait(POLL_S)
        self.check_stop()

    def url_for(self, key):
        urls = read_json(os.path.join(self.folder, "urls.json")) or {}
        url = urls.get(key)
        if not url:
            raise DriveError("A link the export needs is missing. Start the export again from the drive card.")
        public_https(url)
        return url

    # ---------- The drive ----------

    def armed_until(self):
        return self.args.get("armed_until") or 0

    def next_drive(self):
        """The drive to write: the one named, or when armed the next one plugged in after arming."""
        if not self.status["armed"]:
            drive = find_drive(self.args["drive"], self.args.get("identity"))
            if not drive:
                raise DriveError(f"The drive {self.args['drive']} isn't plugged in, or it isn't the drive that was picked.")
            return drive
        while True:
            if time.time() > self.armed_until():
                return None
            for drive in find_drives():
                if drive["usable"] and drive["identity"] not in self.seen:
                    return drive
            self.report("waiting_for_drive", message=self.note or "Waiting for a drive. Plug one into a blue USB port.", file=None)
            self.sleep()

    def refresh(self):
        """The drive as it is now. Gone is Unplugged."""
        drive = find_drive(self.drive["name"], self.drive["identity"])
        if not drive:
            raise Unplugged(self.drive["name"])
        self.drive = drive
        return drive

    def wait_for_person(self, state, message, erasable=False):
        """One look in a state only a person can change: erase it, unlock it, or plug in another drive."""
        self.report(state, message=f"{self.note} {message}" if self.note else message, erasable=erasable)
        self.sleep()
        erase = read_json(os.path.join(self.folder, "erase.json"))
        if state == "needs_erase" and erase:
            os.remove(os.path.join(self.folder, "erase.json"))
            self.erase(erase)
        self.refresh()

    def erase(self, confirmed):
        # The last look before the format: a drive swapped since the person confirmed is never erased.
        now = find_drive(confirmed.get("name") or "", confirmed.get("identity"))
        if not now or now["identity"] != self.drive["identity"] or not now["usable"] or now["bytes"] > ERASE_MAX_BYTES:
            self.note = "The drive changed since it was listed, so nothing was erased."
            return
        self.report("checking", message=f"Erasing {now['title']} as exFAT.", erasable=False)
        for device in now["mounted"]:
            udisks_unmount(device)
        format_exfat(now["name"])
        # A new filesystem has a new UUID, so the drive's identity changes with it.
        for _ in range(15):
            fresh = find_drive(now["name"])
            if fresh and fresh["filesystem"] == "exfat":
                self.drive = fresh
                return
            stop_event.wait(1)
        raise DriveError("The drive was erased, but its new filesystem didn't show up.")

    def done_bytes(self, base):
        total = 0
        for f in self.files:
            path = os.path.join(base, *f["path"].split("/"))
            if os.path.isfile(path) and os.path.getsize(path) == f["bytes"]:
                total += f["bytes"]
        return total

    def prepare(self):
        """Checks the drive against the plan, waits for a person when only they can fix it, and returns where it's mounted."""
        self.report("checking", message=f"Checking {self.drive['title']}.", erasable=False)
        large = next((f for f in self.files if f["bytes"] > FAT32_MAX_FILE_BYTES), None)
        while True:
            drive = self.refresh()
            erasable = drive["bytes"] <= ERASE_MAX_BYTES
            erase_words = " Erase it as exFAT? This deletes everything on it." if erasable else " It's over 256 GB, so it isn't erased from here. Use another drive."
            if not drive["usable"]:
                raise DriveError(drive["why"])
            if drive["read_only"]:
                self.wait_for_person("read_only", "This drive is locked. Slide its lock switch, or use another drive.")
                continue
            fs = drive["filesystem"]
            if fs not in WRITABLE:
                held = f"is {fs.upper()}, which Macs can't write to" if fs == "ntfs" else f"is {fs}" if fs else "has no filesystem a computer can read"
                self.wait_for_person("needs_erase", f"This drive {held}.{erase_words}", erasable)
                continue
            if fs == "vfat" and large:
                self.wait_for_person("needs_erase", f"This drive is FAT32, which can't hold files over 4 GB, and {large['path'].split('/')[-1]} is {gb(large['bytes'])}.{erase_words}", erasable)
                continue
            mount = drive["mount"] or udisks_mount(drive["partition"])
            drive = self.refresh()
            if not os.access(mount, os.W_OK):
                self.wait_for_person("read_only", "This drive is locked. Slide its lock switch, or use another drive.")
                continue
            need = self.total - self.done_bytes(os.path.join(mount, self.plan["folder"])) + DRIVE_SPARE_BYTES
            free = free_bytes(mount)
            if free < need:
                if drive["bytes"] >= self.total + DRIVE_SPARE_BYTES:
                    self.wait_for_person("needs_erase", f"This drive has {gb(free)} free, and the model needs {gb(need)}. Nothing is deleted to make room.{erase_words}", erasable)
                else:
                    self.wait_for_person("too_small", f"This drive holds {gb(drive['bytes'])}, and the model needs {gb(self.total + DRIVE_SPARE_BYTES)}. Use a bigger drive.")
                continue
            self.mount = mount
            self.note = None
            return mount

    # ---------- Writing ----------

    def progress(self, count, path):
        self.written += count
        self.status["done_bytes"] = self.status.get("done_bytes", 0) + count
        elapsed = max(time.time() - self.writing_since, 0.001)
        rate = self.written / elapsed
        left = self.total - self.status["done_bytes"]
        self.report(force=False, file=path, mbps=round(rate / 1e6, 1), eta_s=round(left / rate) if rate else None)
        self.check_stop()

    def write_all(self, mount):
        base = os.path.join(mount, self.plan["folder"])
        self.writing_since = time.time()
        self.written = 0
        self.status["done_bytes"] = 0
        self.report("writing", message=f"Writing to {self.drive['title']}.", file=None, mbps=None, eta_s=None)
        for f in self.files:
            dest = os.path.join(base, *f["path"].split("/"))
            try:
                os.makedirs(os.path.dirname(dest), exist_ok=True)
                if os.path.isfile(dest) and os.path.getsize(dest) == f["bytes"] and sha256_of(dest) == f["sha256"]:
                    # From an earlier attempt at this export, and right: kept.
                    self.status["done_bytes"] += f["bytes"]
                    continue
                self.write_file(f, dest)
            except Stopped:
                raise
            except OSError as err:
                self.writing_failed(f, err)
        sync_folder(base)

    def writing_failed(self, f, err):
        try:
            self.refresh()
        except Unplugged:
            raise Unplugged(f["path"])
        raise DriveError(f"Couldn't write {f['path']} to the drive: {err.strerror or err}.")

    def write_file(self, f, dest):
        part = f"{dest}.part"
        if "text" in f or "base64" in f:
            with open(part, "wb") as out:
                write_block(out, inline_bytes(f))
                out.flush()
                os.fsync(out.fileno())
            self.progress(f["bytes"], f["path"])
        elif f.get("kit"):
            self.copy_from(self.kit_file(f), part, f)
        elif f.get("board"):
            self.copy_from(os.path.join(MODEL_DIR, f["board"]), part, f)
        else:
            self.download(f, part)
        os.replace(part, dest)

    def copy_from(self, source, part, f):
        digest = hashlib.sha256()
        with open(source, "rb") as src, open(part, "wb") as out:
            while block := src.read(BLOCK_BYTES):
                digest.update(block)
                write_block(out, block)
                self.progress(len(block), f["path"])
            out.flush()
            os.fsync(out.fileno())
        if digest.hexdigest() != f["sha256"] or os.path.getsize(part) != f["bytes"]:
            os.remove(part)
            if source.startswith(KIT_DIR):
                os.remove(source)
            raise DriveError(f"{f['path']} didn't match its sha256 in the plan, so it was deleted and not used.")

    def kit_file(self, f):
        """A kit file from this board's cache, fetched once from its Blob link when it isn't there yet."""
        path = os.path.join(KIT_DIR, f["sha256"])
        if os.path.exists(path):
            return path
        os.makedirs(KIT_DIR, exist_ok=True)
        if disk_free(KIT_DIR) - f["bytes"] < KIT_RESERVE_BYTES:
            raise DriveError(f"This board's own disk is too full to keep the drive kit: it keeps {KIT_RESERVE_BYTES // 2**30} GiB free.")
        part = f"{path}.part"
        self.fetch(f, part, progress=False)
        os.replace(part, path)
        return path

    def download(self, f, part):
        self.fetch(f, part, progress=True)

    def fetch(self, f, part, progress):
        """Streams a file to `part`, hashing as it goes. After a network error it tries again with backoff and asks for the rest with
        Range; a 206 that names the right start carries on, a 200 starts over. A link that has expired waits in needs_urls."""
        have = os.path.getsize(part) if os.path.exists(part) else 0
        digest = hashlib.sha256()
        if have > f["bytes"]:
            os.remove(part)
            have = 0
        if have:
            # A resumed file's bytes are read and hashed again, so the hash stays honest.
            with open(part, "rb") as src:
                while block := src.read(BLOCK_BYTES):
                    digest.update(block)
        failures = 0
        if not os.path.exists(part):
            open(part, "wb").close()
        while have < f["bytes"]:
            self.check_stop()
            url = self.url_for(f["sha256"])
            request = urllib.request.Request(url, headers={"Range": f"bytes={have}-"} if have else {})
            try:
                response = DOWNLOADS.open(request, timeout=DOWNLOAD_TIMEOUT_S)
            except urllib.error.HTTPError as err:
                err.close()
                if err.code in (401, 403, 410):
                    self.wait_for_urls(f, url)
                    continue
                failures = self.retry(failures, f, f"HTTP {err.code}")
                continue
            except (urllib.error.URLError, OSError, http.client.HTTPException) as err:
                failures = self.retry(failures, f, err)
                continue
            with response:
                code = getattr(response, "status", 200)
                if have and code == 206 and not str(response.headers.get("Content-Range") or "").startswith(f"bytes {have}-"):
                    code = 200
                if have and code != 206:
                    # The server sent the whole file again, so it starts over.
                    have, digest = 0, hashlib.sha256()
                mode = "ab" if have else "wb"
                with open(part, mode) as out:
                    while True:
                        try:
                            block = response.read(BLOCK_BYTES)
                        except (OSError, http.client.HTTPException) as err:
                            failures = self.retry(failures, f, err)
                            break
                        if not block:
                            break
                        if have + len(block) > f["bytes"]:
                            out.close()
                            os.remove(part)
                            raise DriveError(f"{f['path']} came out bigger than the plan says, so it was deleted.")
                        write_block(out, block)
                        digest.update(block)
                        have += len(block)
                        failures = 0
                        if progress:
                            self.progress(len(block), f["path"])
                        else:
                            self.check_stop()
                    out.flush()
                    os.fsync(out.fileno())
            if have < f["bytes"] and failures == 0:
                failures = self.retry(failures, f, "the download ended early")
        if digest.hexdigest() != f["sha256"]:
            os.remove(part)
            raise DriveError(f"{f['path']} didn't match its sha256 after the download, so it was deleted and not used.")

    def retry(self, failures, f, why):
        failures += 1
        print(f"download of {f['path']}: {blank_urls(why)}", flush=True)
        if failures > DOWNLOAD_RETRIES:
            raise DriveError(f"{f['path']}: {DOWNLOAD_FAILED}")
        stop_event.wait(min(RETRY_WAIT_S * 2 ** (failures - 1), 30))
        self.check_stop()
        return failures

    def wait_for_urls(self, f, url):
        """The link expired. The platform sends fresh ones (export_model {export, urls}) while its drive card is open."""
        self.report("needs_urls", message=f"The link for {f['path']} expired. Muse Muse sends a fresh one while the drive card is open.", file=f["path"])
        while (read_json(os.path.join(self.folder, "urls.json")) or {}).get(f["sha256"]) in (None, url):
            self.sleep()
            self.refresh()
        self.report("writing", message=f"Writing to {self.drive['title']}.")

    # ---------- Verifying ----------

    def verify(self):
        """Unmounts, which drops the page cache for that filesystem, mounts again, and reads every file back from the drive."""
        self.report("verifying", message="Reading every file back from the drive.", file=None, mbps=None, eta_s=None)
        os.sync()
        udisks_unmount(self.drive["partition"])
        self.refresh()
        mount = udisks_mount(self.drive["partition"])
        self.refresh()
        base = os.path.join(mount, self.plan["folder"])
        problems = []
        listed = set()
        for f in self.files:
            self.check_stop()
            listed.add(f["path"])
            path = os.path.join(base, *f["path"].split("/"))
            if not os.path.isfile(path):
                problems.append(f"{f['path']} is missing.")
            elif os.path.getsize(path) != f["bytes"] or sha256_of(path) != f["sha256"]:
                problems.append(f"{f['path']} doesn't match its sha256.")
        for root, _dirs, names in os.walk(base):
            for name in names:
                rel = os.path.relpath(os.path.join(root, name), base).replace(os.sep, "/")
                if rel not in listed:
                    problems.append(f"{rel} isn't on the list.")
        os.sync()
        udisks_unmount(self.drive["partition"])
        self.mount = None
        powered_off = udisks_power_off(self.drive["device"])
        return {"result": "FAIL" if problems else "PASS", "problems": problems, "powered_off": powered_off}

    def release(self):
        """Leaves the drive safe to pull, best effort: unmounted and powered off."""
        if self.drive and self.mount:
            try:
                os.sync()
                udisks_unmount(self.drive["partition"])
                udisks_power_off(self.drive["device"])
            except (DriveError, OSError):
                pass
        self.mount = None

    # ---------- The whole export ----------

    def run(self):
        copies = self.status["copies"]
        while self.status["copies_done"] < copies:
            self.drive = self.next_drive()
            if self.drive is None:
                done = self.status["copies_done"]
                return self.end("done" if done else "stopped", message=f"Armed time ran out after {done} drive(s)." if done else "No drive was plugged in while it was armed.")
            try:
                started = time.time()
                mount = self.prepare()
                self.write_all(mount)
                result = self.verify()
            except Unplugged as err:
                self.mount = None
                path = str(err)
                where = f" while writing {path}" if "/" in path or "." in path else ""
                if not self.status["armed"]:
                    raise DriveError(f"The drive was unplugged{where}. Plug it back in and start the export again to carry on: the files already written are kept.")
                self.note = f"The drive was unplugged{where}. Plug it back in to carry on: the files already written are kept."
                continue
            seconds = round(time.time() - started)
            self.status["results"].append({"drive": self.drive["title"], "bytes": self.drive["bytes"], "seconds": seconds, **result})
            self.status["copies_done"] += 1
            self.seen.add(self.drive["identity"])
            last = self.status["copies_done"] >= copies or not self.status["armed"]
            safe = "Safe to unplug." if result["powered_off"] else "It's unmounted, so it's safe to unplug."
            words = f"Done: {result['result']}. {safe}" if result["result"] == "PASS" else f"Done: FAIL. {' '.join(result['problems'][:5])} {safe}"
            if last:
                return self.end("done", message=words, result=result["result"], problems=result["problems"])
            self.note = f"Copy {self.status['copies_done']} of {copies}: {words} Plug in the next drive."
            self.status.update(result=result["result"], problems=result["problems"])
        return self.end("done", message="Every copy is done.")

    def end(self, state, **fields):
        self.release()
        self.report(state, file=None, erasable=False, **fields, seconds=round(time.time() - self.status["started"]))
        with_urls = os.path.join(self.folder, "urls.json")
        if os.path.exists(with_urls):
            os.remove(with_urls)


def write_block(out, block):
    out.write(block)


def sha256_of(path):
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        while block := f.read(BLOCK_BYTES):
            digest.update(block)
    return digest.hexdigest()


def sync_folder(path):
    """Each folder's own entries, so the renames are on the drive too. Not every filesystem lets a folder be synced."""
    for root, _dirs, _files in os.walk(path, topdown=False):
        try:
            fd = os.open(root, os.O_RDONLY)
        except OSError:
            continue
        try:
            os.fsync(fd)
        except OSError:
            pass
        finally:
            os.close(fd)


def disk_free(path):
    stat = os.statvfs(path)
    return stat.f_bavail * stat.f_frsize


def run_export(folder):
    """The export's own process. Every way it ends is written to status.json."""
    stop_event.clear()
    export = Export(folder)
    try:
        export.run()
    except Stopped:
        export.end("stopped", message="Stopped. What was written is kept on the drive, and it's safe to unplug.")
    except DriveError as err:
        export.end("failed", message=blank_urls(err))
    except Exception as err:  # noqa: BLE001: whatever went wrong, the card must hear it, not wait forever.
        print(f"export failed: {err!r}", flush=True)
        export.end("failed", message=blank_urls(f"The export stopped: {err}"))


# ---------- What server.py calls ----------


def current_export():
    return read_text(os.path.join(EXPORT_DIR, "current")) or None


def process_alive(export_id, pid):
    """Whether an export's process lives. After a restart the server only has /proc, and the path guards against a reused pid."""
    if export_process is not None and export_process.pid == pid:
        return export_process.poll() is None
    return folder_of(export_id) in (read_text(f"/proc/{pid}/cmdline") or "")


def export_status(export_id):
    """What an export's status file says, except that an active export whose process has gone is recorded as failed."""
    config = read_json(file_of(export_id, "config.json"))
    if not config:
        return None
    # In this order, as run_status does, so a process that ends between the two steps has already written its last status.
    alive = process_alive(export_id, config["pid"])
    status = read_json(file_of(export_id, "status.json"))
    if not status:
        return None
    if status.get("state") in ACTIVE_STATES and not alive:
        status.update(state="failed", message="The export stopped without saying why. Start it again to carry on: the files already written are kept.")
        try:
            write_json(file_of(export_id, "status.json"), status)
        except OSError:
            pass
    return status


def active_export():
    export_id = current_export()
    status = export_status(export_id) if export_id else None
    return export_id if status and status.get("state") in ACTIVE_STATES else None


def status_report():
    """drive_status: the drives plugged in, and the current or last export."""
    export_id = current_export()
    status = export_status(export_id) if export_id else None
    if status:
        status = {key: value for key, value in status.items() if key != "pid"}
    return {"drives": find_drives(), "export": status}


def spawn_export(folder):
    """Starts an export's process in its own session, as train_model starts a run."""
    with open(os.path.join(folder, "drive.log"), "ab") as log:
        return subprocess.Popen([sys.executable, DRIVE_SCRIPT, "--export", folder], cwd=folder, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)


def export_model(args, board_files):
    """export_model: starts an export now on a named drive, arms one for drives plugged in after this call, hands fresh links to an
    export waiting in needs_urls, or carries on an export that failed or was stopped."""
    global export_process
    plan = args.get("plan")
    export_id = plan.get("export") if isinstance(plan, dict) else args.get("export")
    if not isinstance(export_id, str) or not EXPORT_ID.fullmatch(export_id):
        raise DriveError("Send a plan, or the export to carry on.")
    urls = args.get("urls")
    with export_lock:
        active = active_export()
        if plan is None:
            stored = read_json(file_of(export_id, "plan.json"))
            if not stored:
                raise DriveError(f"There is no export called {export_id} on this board.")
            if active == export_id:
                # Fresh links for an export that waits on one.
                if not isinstance(urls, dict) or not urls:
                    raise DriveError(f"Export {export_id} is already going. Send urls to give it fresh links.")
                check_urls(urls, list(urls))
                write_json(file_of(export_id, "urls.json"), {**(read_json(file_of(export_id, "urls.json")) or {}), **urls}, 0o600)
                return {"export": export_id, "state": export_status(export_id)["state"]}
            plan = stored
        if active and active != export_id:
            raise DriveError(f"Export {active} is still going. Wait for it, or stop it first.")
        if active == export_id:
            raise DriveError(f"Export {export_id} is already going. To give it fresh links, send only export and urls.")
        files = check_plan(plan, board_files)
        wait = args.get("wait_for_drive", False)
        if not isinstance(wait, bool):
            raise DriveError("wait_for_drive must be true or false.")
        copies = args.get("copies", 1)
        if isinstance(copies, bool) or not isinstance(copies, int) or not 1 <= copies <= MAX_COPIES:
            raise DriveError(f"copies must be a whole number from 1 to {MAX_COPIES}.")
        if not wait and copies != 1:
            raise DriveError("Only an armed export makes several copies.")
        needed = url_keys(files)
        stored_urls = read_json(file_of(export_id, "urls.json")) or {}
        urls = check_urls({**stored_urls, **(urls or {})}, needed)
        if wait and any(urllib.parse.urlsplit(urls[key]).query for key in needed):
            raise DriveError("A file in this plan has a link that expires, so the export can't wait for a drive. Plug the drive in, then export now.")
        drives = find_drives()
        drive, identity = args.get("drive"), args.get("identity")
        if not wait:
            if not isinstance(drive, str) or not DRIVE_NAME.fullmatch(drive):
                raise DriveError("Name the drive to write to, from drive_status, or arm the export with wait_for_drive.")
            found = next((d for d in drives if d["name"] == drive), None)
            if not found or (identity is not None and found["identity"] != identity):
                raise DriveError(f"{drive} isn't plugged in, or it isn't the drive that was picked. Call drive_status again.")
            if not found["usable"]:
                raise DriveError(found["why"])
            identity = found["identity"]
        folder = folder_of(export_id)
        os.makedirs(folder, mode=0o700, exist_ok=True)
        os.makedirs(EXPORT_DIR, exist_ok=True)
        for leftover in ("erase.json", "status.json"):
            if os.path.exists(os.path.join(folder, leftover)):
                os.remove(os.path.join(folder, leftover))
        write_json(os.path.join(folder, "plan.json"), plan)
        write_json(os.path.join(folder, "urls.json"), {key: urls[key] for key in needed}, 0o600)
        write_json(os.path.join(folder, "args.json"), {
            "drive": None if wait else drive,
            "identity": None if wait else identity,
            "wait_for_drive": wait,
            "copies": copies,
            "armed_until": time.time() + ARM_HOURS * 3600 if wait else None,
            # Only drives plugged in after arming count, so a stick already in the board is never written to by surprise.
            "seen": [d["identity"] for d in drives] if wait else [],
        })
        write_json(os.path.join(folder, "status.json"), {"export": export_id, "state": "waiting_for_drive" if wait else "checking", "started": time.time(), "total_bytes": sum(f["bytes"] for f in files)})
        export_process = spawn_export(folder)
        write_json(os.path.join(folder, "config.json"), {"pid": export_process.pid, "started": time.time()})
        with open(os.path.join(EXPORT_DIR, "current.part"), "w") as f:
            f.write(export_id)
        os.replace(os.path.join(EXPORT_DIR, "current.part"), os.path.join(EXPORT_DIR, "current"))
    return {"export": export_id, "state": "waiting_for_drive" if wait else "checking", "folder": plan["folder"]}


def erase_drive(args):
    """erase_drive: only for the drive an export waits on in needs_erase, after a person typed its name (or ERASE when it has none).
    The export's process looks at the drive once more just before the format."""
    name, identity, confirm = args.get("drive"), args.get("identity"), args.get("confirm")
    if not all(isinstance(value, str) and value for value in (name, identity, confirm)):
        raise DriveError("Send the drive, its identity, and the word the person typed.")
    with export_lock:
        export_id = active_export()
        status = export_status(export_id) if export_id else None
        if not status or status.get("state") != "needs_erase" or (status.get("drive") or {}).get("name") != name:
            raise DriveError("No export is waiting to erase that drive. Nothing was erased.")
        if not status.get("erasable"):
            raise DriveError("That drive is over 256 GB, so it isn't erased from here. Nothing was erased.")
        drive = find_drive(name)
        if not drive or drive["identity"] != identity or status["drive"].get("identity") != identity:
            raise DriveError("That drive changed since it was listed, so nothing was erased. Look at the card again.")
        word = drive["label"] or "ERASE"
        if confirm != word:
            raise DriveError(f"To erase it, type {word} exactly. Nothing was erased.")
        write_json(file_of(export_id, "erase.json"), {"name": name, "identity": identity, "at": time.time()})
    return {"export": export_id, "erasing": name}


def stop_export(args):
    """stop_export: ends the export, keeps what was written, and leaves the drive unmounted and powered off."""
    with export_lock:
        export_id = args.get("export") or active_export()
        if not isinstance(export_id, str) or not EXPORT_ID.fullmatch(export_id):
            raise DriveError("No export is going.")
        status = export_status(export_id)
        if not status:
            raise DriveError(f"There is no export called {export_id} on this board.")
        if status.get("state") not in ACTIVE_STATES:
            raise DriveError(f"Export {export_id} isn't going. It is {status.get('state')}.")
        pid = read_json(file_of(export_id, "config.json"))["pid"]
        if export_process is not None and export_process.pid == pid:
            export_process.terminate()
        else:
            try:
                os.kill(pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        deadline = time.time() + STOP_TIMEOUT_S
        while process_alive(export_id, pid) and time.time() < deadline:
            time.sleep(0.1)
        if process_alive(export_id, pid):
            try:
                os.killpg(pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
        status = read_json(file_of(export_id, "status.json")) or status
        if status.get("state") in ACTIVE_STATES:
            # Killed before it could say so itself. The drive is left safe to pull.
            drive = status.get("drive") or {}
            found = find_drive(drive.get("name") or "", drive.get("identity"))
            if found and found["mount"]:
                udisks_unmount(found["partition"])
                udisks_power_off(found["device"])
            status.update(state="stopped", message="Stopped. What was written is kept on the drive, and it's safe to unplug.")
            write_json(file_of(export_id, "status.json"), status)
        urls = file_of(export_id, "urls.json")
        if os.path.exists(urls):
            os.remove(urls)
    return {key: value for key, value in status.items() if key != "pid"}


def main():
    parser = argparse.ArgumentParser(description="Writes one drive export. server.py starts it.")
    parser.add_argument("--export", required=True, help="the export's folder, holding plan.json and args.json")
    options = parser.parse_args()
    signal.signal(signal.SIGTERM, lambda *_: stop_event.set())
    run_export(options.export)


if __name__ == "__main__":
    main()
