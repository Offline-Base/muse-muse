# Free. The main agent's tool list under each web setting, with model calls answered 403.
export PATH="$HOME/.local/bin:$PATH" MUSE_NO_AUTO_UPDATE=1 MUSE_LOGIN=0
mkdir -p /tmp/out /tmp/hooks
cat > /tmp/hooks/log.mjs <<'H'
import { readFileSync, appendFileSync } from "node:fs";
const o = JSON.parse(readFileSync(0, "utf8") || "{}");
if (!/reminder observer/.test(JSON.stringify(o.messages?.[0]?.content?.[0]?.text ?? ""))) appendFileSync("/tmp/out/prellm-f.jsonl", JSON.stringify({ case: process.argv[2], model: o.model, n: o.tool_count, tools: (o.tools || []).map((t) => t.name) }) + "\n");
H
ws() { rm -rf "$1"; mkdir -p "$1/.muse" && cd "$1" && git init -q && git -c user.email=s@s -c user.name=s commit -q --allow-empty -m init; printf '{"hooks":{"PreLLMCall":[{"hooks":[{"type":"command","command":"node /tmp/hooks/log.mjs %s"}]}]}}' "$2" > .muse/hooks.json; }
BASE="serve --disable-sandbox --trust-workspace --disable-request-user-input --model muse-wonder-1.0"
serve() { ws "/tmp/f-$1" "$1"; cd /tmp/sdk; WS="/tmp/f-$1" WAIT_S=5 MODEL=muse-wonder-1.0 SETTING="$2" SERVE_ARGS="$BASE" timeout 30 node /tmp/sdk/msp-host-probe.mjs "/tmp/out/p1f-$1.jsonl" tools; }
serve default ''
serve off 'tools.web_search.mode="off"'
serve hosted 'tools.web_search.mode="hosted"'
ws /tmp/f-exec execflag; timeout 40 muse exec --json --yolo --disable-web-tools --disable-request-user-input --model muse-wonder-1.0 --reasoning-effort high --max-model-steps 2 --session-id "$(node -p 'crypto.randomUUID()')" "Reply OK." >/dev/null 2>/tmp/e.txt
ws /tmp/f-exec2 execnoflag; timeout 40 muse exec --json --yolo --disable-request-user-input --model muse-wonder-1.0 --reasoning-effort high --max-model-steps 2 --session-id "$(node -p 'crypto.randomUUID()')" "Reply OK." >/dev/null 2>/tmp/e.txt
node -e '
const rows=require("fs").readFileSync("/tmp/out/prellm-f.jsonl","utf8").trim().split("\n").map(JSON.parse);
const by={};for(const r of rows)by[r.case]??=r;
const base=new Set(by.default.tools);
for(const[k,r]of Object.entries(by)){const s=new Set(r.tools);console.log(k,"n="+r.n,"web:",r.tools.filter(t=>/web|search|browse|image/.test(t)).join(","),"| only here vs default:",r.tools.filter(t=>!base.has(t)).join(","),"| missing vs default:",[...base].filter(t=>!s.has(t)).join(","))}
'
for kv in 'tools.web_fetch.mode="off"' 'tools.web_search.mode="off"' 'tools.image_generation.mode="off"'; do cd /tmp; timeout 15 muse exec --provider echo --json --yolo -c "$kv" "hi" >/dev/null 2>/tmp/e.err; echo "[-c $kv] exit=$? $(grep -m1 -E 'refusing' /tmp/e.err | cut -c1-200)"; done
