# Paid, tiny: a real Muse Wonder turn at low effort with web search off, under the real build firewall.
export PATH="$HOME/.local/bin:$PATH" MUSE_NO_AUTO_UPDATE=1 MUSE_LOGIN=0
mkdir -p /tmp/out
rm -rf /tmp/w-live; mkdir -p /tmp/w-live/.muse; cd /tmp/w-live; git init -q; git -c user.email=s@s -c user.name=s commit -q --allow-empty -m init
cd /tmp/sdk
SID=$(cd /tmp/sdk && node --input-type=module -e 'import {createUuidV7Mint} from "@muse-code/sdk"; console.log(createUuidV7Mint()())')
echo "session $SID"
PROMPT='Do these in order. 1. Run the shell command: sleep 12; date > now.txt. 2. If you have any web search or browsing tool, use it to find the top headline on the web today, and say the tool name; otherwise say exactly NO WEB TOOL. 3. Say which tools you have whose names mention web, search or browse. Keep it short.'
SESSION_ID=$SID EFFORT=low PROMPT="$PROMPT" WS=/tmp/w-live WAIT_S=120 MODEL=muse-wonder-1.0 SERVE_ARGS="serve --disable-sandbox --trust-workspace --disable-request-user-input --model muse-wonder-1.0" SETTING='tools.web_search.mode="off"' SETTING2='model_catalog=[{"model_id":"muse-wonder-1.0","provider_id":"meta","profile_id":"tbh","background_agent_model":"muse-wonder-1.0"}]' timeout 200 node /tmp/sdk/msp-host-probe.mjs /tmp/out/p3-live.jsonl live; echo "live exit=$?"
LOG=$(ls -d ~/.local/share/muse/sessions/*/*/*/$SID)/session.jsonl
echo "log $LOG"; wc -c "$LOG"
cp "$LOG" /tmp/out/p3-session.jsonl
node -e '
const fs=require("fs");const lines=fs.readFileSync(process.argv[1],"utf8").split("\n").filter(Boolean);const seen={};let n=0;
const recs=[];for(const l of lines){let o;try{o=JSON.parse(l)}catch{continue};if(o.retained_frame){for(const c of o.children||[]){try{recs.push(JSON.parse(c.record_json))}catch{}}}else recs.push(o)}
for(const r of recs){const e=r?.payload?.event;if(e?.kind==="goal_usage_attribution"){n++;const rr=e.record;const k=[rr.usage_family,rr.owner?.owner_type,rr.owner?.run_id].join(" ");seen[k]=(seen[k]||0)+1;if(rr.usage_family==="provider")console.log(JSON.stringify(rr.quantity))}}
console.log("attribution records",n,JSON.stringify(seen,null,1))' "$LOG"
grep -E '"turn/started"' /tmp/out/p3-live.jsonl | cut -c1-400 | head -3

echo "== every model named in this session's logs"
D=$(dirname "$LOG"); grep -rhoE '"model(_id)?":"[^"]+"' "$D" | sort | uniq -c | sort -rn | head
echo "child logs: $(find "$D" -name session.jsonl | wc -l)"; cp -r "$D" /tmp/out/p3-sessiondir 2>/dev/null; tar -C "$D" -czf /tmp/out/p3-sessiondir.tgz . ; rm -rf /tmp/out/p3-sessiondir
