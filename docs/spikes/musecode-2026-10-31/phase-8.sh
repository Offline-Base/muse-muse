# Paid, tiny. Task b again with a made-up CSV to read; the same run with nothing but the firewall watching, so a direct call would
# fail rather than land in the CONNECT logger; and a turn with the catalog route refused.
. /tmp/spike/lib.sh
# The ss watch only: no HTTPS_PROXY, so anything direct meets the firewall, which refuses the stand-in.
sink_on
unset HTTPS_PROXY https_proxy HTTP_PROXY http_proxy ALL_PROXY all_proxy NO_PROXY no_proxy SSL_CERT_FILE CURL_CA_BUNDLE
export SSL_CERT_FILE="$NODE_EXTRA_CA_CERTS"
mode forward
export META_API_KEY="$SPIKE_STANDIN"
unset SPIKE_STANDIN SPIKE_KEY_SHA256 SPIKE_PH_SHA256 SPIKE_REFUSED SPIKE_T0_MS SPIKE_SANDBOX_NAME
BASE=("$WEB_OFF" "$REMINDERS_OFF" "$ENDPOINT" "$QUIET_T")
now() { date +%s%3N; }
mkdir -p /tmp/ws-b2
cat > /tmp/ws-b2/people.csv <<'C'
name,email,city
Ada Sample,ada@example.invalid,Springfield
Bo Placeholder,bo@example.invalid,Shelbyville
Cy Madeup,cy@example.invalid,Ogdenville
Di Fictional,di@example.invalid,North Haverbrook
C
echo "Make a small static HTML page that shows the CSV as a sortable table." > /tmp/pb.txt
echo "== task b with a made-up CSV"
B0=$(now); run_bridge t-b2 /tmp/ws-b2 /tmp/pb.txt 200 "${BASE[@]}"; echo "task b2: $(( $(now) - B0 )) ms"
report t-b2 | cut -c1-600; ls -la /tmp/ws-b2
mkdir -p /tmp/out/task-b2; cp /tmp/ws-b2/* /tmp/out/task-b2/ 2>/dev/null
echo "== does the page work, in the sandbox's own Chromium"
ls -d "$HOME"/.cache/ms-playwright/* 2>/dev/null | head -3
PW=$(ls -d /vercel/app/node_modules/playwright /vercel/app/node_modules/@playwright/test /vercel/*/node_modules/playwright "$HOME"/node_modules/playwright /usr/local/lib/node_modules/playwright 2>/dev/null | head -1); echo "playwright: ${PW:-none}"
if [ -n "$PW" ]; then
  cat > /tmp/check.mjs <<'J'
import { createRequire } from "node:module";
import http from "node:http";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
const require = createRequire(process.argv[2] + "/");
const { chromium } = require("playwright");
const dir = "/tmp/ws-b2";
const page0 = readdirSync(dir).find((f) => f.endsWith(".html"));
const srv = http.createServer((q, s) => { try { s.end(readFileSync(path.join(dir, q.url === "/" ? page0 : q.url.slice(1)))); } catch { s.writeHead(404); s.end(); } }).listen(8799);
const b = await chromium.launch({ args: ["--no-proxy-server"] });
const p = await b.newPage();
await p.goto("http://127.0.0.1:8799/");
await p.waitForTimeout(500);
const col = async () => p.$$eval("table tbody tr td:first-child", (e) => e.map((x) => x.textContent.trim()));
const before = await col();
await p.click("table th:first-child");
await p.waitForTimeout(200);
const once = await col();
await p.click("table th:first-child");
await p.waitForTimeout(200);
const twice = await col();
console.log(JSON.stringify({ page0, before, once, twice }));
await b.close(); srv.close();
J
  node /tmp/check.mjs "$(dirname "$PW")" 2>&1 | tail -3 | cut -c1-500
fi
grep -c '<table' /tmp/ws-b2/*.html; grep -c -E 'sort' /tmp/ws-b2/*.html; echo
echo "== a turn with the catalog route refused"
mode nocatalog
echo "Create a file named n.txt containing the word hi, then reply DONE." > /tmp/pn.txt
run_bridge n1 /tmp/ws-n1 /tmp/pn.txt 60 "${BASE[@]}"
report n1 | grep -E 'proxy requests|metered|kinds|summed|turns|exit:' | cut -c1-500; ls /tmp/ws-n1
mode forward
grep -hE '"(session/contextUsage)"' /tmp/out/n1.bridge.jsonl | tail -1 | cut -c1-300
grep -hE '"(session/contextUsage)"' /tmp/out/t-b2.bridge.jsonl | tail -1 | cut -c1-300
echo "== all refused"
grep -h '"refused"' /tmp/out/proxy.jsonl | node -e 'for (const l of require("fs").readFileSync(0,"utf8").split("\n").filter(Boolean)) { const e=JSON.parse(l); console.log(e.label, e.method, e.path, e.model, e.refused); }'
curl -s --noproxy '*' http://127.0.0.1:8787/__health; echo
