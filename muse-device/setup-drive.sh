#!/bin/bash
# Sets up drive export (drive.py) on a board, once, as root. It installs exfatprogs if mkfs.exfat is missing, checks that the
# kernel has exFAT and that udisks2 and busctl are there, adds a polkit rule that lets the user who runs server.py mount,
# unmount, power off and format USB drives (and only USB drives), and makes that user's ~/drive-export.
#
#   sudo setup-drive.sh <the user that runs server.py>
#
# Polkit 0.106 and later (Ubuntu 24.04, JetPack 7) takes JavaScript rules, which can check that a drive is on USB. Polkit 0.105
# (Ubuntu 22.04, JetPack 6) only takes a .pkla file, which can't, so there drive.py's own checks are the only guard.
set -euo pipefail

USER_NAME="${1:-}"
if [ -z "$USER_NAME" ] || ! id "$USER_NAME" >/dev/null 2>&1; then
  echo "Name the user that runs server.py: setup-drive.sh <user>" >&2
  exit 1
fi
if [ "$(id -u)" -ne 0 ]; then
  echo "Run this as root, with sudo." >&2
  exit 1
fi
HOME_DIR="$(getent passwd "$USER_NAME" | cut -d: -f6)"

if ! command -v mkfs.exfat >/dev/null; then
  apt-get install -y --no-install-recommends exfatprogs
fi
modprobe exfat 2>/dev/null || true
if ! grep -qw exfat /proc/filesystems; then
  echo "This kernel has no exFAT driver, so drives over 4 GB per file can't be written. Nothing else was changed." >&2
  exit 1
fi
if ! command -v udisksctl >/dev/null; then
  apt-get install -y --no-install-recommends udisks2
fi
systemctl is-active --quiet udisks2 || systemctl start udisks2
if ! command -v busctl >/dev/null; then
  echo "busctl is missing. It ships with systemd, which this board should have." >&2
  exit 1
fi

# The actions udisks2 asks polkit about: mounting, unmounting, powering off, and formatting (modify-device). The "-other-seat"
# ones are what a user with no desktop session gets asked. Never the "-system" kind of modify-device: that is the board's own disks.
ACTIONS="org.freedesktop.udisks2.filesystem-mount org.freedesktop.udisks2.filesystem-mount-other-seat org.freedesktop.udisks2.filesystem-unmount-others org.freedesktop.udisks2.power-off-drive org.freedesktop.udisks2.power-off-drive-other-seat org.freedesktop.udisks2.modify-device org.freedesktop.udisks2.modify-device-other-seat"
POLKIT_VERSION="$(pkaction --version 2>/dev/null | awk '{ print $NF }')"
if [ -d /etc/polkit-1/rules.d ] && [ "${POLKIT_VERSION%%.*}" != "0" ]; then
  LIST="$(printf '"%s", ' $ACTIONS)"
  cat > /etc/polkit-1/rules.d/50-muse-device-drive.rules <<RULE
// Lets the muse-device server's user mount, unmount, power off and format USB drives, for drive export (drive.py).
polkit.addRule(function (action, subject) {
  if (subject.user !== "$USER_NAME") return polkit.Result.NOT_HANDLED;
  if ([${LIST%, }].indexOf(action.id) < 0) return polkit.Result.NOT_HANDLED;
  if (action.lookup("drive.removable.bus") !== "usb") return polkit.Result.NOT_HANDLED;
  return polkit.Result.YES;
});
RULE
  echo "Added /etc/polkit-1/rules.d/50-muse-device-drive.rules for $USER_NAME, USB drives only."
else
  mkdir -p /etc/polkit-1/localauthority/50-local.d
  cat > /etc/polkit-1/localauthority/50-local.d/50-muse-device-drive.pkla <<RULE
[Muse Device drive export]
Identity=unix-user:$USER_NAME
Action=$(echo "$ACTIONS" | tr ' ' ';')
ResultAny=yes
ResultInactive=yes
ResultActive=yes
RULE
  echo "Polkit $POLKIT_VERSION takes no JavaScript rules, so the .pkla rule can't check for USB: drive.py's own checks are the only guard."
fi

install -d -m 700 -o "$USER_NAME" -g "$(id -gn "$USER_NAME")" "$HOME_DIR/drive-export"
echo "Drive export is set up for $USER_NAME. Restart the muse-device service to offer its tools."
