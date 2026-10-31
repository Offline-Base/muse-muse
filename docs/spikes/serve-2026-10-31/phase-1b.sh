# Free. Which model do the reminder agents call? Every PreLLMCall is logged while the firewall answers 403.
export PATH="$HOME/.local/bin:$PATH" MUSE_NO_AUTO_UPDATE=1 MUSE_LOGIN=0
mkdir -p /tmp/out /tmp/hooks
cat > /tmp/hooks/log.mjs <<'H'
import { readFileSync, appendFileSync } from "node:fs";
const o = JSON.parse(readFileSync(0, "utf8") || "{}");
appendFileSync(process.env.PRELLM_OUT || "/tmp/out/prellm-all.jsonl", JSON.stringify({ case: process.argv[2], model: o.model, provider: o.model_provider, session: o.session_id, turn: o.turn_id, step: o.step, tools: o.tool_count, effort: o.options?.["meta.reasoning.effort"], contributor: o.options?.["meta.contributor"], first: JSON.stringify(o.messages?.[0]?.content?.[0]?.text ?? "").slice(0, 80) }) + "\n");
H
ws() { rm -rf "$1"; mkdir -p "$1/.muse" && cd "$1" && git init -q && git -c user.email=s@s -c user.name=s commit -q --allow-empty -m init; printf '{"hooks":{"PreLLMCall":[{"hooks":[{"type":"command","command":"node /tmp/hooks/log.mjs %s"}]}]}}' "$2" > .muse/hooks.json; }
ALLR='{"plugin:tbh-reminders:reminder:skill-reminder":{"enabled":true},"plugin:tbh-reminders:reminder:goal-reminder":{"enabled":true},"plugin:tbh-reminders:reminder:verify-reminder":{"enabled":true},"plugin:tbh-reminders:reminder:memory-reminder":{"enabled":true},"plugin:tbh-reminders:reminder:todo-reminder":{"enabled":true},"plugin:tbh-reminders:reminder:scope-reminder":{"enabled":true}}'
SID() { node -p 'crypto.randomUUID()'; }
echo "== exec, default"; ws /tmp/w1 exec-default; timeout 40 muse exec --json --yolo --disable-web-tools --disable-request-user-input --no-foreign-personal-context --model muse-wonder-1.0 --reasoning-effort high --max-model-steps 2 --session-id "$(SID)" "Reply OK." >/dev/null 2>/tmp/e.txt; echo "exit $?"
echo "== exec, all reminders"; ws /tmp/w2 exec-full; timeout 40 muse exec --json --yolo --disable-web-tools --disable-request-user-input --model muse-wonder-1.0 --reasoning-effort high --max-model-steps 2 --session-id "$(SID)" -c "runtime_capabilities=$ALLR" "Reply OK." >/dev/null 2>/tmp/e.txt; echo "exit $?"
echo "== serve, all reminders"; ws /tmp/w3 serve-full; cd /tmp/sdk; WS=/tmp/w3 WAIT_S=10 MODEL=muse-wonder-1.0 SETTING="runtime_capabilities=$ALLR" SERVE_ARGS="serve --disable-sandbox --trust-workspace --disable-request-user-input --model muse-wonder-1.0" timeout 40 node /tmp/sdk/msp-host-probe.mjs /tmp/out/p1b-serve.jsonl tools; echo "exit $?"
cat /tmp/out/prellm-all.jsonl | cut -c1-300
echo "== model-profile"; muse model-profile show muse-wonder-1.0 --effort high 2>&1 | head -60
echo "== settings keys in the binary"
B=$(readlink -f "$(command -v muse)")
grep -a -o -E '[A-Za-z_-]{0,40}(same-as-main|same_as_main|reminder[._]model|model[._]reminder|background_agent_model|small_fast|fast_model|lightweight_model|observer_model)[A-Za-z_.-]{0,40}' "$B" | sort -u | head -40
grep -a -o -E '.{0,120}same-as-main.{0,160}' "$B" | tr -c '[:print:]\n' '.' | sort -u | head -12
grep -a -o -E '.{0,160}muse-spark-1\.3.{0,120}' "$B" | tr -c '[:print:]\n' '.' | sort -u | head -12
ws /tmp/wx x; cd /tmp/wx
for kv in 'reminders.model="muse-wonder-1.0"' 'reminder.model="muse-wonder-1.0"' 'background_agent_model="muse-wonder-1.0"' 'agents.background_model="muse-wonder-1.0"' 'run.background_agent_model="muse-wonder-1.0"' 'runtime_capabilities={"plugin:tbh-reminders:reminder:skill-reminder":{"enabled":true,"model":"muse-wonder-1.0"}}'; do
  timeout 15 muse exec --provider echo --json --yolo -c "$kv" "hi" >/dev/null 2>/tmp/e.err; echo "[-c $kv] exit=$? $(tr '\n' ' ' </tmp/e.err | cut -c1-200)"
done
