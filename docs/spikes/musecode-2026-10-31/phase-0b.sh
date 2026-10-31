# Free. The rest of the help, the real binary's strings, the wire schema's method list. All model calls refused by the firewall.
export PATH="$HOME/.local/bin:$PATH" MUSE_NO_AUTO_UPDATE=1 MUSE_LOGIN=0 LC_ALL=C
BIN=$(ls -1 "$HOME"/.local/bin/muse-bin-* | head -1); echo "bin $BIN"
echo "== muse --help, rest"; muse --help 2>&1 | sed -n '60,200p'
echo "== muse exec --help (base url lines)"; muse exec --help 2>&1 | grep -n -i -A2 -E 'base-url|contributor|provider' | head -30
echo "== config --help"; muse config --help 2>&1 | head -30
echo "== launcher env"; grep -n -oE '\b(MUSE|META)_[A-Z_]+' "$HOME/.local/bin/muse" | cut -d: -f2 | sort -u | tr '\n' ' '; echo
muse schema generate-json-schema --out /tmp/schema >/dev/null 2>&1; ls -la /tmp/schema | head -20
mkdir -p /tmp/out/schema; cp /tmp/schema/*methods* /tmp/out/schema/ 2>/dev/null
find /tmp/schema -maxdepth 1 -type f | head -30
echo "== strings"
grep -a -o -E '[[:print:]]{6,400}' "$BIN" > /tmp/strings.txt 2>/dev/null; wc -l /tmp/strings.txt
for pat in 'endpoint_transport' 'base_url' 'keyless' 'custom.endpoint' 'muse-code/models' '/v1/responses' 'responses/compact' 'MUSE_[A-Z_]*(URL|ENDPOINT|BASE|HOST|KEY|TOKEN)[A-Z_]*' 'META_[A-Z_]*(URL|ENDPOINT|BASE|HOST|KEY|TOKEN)[A-Z_]*' 'api\.meta\.ai' 'muse.meta.ai|meta\.ai/' 'api_key_env|env_key|wire_api' 'upstream_url' 'telemetry\.' 'TRANSPORT_TRACE' 'MUSE_TELEMETRY|OTEL_' 'background_agent_model' 'contributor_mode' 'auto_compact|compact_threshold|compaction\.'; do
  echo "--- $pat"; grep -E -o ".{0,120}($pat).{0,160}" /tmp/strings.txt | sort -u | head -30 | cut -c1-300
done
