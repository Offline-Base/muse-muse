# Phase render: under the build firewall, the scene, its GLB, and a 640x480 render with each engine, timed with Blender's
# own start included, then an OBJ and STL conversion and a decimate. Needs phase setup first.
set -u
export PATH="$HOME/.local/bin:$PATH"
OUT=/tmp/out/render
mkdir -p "$OUT" /tmp/work
L=/tmp/spike/lib
now() { date +%s.%N; }
since() { awk -v a="$1" -v b="$(now)" 'BEGIN { printf "%.1f", b - a }'; }
command -v blender >/dev/null || { echo "no blender, phase setup must run first"; exit 7; }

echo "== R0 firewall ($SPIKE_FIREWALL)"
curl -s -o /dev/null -m 8 -w "registry.npmjs.org %{http_code}\n" https://registry.npmjs.org/three/latest || echo "registry.npmjs.org blocked (curl exit $?)"
curl -s -o /dev/null -m 8 -w "download.blender.org %{http_code}\n" https://download.blender.org/release/ || echo "download.blender.org blocked (curl exit $?)"
curl -s -o /dev/null -m 8 -w "polyhaven %{http_code}\n" https://dl.polyhaven.org/ || echo "dl.polyhaven.org blocked (curl exit $?)"
curl -s -o /dev/null -m 8 -w "api.meta.ai (no placeholder) %{http_code}\n" https://api.meta.ai/v1/models || echo "api.meta.ai blocked (curl exit $?)"

echo "== R1 what this Blender has"
blender -b --factory-startup --python-expr '
import bpy
o = bpy.app.build_options
print("INFO", bpy.app.version_string, "build options:", sorted(k for k in dir(o) if not k.startswith("_") and not callable(getattr(o, k)) and getattr(o, k) is True))
print("INFO engines", [e.identifier for e in bpy.types.RenderSettings.bl_rna.properties["engine"].enum_items])
print("INFO denoisers", [e.identifier for e in bpy.context.scene.cycles.bl_rna.properties["denoiser"].enum_items])
print("INFO importers", [n for n in ("obj_import", "stl_import", "ply_import", "usd_import", "alembic_import") if hasattr(bpy.ops.wm, n)], "fbx", hasattr(bpy.ops.import_scene, "fbx"), "gltf", hasattr(bpy.ops.import_scene, "gltf"))
' 2>&1 | grep -E '^INFO|Error'
blender --help 2>&1 | grep -iE -A3 'gpu-backend' | head -6

echo "== R2 scene and GLB export"
t=$(now)
blender -b --factory-startup --python-exit-code 3 --python $L/scene.py -- --glb "$OUT/scene.glb" > "$OUT/scene.log" 2>&1
echo "scene + export: exit $? in $(since "$t") s wall"; grep '^RESULT' "$OUT/scene.log"
ls -l "$OUT/scene.glb" | awk '{print "scene.glb " $5 " bytes"}'

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

echo "== R3 Cycles on CPU"
render cycles-640-32 CYCLES 640x480 32
render cycles-640-32-again CYCLES 640x480 32
render cycles-640-32-nodenoise CYCLES 640x480 32 -- --no-denoise
render cycles-320-16 CYCLES 320x240 16
render cycles-640-128 CYCLES 640x480 128

echo "== R4 Workbench"
render workbench-640 BLENDER_WORKBENCH 640x480 0

echo "== R5 Eevee"
ls -d "$HOME"/.cache/blender* 2>/dev/null | sed 's/^/shader cache before: /'
render eevee-640-32 BLENDER_EEVEE 640x480 32
render eevee-640-32-again BLENDER_EEVEE 640x480 32
render eevee-640-32-third BLENDER_EEVEE 640x480 32
du -sh "$HOME"/.cache/blender* 2>/dev/null | sed 's/^/shader cache after: /'
REN_ENV=EGL_PLATFORM=surfaceless render eevee-640-32-surfaceless BLENDER_EEVEE 640x480 32
render eevee-640-32-vulkan BLENDER_EEVEE 640x480 32 --gpu-backend vulkan
render eevee-640-32-vulkan-again BLENDER_EEVEE 640x480 32 --gpu-backend vulkan
render eevee-640-64 BLENDER_EEVEE 640x480 64
render eevee-1280-64 BLENDER_EEVEE 1280x960 64

echo "== R5b turntables, 24 frames at 640x480"
render turn-workbench BLENDER_WORKBENCH 640x480 0 -- --turntable 24
render turn-eevee BLENDER_EEVEE 640x480 16 -- --turntable 24
render turn-cycles CYCLES 640x480 16 -- --turntable 24
for k in workbench eevee cycles; do
  t=$(now)
  ffmpeg -v error -y -framerate 24 -i "$OUT/turn-$k-%04d.png" -c:v libx264 -pix_fmt yuv420p -crf 23 "$OUT/turn-$k.mp4" && echo "turn-$k.mp4: $(stat -c %s "$OUT/turn-$k.mp4") bytes, encoded in $(since "$t") s"
done
for k in workbench eevee cycles; do [ -f "$OUT/turn-$k-0012.png" ] && cp "$OUT/turn-$k-0012.png" "$OUT/turn-$k-frame12.png"; done
mkdir -p /tmp/frames && mv "$OUT"/turn-*-00[0-9][0-9].png /tmp/frames/ 2>/dev/null

echo "== R6 conversion and decimate"
mkdir -p /tmp/work/in "$OUT/convert"
node $L/make-meshes.mjs /tmp/work/in
ls -l /tmp/work/in | awk 'NR > 1 {print $9 " " $5 " bytes"}'
t=$(now)
blender -b --factory-startup --python-exit-code 3 --python $L/convert.py -- /tmp/work/in/torus.obj /tmp/work/in/sphere.stl "$OUT/convert" 0.1 > "$OUT/convert.log" 2>&1
echo "convert + decimate: exit $? in $(since "$t") s wall"
grep '^RESULT' "$OUT/convert.log" | cut -c8-
[ -s "$OUT/convert/torus.glb" ] || tail -20 "$OUT/convert.log"

echo "== R7 blank check"
node $L/png-stats.mjs "$OUT"/*.png
exit 0
