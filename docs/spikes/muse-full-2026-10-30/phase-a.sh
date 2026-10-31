# Phase A: no network at all. Facts about the installed Muse Code, with no model calls.
export PATH="$HOME/.local/bin:$PATH" MUSE_NO_AUTO_UPDATE=1 MUSE_LOGIN=0
mkdir -p /tmp/out
echo "== A1 version and layout"
cat /vercel/musemuse/builder.json 2>&1; muse --version; uname -m; whoami; echo "bin: $(readlink -f "$(command -v muse)")"
echo "== A2 help"
muse --help 2>&1 | head -150
echo "-- exec --help"; muse exec --help 2>&1
echo "-- serve --help"; muse serve --help 2>&1
echo "-- schema --help"; muse schema --help 2>&1 | head -40
muse schema > /tmp/out/msp-schema.json 2>/tmp/out/msp-schema.err; echo "schema exit=$? bytes=$(wc -c </tmp/out/msp-schema.json)"; head -c 300 /tmp/out/msp-schema.err
echo "== A3 skills and settings"
muse skills list --json >/tmp/out/skills.json 2>&1; node -e 'const j=JSON.parse(require("fs").readFileSync("/tmp/out/skills.json","utf8"));for(const s of j.skills||[])console.log(s.id, s.activation, s.source||"")' 2>&1 | head -80
echo "-- settings.json"; cat ~/.config/muse/settings.json 2>&1 | head -60
echo "== A4 config commands"
muse config --help 2>&1 | head -40; muse config status 2>&1 | head -40
echo "== A5 strings in the binary"
BINS="$(readlink -f "$(command -v muse)") $(find "$HOME/.local" "$HOME/.cache" -maxdepth 7 -type f -size +20M 2>/dev/null | head -5)"
for B in $BINS; do echo "## $B ($(wc -c <"$B") bytes)"; done
for pat in 'hooks\.json' 'managed_hooks_path' 'hookSpecificOutput' 'additionalContext' 'permissionDecision' 'updatedInput' '"matcher"' 'onFailure' 'execution_capacity' 'runtime_capabilities' 'workflow-script-engine' 'WorkflowTool' 'goal_reminder' 'verify_reminder' 'skill_reminder' 'memory_reminder' 'todo_reminder' 'scope_reminder' 'workflow_mode' 'workflows\.mode' 'session_messaging'; do
  echo "-- $pat"
  for B in $BINS; do grep -a -o -E ".{0,70}${pat}.{0,90}" "$B" 2>/dev/null | tr -c '[:print:]\n' '.' | sort -u | head -12; done
done
echo "== A6 settings validation"
S="$HOME/.config/muse/settings.json"; cp "$S" /tmp/settings.orig.json
probe() { node -e 'const fs=require("fs");const s=JSON.parse(fs.readFileSync("/tmp/settings.orig.json"));const add=JSON.parse(process.argv[1]);for(const[k,v] of Object.entries(add))s[k]=(typeof v==="object"&&v&&!Array.isArray(v)&&typeof s[k]==="object")?{...s[k],...v}:v;fs.writeFileSync(process.argv[2],JSON.stringify(s,null,2))' "$1" "$S"; muse skills list --json >/dev/null 2>/tmp/p.err; echo "[$1] exit=$? $(tr '\n' ' ' </tmp/p.err | head -c 400)"; cp /tmp/settings.orig.json "$S"; }
for f in '{"agents":{"execution_capacity":4}}' '{"agents":{"execution_capacity":65}}' '{"agents":{"execution_capacity":0}}' '{"agents":{"not_a_key":1}}' '{"runtime_capabilities":{"not_a_cap":false}}' '{"not_a_top_level_key":1}' '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"/bin/true"}]}]}}' '{"mcp_servers":{"x":{"transport":"stdio","command":"/bin/true","args":[],"mode":"optional"}}}'; do probe "$f"; done
echo "== A8 workflows"
muse workflows --help 2>&1 | head -30; for s in save list recover; do echo "-- workflows $s --help"; muse workflows "$s" --help 2>&1 | head -25; done
mkdir -p /tmp/wfspike && cd /tmp/wfspike && git init -q && git -c user.email=s@s -c user.name=s commit -q --allow-empty -m init
printf 'export default async function () { return { ok: true }; }\n' >/tmp/wf.js
muse workflows save spike-check --from /tmp/wf.js --scope project; echo "save=$?"; ls -la .agents/workflows 2>&1
muse workflows list 2>&1 | head -20
echo "== A9 other commands"
for c in model-profile mcp hooks agents goal plugin; do echo "-- $c --help"; muse $c --help 2>&1 | head -25; done
