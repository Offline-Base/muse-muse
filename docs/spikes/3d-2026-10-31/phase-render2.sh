# Phase render2: what run 3 left open. Cycles with OIDN actually on (run 3's check read an empty enum and left it off),
# where Eevee's first-render cost goes (Mesa's shader cache or not), and the same set on 8 vCPUs. Build firewall.
set -u
export PATH="$HOME/.local/bin:$PATH"
OUT=/tmp/out/render2
mkdir -p "$OUT" /tmp/work
L=/tmp/spike/lib
now() { date +%s.%N; }
since() { awk -v a="$1" -v b="$(now)" 'BEGIN { printf "%.1f", b - a }'; }
command -v blender >/dev/null || { echo "no blender, phase setup must run first"; exit 7; }
render() { # <label> <engine> <size> <samples> [blender args...] [-- scene.py args...]
  local label=$1 engine=$2 size=$3 samples=$4 t code
  shift 4
  local pre=() post=()
  while [ $# -gt 0 ] && [ "$1" != "--" ]; do pre+=("$1"); shift; done
  [ "${1:-}" = "--" ] && shift
  post=("$@")
  t=$(now)
  env ${REN_ENV:-SPIKE_X=1} timeout 400 blender -b --factory-startup "${pre[@]}" --python-exit-code 3 --python $L/scene.py -- --engine "$engine" --size "$size" --samples "$samples" --out "$OUT/$label.png" "${post[@]}" > "$OUT/$label.log" 2>&1
  code=$?
  echo "$label: exit $code in $(since "$t") s wall; $(grep '^RESULT' "$OUT/$label.log" | cut -c8-500)"
  [ $code = 0 ] || grep -iE 'error|fail|egl|opengl|vulkan|gpu|context|segmentation' "$OUT/$label.log" | head -6 | cut -c1-200
}
echo "== Q0 $(nproc) vCPUs, $(free -m | awk '/Mem:/ {print $2}') MB"

echo "== Q1 Cycles with OIDN"
render c-640-32-oidn CYCLES 640x480 32
render c-640-32-raw CYCLES 640x480 32 -- --no-denoise
render c-640-8-oidn CYCLES 640x480 8
render c-640-128-oidn CYCLES 640x480 128
render c-1280-64-oidn CYCLES 1280x960 64
grep -iE 'denois' "$OUT/c-640-32-oidn.log" | tail -2 | cut -c1-160

echo "== Q2 Workbench"
render w-640 BLENDER_WORKBENCH 640x480 0

echo "== Q3 Eevee, cold and warm"
rm -rf "$HOME/.cache/mesa_shader_cache" "$HOME/.cache/mesa_shader_cache_db" "$HOME/.cache/blender"
render e-640-32-cold BLENDER_EEVEE 640x480 32
du -sh "$HOME"/.cache/* 2>/dev/null | sed 's/^/cache after the cold render: /'
render e-640-32-warm BLENDER_EEVEE 640x480 32
REN_ENV=MESA_SHADER_CACHE_DISABLE=true render e-640-32-nomesacache BLENDER_EEVEE 640x480 32

echo "== Q4 turntable, Cycles with OIDN, 24 frames, 16 samples"
render t-cycles-oidn CYCLES 640x480 16 -- --turntable 24
mv "$OUT"/t-cycles-oidn-00[0-9][0-9].png /tmp/work/ 2>/dev/null

echo "== Q5 pictures"
node $L/png-stats.mjs "$OUT"/*.png
exit 0
