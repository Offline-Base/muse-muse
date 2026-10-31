# Free. The page from task b clicked properly, the catalog path under a path prefix, whether the bearer goes to a real-looking host
# with and without the auth pin, and what max_output_tokens Muse Code asks for. Nothing is forwarded.
. /tmp/spike/lib.sh
sink_on
mode refuse
export META_API_KEY="$SPIKE_STANDIN"
IP=$(hostname -I | awk '{print $1}'); echo "vm address $IP"
export NO_PROXY="127.0.0.1,localhost,$IP" no_proxy="127.0.0.1,localhost,$IP"
echo "Reply READY." > /tmp/pr.txt
try() {
  local name=$1; shift
  run_bridge "$name" "/tmp/ws-$name" /tmp/pr.txt 25 "$WEB_OFF" "$REMINDERS_OFF" "$QUIET_T" "$@"
  sleep 1
  report "$name" | grep -E 'proxy requests|direct connections|exit:|stderr: muse serve: -c' | cut -c1-520
  echo
}
echo "== a path prefix, as the gateway has: /api/gateway/v1"
try b1 "endpoint_transport={\"base_url\":\"http://127.0.0.1:8787/api/gateway/v1\",\"auth\":\"bearer\"}"
echo "== no trailing /v1"
try b2 "endpoint_transport={\"base_url\":\"http://127.0.0.1:8787/api/gateway\",\"auth\":\"bearer\"}"
echo "== https to a non-loopback host, auth pinned"
try b3 "endpoint_transport={\"base_url\":\"https://$IP:8443/api/gateway/v1\",\"auth\":\"bearer\"}"
echo "== https to a non-loopback host, no pin"
try b4 "endpoint_transport.base_url=\"https://$IP:8443/api/gateway/v1\""
echo "== http to a non-loopback host, auth pinned"
try b5 "endpoint_transport={\"base_url\":\"http://$IP:8443/api/gateway/v1\",\"auth\":\"bearer\"}"
echo "== a dotted pin"
try b6 "endpoint_transport.base_url=\"https://$IP:8443/api/gateway/v1\"" 'endpoint_transport.auth="bearer"'
grep -h '"label":"b1"' /tmp/out/proxy.jsonl | grep POST | cut -c1-520
echo "== the page from task b, in the sandbox's Chromium"
mkdir -p /tmp/ws-p; cp /tmp/spike/page-b2.txt /tmp/ws-p/index.html
cat > /tmp/check.mjs <<'J'
import { createRequire } from "node:module";
import http from "node:http";
import { readFileSync } from "node:fs";
const require = createRequire("/vercel/app/node_modules/@playwright/test/");
const { chromium } = require("playwright");
const srv = http.createServer((q, s) => s.end(readFileSync("/tmp/ws-p/index.html"))).listen(8799);
const b = await chromium.launch({ args: ["--no-proxy-server"] });
const p = await b.newPage();
await p.goto("http://127.0.0.1:8799/");
const col = async (n) => p.$$eval(`table tbody tr td:nth-child(${n})`, (e) => e.map((x) => x.textContent.trim()));
const out = { before: await col(3) };
await p.click("table th:nth-child(3) button");
out.cityUp = await col(3);
await p.click("table th:nth-child(3) button");
out.cityDown = await col(3);
await p.click("table th:nth-child(1) button");
await p.click("table th:nth-child(1) button");
out.nameDown = await col(1);
console.log(JSON.stringify(out));
await b.close(); srv.close();
J
env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy -u ALL_PROXY -u all_proxy node /tmp/check.mjs 2>&1 | tail -3 | cut -c1-500
