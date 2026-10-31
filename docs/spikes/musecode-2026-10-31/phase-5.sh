# Paid, small. Tool calls, a shell check from inside a session, compaction, a subagent and reminders, all through the proxy.
. /tmp/spike/lib.sh
sink_on
mode forward
node -e 'const c=require("crypto");const s=(x)=>c.createHash("sha256").update(x).digest("hex");require("fs").writeFileSync("/tmp/spike-hashes.json",JSON.stringify({realKey:process.env.SPIKE_KEY_SHA256,placeholder:process.env.SPIKE_PH_SHA256,standIn:s(process.env.SPIKE_STANDIN)}))'
export META_API_KEY="$SPIKE_STANDIN"
unset SPIKE_STANDIN SPIKE_KEY_SHA256 SPIKE_PH_SHA256 SPIKE_REFUSED SPIKE_T0_MS SPIKE_SANDBOX_NAME
BASE=("$WEB_OFF" "$ENDPOINT" "$QUIET_T")
ROW="model_catalog=[{\"model_id\":\"$M\",\"provider_id\":\"meta\",\"profile_id\":\"tbh\",\"background_agent_model\":\"$M\"}]"

echo "Run this exact command with your shell tool, then reply with the one line it prints: node /tmp/sdk/inside.mjs" > /tmp/p1.txt
run_bridge g1-inside /tmp/ws-g1 /tmp/p1.txt 200 "$REMINDERS_OFF" "${BASE[@]}"
report g1-inside; cat /tmp/out/inside.txt; echo

echo "== compaction"
label g2-compact; rm -rf "$HOME/.local/share/muse/model-catalog"; mkdir -p /tmp/ws-g2
( cd /tmp/sdk && timeout 150 node /tmp/sdk/compact.mjs /tmp/out/g2.jsonl /tmp/ws-g2 "$REMINDERS_OFF" "${BASE[@]}" ) 2>&1 | tail -3
grep -E '"call"|"terminal"|stderr|"closed"' /tmp/out/g2.jsonl | cut -c1-260
node -e 'const f=require("fs").readFileSync("/tmp/out/g2.jsonl","utf8").split("\n").filter(Boolean).map(JSON.parse);const n={};for(const e of f)if(e.note)n[e.note+(e.itemKind?":"+e.itemKind:"")]=(n[e.note+(e.itemKind?":"+e.itemKind:"")]||0)+1;console.log(JSON.stringify(n))'
report g2-compact | grep -E 'proxy requests|direct conn|metered|kinds'; echo

echo "Use a subagent to create a file named sub.txt containing the word hi. When it is done, reply DONE." > /tmp/p3.txt
run_bridge g3-sub /tmp/ws-g3 /tmp/p3.txt 120 "$REMINDERS_OFF" "${BASE[@]}"
report g3-sub; ls -la /tmp/ws-g3; echo

echo "Create a file named note.txt containing the word hi, read it back, then reply DONE." > /tmp/p4.txt
echo "== reminders on, no catalog row"
run_bridge g4-rem /tmp/ws-g4 /tmp/p4.txt 90 "${BASE[@]}"
report g4-rem | grep -E 'proxy requests|direct conn|metered|kinds|turns|exit'
echo "== reminders on, the contributor catalog row"
run_bridge g5-row /tmp/ws-g5 /tmp/p4.txt 90 "${BASE[@]}" "$ROW"
report g5-row | grep -E 'proxy requests|direct conn|metered|kinds|turns|exit'
echo "== every refused model call"
grep -h '"refused"' /tmp/out/proxy.jsonl | node -e 'for (const l of require("fs").readFileSync(0,"utf8").split("\n").filter(Boolean)) { const e=JSON.parse(l); console.log(e.label, e.method, e.path, e.model, e.refused, JSON.stringify(e.toolKinds)); }'
curl -s --noproxy '*' http://127.0.0.1:8787/__health; echo
