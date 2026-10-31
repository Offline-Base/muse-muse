"""The drive export on the kernel's own exFAT and FAT drivers, through a loop device standing in for a USB drive.

  sudo python3 -m unittest test_drive_loop

Skipped unless it runs on Linux as root, with losetup, mkfs.exfat, mkfs.vfat and udisksctl. It makes a 256 MB image file, puts a
filesystem on it, and runs the golden plan (fixtures/plan-small.json) through the real path: udisks2 mounts it, the export writes
and syncs, unmounts, mounts again and reads every file back. drive.DRIVE_ALLOW_LOOP_BACKING is set to this test's own folder, so
only its loop device counts as a drive. It runs in any Linux VM with root, or on a board as a deploy's last check with the
owner's OK. It never touches a real disk.
"""
import base64
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest import mock

import drive

HERE = os.path.dirname(os.path.abspath(__file__))
NEEDS = ("losetup", "mkfs.exfat", "mkfs.vfat", "udisksctl")
ON_LINUX_AS_ROOT = sys.platform.startswith("linux") and hasattr(os, "geteuid") and os.geteuid() == 0 and all(shutil.which(tool) for tool in NEEDS)


class ThreadChild:
    """The export in a thread of this process, so the folders and the loop device this test allows reach it."""

    def __init__(self, folder):
        self.pid = 2_000_000_001
        self.thread = threading.Thread(target=drive.run_export, args=(folder,), daemon=True)
        self.thread.start()

    def poll(self):
        return None if self.thread.is_alive() else 0

    def terminate(self):
        drive.stop_event.set()

    def wait(self, timeout=None):
        self.thread.join(timeout)


@unittest.skipUnless(ON_LINUX_AS_ROOT, f"needs Linux, root and {', '.join(NEEDS)}")
class LoopbackTests(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        with open(os.path.join(HERE, "fixtures", "plan-small.json"), encoding="utf-8") as f:
            self.fixture = json.load(f)
        models = os.path.join(self.root, "models")
        kit = os.path.join(self.root, "drive-export", "kit")
        os.makedirs(models)
        os.makedirs(kit)
        for name, data in self.fixture["board"].items():
            with open(os.path.join(models, name), "wb") as f:
                f.write(base64.b64decode(data))
        for key, data in self.fixture["kit"].items():
            with open(os.path.join(kit, key), "wb") as f:
                f.write(base64.b64decode(data))
        for name, value in {"EXPORT_DIR": os.path.join(self.root, "drive-export"), "KIT_DIR": kit, "MODEL_DIR": models, "DRIVE_ALLOW_LOOP_BACKING": self.root,
                            "POLL_S": 0.2, "export_process": None}.items():
            patcher = mock.patch.object(drive, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        # udisks mounts under /media/root for root. A loop device has no power to switch off.
        for name, value in {"media_root": lambda: "/media/root/", "udisks_power_off": lambda _device: False, "spawn_export": ThreadChild}.items():
            patcher = mock.patch.object(drive, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def loop_drive(self, mkfs):
        image = os.path.join(self.root, "drive.img")
        with open(image, "wb") as f:
            f.truncate(256 * 2**20)
        device = subprocess.run(["losetup", "--find", "--show", image], capture_output=True, text=True, check=True).stdout.strip()
        self.addCleanup(subprocess.run, ["losetup", "--detach", device], capture_output=True)
        self.addCleanup(subprocess.run, ["udisksctl", "unmount", "-b", device, "--no-user-interaction"], capture_output=True)
        subprocess.run(mkfs + [device], capture_output=True, check=True)
        subprocess.run(["udevadm", "settle"], capture_output=True)
        return device

    def export_onto(self, mkfs):
        device = self.loop_drive(mkfs)
        name = os.path.basename(device)
        found = drive.find_drive(name)
        self.assertIsNotNone(found, f"{name} wasn't offered: {drive.find_drives()}")
        result = drive.export_model({"plan": self.fixture["plan"], "drive": name}, list(self.fixture["board"]))
        self.assertEqual(result["state"], "checking")
        drive.export_process.wait(120)
        status = drive.export_status(self.fixture["plan"]["export"])
        self.assertEqual((status["state"], status.get("result")), ("done", "PASS"), status)
        # Read once more, outside the export, from a fresh mount.
        mount = drive.udisks_mount(device)
        self.addCleanup(drive.udisks_unmount, device)
        with open(os.path.join(mount, self.fixture["plan"]["folder"], "SHA256SUMS"), "rb") as f:
            self.assertEqual(hashlib.sha256(f.read()).hexdigest(), self.fixture["manifestSha256"])

    def test_exfat(self):
        self.export_onto(["mkfs.exfat", "-L", "LOOPTEST"])

    def test_fat32(self):
        self.export_onto(["mkfs.vfat", "-F", "32", "-n", "LOOPTEST"])


if __name__ == "__main__":
    unittest.main()
