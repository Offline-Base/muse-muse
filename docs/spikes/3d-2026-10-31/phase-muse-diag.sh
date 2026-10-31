# Phase muse-diag: why Meta answered 401 in run 2. Free calls only: the two GET routes the build firewall brokers, sent
# through proxy.mjs (which adds the placeholder), and the same with no placeholder, which the firewall itself must refuse.
set -u
echo diag > /tmp/proxy-label
for p in /muse-code/models /v1/models; do
  echo "via proxy GET $p: $(curl -s -m 20 -H "Authorization: Bearer $SPIKE_STANDIN" -o /tmp/diag.body -w '%{http_code}' "http://127.0.0.1:8787$p") $(head -c 160 /tmp/diag.body | tr '\n' ' ')"
done
echo "direct, no placeholder, GET /v1/models: $(curl -s -m 20 -o /tmp/diag.body -w '%{http_code}' https://api.meta.ai/v1/models) $(head -c 120 /tmp/diag.body)"
echo "direct, stand-in, GET /v1/models: $(curl -s -m 20 -H "Authorization: Bearer $SPIKE_STANDIN" -o /tmp/diag.body -w '%{http_code}' https://api.meta.ai/v1/models) $(head -c 120 /tmp/diag.body)"
grep '"label":"diag"' /tmp/out/proxy.jsonl | cut -c1-500
exit 0
