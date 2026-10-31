# Paid, tiny: the real bridge with questions on. Muse Code asks, the mailbox answers, the turn goes on.
export PATH="$HOME/.local/bin:$PATH" MUSE_NO_AUTO_UPDATE=1 MUSE_LOGIN=0
mkdir -p /tmp/out /tmp/q /vercel/musemuse/bridge
rm -rf /tmp/w-q; mkdir -p /tmp/w-q/.muse; cd /tmp/w-q; git init -q; git -c user.email=s@s -c user.name=s commit -q --allow-empty -m init
cat > brief.md <<'P'
Ask me one multiple choice question with your tool for asking the user: which color should the file say, with options red and blue. Wait for my answer. Then write the chosen color to color.txt and stop. Do nothing else.
P
SID=$(cd /tmp/sdk && node --input-type=module -e 'import {createUuidV7Mint} from "@muse-code/sdk"; console.log(createUuidV7Mint()())')
cp /tmp/spike/bridge.mjs /tmp/sdk/bridge.mjs
cat > /tmp/q/config.json <<J
{"workspace":"/tmp/w-q","sessionId":"$SID","model":"muse-wonder-1.0","reasoningEffort":"low","promptFile":"/tmp/w-q/brief.md","images":[],"goal":null,"settings":["tools.web_search.mode=\"off\"","model_catalog=[{\"model_id\":\"muse-wonder-1.0\",\"provider_id\":\"meta\",\"profile_id\":\"tbh\",\"background_agent_model\":\"muse-wonder-1.0\"}]","runtime_capabilities={\"plugin:tbh-reminders:reminder:skill-reminder\":{\"enabled\":false},\"plugin:tbh-reminders:reminder:goal-reminder\":{\"enabled\":false},\"plugin:tbh-reminders:reminder:verify-reminder\":{\"enabled\":false}}"],"disableRequestUserInput":false,"logPath":"/tmp/out/p4-bridge.jsonl","mailboxDir":"/tmp/q/mailbox","maxModelSteps":12,"idleExitMs":60000}
J
mkdir -p /tmp/q/mailbox
(cd /tmp/sdk && timeout 240 node /tmp/sdk/bridge.mjs /tmp/q/config.json; echo "bridge exit=$?" > /tmp/q/exit) &
for i in $(seq 1 120); do grep -q '"userInput/requested"\|"userInput/request"' /tmp/out/p4-bridge.jsonl 2>/dev/null && break; [ -f /tmp/q/exit ] && break; sleep 1; done
echo "asked after ${i}s"
sleep 75   # A wait past QUIET_MS, as an owner takes their time: the session/read check must not end the turn.
node -e '
const fs=require("fs");const lines=fs.readFileSync("/tmp/out/p4-bridge.jsonl","utf8").trim().split("\n").map(JSON.parse);
const q=lines.filter(l=>l.kind==="note"&&/^userInput\/request/.test(l.method)).pop();
console.log(JSON.stringify(q).slice(0,1200));
const p=q.params;const id=p.userInputId||p.requestId||p.id;const qs=p.questions||[];
const answers=qs.map(x=>({questionId:x.id||x.questionId,selectedLabel:"blue"}));
const env={id:"answer-1",at:new Date().toISOString(),by:"owner",command:{type:"answer",userInputId:id,answers}};
fs.writeFileSync("/tmp/q/mailbox/"+env.at+"-answer-1.json",JSON.stringify(env));console.log("answered",JSON.stringify(env).slice(0,400));
'
for i in $(seq 1 90); do [ -f /tmp/q/exit ] && break; sleep 1; done
cat /tmp/q/exit; echo "color.txt: $(cat /tmp/w-q/color.txt 2>&1)"
node -e '
const fs=require("fs");for(const l of fs.readFileSync("/tmp/out/p4-bridge.jsonl","utf8").trim().split("\n")){const o=JSON.parse(l);if(o.kind==="bridge"||o.kind==="command"||(o.kind==="call"&&(o.method==="session/read"||!o.ok))||(o.kind==="note"&&["turn/started","turn/completed","session/statusChanged"].includes(o.method)))console.log(JSON.stringify(o).slice(0,300))}'
