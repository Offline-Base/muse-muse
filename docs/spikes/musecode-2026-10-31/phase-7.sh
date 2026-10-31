# Paid. The two real tasks, stop latency, forced compaction and one environment setting. Budget set by the runner.
. /tmp/spike/lib.sh
sink_on
mode forward
export META_API_KEY="$SPIKE_STANDIN"
unset SPIKE_STANDIN SPIKE_KEY_SHA256 SPIKE_PH_SHA256 SPIKE_REFUSED SPIKE_T0_MS SPIKE_SANDBOX_NAME
BASE=("$WEB_OFF" "$REMINDERS_OFF" "$ENDPOINT" "$QUIET_T")
now() { date +%s%3N; }
keep() { mkdir -p "/tmp/out/$1"; ( cd "$2" && find . -type f -size -200k -not -path './node_modules/*' -not -path './.git/*' -print0 | xargs -0 -I{} cp --parents {} "/tmp/out/$1/" ) ; }

echo "== task a"
echo "Write a Node script that dedupes a CSV by email, add a test, run it." > /tmp/pa.txt
A0=$(now); run_bridge t-a /tmp/ws-a /tmp/pa.txt 280 "${BASE[@]}"; echo "task a: $(( $(now) - A0 )) ms"
report t-a | cut -c1-700; ls -la /tmp/ws-a; keep task-a /tmp/ws-a
( cd /tmp/ws-a; echo "-- my rerun of its test:"; ( node --test 2>&1 || npm test 2>&1 ) | tail -12 | cut -c1-200 ); echo

echo "== task b"
echo "Make a small static HTML page that shows the CSV as a sortable table." > /tmp/pb.txt
B0=$(now); run_bridge t-b /tmp/ws-b /tmp/pb.txt 280 "${BASE[@]}"; echo "task b: $(( $(now) - B0 )) ms"
report t-b | cut -c1-700; ls -la /tmp/ws-b; keep task-b /tmp/ws-b; echo

stop_test() { # stop_test <name> <how> <prompt file> <wait pattern> [setting...]
  local name=$1 how=$2 prompt=$3 pat=$4; shift 4
  prep_bridge "$name" "/tmp/ws-$name" "$prompt" "$@"
  ( cd /tmp/sdk; exec node /tmp/sdk/bridge.mjs "/tmp/runs/$name/config.json" >"/tmp/out/$name.bridge.err" 2>&1 ) &
  local bp=$!
  for i in $(seq 1 300); do
    if [ "$pat" = HELD ]; then grep -q '"held":true' /tmp/out/proxy.jsonl 2>/dev/null && break; else pgrep -f "$pat" >/dev/null && break; fi
    sleep 0.2
  done
  sleep 1
  local t=$(now)
  case "$how" in
    end) printf '{"id":"stop-1","command":{"type":"end","reason":"stopped"}}' > "/tmp/runs/$name/mailbox/stop-1.json" ;;
    term) kill -TERM "$bp" ;;
  esac
  local bg= hg= cg=
  for i in $(seq 1 450); do
    [ -z "$bg" ] && ! kill -0 "$bp" 2>/dev/null && bg=$(( $(now) - t ))
    [ -z "$hg" ] && ! pgrep -f 'muse-bin.*serve' >/dev/null && hg=$(( $(now) - t ))
    if [ "$pat" != HELD ] && [ -z "$cg" ] && ! pgrep -f "$pat" >/dev/null; then cg=$(( $(now) - t )); fi
    [ -n "$bg" ] && [ -n "$hg" ] && { [ "$pat" = HELD ] || [ -n "$cg" ]; } && break
    sleep 0.1
  done
  echo "[$name] $how: bridge gone ${bg:-NOT in 45 s} ms, host gone ${hg:-NOT in 45 s} ms, tool child gone ${cg:-n/a or NOT in 45 s} ms"
  report "$name" | grep -E 'exit:|metered' | cut -c1-300
  pkill -f "$pat" 2>/dev/null; pkill -f 'muse-bin.*serve' 2>/dev/null; true
}
echo "Run this exact command with your shell tool and wait for it: sleep 317" > /tmp/ps.txt
echo "== stop latency, a tool running"
stop_test s1 end /tmp/ps.txt 'sleep 317' "${BASE[@]}"
stop_test s2 term /tmp/ps.txt 'sleep 317' "${BASE[@]}"
echo "== stop latency, a model call open (free)"
mode hang; echo "Reply READY." > /tmp/pr.txt
stop_test s3 term /tmp/pr.txt HELD "${BASE[@]}"
mode forward; echo

echo "== forced compaction: a 30k context limit, several tool turns"
cat > /tmp/pc.txt <<'P'
Use your shell tool for each of these, one at a time: print the numbers 1 to 3000 with seq, then 3001 to 6000, then 6001 to 9000. Then reply DONE.
P
run_bridge c1 /tmp/ws-c1 /tmp/pc.txt 150 "${BASE[@]}" 'context_compaction={"soft_threshold":0.5,"hard_threshold":0.8,"provider_context_limit_tokens":30000}'
report c1 | grep -E 'proxy requests|direct conn|metered|kinds|summed|turns|exit:|bridge notes' | cut -c1-600
node -e '
  const l=require("fs").readFileSync("/tmp/out/c1.bridge.jsonl","utf8").split("\n").filter(Boolean).map(JSON.parse);
  const kinds={}; for (const r of l) { const k=r.params?.item?.kind; if (k) kinds[k]=(kinds[k]||0)+1; }
  console.log("item kinds", JSON.stringify(kinds));
  for (const r of l) if (r.params?.item?.kind==="compaction" && r.method==="item/completed") console.log("compaction item", JSON.stringify(r.params.item).slice(0,300));
'
echo "== the compact command after real history"
label c2; rm -rf "$HOME/.local/share/muse/model-catalog"; mkdir -p /tmp/ws-c2
( cd /tmp/sdk && timeout 100 node /tmp/sdk/compact.mjs /tmp/out/c2.jsonl /tmp/ws-c2 "${BASE[@]}" 'context_compaction={"soft_threshold":0.5,"hard_threshold":0.8,"provider_context_limit_tokens":30000}' ) 2>&1 | tail -2
grep -E '"call":"session/compact"' /tmp/out/c2.jsonl | cut -c1-240
report c2 | grep -E 'proxy requests|metered|kinds' | cut -c1-500; echo

echo "== keeping the key out of the shell"
echo 'Run this exact command with your shell tool and reply with its output: env | grep -c "^META_API_KEY=" ; cat /proc/$PPID/environ | tr "\0" "\n" | grep -c "^META_API_KEY="' > /tmp/pe.txt
for v in 'shell_environment_policy={"exclude":["META_API_KEY"]}'; do
  run_bridge e1 /tmp/ws-e1 /tmp/pe.txt 40 "${BASE[@]}" "$v"
  report e1 | grep -E 'stderr: muse serve: -c|exit:' | cut -c1-400
done
echo "== why the lock did not lock"
BIN=$(ls -1 "$HOME"/.local/bin/muse-bin-* | head -1)
grep -E '^(Cap(Eff|Prm|Inh|Amb|Bnd)|NoNewPrivs|Uid):' /proc/self/status | tr '\n' ' '; echo
sudo -n chown root:root "$BIN"; sudo -n chmod 711 "$BIN"; ls -la "$BIN" | cut -c1-90; head -c 4 "$BIN" | od -c | head -1; head -c 1 /etc/shadow 2>&1 | od -c | head -1 | cut -c1-120
stat -f -c '%T' "$BIN"
sudo -n chown ubuntu:ubuntu "$BIN"; sudo -n chmod 755 "$BIN"
echo "== all refused calls"
grep -h '"refused"' /tmp/out/proxy.jsonl | node -e 'for (const l of require("fs").readFileSync(0,"utf8").split("\n").filter(Boolean)) { const e=JSON.parse(l); console.log(e.label, e.method, e.path, e.model, e.refused); }'
curl -s --noproxy '*' http://127.0.0.1:8787/__health; echo
