# Free, and the first pass. Which forms of the custom endpoint does Muse Code take? The proxy refuses everything and the firewall
# answers every direct call 403. Its results are in results/p1 (on the first sink, which /etc/hosts being read-only made blind).
. /tmp/spike/lib.sh
mode refuse
sink_on
echo "Reply with the word READY." > /tmp/prompt.txt
cases() {
  local name=$1; shift
  run_bridge "$name" "/tmp/ws-$name" /tmp/prompt.txt 40 "$WEB_OFF" "$REMINDERS_OFF" "$@"
  report "$name"; echo
}
export META_API_KEY="$SPIKE_STANDIN"
echo "== control: no custom endpoint"; cases c0-control
echo "== base_url alone, with a key"; cases c1-base "endpoint_transport.base_url=\"$EP\""
echo "== base_url and auth=bearer"; cases c2-bearer "$ENDPOINT"
echo "== base_url and auth=bearer, telemetry and feature config off"; cases c3-quiet "$ENDPOINT" "$QUIET_T" "$QUIET_F"
unset META_API_KEY
echo "== keyless: base_url alone, no key anywhere"; cases c4-keyless "endpoint_transport.base_url=\"$EP\"" "$QUIET_T" "$QUIET_F"
export META_API_KEY="$SPIKE_STANDIN"
echo "== a wrong key must refuse loudly"; cases c5-wrongkey "endpoint_transport.nope=1"
