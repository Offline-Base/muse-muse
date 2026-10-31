# Phase A: a bare three.js page with IWER. Four flag sets in both Chromium builds. Network: npm only.
export PATH="$HOME/.local/bin:$PATH" NPM_CONFIG_UPDATE_NOTIFIER=false
mkdir -p /tmp/out/a /tmp/xa
echo "== A0 machine"
cat /vercel/musemuse/builder.json; echo; uname -a; nproc; free -m | head -2; lscpu | grep -E 'Model name|Flags' | cut -c1-200; whoami; echo "HOME=$HOME"
ls -la "$HOME/.cache/ms-playwright" 2>&1; ls /dev/dri 2>&1 | head -3
echo "== A1 network"
curl -s -o /dev/null -m 10 -w "npm %{http_code}\n" https://registry.npmjs.org/three/latest
curl -s -o /dev/null -m 10 -w "unpkg %{http_code}\n" https://unpkg.com/three || echo "unpkg blocked (curl exit $?)"
echo "== A2 install"
cd /tmp/xa && cp -r /tmp/spike/phase-a/. . && npm init -y >/dev/null
npm install --no-audit --no-fund --loglevel=error --save-exact three@0.184.0 iwer@2.7.0 2>&1 | tail -2
du -sh node_modules
(node server.mjs 3199 >/tmp/xa/server.log 2>&1 &)
sleep 1; curl -s -o /dev/null -w "page %{http_code}\n" http://localhost:3199/
echo "== A3 matrix"
SECONDS=0
node matrix.mjs 2>&1
echo "matrix exit $? in $SECONDS s"
pkill -f "server.mjs 3199" || true
