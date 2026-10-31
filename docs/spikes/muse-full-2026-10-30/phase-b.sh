# Phase B: only the model catalog is brokered; model calls get the firewall's 403, so nothing is billed.
export PATH="$HOME/.local/bin:$PATH" MUSE_NO_AUTO_UPDATE=1 MUSE_LOGIN=0
mkdir -p /tmp/out /tmp/hookspike/.muse /tmp/hookspike/markers && cd /tmp/hookspike
[ -d .git ] || { git init -q && git -c user.email=s@s -c user.name=s commit -q --allow-empty -m init; }
echo "catalog: $(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $META_API_KEY" https://api.meta.ai/muse-code/models)  responses: $(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $META_API_KEY" https://api.meta.ai/v1/responses)"
# A guess at the hooks.json shape (Claude Code's); hook/list below shows whether Muse Code parsed it.
node -e '
const ev=["SessionStart","UserPromptSubmit","PreLLMCall","PostLLMCall","PreToolUse","PostToolUse","PostToolBatch","Stop","StopFailure","SessionEnd","SubagentStart","SubagentStop"];
const c=e=>`/bin/sh -c "/bin/cat > /tmp/hookspike/markers/${e}.json; /usr/bin/env | /usr/bin/cut -d= -f1 | /usr/bin/sort > /tmp/hookspike/markers/${e}.env"`;
require("fs").writeFileSync("/tmp/hookspike/.muse/hooks.json",JSON.stringify({hooks:Object.fromEntries(ev.map(e=>[e,[{matcher:".*",hooks:[{type:"command",command:c(e)}]}]]))},null,2))'
HELP=$(muse exec --help 2>&1); flag() { grep -Eq -- "(^|[^A-Za-z0-9_-])$1([^A-Za-z0-9_-]|\$)" <<<"$HELP" && printf '%s ' "$1"; }
EXTRA="$(flag --disable-reminders)"
echo "== B1 exec with the guessed hooks (extra: $EXTRA)"
SID=$(node -p 'crypto.randomUUID()')
timeout 150 muse exec --json --yolo --disable-web-tools $EXTRA --model muse-spark-1.3-contributor --reasoning-effort low --max-model-steps 1 --session-id "$SID" "Reply OK." >/tmp/out/b1.jsonl 2>/tmp/out/b1.err; echo "exit=$?"
echo "markers: $(ls markers | tr '\n' ' ')"; for f in markers/*.json; do echo "== $f"; head -c 700 "$f"; echo; done
echo "-- env seen by hooks: $(tr '\n' ' ' < markers/SessionStart.env 2>/dev/null)"
grep -iE 'hook|warn|invalid|malformed|trust|capacity' /tmp/out/b1.err | head -20
grep -oE '"payload_type":"[^"]+"' /tmp/out/b1.jsonl | sort | uniq -c
echo "== B2 model profile and workflows with the catalog reachable"
muse model-profile show muse-wonder-1.0 --effort high 2>&1 | head -80
muse workflows list 2>&1 | head -20
echo "== B3 muse serve over the SDK"
SHELP=$(muse serve --help 2>&1); sflag() { grep -Eq -- "(^|[^A-Za-z0-9_-])$1([^A-Za-z0-9_-]|\$)" <<<"$SHELP" && printf '%s ' "$1"; }
export SERVE_ARGS="serve $(sflag --disable-sandbox)$(sflag --disable-web-tools)"
echo "serve args: $SERVE_ARGS"
export WS=/tmp/hookspike MODEL=muse-spark-1.3-contributor OBJECTIVE="Reply OK."
rm -f markers/*
cd /tmp/sdk && timeout 120 node /tmp/sdk/msp-probe.mjs /tmp/out/msp-b.jsonl list; echo "probe exit=$?"; cd /tmp/hookspike
echo "markers after serve: $(ls markers | tr '\n' ' ')"
node -e '
for (const l of require("fs").readFileSync("/tmp/out/msp-b.jsonl","utf8").trim().split("\n")) {
  const o = JSON.parse(l);
  if (o.call) console.log("CALL", o.call, o.ok ? "ok" : "ERR", JSON.stringify(o.ok ? o.result : {error:o.error, code:o.code, kind:o.kind, data:o.data}).slice(0, 1500));
  else if (o.note) console.log("NOTE", o.note.method, JSON.stringify(o.note.params ?? {}).slice(0, 300));
  else if (o.stderr) console.log("STDERR", o.stderr.slice(0, 400).replace(/\n/g, " | "));
  else console.log(Object.keys(o).filter(k => k !== "t").join(","), JSON.stringify(o).slice(0, 600));
}' 2>&1 | head -120
