# Tuning: where the budget scene's time goes. Runs after phase B, on its build and its chosen flags.
export PATH="$HOME/.local/bin:$PATH" NEXT_TELEMETRY_DISABLED=1 FORCE_COLOR=0
mkdir -p /tmp/out/t
cd /vercel/app || exit 9
PORT=3151
(./node_modules/.bin/next start -p $PORT >/tmp/next-start-t.log 2>&1 &)
for i in $(seq 1 60); do curl -s -o /dev/null -m 2 "http://localhost:$PORT/" && break; sleep 1; done
SECONDS=0
node /tmp/spike/phase-b/tune.mjs $PORT 2>&1
echo "tune exit $? in $SECONDS s"
pkill -f "next start -p $PORT" || true; pkill -f "next-server" || true; sleep 1
exit 0
