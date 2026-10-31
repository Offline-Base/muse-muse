# Free: the echo provider runs a real host with no model. session/read and view/page shapes, then session/resume.
export PATH="$HOME/.local/bin:$PATH" MUSE_NO_AUTO_UPDATE=1 MUSE_LOGIN=0
mkdir -p /tmp/out
rm -rf /tmp/w-echo; mkdir -p /tmp/w-echo/.muse; cd /tmp/w-echo; git init -q; git -c user.email=s@s -c user.name=s commit -q --allow-empty -m init
cd /tmp/sdk
SID=$(cd /tmp/sdk && node --input-type=module -e 'import {createUuidV7Mint} from "@muse-code/sdk"; console.log(createUuidV7Mint()())')
echo "session $SID"
SESSION_ID=$SID WS=/tmp/w-echo WAIT_S=15 SERVE_ARGS="serve --provider echo --disable-sandbox --trust-workspace --disable-request-user-input" SETTING='tools.web_search.mode="off"' timeout 60 node /tmp/sdk/msp-host-probe.mjs /tmp/out/p2-echo.jsonl echo; echo "echo exit=$?"
SESSION_ID=$SID WS=/tmp/w-echo WAIT_S=15 SERVE_ARGS="serve --provider echo --disable-sandbox --trust-workspace --disable-request-user-input" SETTING='tools.web_search.mode="off"' PROMPT="second" timeout 60 node /tmp/sdk/msp-host-probe.mjs /tmp/out/p2-resume.jsonl resume; echo "resume exit=$?"
ls ~/.local/share/muse/sessions/*/*/*/ 2>/dev/null | head

echo "== exec and serve resuming each other's sessions, by id version"
v7() { (cd /tmp/sdk && node --input-type=module -e 'import {createUuidV7Mint} from "@muse-code/sdk"; console.log(createUuidV7Mint()())'); }
SERVE="serve --provider echo --disable-sandbox --trust-workspace --disable-request-user-input"
execrun() { (cd /tmp/w-echo && timeout 30 muse exec --provider echo --json --yolo --session-id "$1" "hello" >/tmp/e.out 2>/tmp/e.err; echo "exec $2 session $1 exit=$? $(tail -c 200 /tmp/e.err | tr '\n' ' ')"); }
V4=$(node -p 'crypto.randomUUID()'); V7=$(v7)
execrun "$V4" v4; execrun "$V7" v7
SESSION_ID=$V4 WS=/tmp/w-echo WAIT_S=8 SERVE_ARGS="$SERVE" PROMPT=x timeout 50 node /tmp/sdk/msp-host-probe.mjs /tmp/out/p2-exec-v4-resume.jsonl resume
SESSION_ID=$V7 WS=/tmp/w-echo WAIT_S=8 SERVE_ARGS="$SERVE" PROMPT=x timeout 50 node /tmp/sdk/msp-host-probe.mjs /tmp/out/p2-exec-v7-resume.jsonl resume
grep -m1 '"session/resume"' /tmp/out/p2-exec-v4-resume.jsonl | cut -c1-300
grep -m1 '"session/resume"' /tmp/out/p2-exec-v7-resume.jsonl | cut -c1-300
SV7=$(v7)
SESSION_ID=$SV7 WS=/tmp/w-echo WAIT_S=8 SERVE_ARGS="$SERVE" PROMPT=x timeout 50 node /tmp/sdk/msp-host-probe.mjs /tmp/out/p2-serve-first.jsonl echo
execrun "$SV7" "resuming-serve-v7"
SESSION_ID=$SV7 WS=/tmp/w-echo WAIT_S=8 SERVE_ARGS="$SERVE" PROMPT=y timeout 50 node /tmp/sdk/msp-host-probe.mjs /tmp/out/p2-serve-after-exec.jsonl resume
grep -m1 '"session/resume"' /tmp/out/p2-serve-after-exec.jsonl | cut -c1-300
