"""Tests for drive.py and the drive tools in server.py. They need no root, no udisks and no USB drive.

  python -m unittest test_drive

A fake drive is a temp folder that holds its files, and lsblk's tree, a sysfs tree and the mounts are made up around it:
mounting one gives back its folder, powering one off unplugs it, and erasing one gives it a new empty folder. Fake model files are
small files starting GGUF. The large-file rules are decided from a plan's sizes, so no 4 GB file is ever written. Exports run in
a thread of this process instead of their own, so the fakes reach them.
"""
import base64
import errno
import hashlib
import io
import itertools
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
from unittest import mock

import drive
import server

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURE = os.path.join(HERE, "fixtures", "plan-small.json")
FAKE_PIDS = itertools.count(2_000_000_000)
REAL_BUSY_DEVICES = drive.busy_devices


def sha(data):
    return hashlib.sha256(data).hexdigest()


def wait_for(condition, seconds=20):
    deadline = time.time() + seconds
    while not condition():
        if time.time() > deadline:
            raise AssertionError("Timed out waiting.")
        time.sleep(0.02)


def load_fixture():
    with open(FIXTURE, encoding="utf-8") as f:
        return json.load(f)


def with_files(plan, extra, export="exp_0123456789ab"):
    """The golden plan with more files before its manifests, a new export id, and SHA256SUMS made again to match."""
    files = [f for f in plan["files"] if f["path"] != "SHA256SUMS"]
    files = files[:-1] + extra + files[-1:]
    sums = "".join(f"{f['sha256']}  {f['path']}\n" for f in sorted(files, key=lambda f: f["path"]))
    files.append({"path": "SHA256SUMS", "bytes": len(sums.encode()), "sha256": sha(sums.encode()), "text": sums})
    return {**plan, "export": export, "folder": f"MuseMuse/test-{export[4:8]}", "files": files, "needsLargeFiles": any(f["bytes"] > drive.FAT32_MAX_FILE_BYTES for f in files)}


class FakeDrives:
    """The drives plugged into a pretend board."""

    def __init__(self, root):
        self.root = root
        self.media = os.path.join(root, "media") + os.sep
        self.sys = os.path.join(root, "sys")
        os.makedirs(os.path.join(self.sys, "block"))
        self.disks = {}
        self.others = []
        self.calls = []
        self.busy = {(179, 1)}
        self.on_mount = None
        self.count = itertools.count(1)

    def plug(self, name="sda", size=32 * 10**9, fstype="exfat", label="STICK", free=None, ro=False, tran="usb", usb=True, rm=True,
             partitioned=True, serial=None, uuid=None, content=None, mountpoint=None, model="Ultra"):
        number = next(self.count)
        uuid = uuid or f"{number:04X}-ABCD"
        content = content or os.path.join(self.media, f"{name}-{uuid}")
        os.makedirs(content, exist_ok=True)
        bus = os.path.join(self.sys, "devices", "platform", "3610000.usb" if usb else "14100000.pcie", "usb2" if usb else "pci0000:00", "2-1", "host0", "block", name)
        os.makedirs(bus, exist_ok=True)
        link = os.path.join(self.sys, "block", name)
        if os.path.lexists(link):
            os.remove(link)
        os.symlink(bus, link)
        self.disks[name] = {
            "name": name, "size": size, "fstype": fstype, "label": label, "uuid": uuid, "free": size if free is None else free, "ro": ro,
            "tran": tran, "rm": rm, "partitioned": partitioned, "serial": serial or f"SN-{name}-{number}", "content": content,
            "mounted": mountpoint, "number": (8, 16 * number), "model": model,
        }
        return content

    def unplug(self, name):
        return self.disks.pop(name)

    def replug(self, disk):
        self.disks[disk["name"]] = {**disk, "mounted": None}

    def tree(self):
        out = []
        for d in self.disks.values():
            major, minor = d["number"]
            node = {"name": d["name"], "path": f"/dev/{d['name']}", "size": d["size"], "type": "disk", "tran": d["tran"], "rm": d["rm"], "hotplug": d["rm"],
                    "ro": d["ro"], "fstype": None, "label": None, "uuid": None, "mountpoint": None, "vendor": "SanDisk ", "model": d["model"],
                    "serial": d["serial"], "maj:min": f"{major}:{minor}"}
            fs = {"fstype": d["fstype"], "label": d["label"] or None, "uuid": d["uuid"] if d["fstype"] else None, "mountpoint": d["mounted"], "ro": d["ro"]}
            if d["partitioned"]:
                node["children"] = [{"name": f"{d['name']}1", "path": f"/dev/{d['name']}1", "size": d["size"] - 2**20, "type": "part", "maj:min": f"{major}:{minor + 1}", **fs}]
            else:
                node.update(fs)
            out.append(node)
        return out + self.others

    def disk_of(self, device):
        name = device.rsplit("/", 1)[-1]
        found = self.disks.get(name) or self.disks.get(name.rstrip("0123456789"))
        if not found:
            raise drive.DriveError(f"{device} is gone.")
        return found

    def mount(self, device):
        d = self.disk_of(device)
        self.calls.append(("mount", d["name"]))
        if d["mounted"] is None:
            d["mounted"] = d["content"]
            if self.on_mount:
                self.on_mount(d, sum(1 for c in self.calls if c == ("mount", d["name"])))
        return d["mounted"]

    def unmount(self, device):
        d = self.disk_of(device)
        self.calls.append(("unmount", d["name"]))
        d["mounted"] = None

    def power_off(self, device):
        d = self.disk_of(device)
        self.calls.append(("power_off", d["name"]))
        self.disks.pop(d["name"])
        return True

    def format(self, name):
        d = self.disks[name]
        self.calls.append(("format", name))
        d.update(fstype="exfat", label="MUSEMUSE", uuid=f"{next(self.count):04X}-E0E0", partitioned=True, mounted=None, free=d["size"])
        d["content"] = os.path.join(self.media, f"{name}-{d['uuid']}")
        os.makedirs(d["content"])

    def free(self, mount):
        for d in self.disks.values():
            if d["content"] == mount:
                return d["free"]
        return 0

    def written(self, name_or_disk, folder):
        d = self.disks[name_or_disk] if isinstance(name_or_disk, str) else name_or_disk
        base = os.path.join(d["content"], folder)
        return sorted(os.path.relpath(os.path.join(r, n), base).replace(os.sep, "/") for r, _, ns in os.walk(base) for n in ns)


class FakeResponse(io.BytesIO):
    def __init__(self, data, status=200, headers=None, cut=None):
        super().__init__(data)
        self.status = status
        self.headers = headers or {}
        self.cut = cut

    def read(self, n=-1):
        if self.cut is not None and self.tell() >= self.cut:
            raise ConnectionResetError("cut off")
        if self.cut is not None and n and n > 0:
            n = min(n, self.cut - self.tell())
        return super().read(n)


class FakeDownloads:
    """A public server for kit files and model files, which honors Range unless told not to."""

    def __init__(self):
        self.files = {}
        self.requests = []
        self.cut_first = None
        self.refuse = {}
        self.ignore_range = False

    def open(self, request, timeout=None):
        url = request.full_url
        self.requests.append((url, request.get_header("Range")))
        if self.refuse.get(url):
            self.refuse[url] -= 1
            raise urllib.error.HTTPError(url, 403, "Forbidden", {}, io.BytesIO(b""))
        data = self.files.get(url)
        if data is None:
            raise urllib.error.HTTPError(url, 404, "Not Found", {}, io.BytesIO(b""))
        start = int(request.get_header("Range")[len("bytes="):-1]) if request.get_header("Range") else 0
        cut, self.cut_first = self.cut_first, None
        if start and not self.ignore_range:
            return FakeResponse(data[start:], 206, {"Content-Range": f"bytes {start}-{len(data) - 1}/{len(data)}"}, cut)
        return FakeResponse(data, 200, {}, cut)


class ThreadChild:
    """An export's process, as a thread of this one, so the fakes reach it."""

    def __init__(self, folder):
        self.pid = next(FAKE_PIDS)
        self.thread = threading.Thread(target=drive.run_export, args=(folder,), daemon=True)
        self.thread.start()

    def poll(self):
        return None if self.thread.is_alive() else 0

    def terminate(self):
        drive.stop_event.set()


class DriveTestCase(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.home, ignore_errors=True)
        self.drives = FakeDrives(os.path.join(self.home, "board"))
        self.downloads = FakeDownloads()
        models = os.path.join(self.home, "models")
        os.makedirs(models)
        patches = {
            (drive, "EXPORT_DIR"): os.path.join(self.home, "drive-export"),
            (drive, "KIT_DIR"): os.path.join(self.home, "drive-export", "kit"),
            (drive, "MODEL_DIR"): models,
            (server, "MODEL_DIR"): models,
            (drive, "SYS_ROOT"): self.drives.sys,
            (drive, "POLL_S"): 0.02,
            (drive, "RETRY_WAIT_S"): 0,
            (drive, "STOP_TIMEOUT_S"): 5,
            (drive, "export_process"): None,
            (drive, "lsblk_tree"): self.drives.tree,
            (drive, "busy_devices"): lambda: self.drives.busy,
            (drive, "media_root"): lambda: self.drives.media,
            (drive, "udisks_mount"): self.drives.mount,
            (drive, "udisks_unmount"): self.drives.unmount,
            (drive, "udisks_power_off"): self.drives.power_off,
            (drive, "format_exfat"): self.drives.format,
            (drive, "free_bytes"): self.drives.free,
            (drive, "disk_free"): lambda _path: 50 * 2**30,
            (drive, "addresses_of"): lambda _host: {"93.184.216.34"},
            (drive, "spawn_export"): ThreadChild,
        }
        for (module, name), value in patches.items():
            patcher = mock.patch.object(module, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        opener = mock.patch.object(drive.DOWNLOADS, "open", self.downloads.open)
        opener.start()
        self.addCleanup(opener.stop)
        self.addCleanup(self.end_export)
        self.fixture = load_fixture()
        for name, data in self.fixture["board"].items():
            with open(os.path.join(models, name), "wb") as f:
                f.write(base64.b64decode(data))
        self.models = models

    def end_export(self):
        drive.stop_event.set()
        child = drive.export_process
        if isinstance(child, ThreadChild):
            child.thread.join(10)
        drive.stop_event.clear()

    def stage_kit(self):
        os.makedirs(drive.KIT_DIR, exist_ok=True)
        for key, data in self.fixture["kit"].items():
            with open(os.path.join(drive.KIT_DIR, key), "wb") as f:
                f.write(base64.b64decode(data))

    def serve_kit(self):
        urls = {}
        for key, data in self.fixture["kit"].items():
            url = f"https://kit.example/drive-kit/{key}"
            self.downloads.files[url] = base64.b64decode(data)
            urls[key] = url
        return urls

    def call(self, tool, /, **arguments):
        result = server.handle_rpc("tools/call", {"name": tool, "arguments": arguments})
        text = result["content"][0]["text"]
        return bool(result.get("isError")), (text if result.get("isError") else json.loads(text))

    def start(self, plan=None, **arguments):
        error, reply = self.call("export_model", plan=plan or self.fixture["plan"], **arguments)
        self.assertFalse(error, reply)
        return reply

    def status(self):
        return self.call("drive_status")[1]["export"]

    def wait_for_state(self, *states):
        wait_for(lambda: (self.status() or {}).get("state") in states)
        return self.status()

    def finished(self):
        status = self.wait_for_state("done", "failed", "stopped")
        drive.export_process.thread.join(10)
        return status


class DetectionTests(DriveTestCase):
    def test_a_usb_stick_is_offered_with_what_it_holds(self):
        self.drives.plug("sda", label="PHOTOS", free=10 * 10**9, mountpoint=None)
        (found,) = drive.find_drives()
        self.assertEqual((found["name"], found["kind"], found["filesystem"], found["label"], found["usable"]), ("sda", "USB stick", "exfat", "PHOTOS", True))
        self.assertEqual(found["partition"], "/dev/sda1")
        self.assertRegex(found["identity"], r"^[0-9a-f]{16}$")

    def test_a_usb_ssd_is_offered_as_a_usb_disk(self):
        self.drives.plug("sdb", rm=False)
        self.assertEqual(drive.find_drives()[0]["kind"], "USB disk")

    def test_the_boards_own_disks_and_loop_devices_are_never_offered(self):
        self.drives.others = [
            {"name": "mmcblk0", "type": "disk", "tran": None, "size": 64 * 10**9, "maj:min": "179:0", "children": [{"name": "mmcblk0p1", "type": "part", "mountpoint": "/", "maj:min": "179:1"}]},
            {"name": "nvme0n1", "type": "disk", "tran": "nvme", "size": 10**12, "maj:min": "259:0"},
            {"name": "loop0", "type": "loop", "tran": None, "size": 2**28, "maj:min": "7:0"},
            {"name": "zram0", "type": "disk", "tran": None, "size": 2**30, "maj:min": "252:0", "mountpoint": "[SWAP]"},
        ]
        self.assertEqual(drive.find_drives(), [])

    def test_a_usb_disk_the_board_boots_from_is_refused(self):
        self.drives.plug("sda")
        self.drives.busy = {(8, 17)}
        (found,) = drive.find_drives()
        self.assertFalse(found["usable"])
        self.assertIn("board's own disks", found["why"])
        self.drives.busy = set()
        self.drives.disks["sda"]["mounted"] = "/"
        self.assertIn("board's own disks", drive.find_drives()[0]["why"])

    def test_a_drive_another_user_mounted_is_left_alone(self):
        self.drives.plug("sda", mountpoint="/media/someone/STICK")
        found = drive.find_drives()[0]
        self.assertFalse(found["usable"])
        self.assertIn("Another user", found["why"])

    def test_only_usb_counts(self):
        self.drives.plug("sda", tran="sata")
        self.drives.plug("sdb", usb=False)
        self.assertEqual(drive.find_drives(), [])

    def test_a_loop_device_counts_only_inside_the_loopback_tests_folder(self):
        allowed = os.path.join(self.home, "loopback")
        os.makedirs(os.path.join(self.drives.sys, "block", "loop3", "loop"))
        self.drives.others = [{"name": "loop3", "path": "/dev/loop3", "type": "loop", "tran": None, "size": 256 * 2**20, "fstype": "exfat", "label": "T", "uuid": "1", "maj:min": "7:3"}]
        backing = os.path.join(self.drives.sys, "block", "loop3", "loop", "backing_file")
        for where, offered in ((os.path.join(allowed, "drive.img"), True), (os.path.join(self.home, "elsewhere.img"), False)):
            with self.subTest(where=where):
                with open(backing, "w") as f:
                    f.write(where + "\n")
                self.assertEqual(drive.find_drives(), [])
                with mock.patch.object(drive, "DRIVE_ALLOW_LOOP_BACKING", allowed):
                    self.assertEqual(len(drive.find_drives()), int(offered))

    def test_a_drive_has_the_same_identity_until_it_changes(self):
        self.drives.plug("sda", serial="A")
        first = drive.find_drives()[0]["identity"]
        self.assertEqual(drive.find_drives()[0]["identity"], first)
        self.drives.unplug("sda")
        self.drives.plug("sda", serial="B")
        self.assertNotEqual(drive.find_drives()[0]["identity"], first)

    def test_the_busy_set_has_the_root_filesystems_device_and_not_this_users_drives(self):
        mounts = os.path.join(self.home, "mounts")
        with open(mounts, "w") as f:
            f.write(f"/dev/root / ext4 rw 0 0\n/dev/sdz1 {self.drives.media}MY\\040STICK exfat rw 0 0\n")
        with mock.patch.object(drive, "MOUNTS_FILE", mounts), mock.patch.object(drive, "SWAPS_FILE", os.path.join(self.home, "none")):
            self.assertEqual(drive.mounts()[1], ("/dev/sdz1", f"{self.drives.media}MY STICK"))
            root = os.stat("/").st_dev
            self.assertEqual(REAL_BUSY_DEVICES(), {(os.major(root), os.minor(root))})


class PlanTests(DriveTestCase):
    def assert_refused(self, words, plan, board_files=None):
        with self.assertRaises(drive.DriveError) as caught:
            drive.check_plan(plan, board_files if board_files is not None else list(self.fixture["board"]))
        self.assertIn(words, str(caught.exception))

    def test_the_golden_plan_is_taken(self):
        self.assertEqual(len(drive.check_plan(self.fixture["plan"], list(self.fixture["board"]))), len(self.fixture["plan"]["files"]))

    def test_paths_that_escape_or_a_drive_cant_hold_are_refused(self):
        for bad in ("/etc/passwd", "../up", "a/../../b", "a\\b", "a\x01b", "", "a//b", "a/", "./a", "x.gguf.part", "a:b", "what?", 5):
            with self.subTest(path=bad):
                plan = json.loads(json.dumps(self.fixture["plan"]))
                plan["files"][0]["path"] = bad
                self.assert_refused("plan.files[0]", plan)
        for folder in ("../x", "MuseMuse/../x", "Other/x", "MuseMuse/a/b", "MuseMuse/"):
            with self.subTest(folder=folder):
                self.assert_refused("plan.folder", {**self.fixture["plan"], "folder": folder})

    def test_inline_files_must_match_their_sha256(self):
        plan = json.loads(json.dumps(self.fixture["plan"]))
        inline = next(f for f in plan["files"] if "text" in f)
        inline["text"] += "x"
        self.assert_refused("doesn't match its own sha256", plan)
        self.assert_refused("doesn't match its own sha256", with_files(self.fixture["plan"], [{"path": "b.bin", "bytes": 3, "sha256": sha(b"abd"), "base64": base64.b64encode(b"abc").decode()}]))

    def test_unknown_board_files_and_two_sources_are_refused(self):
        self.assert_refused("isn't a model on this board", self.fixture["plan"], board_files=[])
        plan = json.loads(json.dumps(self.fixture["plan"]))
        plan["files"][0]["url"] = True
        self.assert_refused("exactly one of", plan)

    def test_too_many_files_or_a_wrong_large_file_flag_is_refused(self):
        many = [{"path": f"f{i}.txt", "bytes": 1, "sha256": sha(b"x"), "text": "x"} for i in range(drive.MAX_PLAN_FILES)]
        self.assert_refused("at most 400", with_files(self.fixture["plan"], many))
        self.assert_refused("needsLargeFiles", {**self.fixture["plan"], "needsLargeFiles": True})

    def test_links_must_be_https_at_a_public_address(self):
        key = "a" * 64
        with self.assertRaises(drive.DriveError):
            drive.check_urls({key: "http://kit.example/x"}, [key])
        for address in ("127.0.0.1", "10.0.0.5", "192.168.1.1", "169.254.169.254", "::1"):
            with self.subTest(address=address), mock.patch.object(drive, "addresses_of", return_value={address}), self.assertRaises(drive.DriveError) as caught:
                drive.check_urls({key: "https://kit.example/x"}, [key])
            self.assertIn("public address", str(caught.exception))
        with self.assertRaises(drive.DriveError):
            drive.check_urls({}, [key])

    def test_a_redirect_must_stay_https_and_public(self):
        handler = drive.HttpsOnlyRedirect()
        request = drive.urllib.request.Request("https://kit.example/x")
        for target in ("http://kit.example/x", "file:///etc/passwd"):
            with self.subTest(target=target), self.assertRaises(drive.DriveError):
                handler.redirect_request(request, None, 302, "Found", {}, target)
        with mock.patch.object(drive, "addresses_of", return_value={"10.1.2.3"}), self.assertRaises(drive.DriveError):
            handler.redirect_request(request, None, 302, "Found", {}, "https://cdn.example/x")


class ExportTests(DriveTestCase):
    def test_the_golden_plan_ends_on_the_drive_with_the_same_sha256sums(self):
        self.stage_kit()
        self.drives.plug("sda")
        disk = self.drives.disks["sda"]
        reply = self.start(drive="sda")
        self.assertEqual(reply["state"], "checking")
        status = self.finished()
        self.assertEqual((status["state"], status["result"]), ("done", "PASS"), status)
        self.assertIn("Safe to unplug", status["message"])
        plan = self.fixture["plan"]
        self.assertEqual(self.drives.written(disk, plan["folder"]), sorted(f["path"] for f in plan["files"]))
        with open(os.path.join(disk["content"], plan["folder"], "SHA256SUMS"), "rb") as f:
            self.assertEqual(sha(f.read()), self.fixture["manifestSha256"])
        # Mounted, unmounted to drop the cache, mounted again to read back, then unmounted and powered off.
        self.assertEqual([c for c in self.drives.calls if c[1] == "sda"], [("mount", "sda"), ("unmount", "sda"), ("mount", "sda"), ("unmount", "sda"), ("power_off", "sda")])
        self.assertEqual(drive.find_drives(), [], "powered off, so it's gone")
        self.assertFalse(os.path.exists(os.path.join(drive.EXPORT_DIR, plan["export"], "urls.json")))
        # ~/models is read and never changed.
        self.assertEqual(sorted(os.listdir(self.models)), sorted(self.fixture["board"]))

    def test_the_kit_is_fetched_once_from_its_links(self):
        urls = self.serve_kit()
        self.drives.plug("sda")
        self.start(drive="sda", urls=urls)
        self.assertEqual(self.finished()["result"], "PASS")
        fetched = len(self.downloads.requests)
        self.assertEqual(fetched, len(set(self.fixture["kit"])))
        self.drives.plug("sdb")
        self.start(with_files(self.fixture["plan"], []), drive="sdb")
        self.assertEqual(self.finished()["result"], "PASS")
        self.assertEqual(len(self.downloads.requests), fetched, "the second export fetched nothing")

    def test_a_kit_file_with_no_link_is_refused_before_anything_starts(self):
        self.drives.plug("sda")
        error, reply = self.call("export_model", plan=self.fixture["plan"], drive="sda")
        self.assertTrue(error)
        self.assertIn("needs a link", reply)
        self.assertIsNone(self.status())

    def test_fat32_takes_small_files_as_it_is(self):
        self.stage_kit()
        self.drives.plug("sda", fstype="vfat", label="OLD")
        self.start(drive="sda")
        self.assertEqual(self.finished()["result"], "PASS")
        self.assertNotIn(("format", "sda"), self.drives.calls)

    def test_a_file_over_4_gb_on_fat32_waits_for_an_erase_that_a_person_confirms(self):
        self.stage_kit()
        big = {"path": "model/big.gguf", "bytes": 5 * 2**30, "sha256": "b" * 64, "url": True}
        self.downloads.files["https://models.example/big.gguf"] = b""
        self.drives.plug("sda", fstype="vfat", label="OLD")
        disk = self.drives.disks["sda"]
        self.start(with_files(self.fixture["plan"], [big]), drive="sda", urls={"b" * 64: "https://models.example/big.gguf"})
        status = self.wait_for_state("needs_erase")
        self.assertIn("FAT32, which can't hold files over 4 GB, and big.gguf is 5.4 GB", status["message"])
        self.assertTrue(status["erasable"])
        identity = status["drive"]["identity"]
        time.sleep(0.2)
        self.assertNotIn(("format", "sda"), self.drives.calls, "never on its own")
        self.assertEqual(self.drives.written("sda", "MuseMuse/test-0123"), [], "nothing written")
        error, reply = self.call("erase_drive", drive="sda", identity=identity, confirm="ERASE")
        self.assertTrue(error)
        self.assertIn("type OLD exactly", reply)
        error, reply = self.call("erase_drive", drive="sda", identity="0" * 16, confirm="OLD")
        self.assertTrue(error)
        self.assertIn("changed since it was listed", reply)
        self.assertFalse(self.call("erase_drive", drive="sda", identity=identity, confirm="OLD")[0])
        wait_for(lambda: ("format", "sda") in self.drives.calls)
        self.wait_for_state("writing", "failed")
        self.assertEqual((disk["fstype"], disk["label"]), ("exfat", "MUSEMUSE"))
        self.assertEqual(self.drives.calls.count(("format", "sda")), 1)

    def test_a_drive_swapped_while_it_waits_is_never_erased(self):
        self.stage_kit()
        self.drives.plug("sda", fstype="ntfs", label="BACKUP")
        self.start(drive="sda")
        status = self.wait_for_state("needs_erase")
        self.assertIn("NTFS, which Macs can't write to", status["message"])
        identity = status["drive"]["identity"]
        # Pulled, and another put in under the same name: Linux calls the next disk sda too.
        self.drives.unplug("sda")
        self.drives.plug("sda", fstype="ntfs", label="BACKUP", serial="SOMEONE-ELSES")
        error, reply = self.call("erase_drive", drive="sda", identity=identity, confirm="BACKUP")
        self.assertTrue(error)
        # Refused either way: as a drive that changed, or because the export already saw it go.
        self.assertIn("nothing was erased", reply.lower())
        status = self.finished()
        self.assertEqual(status["state"], "failed")
        self.assertIn("unplugged", status["message"])
        self.assertNotIn(("format", "sda"), self.drives.calls)

    def test_the_export_looks_once_more_just_before_the_format(self):
        self.stage_kit()
        self.drives.plug("sda", fstype="ntfs", label="BACKUP")
        self.start(drive="sda")
        status = self.wait_for_state("needs_erase")
        # As if the person confirmed for a drive whose identity no longer matches by the time the export reads it.
        server.write_json(drive.file_of(status["export"], "erase.json"), {"name": "sda", "identity": "f" * 16, "at": 0})
        wait_for(lambda: "nothing was erased" in (self.status() or {}).get("message", ""))
        self.assertNotIn(("format", "sda"), self.drives.calls)
        self.assertEqual(self.status()["state"], "needs_erase")

    def test_ntfs_none_and_over_256_gb(self):
        self.stage_kit()
        self.drives.plug("sda", fstype=None, label="")
        self.start(drive="sda")
        status = self.wait_for_state("needs_erase")
        self.assertIn("has no filesystem a computer can read", status["message"])
        self.call("stop_export")
        self.wait_for_state("stopped")
        self.drives.unplug("sda")
        self.drives.plug("sdb", size=300 * 10**9, fstype="ext4", label="NAS")
        self.start(with_files(self.fixture["plan"], []), drive="sdb")
        status = self.wait_for_state("needs_erase")
        self.assertFalse(status["erasable"])
        self.assertIn("over 256 GB", status["message"])
        error, reply = self.call("erase_drive", drive="sdb", identity=status["drive"]["identity"], confirm="NAS")
        self.assertTrue(error)
        self.assertIn("over 256 GB", reply)

    def test_a_locked_drive_and_a_full_one(self):
        self.stage_kit()
        self.drives.plug("sda", ro=True)
        self.start(drive="sda")
        self.assertIn("locked", self.wait_for_state("read_only")["message"])
        self.call("stop_export")
        self.wait_for_state("stopped")
        self.drives.plug("sdb", size=2 * 10**9, free=10**6)
        self.start(with_files(self.fixture["plan"], [], "exp_00000000000b"), drive="sdb")
        self.assertIn("Nothing is deleted to make room", self.wait_for_state("needs_erase")["message"])
        self.call("stop_export")
        self.wait_for_state("stopped")
        self.drives.plug("sdc", size=10**6, free=10**6)
        self.start(with_files(self.fixture["plan"], [], "exp_00000000000c"), drive="sdc")
        self.assertIn("Use a bigger drive", self.wait_for_state("too_small")["message"])

    def test_an_armed_export_writes_only_drives_plugged_in_after_it_and_never_erases(self):
        self.stage_kit()
        self.drives.plug("sda")
        self.start(wait_for_drive=True)
        self.wait_for_state("waiting_for_drive")
        time.sleep(0.15)
        self.assertEqual(self.drives.calls, [], "the stick that was already there is left alone")
        self.drives.plug("sdb", fstype="ntfs", label="WIN")
        self.wait_for_state("needs_erase")
        time.sleep(0.15)
        self.assertNotIn(("format", "sdb"), self.drives.calls)
        self.drives.unplug("sdb")
        self.wait_for_state("waiting_for_drive")
        self.drives.plug("sdc")
        status = self.finished()
        self.assertEqual(status["result"], "PASS")
        self.assertEqual(status["drive"]["name"], "sdc")

    def test_an_armed_export_makes_several_copies(self):
        self.stage_kit()
        self.start(wait_for_drive=True, copies=2)
        self.drives.plug("sdb")
        wait_for(lambda: (self.status() or {}).get("copies_done") == 1)
        self.drives.plug("sdc")
        status = self.finished()
        self.assertEqual(([r["result"] for r in status["results"]], status["copies_done"]), (["PASS", "PASS"], 2))

    def test_a_link_that_expires_cant_be_armed(self):
        self.stage_kit()
        extra = {"path": "model/x.gguf", "bytes": 4, "sha256": sha(b"GGUF"), "url": True}
        error, reply = self.call("export_model", plan=with_files(self.fixture["plan"], [extra]), wait_for_drive=True, urls={extra["sha256"]: "https://s3.example/x.gguf?X-Amz-Signature=abc"})
        self.assertTrue(error)
        self.assertIn("expires", reply)
        self.assertNotIn("X-Amz", reply)

    def test_one_export_at_a_time_and_stop_keeps_what_was_written(self):
        self.stage_kit()
        self.start(wait_for_drive=True)
        self.wait_for_state("waiting_for_drive")
        error, reply = self.call("export_model", plan=with_files(self.fixture["plan"], []), wait_for_drive=True)
        self.assertTrue(error)
        self.assertIn("still going", reply)
        error, reply = self.call("stop_export")
        self.assertFalse(error, reply)
        self.assertEqual(self.finished()["state"], "stopped")
        self.assertTrue(self.call("stop_export")[0], "nothing to stop")


class DownloadTests(DriveTestCase):
    MODEL = b"GGUF downloaded model " * 500
    URL = "https://models.example/m.gguf"

    def plan(self):
        return with_files(self.fixture["plan"], [{"path": "model/m.gguf", "bytes": len(self.MODEL), "sha256": sha(self.MODEL), "url": True}])

    def start_download(self, **arguments):
        self.stage_kit()
        self.downloads.files[self.URL] = self.MODEL
        self.drives.plug("sda")
        with mock.patch.object(drive, "BLOCK_BYTES", 1000):
            self.start(self.plan(), drive="sda", urls={sha(self.MODEL): self.URL}, **arguments)
            return self.finished()

    def test_a_cut_download_resumes_with_range_and_rehashes_what_it_has(self):
        self.downloads.cut_first = 3000
        self.assertEqual(self.start_download()["result"], "PASS")
        model = [r for r in self.downloads.requests if r[0] == self.URL]
        self.assertEqual(model, [(self.URL, None), (self.URL, "bytes=3000-")])

    def test_a_200_to_a_range_request_starts_over(self):
        self.downloads.cut_first = 3000
        self.downloads.ignore_range = True
        self.assertEqual(self.start_download()["result"], "PASS")

    def test_a_refused_link_waits_for_a_fresh_one(self):
        self.stage_kit()
        self.downloads.files[self.URL] = self.MODEL
        self.downloads.refuse[self.URL] = 1
        self.drives.plug("sda")
        reply = self.start(self.plan(), drive="sda", urls={sha(self.MODEL): self.URL})
        status = self.wait_for_state("needs_urls")
        self.assertIn("expired", status["message"])
        fresh = "https://models.example/m.gguf?fresh=1"
        self.downloads.files[fresh] = self.MODEL
        error, answer = self.call("export_model", export=reply["export"], urls={sha(self.MODEL): fresh})
        self.assertFalse(error, answer)
        status = self.finished()
        self.assertEqual(status["result"], "PASS")
        self.assertNotIn("fresh=1", json.dumps(status), "no link in a status")

    def test_a_file_that_doesnt_match_is_deleted_and_never_used(self):
        self.stage_kit()
        self.downloads.files[self.URL] = self.MODEL[:-1] + b"!"
        self.drives.plug("sda")
        disk = self.drives.disks["sda"]
        self.start(self.plan(), drive="sda", urls={sha(self.MODEL): self.URL})
        status = self.finished()
        self.assertEqual(status["state"], "failed")
        self.assertIn("model/m.gguf didn't match its sha256", status["message"])
        written = self.drives.written(disk, "MuseMuse/test-0123")
        self.assertNotIn("model/m.gguf", written)
        self.assertNotIn("model/m.gguf.part", written)

    def test_a_private_address_is_refused(self):
        self.stage_kit()
        self.drives.plug("sda")
        with mock.patch.object(drive, "addresses_of", return_value={"192.168.1.20"}):
            error, reply = self.call("export_model", plan=self.plan(), drive="sda", urls={sha(self.MODEL): self.URL})
        self.assertTrue(error)
        self.assertIn("public address", reply)


class VerifyTests(DriveTestCase):
    def run_with(self, on_mount):
        self.stage_kit()
        self.drives.plug("sda")
        self.drives.on_mount = on_mount
        self.start(drive="sda")
        return self.finished()

    def test_a_byte_flipped_before_the_read_back_fails(self):
        def flip(disk, count):
            if count == 2:
                path = os.path.join(disk["content"], self.fixture["plan"]["folder"], "model", "support-coach.gguf")
                with open(path, "r+b") as f:
                    f.seek(10)
                    f.write(b"X")

        status = self.run_with(flip)
        self.assertEqual((status["result"], status["problems"]), ("FAIL", ["model/support-coach.gguf doesn't match its sha256."]))
        self.assertIn("Done: FAIL", status["message"])

    def test_a_missing_file_and_an_extra_one_fail(self):
        def change(disk, count):
            if count == 2:
                base = os.path.join(disk["content"], self.fixture["plan"]["folder"])
                os.remove(os.path.join(base, "README.txt"))
                with open(os.path.join(base, "stray.txt"), "w") as f:
                    f.write("x")

        status = self.run_with(change)
        self.assertEqual(status["result"], "FAIL")
        self.assertEqual(sorted(status["problems"]), ["README.txt is missing.", "stray.txt isn't on the list."])

    def test_a_retry_after_a_fail_rewrites_only_what_is_wrong(self):
        kept = []

        def spoil(disk, count):
            if count == 2 and not kept:
                kept.append(disk)
                with open(os.path.join(disk["content"], self.fixture["plan"]["folder"], "README.txt"), "ab") as f:
                    f.write(b"x")

        self.assertEqual(self.run_with(spoil)["result"], "FAIL")
        self.assertNotIn("sda", self.drives.disks, "powered off after the check")
        self.drives.on_mount = None
        self.drives.replug(kept[0])
        written = []
        real = drive.write_block
        with mock.patch.object(drive, "write_block", lambda out, block: written.append(os.path.basename(out.name)) or real(out, block)):
            self.assertFalse(self.call("export_model", export=self.fixture["plan"]["export"], drive="sda")[0])
            self.assertEqual(self.finished()["result"], "PASS")
        self.assertEqual(set(written), {"README.txt.part"})


class UnplugTests(DriveTestCase):
    def unplug_during(self, path_suffix, armed):
        self.stage_kit()
        self.drives.plug("sda")
        disk = self.drives.disks["sda"]
        real = drive.write_block
        pulled = []

        def write_block(out, block):
            if out.name.endswith(path_suffix + ".part") and not pulled:
                pulled.append(self.drives.unplug("sda"))
                raise OSError(errno.EIO, "Input/output error")
            return real(out, block)

        patcher = mock.patch.object(drive, "write_block", write_block)
        patcher.start()
        self.addCleanup(patcher.stop)
        if armed:
            # Plugged in after arming, so it counts.
            self.drives.disks.pop("sda")
            self.start(wait_for_drive=True)
            self.wait_for_state("waiting_for_drive")
            self.drives.replug(disk)
        else:
            self.start(drive="sda")
        return disk, pulled

    def test_an_unplugged_drive_fails_and_keeps_what_was_written(self):
        disk, pulled = self.unplug_during("support-coach.gguf", armed=False)
        status = self.finished()
        self.assertEqual(status["state"], "failed")
        self.assertIn("unplugged while writing model/support-coach.gguf", status["message"])
        self.assertIn("files already written are kept", status["message"])
        self.assertIn("model/Qwen3.5-0.8B-Q4_K_M.gguf", self.drives.written(disk, self.fixture["plan"]["folder"]))
        # Plugged back in, the same export carries on and keeps what is there.
        self.drives.replug(pulled[0])
        self.drives.calls.clear()
        error, reply = self.call("export_model", export=self.fixture["plan"]["export"], drive="sda")
        self.assertFalse(error, reply)
        self.assertEqual(self.finished()["result"], "PASS")

    def test_an_armed_export_resumes_when_the_same_drive_comes_back(self):
        disk, pulled = self.unplug_during("support-coach.gguf", armed=True)
        status = self.wait_for_state("waiting_for_drive")
        wait_for(lambda: "unplugged" in (self.status() or {}).get("message", ""))
        self.drives.replug(pulled[0])
        self.assertEqual(self.finished()["result"], "PASS")


class ChildTests(DriveTestCase):
    """The export's own process: one that is killed leaves failed, and its files, for the next attempt."""

    FAKE_CHILD = """
import json, os, sys, time
folder = sys.argv[sys.argv.index("--export") + 1]
status = json.load(open(os.path.join(folder, "status.json")))
status.update(state="writing", file="model/support-coach.gguf")
json.dump(status, open(os.path.join(folder, "status.json"), "w"))
time.sleep(60)
"""

    def test_a_killed_export_reads_as_failed_and_carries_on_from_its_files(self):
        self.stage_kit()
        self.drives.plug("sda")
        script = os.path.join(self.home, "fake_child.py")
        with open(script, "w") as f:
            f.write(self.FAKE_CHILD)

        def real_child(folder):
            return subprocess.Popen([sys.executable, script, "--export", folder], start_new_session=True)

        with mock.patch.object(drive, "spawn_export", real_child):
            self.start(drive="sda")
        self.wait_for_state("writing")
        drive.export_process.kill()
        drive.export_process.wait()
        status = self.status()
        self.assertEqual(status["state"], "failed")
        self.assertIn("stopped without saying why", status["message"])
        self.assertEqual(self.call("export_model", export=self.fixture["plan"]["export"], drive="sda")[0], False)
        self.assertEqual(self.finished()["result"], "PASS")

    @unittest.skipUnless(os.path.isdir("/proc/self"), "needs /proc")
    def test_a_restarted_server_still_finds_and_stops_a_live_export(self):
        self.stage_kit()
        self.drives.plug("sda")
        script = os.path.join(self.home, "fake_child.py")
        with open(script, "w") as f:
            f.write(self.FAKE_CHILD)
        with mock.patch.object(drive, "spawn_export", lambda folder: subprocess.Popen([sys.executable, script, "--export", folder], start_new_session=True)):
            self.start(drive="sda")
        self.wait_for_state("writing")
        process = drive.export_process
        self.addCleanup(process.wait)
        self.addCleanup(process.kill)
        drive.export_process = None
        self.assertEqual(self.status()["state"], "writing")
        self.assertEqual(self.call("stop_export")[1]["state"], "stopped")


class ServerToolTests(DriveTestCase):
    def setUp(self):
        super().setUp()
        train = os.path.join(self.home, "train")
        for name, value in {"TRAIN_DIR": train, "BASE_DIR": os.path.join(train, "models"), "DATASET_DIR": os.path.join(train, "datasets"), "RUN_DIR": os.path.join(train, "runs"), "train_process": None}.items():
            patcher = mock.patch.object(server, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        os.makedirs(os.path.join(server.RUN_DIR, "support-coach"))
        os.makedirs(server.DATASET_DIR)
        metadata = os.path.join(server.BASE_DIR, "Qwen3.5-0.8B", ".cache", "huggingface", "download")
        os.makedirs(metadata)
        with open(os.path.join(metadata, "model.safetensors.metadata"), "w") as f:
            f.write("23c69c53358a07516b5827588b3fdb12ae78fd65\netag\n1761900000\n")
        with open(os.path.join(server.DATASET_DIR, "support-coach.jsonl"), "w") as f:
            f.write(json.dumps({"messages": [{"role": "system", "content": "You are the support coach."}, {"role": "user", "content": "Hi"}, {"role": "assistant", "content": "Hello"}]}) + "\n")
        server.write_json(server.run_file("support-coach", "config.json"), {"pid": 1, "started": 1, "base": "Qwen3.5-0.8B", "dataset": "support-coach", "steps": 60, "rank": 8, "lr": 0.0002, "max_length": 512})
        server.write_json(server.run_file("support-coach", "status.json"), {"state": "done", "step": 60, "steps": 60, "loss": 0.41, "seconds": 812, "peak_gpu_gib": 1.91, "adapter": "support-coach.gguf", "examples": 49, "skipped": 0})

    def test_the_five_drive_tools_are_offered_on_version_0_4_0(self):
        names = [tool["name"] for tool in server.handle_rpc("tools/list", {})["tools"]]
        for name in ("drive_status", "export_source", "export_model", "erase_drive", "stop_export"):
            self.assertIn(name, names)
        self.assertEqual(server.VERSION, "0.4.0")
        tools = {tool["name"]: tool for tool in server.handle_rpc("tools/list", {})["tools"]}
        self.assertEqual(tools["erase_drive"]["annotations"], {"destructiveHint": True})
        self.assertTrue(tools["drive_status"]["annotations"]["readOnlyHint"])

    def test_export_source_names_the_files_and_facts_of_a_finished_run(self):
        error, source = self.call("export_source", run="support-coach")
        self.assertFalse(error, source)
        adapter = base64.b64decode(self.fixture["board"]["support-coach.gguf"])
        self.assertEqual(source["adapter"], {"name": "support-coach.gguf", "bytes": len(adapter), "sha256": sha(adapter)})
        self.assertEqual([(b["name"], b["level"], b["source"]) for b in source["bases"]], [("Qwen3.5-0.8B-Q4_K_M.gguf", "Q4_K_M", None)])
        self.assertEqual(source["base_revision"], "23c69c53358a07516b5827588b3fdb12ae78fd65")
        self.assertEqual(source["system"], "You are the support coach.")
        self.assertEqual(source["converter"], server.CONVERTER_NAME)
        self.assertEqual(source["board"]["muse_device"], "0.4.0")
        self.assertEqual((source["config"]["steps"], source["status"]["loss"]), (60, 0.41))
        # The sha256 is kept beside each file, so a second export hashes nothing.
        with mock.patch.object(drive, "sha256_of", side_effect=AssertionError("hashed again")):
            self.assertFalse(self.call("export_source", run="support-coach")[0])

    def test_drive_status_lists_the_finished_runs(self):
        self.assertEqual(self.call("drive_status")[1]["runs"], [{"run": "support-coach", "base": "Qwen3.5-0.8B", "adapter": "support-coach.gguf"}])
        server.write_json(server.run_file("support-coach", "status.json"), {"state": "failed"})
        self.assertEqual(self.call("drive_status")[1]["runs"], [])

    def test_export_source_refuses_a_run_that_isnt_done(self):
        server.write_json(server.run_file("support-coach", "status.json"), {"state": "failed"})
        error, reply = self.call("export_source", run="support-coach")
        self.assertTrue(error)
        self.assertIn("nothing to put on a drive", reply)
        self.assertTrue(self.call("export_source", run="../x")[0])

    def test_the_converter_named_is_the_one_setup_train_installs(self):
        with open(os.path.join(HERE, "setup-train.sh"), encoding="utf-8") as f:
            tag = next(line.split("=", 1)[1].strip() for line in f if line.startswith("LLAMA_CPP_TAG="))
        self.assertIn(f"llama.cpp {tag} ", server.CONVERTER_NAME)

    def test_install_model_remembers_where_a_file_came_from_without_its_query(self):
        data = b"GGUF installed"
        response = io.BytesIO(data)
        response.headers = {"Content-Length": None}
        with mock.patch.object(server, "addresses_of", return_value={"93.184.216.34"}), mock.patch.object(server.DOWNLOADS, "open", return_value=response):
            result = server.handle_rpc("tools/call", {"name": "install_model", "arguments": {"url": "https://cdn.example/b.gguf?X-Amz-Signature=secret", "name": "Qwen3.5-0.8B-Q8_0.gguf"}})
        self.assertFalse(result.get("isError"), result)
        saved = server.read_json(os.path.join(self.models, "Qwen3.5-0.8B-Q8_0.gguf.source.json"))
        self.assertEqual(saved, {"url": "https://cdn.example/b.gguf", "bytes": len(data), "sha256": sha(data)})
        self.assertNotIn("Qwen3.5-0.8B-Q8_0.gguf.source.json", server.model_files())
        error, source = self.call("export_source", run="support-coach")
        self.assertEqual([b["source"] for b in source["bases"]], [None, {"url": "https://cdn.example/b.gguf"}])

    def test_drive_status_never_shows_a_pid_or_a_link(self):
        urls = self.serve_kit()
        self.drives.plug("sda")
        self.start(drive="sda", urls=urls)
        self.finished()
        text = server.handle_rpc("tools/call", {"name": "drive_status", "arguments": {}})["content"][0]["text"]
        self.assertNotIn("kit.example", text)
        self.assertNotIn('"pid"', text)


class SetupScriptTests(unittest.TestCase):
    def read(self):
        with open(os.path.join(HERE, "setup-drive.sh"), encoding="utf-8") as f:
            return f.read()

    def test_the_polkit_rule_is_for_this_user_and_usb_drives_only(self):
        script = self.read()
        self.assertIn('action.lookup("drive.removable.bus") !== "usb"', script)
        self.assertIn("subject.user !==", script)
        for action in ("filesystem-mount", "power-off-drive", "modify-device"):
            self.assertIn(f"org.freedesktop.udisks2.{action}", script)
        self.assertNotIn("modify-device-system", script, "never the board's own disks")

    def test_it_checks_the_kernels_exfat_and_installs_only_exfatprogs_and_udisks2(self):
        script = self.read()
        self.assertIn("/proc/filesystems", script)
        installs = [line for line in script.splitlines() if "apt-get install" in line]
        self.assertTrue(installs)
        for line in installs:
            self.assertRegex(line, r"apt-get install -y --no-install-recommends (exfatprogs|udisks2)$")


if __name__ == "__main__":
    unittest.main()
