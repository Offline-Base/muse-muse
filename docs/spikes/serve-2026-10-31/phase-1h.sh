# Free. On a resumed session, does the catalog row still hold for the reminder agents? Model calls are answered 403.
export PATH="$HOME/.local/bin:$PATH" MUSE_NO_AUTO_UPDATE=1 MUSE_LOGIN=0
mkdir -p /tmp/out /tmp/hooks
cat > /tmp/hooks/log.mjs <<'H'
import { readFileSync, appendFileSync } from "node:fs";
const o = JSON.parse(readFileSync(0, "utf8") || "{}");
appendFileSync("/tmp/out/prellm-h.jsonl", JSON.stringify({ case: process.env.CASE_NAME || process.argv[2], model: o.model, tools: o.tool_count, reminder: /reminder observer/.test(JSON.stringify(o.messages?.[0]?.content?.[0]?.text ?? "")) }) + "\n");
H
M=muse-wonder-1.0
ROW="model_catalog=[{\"model_id\":\"$M\",\"provider_id\":\"meta\",\"profile_id\":\"tbh\",\"background_agent_model\":\"$M\"}]"
BASE="serve --disable-sandbox --trust-workspace --disable-request-user-input --model $M"
v7() { (cd /tmp/sdk && node --input-type=module -e 'import {createUuidV7Mint} from "@muse-code/sdk"; console.log(createUuidV7Mint()())'); }
ws() { rm -rf "$1"; mkdir -p "$1/.muse" && cd "$1" && git init -q && git -c user.email=s@s -c user.name=s commit -q --allow-empty -m init; printf '{"hooks":{"PreLLMCall":[{"hooks":[{"type":"command","command":"node /tmp/hooks/log.mjs %s"}]}]}}' "$2" > .muse/hooks.json; }
hookname() { printf '{"hooks":{"PreLLMCall":[{"hooks":[{"type":"command","command":"node /tmp/hooks/log.mjs %s"}]}]}}' "$2" > "$1/.muse/hooks.json"; }
cat > /tmp/sdk/resume.mjs <<'J'
// node resume.mjs <out> : resume SESSION_ID with or without modelId (RESUME_MODEL), optionally session/setModel (SET_MODEL), then a turn.
import { spawnMspConnection, createUuidV7Mint } from "@muse-code/sdk";
import { appendFileSync } from "node:fs";
const out = process.argv[2]; const log = (o) => appendFileSync(out, JSON.stringify(o) + "\n");
const args = process.env.SERVE_ARGS.split(" "); args.push("-c", process.env.SETTING);
const hs = spawnMspConnection({ command: "muse", args, cwd: process.env.WS, env: process.env, onStderr: (c) => log({ stderr: String(c).slice(0, 400) }), shutdownTimeoutMs: 6000 });
hs.onNotification((n) => { if (n.method === "turn/completed") log({ completed: n.params?.terminal }); }); hs.onServerRequest(async () => ({})); hs.onProtocolError(() => {});
const s = await hs.initialize({ clientInfo: { name: "p", version: "0" } }); const c = s.connection; const m = createUuidV7Mint(); const sessionId = process.env.SESSION_ID;
const req = async (method, params) => { try { const r = await c.request(method, params); log({ method, ok: true, keys: Object.keys(r ?? {}), model: r?.session?.modelId }); return r; } catch (e) { log({ method, ok: false, error: String(e).slice(0, 300) }); } };
await req("session/resume", { commandId: m(), sessionId, excludeItems: true, ...(process.env.RESUME_MODEL ? { modelId: process.env.RESUME_MODEL } : {}) });
if (process.env.SET_MODEL) await req("session/setModel", { commandId: m(), sessionId, modelId: process.env.SET_MODEL });
await req("turn/start", { commandId: m(), sessionId, input: [{ type: "text", text: "Reply OK." }], ifBusy: "queue" });
await new Promise((r) => setTimeout(r, 5000));
await hs.close().catch(() => {});
J
first() { # a first round with the row, then a resume variant
  local name=$1 resumeModel=$2 setModel=$3
  ws "/tmp/h-$name" "$name-first"; local SID=$(v7); cd /tmp/sdk
  SESSION_ID=$SID WS="/tmp/h-$name" WAIT_S=4 MODEL=$M SETTING="$ROW" SERVE_ARGS="$BASE" timeout 30 node /tmp/sdk/msp-host-probe.mjs "/tmp/out/p1h-$name-1.jsonl" tools
  hookname "/tmp/h-$name" "$name-resumed"
  SESSION_ID=$SID WS="/tmp/h-$name" RESUME_MODEL="$resumeModel" SET_MODEL="$setModel" SETTING="$ROW" SERVE_ARGS="$BASE" timeout 30 node /tmp/sdk/resume.mjs "/tmp/out/p1h-$name-2.jsonl"
  echo "[$name] resumeModel=[$resumeModel] setModel=[$setModel]"; cut -c1-260 "/tmp/out/p1h-$name-2.jsonl" | grep -E '"ok":false|setModel' | head -4
  grep -E "\"case\":\"$name-(first|resumed)\"" /tmp/out/prellm-h.jsonl | sort -u | cut -c1-140
}
first with-model "$M" ""
first no-model "" ""
first set-model "" "$M"
echo "== exec resuming with the row"
ws /tmp/h-exec exec-first; SID=$(v7); timeout 30 muse exec --json --yolo --disable-web-tools --model $M --max-model-steps 2 --session-id "$SID" -c "$ROW" "Reply OK." >/dev/null 2>/tmp/e.txt
hookname /tmp/h-exec exec-resumed; cd /tmp/h-exec; timeout 30 muse exec --json --yolo --disable-web-tools --model $M --max-model-steps 2 --session-id "$SID" -c "$ROW" "Reply OK." >/dev/null 2>/tmp/e.txt
grep -E '"case":"exec-' /tmp/out/prellm-h.jsonl | sort -u | cut -c1-140
