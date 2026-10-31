#!/bin/bash
# Sets up the AWS Mac as a lab box. Run it once as ec2-user over an SSM session, from an unpacked native/lab folder, after
# Xcode's .xip has been handled (docs/NATIVE_LAB.md, "Setting up the Mac"). It's safe to run again.
#
#   MUSE_LAB_PLATFORM=https://muse-muse.vercel.app AWS_REGION=us-east-1 bash setup/mac.sh
#
# Auto-login needs a password on ec2-user. Set MUSE_LAB_USER_PASSWORD to choose one, which you'll also need for screen
# sharing. Otherwise the script makes a random one and doesn't show it. Nothing here prints a secret.
#
# Accepting Xcode's and the Android SDK's licenses is the owner's call, so those steps and everything that needs them only
# run with MUSE_LAB_ACCEPT_LICENSES=1, which only the owner sets. Without it, the box gets everything else and can run
# desktop_mac jobs. docs/NATIVE_LAB.md has the one command that finishes the rest.
set -euo pipefail

PLATFORM="${MUSE_LAB_PLATFORM:-https://muse-muse.vercel.app}"
REGION="${AWS_REGION:-us-east-1}"
LAB_USER="$(id -un)"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
ROOT="$HOME/musemuse-lab"
VERSION="$(/usr/bin/plutil -extract version raw -o - -- "$HERE/package.json" 2>/dev/null || echo 0.1.0)"
AVD_NAME="mm_pixel"
AVD_DEVICE="pixel_7"
SYSTEM_IMAGE="system-images;android-35;google_apis;arm64-v8a"
SDK_ROOT="/opt/homebrew/share/android-commandlinetools"
XCODE_DIR="/Applications/Xcode.app/Contents/Developer"
CLT_DIR="/Library/Developer/CommandLineTools"
ACCEPT_LICENSES="${MUSE_LAB_ACCEPT_LICENSES:-}"

step() { printf '\n== %s\n' "$1"; }

if [ "$(uname -m)" != "arm64" ]; then
  echo "This script is for an Apple silicon Mac." >&2
  exit 1
fi
if [ "$LAB_USER" = "root" ]; then
  echo "Run this as ec2-user, not root." >&2
  exit 1
fi

step "Growing the disk to fill the volume"
# The AMI's APFS container starts small. This is AWS's documented resize, and it does nothing once it's full size.
PDISK="$(diskutil list physical external | head -n1 | cut -d' ' -f1 || true)"
APFS_CONTAINER="$(diskutil list physical external | awk '/Apple_APFS/ {print $7; exit}' || true)"
if [ -n "$PDISK" ] && [ -n "$APFS_CONTAINER" ]; then
  yes | sudo diskutil repairDisk "$PDISK" >/dev/null 2>&1 || true
  sudo diskutil apfs resizeContainer "$APFS_CONTAINER" 0 >/dev/null 2>&1 || echo "The disk resize didn't run. Check df before going on."
fi

step "Auto-login, with no sleep and no screen lock"
# A new password here would need a new /etc/kcpassword too, so on a second run with auto-login already on, leave them both.
if [ -z "${MUSE_LAB_USER_PASSWORD:-}" ] && sudo /bin/test -s /etc/kcpassword \
  && [ "$(/usr/bin/defaults read /Library/Preferences/com.apple.loginwindow autoLoginUser 2>/dev/null)" = "$LAB_USER" ]; then
  echo "Auto-login is already on."
else
  MUSE_LAB_USER_PASSWORD="${MUSE_LAB_USER_PASSWORD:-$(openssl rand -hex 10)}"
  sudo /usr/bin/dscl . -passwd "/Users/$LAB_USER" "$MUSE_LAB_USER_PASSWORD"
  sudo /bin/rm -f /etc/kcpassword
  sudo /usr/sbin/sysadminctl -autologin set -userName "$LAB_USER" -password "$MUSE_LAB_USER_PASSWORD" >/dev/null 2>&1 || true
  if ! sudo /bin/test -s /etc/kcpassword; then
    # macOS 26 answers SACSetAutoLoginPassword error 22 here, with exit code 0, so this writes what that call would have: the
    # password in loginwindow's obfuscated form, padded to 12 bytes, readable only by root.
    MUSE_LAB_PW="$MUSE_LAB_USER_PASSWORD" /usr/bin/perl -e '
      my @key = (0x7D, 0x89, 0x52, 0x23, 0xD2, 0xBC, 0xDD, 0xEA, 0xA3, 0xB9, 0x1F);
      my @pw = unpack("C*", $ENV{MUSE_LAB_PW});
      push @pw, 0 while @pw % 12;
      print pack("C*", map { $pw[$_] ^ $key[$_ % @key] } 0 .. $#pw);
    ' | sudo /usr/bin/tee /etc/kcpassword >/dev/null
    sudo /bin/chmod 600 /etc/kcpassword
    sudo /usr/sbin/chown root:wheel /etc/kcpassword
  fi
  sudo /usr/bin/defaults write /Library/Preferences/com.apple.loginwindow autoLoginUser -string "$LAB_USER"
  unset MUSE_LAB_USER_PASSWORD
fi
sudo /usr/bin/pmset -a sleep 0 displaysleep 0 disksleep 0 standby 0 powernap 0 autorestart 1
/usr/bin/defaults -currentHost write com.apple.screensaver idleTime -int 0
/usr/bin/defaults write com.apple.screensaver askForPassword -int 0
sudo /usr/bin/defaults write /Library/Preferences/com.apple.screensaver loginWindowIdleTime -int 0

step "Developer tools"
# With Xcode selected and its license not accepted, every developer tool stops at the license, including the git Homebrew
# runs. The AMI's Command Line Tools have what the box needs until then. Once it's accepted, Xcode stays selected, because
# the agent's simulator kinds need it.
if [ "$ACCEPT_LICENSES" != "1" ] && [ "$(/usr/bin/xcode-select -p 2>/dev/null)" = "$XCODE_DIR" ] && [ -d "$CLT_DIR" ] \
  && [ -z "$(/usr/bin/defaults read /Library/Preferences/com.apple.dt.Xcode IDEXcodeVersionForAgreedToGMLicense 2>/dev/null)" ]; then
  sudo /usr/bin/xcode-select -s "$CLT_DIR"
  echo "Using the Command Line Tools, because Xcode's license hasn't been accepted."
fi

step "Homebrew packages"
if ! command -v brew >/dev/null 2>&1; then
  [ -x /opt/homebrew/bin/brew ] && eval "$(/opt/homebrew/bin/brew shellenv)"
fi
if ! command -v brew >/dev/null 2>&1; then
  NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  eval "$(/opt/homebrew/bin/brew shellenv)"
fi
export HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALL_CLEANUP=1
brew install node@22 ffmpeg openjdk@17 awscli
# The plain ffmpeg formula has no drawtext filter, which captions use. Without ffmpeg-full, the agent draws them with
# lib/caption.jxa instead, so a failure here isn't fatal.
brew install ffmpeg-full || echo "ffmpeg-full didn't install. Captions will use the system font."

step "Android SDK and the $AVD_NAME emulator"
if [ "$ACCEPT_LICENSES" = "1" ]; then
  brew install --cask android-commandlinetools
  export JAVA_HOME="/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home"
  export ANDROID_HOME="$SDK_ROOT" ANDROID_SDK_ROOT="$SDK_ROOT"
  export PATH="/opt/homebrew/opt/node@22/bin:$JAVA_HOME/bin:$SDK_ROOT/platform-tools:$SDK_ROOT/emulator:$PATH"
  SDKMANAGER="$SDK_ROOT/cmdline-tools/latest/bin/sdkmanager"
  [ -x "$SDKMANAGER" ] || SDKMANAGER="$(command -v sdkmanager)"
  AVDMANAGER="$(dirname "$SDKMANAGER")/avdmanager"
  yes | "$SDKMANAGER" --licenses >/dev/null || true
  "$SDKMANAGER" --install "platform-tools" "emulator" "platforms;android-35" "$SYSTEM_IMAGE"
  if ! "$AVDMANAGER" list avd -c 2>/dev/null | grep -qx "$AVD_NAME"; then
    echo no | "$AVDMANAGER" create avd --name "$AVD_NAME" --package "$SYSTEM_IMAGE" --device "$AVD_DEVICE" --force
  fi
  AVD_CONFIG="$HOME/.android/avd/$AVD_NAME.avd/config.ini"
  if [ -f "$AVD_CONFIG" ]; then
    for pair in "hw.ramSize=4096" "hw.keyboard=yes" "disk.dataPartition.size=8G" "hw.gpu.enabled=yes" "hw.gpu.mode=swiftshader_indirect"; do
      key="${pair%%=*}"
      /usr/bin/sed -i '' "/^${key}[ =]/d" "$AVD_CONFIG"
      echo "$pair" >>"$AVD_CONFIG"
    done
  fi
else
  echo "Skipped: this step only runs with MUSE_LAB_ACCEPT_LICENSES=1, which only the owner sets."
fi

step "Xcode and the iOS Simulator"
if [ "$ACCEPT_LICENSES" = "1" ]; then
  if [ -d /Applications/Xcode.app ]; then
    sudo /usr/bin/xcode-select -s "$XCODE_DIR"
    sudo xcodebuild -license accept
    sudo xcodebuild -runFirstLaunch
    xcodebuild -downloadPlatform iOS
  else
    echo "Xcode isn't installed yet. Install it, then run this script again. See docs/NATIVE_LAB.md."
  fi
else
  echo "Skipped: this step only runs with MUSE_LAB_ACCEPT_LICENSES=1, which only the owner sets."
fi

step "The agent"
mkdir -p "$ROOT/releases" "$ROOT/data" "$ROOT/logs" "$HOME/Library/LaunchAgents"
# Run from an installed release, it stays on that one, so a second run doesn't move the box off its pinned bundle.
case "$HERE" in
  "$ROOT/releases/"*) RELEASE="$HERE" ;;
  *)
    RELEASE="$ROOT/releases/$VERSION"
    mkdir -p "$RELEASE"
    /usr/bin/rsync -a --delete --exclude __tests__ --exclude node_modules "$HERE/" "$RELEASE/"
    ;;
esac
ln -sfn "$RELEASE" "$ROOT/current"

# ec2-user's Homebrew tools can't reach the metadata address, so the aws CLI gets the instance role through this. See the script.
mkdir -p "$HOME/.aws"
AWS_CONFIG="$HOME/.aws/config"
if ! /usr/bin/grep -q credential_process "$AWS_CONFIG" 2>/dev/null; then
  printf '[default]\ncredential_process = %s\nregion = %s\n' "$ROOT/current/setup/imds-credentials.sh" "$REGION" >"$AWS_CONFIG"
fi

PLIST="$HOME/Library/LaunchAgents/ai.musemuse.lab.plist"
/usr/bin/sed -e "s|__HOME__|$HOME|g" -e "s|__PLATFORM__|$PLATFORM|g" -e "s|__REGION__|$REGION|g" "$HERE/setup/ai.musemuse.lab.plist" >"$PLIST"
/usr/bin/plutil -lint "$PLIST" >/dev/null
GUI_DOMAIN="gui/$(id -u)"
if launchctl print "$GUI_DOMAIN" >/dev/null 2>&1; then
  launchctl bootout "$GUI_DOMAIN/ai.musemuse.lab" >/dev/null 2>&1 || true
  # The old agent takes some seconds to shut down, and until it has gone bootstrap fails with an I/O error.
  STARTED=""
  for _ in $(seq 1 30); do
    if launchctl bootstrap "$GUI_DOMAIN" "$PLIST" >/dev/null 2>&1; then
      STARTED=1
      break
    fi
    sleep 3
  done
  [ -n "$STARTED" ] || echo "The agent didn't start. It will start at the next login."
else
  echo "There's no GUI session yet. Reboot once, and auto-login will start the agent."
fi

step "Done"
echo "Check it with: tail -f $ROOT/logs/agent.log"
