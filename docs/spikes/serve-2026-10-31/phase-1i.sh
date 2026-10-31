# Free. Why does only the first serve host in a sandbox honor the catalog row? Model calls are answered 403.
export PATH="$HOME/.local/bin:$PATH" MUSE_NO_AUTO_UPDATE=1 MUSE_LOGIN=0
mkdir -p /tmp/out /tmp/hooks
cat > /tmp/hooks/log.mjs <<'H'
import { readFileSync, appendFileSync } from "node:fs";
const o = JSON.parse(readFileSync(0, "utf8") || "{}");
appendFileSync("/tmp/out/prellm-i.jsonl", JSON.stringify({ case: process.argv[2], model: o.model, reminder: /reminder observer/.test(JSON.stringify(o.messages?.[0]?.content?.[0]?.text ?? "")) }) + "\n");
H
M=muse-wonder-1.0
ROW="model_catalog=[{\"model_id\":\"$M\",\"provider_id\":\"meta\",\"profile_id\":\"tbh\",\"background_agent_model\":\"$M\"}]"
BASE="serve --disable-sandbox --trust-workspace --disable-request-user-input --model $M"
ws() { rm -rf "$1"; mkdir -p "$1/.muse" && cd "$1" && git init -q && git -c user.email=s@s -c user.name=s commit -q --allow-empty -m init; printf '{"hooks":{"PreLLMCall":[{"hooks":[{"type":"command","command":"node /tmp/hooks/log.mjs %s"}]}]}}' "$2" > .muse/hooks.json; }
one() { ws "/tmp/i-$1" "$1"; cd /tmp/sdk; WS="/tmp/i-$1" WAIT_S=4 MODEL=$M SETTING="$ROW" SERVE_ARGS="$BASE" timeout 30 node /tmp/sdk/msp-host-probe.mjs "/tmp/out/p1i-$1.jsonl" tools; echo "[$1] $(grep "\"case\":\"$1\"" /tmp/out/prellm-i.jsonl | grep '"reminder":true' | sort -u | cut -c1-90 | tr '\n' ' ')"; }
C="$HOME/.local/share/muse/model-catalog"
one run1
ls -la "$C" | cut -c20-; for f in "$C"/*; do echo "== $f"; head -c 500 "$f"; echo; grep -o 'background_agent_model[^,}]*' "$f" | sort | uniq -c; done
one run2-cached
rm -rf "$C"; one run3-deleted
one run4-cached
rm -rf "$C"; one run5-deleted
cd /tmp/sdk; ws /tmp/i-res res-first; SID=$(cd /tmp/sdk && node --input-type=module -e 'import {createUuidV7Mint} from "@muse-code/sdk"; console.log(createUuidV7Mint()())')
rm -rf "$C"; cd /tmp/sdk; SESSION_ID=$SID WS=/tmp/i-res WAIT_S=4 MODEL=$M SETTING="$ROW" SERVE_ARGS="$BASE" timeout 30 node /tmp/sdk/msp-host-probe.mjs /tmp/out/p1i-res1.jsonl tools
printf '{"hooks":{"PreLLMCall":[{"hooks":[{"type":"command","command":"node /tmp/hooks/log.mjs res-resumed-deleted"}]}]}}' > /tmp/i-res/.muse/hooks.json
rm -rf "$C"; cd /tmp/sdk; SESSION_ID=$SID WS=/tmp/i-res WAIT_S=4 MODEL=$M SETTING="$ROW" SERVE_ARGS="$BASE" timeout 30 node /tmp/sdk/msp-host-probe.mjs /tmp/out/p1i-res2.jsonl resume
sort -u /tmp/out/prellm-i.jsonl | grep -E 'res-' | cut -c1-100
ls -la "$C" | wc -l
echo "== exec with a cached catalog, row given"; ws /tmp/i-e e1; timeout 30 muse exec --json --yolo --disable-web-tools --model $M --max-model-steps 2 --session-id "$(node -p 'crypto.randomUUID()')" -c "$ROW" "Reply OK." >/dev/null 2>/tmp/e.txt; grep '"case":"e1"' /tmp/out/prellm-i.jsonl | sort -u | cut -c1-90
