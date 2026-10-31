# Phase muse: Muse Code drives Blender under the build firewall, on muse-spark-1.3-contributor only, reminders off, the way
# a TEST_MODEL build runs `muse exec` (lib/sandbox/muse.ts museExecArgs, builder.ts roundSettings), plus the endpoint and
# telemetry settings of docs/spikes/musecode-2026-10-31 so every call goes through proxy.mjs and is metered and capped.
# M1 is free: the proxy refuses the model call, which proves the wiring. M2 is the task. M3 repeats it with Muse Code's
# bundled blender skill on (builds turn it off, lib/sandbox/setup.ts), only while M2 left budget.
set -u
export PATH="$HOME/.local/bin:$PATH"
OUT=/tmp/out/muse
mkdir -p "$OUT"
L=/tmp/spike/lib
M=muse-spark-1.3-contributor
now() { date +%s.%N; }
since() { awk -v a="$1" -v b="$(now)" 'BEGIN { printf "%.1f", b - a }'; }
uuid7() { node -e 'const b=require("crypto").randomBytes(16);b.writeUIntBE(Date.now(),0,6);b[6]=(b[6]&15)|112;b[8]=(b[8]&63)|128;const h=b.toString("hex");console.log(`${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`)'; }
REMINDERS_OFF='runtime_capabilities={"plugin:tbh-reminders:reminder:scope-reminder":{"enabled":false},"plugin:tbh-reminders:reminder:skill-reminder":{"enabled":false},"plugin:tbh-reminders:reminder:goal-reminder":{"enabled":false},"plugin:tbh-reminders:reminder:verify-reminder":{"enabled":false},"plugin:tbh-reminders:reminder:memory-reminder":{"enabled":false},"plugin:tbh-reminders:reminder:todo-reminder":{"enabled":false}}'
BACKGROUND="model_catalog=[{\"model_id\":\"$M\",\"provider_id\":\"meta\",\"profile_id\":\"tbh\",\"background_agent_model\":\"$M\"}]"
ENDPOINT='endpoint_transport={"base_url":"http://127.0.0.1:8787/v1","auth":"bearer"}'
health() { curl -s -m 2 http://127.0.0.1:8787/__health; echo; }
# keep <workspace> <out dir>: lists what the task made, keeps its scripts, models and pictures, and checks the pictures.
keep() {
  mkdir -p "$2"
  (cd "$1" && find . -path ./.git -prune -o -type f -printf '  %P %s bytes\n' | sort | head -40)
  (cd "$1" && find . -path ./.git -prune -o -type f \( -name '*.py' -o -name '*.glb' -o -name '*.png' \) -size -20M -exec cp --parents {} "$2/" \;)
  find "$1" -name '*.png' -not -path '*/.git/*' -exec node $L/png-stats.mjs {} +
}

# run_task <label> <workspace> <prompt file> <effort> <steps> <limit s>
run_task() {
  local label=$1 ws=$2 prompt=$3 effort=$4 steps=$5 limit=$6 t
  echo "$label" > /tmp/proxy-label
  rm -rf "$HOME/.local/share/muse/model-catalog"
  mkdir -p "$ws" && (cd "$ws" && git init -q 2>/dev/null)
  t=$(now)
  (cd "$ws" && META_API_KEY="$SPIKE_STANDIN" timeout "$limit" muse exec --json --yolo --session-id "$(uuid7)" --prompt-file "$prompt" \
    --model "$M" --reasoning-effort "$effort" --max-model-steps "$steps" --disable-web-tools --disable-request-user-input --no-foreign-personal-context \
    --config "$REMINDERS_OFF" --config "$BACKGROUND" --config "$ENDPOINT" --config 'telemetry.enabled=false' \
    > "$OUT/$label.exec.jsonl" 2> "$OUT/$label.exec.err" < /dev/null)
  local code=$?
  echo "$label: muse exec exit $code in $(since "$t") s"
  tail -c 600 "$OUT/$label.exec.err" | tr '\n' ' ' | cut -c1-600; echo
  node $L/exec-summary.mjs "$OUT/$label.exec.jsonl" /tmp/out/proxy.jsonl "$label"
}

command -v blender >/dev/null || { echo "no blender, phase setup must run first"; exit 7; }

echo "== M0 Muse Code and its blender skill"
muse --version
muse skills list --json > /tmp/skills.json 2>/dev/null
node -e '
  const s = JSON.parse(require("fs").readFileSync("/tmp/skills.json", "utf8")).skills ?? [];
  for (const k of s.filter((x) => /blender|3d|web3d|visual/i.test(String(x.id)))) console.log(JSON.stringify({ id: k.id, activation: k.activation, description: String(k.description ?? "").slice(0, 300), path: k.path ?? k.location ?? null }));
' 2>&1 | head -8
SKILL_DIR=$(node -e 'const s=JSON.parse(require("fs").readFileSync("/tmp/skills.json","utf8")).skills??[];const k=s.find(x=>x.id==="bundled:blender");const p=k&&(k.path??k.location);console.log(p?require("path").dirname(p):"")' 2>/dev/null)
[ -n "$SKILL_DIR" ] && find "$SKILL_DIR" -type f -printf '  %P %s bytes\n' 2>/dev/null | head -20
echo "proxy: $(health)"

echo "== M1 wiring check, free (the proxy refuses the model call)"
echo refuse > /tmp/proxy-mode
printf 'Reply with the single word ready.\n' > /tmp/m1-prompt.md
run_task m1-wiring /tmp/m1 /tmp/m1-prompt.md low 2 120

WIRED=$(node -e 'const ls=require("fs").readFileSync("/tmp/out/proxy.jsonl","utf8").split("\n").filter(Boolean).map(l=>JSON.parse(l));console.log(ls.some(p=>p.label==="m1-wiring"&&p.path==="/v1/responses"&&p.model==="muse-spark-1.3-contributor"&&p.auth==="standin")?1:0)' 2>/dev/null)
if [ "$WIRED" != 1 ]; then echo "M1 never reached the proxy as Contributor with the stand-in, so no paid run"; exit 0; fi

echo "== M2 the task"
cat > /tmp/mug-prompt.md <<'EOF'
Make a low-poly coffee mug in Blender with a script, export mug.glb, and render mug.png.

Blender 5.2 is installed as `blender` on the PATH. There is no GPU and no display, so run it headless with `blender -b --python <script>`. There is no internet access.
EOF
echo forward > /tmp/proxy-mode
run_task m2-mug /tmp/mug /tmp/mug-prompt.md high 40 600
echo refuse > /tmp/proxy-mode
keep /tmp/mug "$OUT/mug"
for g in $(find /tmp/mug -name '*.glb'); do [ -f "$g" ] && blender -b --factory-startup --python-expr "import bpy; bpy.ops.wm.read_factory_settings(use_empty=True); bpy.ops.import_scene.gltf(filepath='$g'); print('GLBCHECK', '$g', len([o for o in bpy.context.scene.objects if o.type=='MESH']), 'meshes', sum(len(o.data.polygons) for o in bpy.context.scene.objects if o.type=='MESH'), 'faces', [m.name for m in bpy.data.materials])" 2>&1 | grep GLBCHECK; done
echo "proxy: $(health)"

SPENT=$(curl -s -m 2 http://127.0.0.1:8787/__health | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).spent)}catch{console.log(1)}})')
if awk -v s="$SPENT" 'BEGIN { exit !(s < 0.06) }'; then
  echo "== M3 the same task with the bundled blender skill on (spent so far \$$SPENT)"
  muse skills enable bundled:blender --scope built-in --json > /dev/null 2>&1; echo "enable exit $?"
  echo forward > /tmp/proxy-mode
  run_task m3-mug-skill /tmp/mug2 /tmp/mug-prompt.md high 40 480
  echo refuse > /tmp/proxy-mode
  muse skills disable bundled:blender --scope built-in --json > /dev/null 2>&1
  keep /tmp/mug2 "$OUT/mug-skill"
  echo "proxy: $(health)"
else
  echo "== M3 skipped, spent \$$SPENT"
fi
exit 0
