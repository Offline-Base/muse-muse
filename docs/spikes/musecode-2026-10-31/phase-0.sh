# Free. What Muse Code 1.4.14 says about custom endpoints. No model call can leave: the firewall answers them all 403.
export PATH="$HOME/.local/bin:$PATH" MUSE_NO_AUTO_UPDATE=1 MUSE_LOGIN=0
muse --version
BIN=$(readlink -f "$(command -v muse)"); echo "bin $BIN $(wc -c <"$BIN") bytes"; ls -la "$(command -v muse)"; ls -la "$(dirname "$BIN")" | head; file "$BIN" 2>/dev/null | cut -c1-200
ls -la "$HOME/.local/share/muse" 2>/dev/null | head -20
echo "== tools"; for t in strace ss tcpdump lsof sudo curl openssl; do printf '%s ' "$t"; command -v "$t" || echo none; done
sudo -n true && echo "sudo ok"; id
echo "== cert env (names only)"; env | cut -d= -f1 | grep -iE 'cert|ssl|_ca|proxy' ; echo "== env names"; env | cut -d= -f1 | sort | tr '\n' ' '; echo
echo "== muse --help"; muse --help 2>&1 | head -60
echo "== muse serve --help"; muse serve --help 2>&1
echo "== muse schema --help"; muse schema --help 2>&1 | head -40
muse schema > /tmp/out/schema-default.txt 2>&1; echo "schema exit $? $(wc -c </tmp/out/schema-default.txt)"; head -c 600 /tmp/out/schema-default.txt; echo
echo "== strings"
B="$BIN"; [ -f "$B" ] || exit 0
for pat in 'endpoint_transport' 'base_url' 'keyless' 'custom_endpoint' 'custom endpoint' 'muse-code/models' 'v1/responses' 'responses/compact' 'MUSE_[A-Z_]*\(URL\|ENDPOINT\|BASE\|HOST\|KEY\|TOKEN\)[A-Z_]*' 'META_[A-Z_]*\(URL\|ENDPOINT\|BASE\|HOST\|KEY\|TOKEN\)[A-Z_]*' 'api\.meta\.ai' 'env_key' 'wire_api' 'model_providers' 'upstream_url' 'telemetry' ; do
  echo "--- $pat"; grep -a -o ".\{0,140\}$pat.\{0,160\}" "$B" | LC_ALL=C tr -cd '\11\12\15\40-\176' | sort -u | head -24 | cut -c1-320
done
