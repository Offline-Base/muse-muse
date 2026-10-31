# Phase setup: Blender's current LTS for Linux x64 from download.blender.org, checked against Blender's own sha256 file,
# extracted to /opt/blender. Then which shared libraries it lacks, what fixes them, and a first engine probe. Open egress.
set -u
export PATH="$HOME/.local/bin:$PATH" DEBIAN_FRONTEND=noninteractive
OUT=/tmp/out/setup
mkdir -p "$OUT" /tmp/dl
used() { df --output=used -B1 / | tail -1 | tr -d ' '; }
mb() { awk -v b="$1" 'BEGIN { printf "%.1f MB", b / 1e6 }'; }
# Installed size of the packages an apt log set up, from dpkg (df lags behind deletes, so it isn't used for this).
pkgsize() { grep -oE '^Setting up [^: ]+' "$1" | awk '{print $3}' | xargs -r dpkg-query -W -f='${Installed-Size}\n' 2>/dev/null | awk '{ s += $1 } END { printf "%.1f MB in %d packages", s * 1024 / 1e6, NR }'; }
installed() { dpkg-query -W -f='${db:Status-Abbrev}${Package}=${Version}\n' "$@" 2>/dev/null | awk '$1 == "ii" {print $2}' | tr '\n' ' '; }
now() { date +%s.%N; }
since() { awk -v a="$1" -v b="$(now)" 'BEGIN { printf "%.1f", b - a }'; }

echo "== S0 machine"
cat /vercel/musemuse/builder.json 2>/dev/null; echo
grep -E '^(PRETTY_NAME|VERSION_ID)=' /etc/os-release
uname -r; nproc; free -m | head -2; lscpu | grep -E 'Model name' | cut -c1-120
df -h / | tail -1
for m in apt-get dnf yum; do printf '%s: %s\n' "$m" "$(command -v $m || echo none)"; done
ls /dev/dri 2>&1 | head -2
echo "GL, EGL and Vulkan packages installed before: $(installed 'libegl*' 'libgl1*' 'libglx*' 'mesa*' 'libgbm*' 'libvulkan*')"

echo "== S1 find the LTS"
curl -fsSL -m 30 https://www.blender.org/download/lts/ -o /tmp/dl/lts.html && grep -oE 'Blender [0-9]+\.[0-9]+(\.[0-9]+)? LTS' /tmp/dl/lts.html | sort -uV | tail -4 | tr '\n' ';'; echo
# Run 1: download.blender.org answered 403 to the sandbox for its index. Plain curl only (no other user agent), so this tries
# download.blender.org first and then mirror.blender.org, the mirror Blender's own download page links. The version is
# what blender.org's LTS page said on Oct 31 (5.2.3, Oct 22) unless the index can be read.
SERIES=5.2
VER=5.2.3
REL="release/Blender$SERIES"
st=$(curl -s -m 30 -o /tmp/dl/index.html -w '%{http_code}' "https://download.blender.org/$REL/")
echo "download.blender.org index: HTTP $st"
if [ "$st" = 200 ]; then
  v=$(grep -oE "blender-$SERIES\.[0-9]+-linux-x64\.tar\.xz" /tmp/dl/index.html | sort -uV | tail -1 | sed -e 's/^blender-//' -e 's/-linux-x64.tar.xz$//')
  [ -n "$v" ] && VER=$v
fi
TARBALL="blender-$VER-linux-x64.tar.xz"
echo "version $VER, $TARBALL"

echo "== S2 download"
U0=$(used)
SRC=""
for host in download.blender.org mirror.blender.org; do
  t=$(now)
  st=$(curl -sL -m 600 -o "/tmp/dl/$TARBALL" -w '%{http_code} %{size_download} bytes at %{speed_download} B/s, %{time_total} s, from %{url_effective}' "https://$host/$REL/$TARBALL")
  echo "$host tarball: HTTP $st"
  if [ "${st%% *}" = 200 ] && [ "$(stat -c %s "/tmp/dl/$TARBALL")" -gt 100000000 ]; then SRC=$host; echo "download took $(since "$t") s"; break; fi
done
[ -n "$SRC" ] || { echo "no source gave the tarball"; exit 4; }
# Blender's sums file, from each host that will give it, and the copy fetched from download.blender.org on the laptop's side
# (SPIKE_EXPECTED_SHA, passed in by run.ts). Every source that answered must agree with the tarball.
SUMS=0
for host in download.blender.org mirror.blender.org; do
  st=$(curl -sL -m 30 -o "/tmp/dl/sums-$host" -w '%{http_code}' "https://$host/$REL/blender-$VER.sha256")
  want=$(grep " $TARBALL\$" "/tmp/dl/sums-$host" 2>/dev/null | cut -c1-64)
  echo "$host sums file: HTTP $st, linux x64 line: ${want:-none}"
  [ -n "$want" ] && { echo "$want  $TARBALL" >> /tmp/dl/check.sha256; SUMS=$((SUMS + 1)); }
done
if [ -n "${SPIKE_EXPECTED_SHA:-}" ]; then echo "$SPIKE_EXPECTED_SHA  $TARBALL" >> /tmp/dl/check.sha256; SUMS=$((SUMS + 1)); echo "laptop copy: $SPIKE_EXPECTED_SHA"; fi
t=$(now)
GOT=$(sha256sum "/tmp/dl/$TARBALL" | cut -c1-64)
SHA_OK=1
[ "$SUMS" -gt 0 ] || SHA_OK=0
while read -r h _; do [ "$h" = "$GOT" ] || SHA_OK=0; done < /tmp/dl/check.sha256
echo "sha256 check against $SUMS published copies: $([ $SHA_OK = 1 ] && echo PASS || echo FAIL) in $(since "$t") s; computed $GOT"
[ $SHA_OK = 1 ] || { echo "refusing to extract a tarball that fails its check"; exit 5; }
TB=$(stat -c %s "/tmp/dl/$TARBALL")
echo "tarball $(mb "$TB")"

echo "== S3 extract"
t=$(now)
sudo -n mkdir -p /opt && sudo -n tar -xJf "/tmp/dl/$TARBALL" -C /opt && sudo -n mv "/opt/blender-$VER-linux-x64" /opt/blender
echo "extract took $(since "$t") s"
EB=$(du -sb /opt/blender | cut -f1)
echo "extracted $(mb "$EB"), $(find /opt/blender -type f | wc -l) files"
du -sh /opt/blender/* 2>/dev/null | sort -h | tail -8
sudo -n ln -sf /opt/blender/blender /usr/local/bin/blender
rm -f "/tmp/dl/$TARBALL"
sync; echo "disk used after removing the tarball (df, lags behind the delete): $(mb $(( $(used) - U0 )))"
echo "$VER" > "$OUT/version.txt"

echo "== S4 does it run, as shipped"
B=/opt/blender/blender
blender -b --factory-startup --version > "$OUT/version-bare.txt" 2>&1; echo "blender -b --version exit $?"
head -4 "$OUT/version-bare.txt"
echo "missing per ldd:"; ldd "$B" | grep 'not found' | awk '{print "  " $1}' | tee "$OUT/missing-bare.txt"
echo "in the tarball's own lib/: $(ls /opt/blender/lib 2>/dev/null | wc -l) files; X11/GL/SM ones: $(ls /opt/blender/lib 2>/dev/null | grep -iE '^lib(X|GL|EGL|SM|ICE|xkb|wayland|decor)' | tr '\n' ' ')"
LD_LIBRARY_PATH=/opt/blender/lib ldd "$B" | grep -c 'not found' | sed 's/^/still missing with LD_LIBRARY_PATH=lib: /'

echo "== S5 the fix by package"
pkg_for() {
  case "$1" in
    libX11.so.*) echo libx11-6 ;; libX11-xcb.so.*) echo libx11-xcb1 ;; libXi.so.*) echo libxi6 ;; libXxf86vm.so.*) echo libxxf86vm1 ;;
    libXfixes.so.*) echo libxfixes3 ;; libXrender.so.*) echo libxrender1 ;; libXext.so.*) echo libxext6 ;; libXkbcommon* | libxkbcommon.so.*) echo libxkbcommon0 ;;
    libxkbcommon-x11.so.*) echo libxkbcommon-x11-0 ;; libSM.so.*) echo libsm6 ;; libICE.so.*) echo libice6 ;; libGL.so.*) echo libgl1 ;;
    libEGL.so.*) echo libegl1 ;; libOpenGL.so.*) echo libopengl0 ;; libGLX.so.*) echo libglx0 ;; libxcb.so.*) echo libxcb1 ;;
    libwayland-client.so.*) echo libwayland-client0 ;; libwayland-cursor.so.*) echo libwayland-cursor0 ;; libwayland-egl.so.*) echo libwayland-egl1 ;;
    libdecor-0.so.*) echo libdecor-0-0 ;; libdbus-1.so.*) echo libdbus-1-3 ;; libXrandr.so.*) echo libxrandr2 ;; libXinerama.so.*) echo libxinerama1 ;;
    libXcursor.so.*) echo libxcursor1 ;; *) echo "UNMAPPED:$1" ;;
  esac
}
PKGS=$(while read -r so; do [ -n "$so" ] && pkg_for "$so"; done < "$OUT/missing-bare.txt" | sort -u | tr '\n' ' ')
echo "packages for the missing ones: ${PKGS:-none}"
U1=$(used)
t=$(now)
sudo -n apt-get update -q >/dev/null 2>&1; echo "apt-get update exit $? in $(since "$t") s"
if [ -n "$PKGS" ]; then
  t=$(now)
  # shellcheck disable=SC2086
  sudo -n apt-get install -y -q --no-install-recommends $(echo "$PKGS" | tr ' ' '\n' | grep -v UNMAPPED) > "$OUT/apt-libs.txt" 2>&1
  echo "apt install exit $? in $(since "$t") s, $(mb $(( $(used) - U1 ))) more on disk"
  grep -E '^(Setting up|The following NEW)' "$OUT/apt-libs.txt" | cut -c1-100 | head -40
fi
echo "missing per ldd now: $(ldd "$B" | grep 'not found' | awk '{print $1}' | tr '\n' ' ')"
blender -b --factory-startup --version > "$OUT/version.txt.full" 2>&1; echo "blender -b --version exit $?"
head -3 "$OUT/version.txt.full"
t=$(now)
blender -b --factory-startup --python-expr 'import bpy, sys; print("BPY", bpy.app.version_string, "python", sys.version.split()[0])' 2>&1 | grep -E '^BPY|Error' | head -3
echo "python start took $(since "$t") s"
echo "GL, EGL and Vulkan packages installed now: $(installed 'libegl*' 'libgl1*' 'libglx*' 'mesa*' 'libgbm*' 'libvulkan*')"

echo "== S6 engine probe before any software GL"
for e in BLENDER_WORKBENCH BLENDER_EEVEE; do
  t=$(now)
  timeout 120 blender -b --factory-startup --python-exit-code 3 --python /tmp/spike/lib/probe.py -- "$e" "$OUT/probe-$e-before.png" > "$OUT/probe-$e-before.log" 2>&1
  echo "$e: exit $? in $(since "$t") s; $(grep -E 'PROBE|rror|EGL|GPU|OpenGL|Vulkan' "$OUT/probe-$e-before.log" | head -4 | cut -c1-160 | tr '\n' '|')"
done

echo "== S7 software GL (Mesa llvmpipe for EGL and OpenGL, lavapipe for Vulkan)"
U2=$(used)
t=$(now)
sudo -n apt-get install -y -q --no-install-recommends libegl1 libegl-mesa0 libgl1 libgl1-mesa-dri libglx-mesa0 libgbm1 > "$OUT/apt-mesa.txt" 2>&1
echo "mesa EGL/GL install exit $? in $(since "$t") s, $(pkgsize "$OUT/apt-mesa.txt")"
grep -E '^Setting up' "$OUT/apt-mesa.txt" | cut -c1-90 | head -30
U3=$(used)
t=$(now)
sudo -n apt-get install -y -q --no-install-recommends mesa-vulkan-drivers libvulkan1 > "$OUT/apt-vulkan.txt" 2>&1
echo "lavapipe install exit $? in $(since "$t") s, $(pkgsize "$OUT/apt-vulkan.txt")"
grep -E '^Setting up' "$OUT/apt-vulkan.txt" | cut -c1-90 | head -10
echo "GL, EGL and Vulkan packages installed now: $(installed 'libegl*' 'libgl1*' 'libglx*' 'mesa*' 'libgbm*' 'libvulkan*')"
exit 0
