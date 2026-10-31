# Paid, tiny. The first real call through the proxy: one short turn, reminders off. Proxy budget set by the runner.
. /tmp/spike/lib.sh
sink_on
mode forward
SHA=$SPIKE_KEY_SHA256
export META_API_KEY="$SPIKE_STANDIN"
unset SPIKE_STANDIN SPIKE_KEY_SHA256 SPIKE_PH_SHA256
echo "Reply with the word READY and nothing else." > /tmp/prompt.txt
run_bridge f1-ready /tmp/ws-f1 /tmp/prompt.txt 60 "$WEB_OFF" "$REMINDERS_OFF" "$ENDPOINT" "$QUIET_T"
report f1-ready
grep -E '"label":"f1-ready"' /tmp/out/proxy.jsonl | cut -c1-800
grep -h 'session/tokenUsage' /tmp/out/f1-ready.bridge.jsonl | cut -c1-1200
curl -s --noproxy '*' http://127.0.0.1:8787/__health; echo
