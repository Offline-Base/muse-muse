# Free. The CONNECT logger now sees direct connections. Proxy forwards the real catalog, and model calls are still refused.
. /tmp/spike/lib.sh
sink_on
mode catalog
echo "Reply with the word READY." > /tmp/prompt.txt
cases() {
  local name=$1; shift
  run_bridge "$name" "/tmp/ws-$name" /tmp/prompt.txt 40 "$@"
  report "$name"; echo
}
export META_API_KEY="$SPIKE_STANDIN"
echo "== control: no custom endpoint. Every direct connection should show here, or HTTPS_PROXY is ignored"
cases d0-control "$WEB_OFF" "$REMINDERS_OFF"
echo "== endpoint, telemetry and feature config at their defaults"
cases d1-endpoint "$WEB_OFF" "$REMINDERS_OFF" "$ENDPOINT"
echo "== endpoint, telemetry and feature config off"
cases d2-quiet "$WEB_OFF" "$REMINDERS_OFF" "$ENDPOINT" "$QUIET_T" "$QUIET_F"
echo "== endpoint, reminders at their defaults"
cases d3-reminders "$WEB_OFF" "$ENDPOINT" "$QUIET_T" "$QUIET_F"
echo "== endpoint, auth none and no key"
unset META_API_KEY
cases d4-authnone "$WEB_OFF" "$REMINDERS_OFF" "endpoint_transport={\"base_url\":\"$EP\",\"auth\":\"none\"}" "$QUIET_T" "$QUIET_F"
export META_API_KEY="$SPIKE_STANDIN"
echo "== catalog: what comes back for the Contributor model"
curl -s -m 10 http://127.0.0.1:8787/muse-code/models -H "Authorization: Bearer $META_API_KEY" > /tmp/out/catalog.json
node -e '
  const c = JSON.parse(require("fs").readFileSync("/tmp/out/catalog.json","utf8"));
  const rows = c.models ?? c.data ?? c;
  for (const r of rows) console.log(JSON.stringify({ id: r.model_id ?? r.id, background_agent_model: r.background_agent_model, context: r.context_limit, output: r.output_limit, hidden: r.is_hidden, efforts: (r.reasoning_effort_variants ?? []).map?.((v) => v.effort ?? v) }));
' 2>&1 | head -12
echo "== model-catalog copy in home"; ls -la "$HOME/.local/share/muse/" | head; ls -la "$HOME/.local/share/muse/local-tracing" 2>/dev/null | head -5
