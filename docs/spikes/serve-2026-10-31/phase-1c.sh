# Free. Can the reminder agents' model be set? Every PreLLMCall is logged while the firewall answers 403.
export PATH="$HOME/.local/bin:$PATH" MUSE_NO_AUTO_UPDATE=1 MUSE_LOGIN=0
mkdir -p /tmp/out /tmp/hooks
cat > /tmp/hooks/log.mjs <<'H'
import { readFileSync, appendFileSync } from "node:fs";
const o = JSON.parse(readFileSync(0, "utf8") || "{}");
appendFileSync("/tmp/out/prellm-c.jsonl", JSON.stringify({ case: process.argv[2], model: o.model, tools: o.tool_count, effort: o.options?.["meta.reasoning.effort"], reminder: /reminder observer/.test(JSON.stringify(o.messages?.[0]?.content?.[0]?.text ?? "")) }) + "\n");
H
ws() { rm -rf "$1"; mkdir -p "$1/.muse" && cd "$1" && git init -q && git -c user.email=s@s -c user.name=s commit -q --allow-empty -m init; printf '{"hooks":{"PreLLMCall":[{"hooks":[{"type":"command","command":"node /tmp/hooks/log.mjs %s"}]}]}}' "$2" > .muse/hooks.json; }
BASE="serve --disable-sandbox --trust-workspace --disable-request-user-input --model muse-wonder-1.0"
serve() { # serve <case> <setting> [extra serve args]
  local name=$1 setting=$2 extra=$3
  ws "/tmp/c-$name" "$name"; cd /tmp/sdk
  WS="/tmp/c-$name" WAIT_S=6 MODEL=muse-wonder-1.0 SETTING="$setting" SERVE_ARGS="$BASE $extra" timeout 30 node /tmp/sdk/msp-host-probe.mjs "/tmp/out/p1c-$name.jsonl" tools
  echo "[$name] exit=$? $(grep -m1 -E 'fatal|refusing' "/tmp/out/p1c-$name.jsonl" | cut -c1-240)"
  grep "\"case\":\"$name\"" /tmp/out/prellm-c.jsonl | cut -c1-200 | sort -u
}
R='plugin:tbh-reminders:reminder'
serve baseline ''
serve model-field "runtime_capabilities={\"$R:skill-reminder\":{\"enabled\":true,\"model\":\"muse-wonder-1.0\"},\"$R:goal-reminder\":{\"enabled\":true,\"model\":\"muse-wonder-1.0\"}}"
serve bad-field "runtime_capabilities={\"$R:skill-reminder\":{\"enabled\":true,\"nope\":1}}"
serve setting-model 'model="muse-wonder-1.0"'
serve contributor '' '--contributor-mode on'
serve all-off "runtime_capabilities={\"$R:skill-reminder\":{\"enabled\":false},\"$R:goal-reminder\":{\"enabled\":false},\"$R:verify-reminder\":{\"enabled\":false},\"$R:memory-reminder\":{\"enabled\":false},\"$R:todo-reminder\":{\"enabled\":false},\"$R:scope-reminder\":{\"enabled\":false}}"
echo "== binary"
B=$(ls "$HOME"/.local/bin/muse-bin-* | head -1); echo "$B"
g() { grep -a -o -E "$1" "$B" | tr -c '[:print:]\n' '.' | sort -u | head -"${2:-12}"; }
echo "-- same-as-main"; g '.{0,200}same-as-main.{0,240}'
echo "-- reminder model"; g '.{0,120}(reminder[_ .-]model|model[_ .-]reminder|reminder_agent_model|modelPolicy|model_policy|model_selection|modelSelection).{0,160}' 20
echo "-- skill-reminder"; g '.{0,200}skill-reminder.{0,300}' 8
echo "-- spark"; g '.{0,100}spark.{0,100}' 16
echo "-- capability value keys"; g '.{0,200}(RuntimeCapabilit|runtime_capabilities\.).{0,200}' 10
muse plugin --help 2>&1 | head -20; muse plugin list --json 2>&1 | head -40 | cut -c1-400
curl -s -m 20 -H "Authorization: Bearer $META_API_KEY" https://api.meta.ai/muse-code/models > /tmp/out/muse-code-models.json; echo "catalog bytes $(wc -c </tmp/out/muse-code-models.json)"
