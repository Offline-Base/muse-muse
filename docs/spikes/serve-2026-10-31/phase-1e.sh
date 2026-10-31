# Free. Does a settings model_catalog row move the reminder agents off muse-spark-1.3? Model calls are answered 403.
export PATH="$HOME/.local/bin:$PATH" MUSE_NO_AUTO_UPDATE=1 MUSE_LOGIN=0
mkdir -p /tmp/out /tmp/hooks
cat > /tmp/hooks/log.mjs <<'H'
import { readFileSync, appendFileSync } from "node:fs";
const o = JSON.parse(readFileSync(0, "utf8") || "{}");
appendFileSync("/tmp/out/prellm-e.jsonl", JSON.stringify({ case: process.argv[2], model: o.model, tools: o.tool_count, effort: o.options?.["meta.reasoning.effort"], reminder: /reminder observer/.test(JSON.stringify(o.messages?.[0]?.content?.[0]?.text ?? "")) }) + "\n");
H
ws() { rm -rf "$1"; mkdir -p "$1/.muse" && cd "$1" && git init -q && git -c user.email=s@s -c user.name=s commit -q --allow-empty -m init; printf '{"hooks":{"PreLLMCall":[{"hooks":[{"type":"command","command":"node /tmp/hooks/log.mjs %s"}]}]}}' "$2" > .muse/hooks.json; }
BASE="serve --disable-sandbox --trust-workspace --disable-request-user-input --model muse-wonder-1.0"
serve() {
  local name=$1 setting=$2
  ws "/tmp/e-$name" "$name"; cd /tmp/sdk
  WS="/tmp/e-$name" WAIT_S=5 MODEL=muse-wonder-1.0 SETTING="$setting" SERVE_ARGS="$BASE" timeout 30 node /tmp/sdk/msp-host-probe.mjs "/tmp/out/p1e-$name.jsonl" tools
  echo "[$name] exit=$?"
  grep -h -E 'stderr' "/tmp/out/p1e-$name.jsonl" | grep -iE 'catalog|malformed|refusing' | cut -c1-500 | head -3
  grep "\"case\":\"$name\"" /tmp/out/prellm-e.jsonl | cut -c1-160 | sort -u
  node -e 'for(const l of require("fs").readFileSync(process.argv[1],"utf8").split("\n")){if(!l)continue;const o=JSON.parse(l);if(o.call==="session/start"&&!o.ok)console.log("  start failed",o.error)}' "/tmp/out/p1e-$name.jsonl"
}
ROW='"provider_id":"meta","profile_id":"tbh"'
serve a "model_catalog=[{\"model_id\":\"muse-wonder-1.0\",$ROW,\"background_agent_model\":\"muse-wonder-1.0\"}]"
serve b "model_catalog=[{\"model_id\":\"muse-wonder-1.0\",$ROW,\"background_agent_model\":\"muse-spark-1.3-contributor\"}]"
ALLR='{"plugin:tbh-reminders:reminder:skill-reminder":{"enabled":true},"plugin:tbh-reminders:reminder:goal-reminder":{"enabled":true},"plugin:tbh-reminders:reminder:verify-reminder":{"enabled":true},"plugin:tbh-reminders:reminder:memory-reminder":{"enabled":true},"plugin:tbh-reminders:reminder:todo-reminder":{"enabled":true},"plugin:tbh-reminders:reminder:scope-reminder":{"enabled":true}}'
echo "== exec with the row"; ws /tmp/e-x execrow; timeout 40 muse exec --json --yolo --disable-web-tools --disable-request-user-input --model muse-wonder-1.0 --reasoning-effort high --max-model-steps 2 --session-id "$(node -p 'crypto.randomUUID()')" -c "runtime_capabilities=$ALLR" -c "model_catalog=[{\"model_id\":\"muse-wonder-1.0\",$ROW,\"background_agent_model\":\"muse-spark-1.3-contributor\"}]" "Reply OK." >/dev/null 2>/tmp/e.txt; echo "exit $?"; grep -iE 'catalog|refusing' /tmp/e.txt | cut -c1-300; grep '"case":"execrow"' /tmp/out/prellm-e.jsonl | cut -c1-160 | sort -u
cd /tmp/sdk; ws /tmp/e-list listrow; cd /tmp/sdk
cat > /tmp/sdk/modellist.mjs <<'H'
import { spawnMspConnection, createUuidV7Mint } from "@muse-code/sdk";
const args = ["serve","--disable-sandbox","--model","muse-wonder-1.0","-c",process.env.SETTING];
const hs = spawnMspConnection({ command: "muse", args, cwd: "/tmp/e-list", env: process.env, onStderr: () => {} });
hs.onNotification(()=>{}); hs.onServerRequest(async()=>({})); hs.onProtocolError(()=>{});
const s = await hs.initialize({ clientInfo: { name: "p", version: "0" } });
const m = createUuidV7Mint(); const id = m();
await s.connection.request("session/start",{commandId:m(),sessionId:id,workspaceRoot:"/tmp/e-list",approvalMode:"allowAll",modelId:"muse-wonder-1.0"});
const r = await s.connection.request("model/list",{sessionId:id});
console.log(JSON.stringify((r.models||[]).filter(x=>x.modelId==="muse-wonder-1.0")));
await hs.close();
H
SETTING="model_catalog=[{\"model_id\":\"muse-wonder-1.0\",$ROW,\"background_agent_model\":\"muse-spark-1.3-contributor\"}]" timeout 20 node /tmp/sdk/modellist.mjs | cut -c1-900
