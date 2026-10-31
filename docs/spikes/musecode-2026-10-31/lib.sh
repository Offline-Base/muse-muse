# Shared by the phases. Sourced, never run.
export PATH="$HOME/.local/bin:$PATH" MUSE_NO_AUTO_UPDATE=1 MUSE_LOGIN=0
M=muse-spark-1.3-contributor
EP='http://127.0.0.1:8787/v1'
mkdir -p /tmp/out /tmp/runs
REMINDERS_OFF='runtime_capabilities={"plugin:tbh-reminders:reminder:skill-reminder":{"enabled":false},"plugin:tbh-reminders:reminder:goal-reminder":{"enabled":false},"plugin:tbh-reminders:reminder:verify-reminder":{"enabled":false},"plugin:tbh-reminders:reminder:memory-reminder":{"enabled":false},"plugin:tbh-reminders:reminder:todo-reminder":{"enabled":false},"plugin:tbh-reminders:reminder:scope-reminder":{"enabled":false}}'
WEB_OFF='tools.web_search.mode="off"'
ENDPOINT="endpoint_transport={\"base_url\":\"$EP\",\"auth\":\"bearer\"}"
QUIET_T='telemetry.enabled=false'
QUIET_F='feature_config.enabled=false'

# Sends every non-local HTTPS connection to the CONNECT logger (sink.mjs). Once per sandbox for the start, every phase for the env.
sink_on() {
  if ! curl -s -m 1 -o /dev/null --noproxy '*' http://127.0.0.1:8788/; then
    mkdir -p /tmp/sink
    ( cd /tmp/sink || exit 1
      openssl req -x509 -newkey rsa:2048 -nodes -keyout ca.key -out ca.crt -days 2 -subj /CN=spike-sink-ca >/dev/null 2>&1
      openssl req -newkey rsa:2048 -nodes -keyout leaf.key -out leaf.csr -subj /CN=api.meta.ai >/dev/null 2>&1
      printf 'subjectAltName=DNS:api.meta.ai,IP:%s\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n' "$(hostname -I | awk '{print $1}')" > ext
      openssl x509 -req -in leaf.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 2 -extfile ext -out leaf.crt >/dev/null 2>&1
      cat "${SSL_CERT_FILE:-/etc/ssl/certs/ca-certificates.crt}" ca.crt > bundle.pem
      chmod a+r ./* )
    sudo -n nohup node /tmp/spike/sink.mjs >/tmp/out/sink.out 2>&1 &
    sleep 0.7
  fi
  export SSL_CERT_FILE=/tmp/sink/bundle.pem CURL_CA_BUNDLE=/tmp/sink/bundle.pem
  export HTTPS_PROXY=http://127.0.0.1:8788 https_proxy=http://127.0.0.1:8788 HTTP_PROXY=http://127.0.0.1:8788 http_proxy=http://127.0.0.1:8788 ALL_PROXY=http://127.0.0.1:8788 all_proxy=http://127.0.0.1:8788 NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost
}
label() { echo "$1" > /tmp/proxy-label; }
mode() { echo "$1" > /tmp/proxy-mode; }

# prep_bridge <label> <workspace> <prompt file> [setting ...]. Clears the catalog copy and writes the real bridge's config.
prep_bridge() {
  local name=$1 ws=$2 prompt=$3
  shift 3
  label "$name"
  rm -rf "$HOME/.local/share/muse/model-catalog"
  mkdir -p "$ws"
  rm -rf "/tmp/runs/$name"; mkdir -p "/tmp/runs/$name/mailbox"
  SETTINGS_JSON=$(node -e 'console.log(JSON.stringify(process.argv.slice(1)))' -- "$@")
  node -e '
    const [name, ws, prompt, settings] = process.argv.slice(1);
    const id = (() => { const t = Date.now().toString(16).padStart(12, "0"); const r = crypto.randomUUID().replace(/-/g, ""); return `${t.slice(0,8)}-${t.slice(8)}-7${r.slice(0,3)}-8${r.slice(3,6)}-${r.slice(6,18)}`; })();
    require("fs").writeFileSync(`/tmp/runs/${name}/config.json`, JSON.stringify({ workspace: ws, sessionId: id, model: "muse-spark-1.3-contributor", reasoningEffort: process.env.EFFORT || "low", promptFile: prompt, images: [], goal: null, settings: JSON.parse(settings), disableRequestUserInput: true, logPath: `/tmp/out/${name}.bridge.jsonl`, mailboxDir: `/tmp/runs/${name}/mailbox`, maxModelSteps: Number(process.env.MAX_STEPS || 30), idleExitMs: 4000 }));
  ' "$name" "$ws" "$prompt" "$SETTINGS_JSON"
}
# run_bridge <label> <workspace> <prompt file> <limit s> [setting ...]. Uses the real bridge, to the end.
run_bridge() {
  local name=$1 ws=$2 prompt=$3 limit=$4
  shift 4
  prep_bridge "$name" "$ws" "$prompt" "$@"
  ( cd /tmp/sdk && timeout "$limit" node /tmp/sdk/bridge.mjs "/tmp/runs/$name/config.json" ) >"/tmp/out/$name.bridge.err" 2>&1
  echo "bridge exit $?"
}

# What a run did, read from its logs.
report() { node /tmp/sdk/report.mjs "$1"; }
