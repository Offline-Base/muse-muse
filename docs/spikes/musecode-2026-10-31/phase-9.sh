# Free. Cold start: the bridge run straight after the SDK install, with no sink or anything else in front of it.
. /tmp/spike/lib.sh
mode refuse
T=$SPIKE_T0_MS
export META_API_KEY="$SPIKE_STANDIN"
unset SPIKE_STANDIN SPIKE_KEY_SHA256 SPIKE_PH_SHA256 SPIKE_REFUSED SPIKE_SANDBOX_NAME
echo "Reply READY." > /tmp/pr.txt
echo "bridge started at $(( $(date +%s%3N) - T )) ms from create"
run_bridge cold /tmp/ws-cold /tmp/pr.txt 25 "$WEB_OFF" "$REMINDERS_OFF" "$ENDPOINT" "$QUIET_T" >/dev/null
export SPIKE_T0_MS=$T
node -e '
  const t0=Number(process.argv[1]);
  const l=require("fs").readFileSync("/tmp/out/cold.bridge.jsonl","utf8").split("\n").filter(Boolean).map(JSON.parse);
  const first=(f)=>{const r=l.find(f);return r?((r.t-t0)/1000).toFixed(2):"-"};
  console.log(JSON.stringify({firstLogS:first(()=>true),sessionStartedS:first(r=>r.method==="session/started"),turnStartedS:first(r=>r.method==="turn/started")}));
  const p=require("fs").readFileSync("/tmp/out/proxy.jsonl","utf8").split("\n").filter(Boolean).map(JSON.parse).find(e=>e.method==="POST");
  console.log("first model call reached the proxy", p?((p.t-t0)/1000).toFixed(2):"-","s");
' "$T"
