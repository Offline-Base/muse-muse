# Free. The sink now reads the direct calls, so each one has a method and path. Model calls are still refused.
. /tmp/spike/lib.sh
sink_on
mode catalog
echo "Reply with the word READY." > /tmp/prompt.txt
cases() {
  local name=$1; shift
  run_bridge "$name" "/tmp/ws-$name" /tmp/prompt.txt 40 "$@"
  sleep 2
  report "$name" | grep -E 'proxy requests|direct connections|turns:|exit:|stderr'; echo
}
export META_API_KEY="$SPIKE_STANDIN"
ROW="model_catalog=[{\"model_id\":\"$M\",\"provider_id\":\"meta\",\"profile_id\":\"tbh\",\"background_agent_model\":\"$M\"}]"
echo "== control, no custom endpoint"; cases e0-control "$WEB_OFF" "$REMINDERS_OFF"
echo "== endpoint, everything else at its default"; cases e1-endpoint "$WEB_OFF" "$REMINDERS_OFF" "$ENDPOINT"
echo "== endpoint, telemetry off"; cases e2-tele "$WEB_OFF" "$REMINDERS_OFF" "$ENDPOINT" "$QUIET_T"
echo "== endpoint, feature config off"; cases e3-feat "$WEB_OFF" "$REMINDERS_OFF" "$ENDPOINT" "$QUIET_F"
echo "== endpoint, both off"; cases e4-quiet "$WEB_OFF" "$REMINDERS_OFF" "$ENDPOINT" "$QUIET_T" "$QUIET_F"
echo "== endpoint, both off, web tools at their default"; cases e5-web "$REMINDERS_OFF" "$ENDPOINT" "$QUIET_T" "$QUIET_F"
echo "== endpoint, both off, reminders on, the contributor catalog row (the trap)"; cases e6-row "$WEB_OFF" "$ENDPOINT" "$QUIET_T" "$QUIET_F" "$ROW"
echo "== endpoint, both off, reminders on, no row"; cases e7-norow "$WEB_OFF" "$ENDPOINT" "$QUIET_T" "$QUIET_F"
grep -hE '"label":"e[67]-' /tmp/out/proxy.jsonl | node -e 'for (const l of require("fs").readFileSync(0,"utf8").split("\n").filter(Boolean)) { const e=JSON.parse(l); if (e.method==="POST") console.log(e.label, e.path, e.model, "size", e.size, "tools", JSON.stringify(e.toolKinds), "instr", e.instrSha, e.instrLen, e.effort); }'
echo "== exec: --base-url alone"
label e8-exec; rm -rf "$HOME/.local/share/muse/model-catalog"; mkdir -p /tmp/ws-e8; cd /tmp/ws-e8
timeout 40 muse exec --json --yolo --disable-web-tools --model $M --reasoning-effort low --max-model-steps 2 --base-url "$EP" -c "$QUIET_T" -c "$QUIET_F" -c "$REMINDERS_OFF" "Reply READY." 2>&1 | tail -n 3 | cut -c1-300; echo "exit $?"
report e8-exec | grep -E 'proxy requests|direct connections'
