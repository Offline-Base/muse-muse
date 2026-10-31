# Free. Compaction settings that a small session can reach, the keyless model rewrite, keeping the key out of the shell, and locking
# the binary. Nothing is forwarded except the catalog.
. /tmp/spike/lib.sh
sink_on
mode catalog
export META_API_KEY="$SPIKE_STANDIN"
BASE=("$WEB_OFF" "$REMINDERS_OFF" "$ENDPOINT" "$QUIET_T")
echo "Reply with the word READY." > /tmp/prompt.txt
try() {
  local name=$1; shift
  run_bridge "$name" "/tmp/ws-$name" /tmp/prompt.txt 25 "$@"
  report "$name" | grep -E 'proxy requests|stderr: muse serve: -c|exit:' | cut -c1-420
  echo
}
echo "== compaction settings, each alone"
try h1 "${BASE[@]}" 'context_compaction.provider_context_limit_tokens=30000'
try h2 "${BASE[@]}" 'context_compaction={"soft_threshold":0.5,"hard_threshold":0.8}'
try h3 "${BASE[@]}" 'context_compaction={"soft_threshold":20000,"hard_threshold":28000}'
try h4 "${BASE[@]}" 'context_compaction={"strategy":"summarize"}'
try h5 "${BASE[@]}" 'context_compaction={"strategy":"nope"}'
echo "== the keyless rewrite"
unset META_API_KEY
try k1 "$WEB_OFF" "$REMINDERS_OFF" "endpoint_transport={\"base_url\":\"$EP\",\"auth\":\"none\"}" "$QUIET_T"
try k2 "$WEB_OFF" "$REMINDERS_OFF" "endpoint_transport={\"base_url\":\"$EP\",\"auth\":\"none\"}" "$QUIET_T" 'contributor_mode_enabled=true' 'contributor_mode_disclosure_acknowledged=true'
try k3 "$WEB_OFF" "$REMINDERS_OFF" "endpoint_transport={\"base_url\":\"$EP\",\"auth\":\"none\",\"http_headers\":{\"x-session-token\":\"spike\"}}" "$QUIET_T" 'contributor_mode_enabled=true'
export META_API_KEY="$SPIKE_STANDIN"
echo "== strings about the shell tool's environment"
BIN=$(ls -1 "$HOME"/.local/bin/muse-bin-* | head -1)
LC_ALL=C grep -a -o -E '[[:print:]]{0,100}(shell_env|env_policy|shell\.env|inherit_env|environment_policy|scrub_env|env_clear|env_allow)[[:print:]]{0,120}' "$BIN" | sort -u | head -12 | cut -c1-240
LC_ALL=C grep -a -o -E '[[:print:]]{0,60}"?auth"? *(must|=|:)[[:print:]]{0,160}' "$BIN" | grep -iE 'endpoint|bearer|none' | sort -u | head -8 | cut -c1-260
LC_ALL=C grep -a -o -E 'bearer[[:print:]]{0,3}none[[:print:]]{0,60}|none[[:print:]]{0,3}bearer[[:print:]]{0,60}' "$BIN" | sort -u | head -5
echo "== sudo policy"; sudo -n -l 2>&1 | tail -4 | cut -c1-200; sudo -n ls -la /etc/sudoers.d 2>&1 | tail -6; mount | grep -E ' / | /etc' | head -5 | cut -c1-200
echo "== locking the binary: root owned, execute only"
sudo -n chown root:root "$BIN" && sudo -n chmod 711 "$BIN"; ls -la "$BIN" | cut -c1-120
cat "$BIN" 2>&1 | head -c 0; cat "$BIN" >/dev/null 2>/tmp/e; echo "cat as ubuntu: exit $? $(cut -c1-120 /tmp/e)"
cp "$BIN" /tmp/copy 2>/tmp/e; echo "cp as ubuntu: exit $? $(cut -c1-120 /tmp/e)"
muse --version 2>&1 | head -2
try l1 "${BASE[@]}"
( cd /tmp/ws-l1; muse exec --help >/dev/null 2>&1; echo "exec help $?" )
echo "while serving, is the running binary readable through /proc?"
( cd /tmp/sdk && timeout 12 muse serve --disable-sandbox --trust-workspace </dev/zero >/dev/null 2>&1 & )
sleep 2; P=$(pgrep -f 'muse-bin.*serve' | head -1); echo "pid ${P:-none}"
[ -n "$P" ] && { ls -la "/proc/$P/exe" 2>&1 | cut -c1-120; cat "/proc/$P/exe" 2>&1 >/dev/null | cut -c1-120; echo "cat exe exit ${PIPESTATUS[0]}"; }
echo "== taking sudo away"
for f in $(sudo -n ls /etc/sudoers.d 2>/dev/null); do sudo -n rm -f "/etc/sudoers.d/$f" 2>&1 | cut -c1-160; done
sudo -n deluser ubuntu sudo 2>&1 | tail -1 | cut -c1-160
sudo -n true 2>&1 | cut -c1-160; echo "sudo after: exit ${PIPESTATUS[0]}"
