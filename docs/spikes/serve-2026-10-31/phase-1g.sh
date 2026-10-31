# Free. A contributor-model round with the catalog row: where do its reminders go? Model calls are answered 403.
export PATH="$HOME/.local/bin:$PATH" MUSE_NO_AUTO_UPDATE=1 MUSE_LOGIN=0
mkdir -p /tmp/out /tmp/hooks
cat > /tmp/hooks/log.mjs <<'H'
import { readFileSync, appendFileSync } from "node:fs";
const o = JSON.parse(readFileSync(0, "utf8") || "{}");
appendFileSync("/tmp/out/prellm-g.jsonl", JSON.stringify({ case: process.argv[2], model: o.model, tools: o.tool_count, reminder: /reminder observer/.test(JSON.stringify(o.messages?.[0]?.content?.[0]?.text ?? "")) }) + "\n");
H
ws() { rm -rf "$1"; mkdir -p "$1/.muse" && cd "$1" && git init -q && git -c user.email=s@s -c user.name=s commit -q --allow-empty -m init; printf '{"hooks":{"PreLLMCall":[{"hooks":[{"type":"command","command":"node /tmp/hooks/log.mjs %s"}]}]}}' "$2" > .muse/hooks.json; }
M=muse-spark-1.3-contributor
ROW="model_catalog=[{\"model_id\":\"$M\",\"provider_id\":\"meta\",\"profile_id\":\"tbh\",\"background_agent_model\":\"$M\"}]"
BASE="serve --disable-sandbox --trust-workspace --disable-request-user-input --model $M"
ws /tmp/g1 serve-row; cd /tmp/sdk; WS=/tmp/g1 WAIT_S=5 MODEL=$M SETTING="$ROW" SERVE_ARGS="$BASE" timeout 30 node /tmp/sdk/msp-host-probe.mjs /tmp/out/p1g-1.jsonl tools
ws /tmp/g2 serve-norow; cd /tmp/sdk; WS=/tmp/g2 WAIT_S=5 MODEL=$M SERVE_ARGS="$BASE" timeout 30 node /tmp/sdk/msp-host-probe.mjs /tmp/out/p1g-2.jsonl tools
ws /tmp/g3 exec-row; timeout 40 muse exec --json --yolo --disable-web-tools --model $M --max-model-steps 2 --session-id "$(node -p 'crypto.randomUUID()')" -c "$ROW" "Reply OK." >/dev/null 2>/tmp/e.txt
ws /tmp/g4 exec-norow; timeout 40 muse exec --json --yolo --disable-web-tools --model $M --max-model-steps 2 --session-id "$(node -p 'crypto.randomUUID()')" "Reply OK." >/dev/null 2>/tmp/e.txt
sort -u /tmp/out/prellm-g.jsonl
