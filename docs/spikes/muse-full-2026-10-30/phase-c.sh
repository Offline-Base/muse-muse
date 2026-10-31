# Phase C: the real build firewall. Tiny paid runs on muse-spark-1.3-contributor at low effort.
export PATH="$HOME/.local/bin:$PATH" MUSE_NO_AUTO_UPDATE=1 MUSE_LOGIN=0
mkdir -p /tmp/out /tmp/spike/hooks
uuid() { node -p 'crypto.randomUUID()'; }
ws() { rm -rf "$1"; mkdir -p "$1/.muse" && cd "$1" && git init -q && git -c user.email=s@s -c user.name=s commit -q --allow-empty -m init; }
run() { # run <name> <steps> <prompt> [extra flags...]
  local name=$1 steps=$2 prompt=$3; shift 3
  timeout 300 muse exec --json --yolo --disable-web-tools --disable-request-user-input --model muse-spark-1.3-contributor --reasoning-effort low --max-model-steps "$steps" --session-id "$(uuid)" "$@" "$prompt" >/tmp/out/c-$name.jsonl 2>/tmp/out/c-$name.err
  echo "[$name] exit=$?"; grep -E 'Hooks:|hooks.json|MCP|mcp|warn|error' /tmp/out/c-$name.err | head -8
  node -e 'let t="";for(const l of require("fs").readFileSync(process.argv[1],"utf8").split("\n")){try{const o=JSON.parse(l);const p=o.payload||o;if(p.payload_type==="run.terminal.completed")t=JSON.stringify(p).slice(0,600);if(p.payload_type==="run.usage")console.log("usage:",JSON.stringify(p).slice(0,400))}catch{}}console.log("final:",t)' /tmp/out/c-$name.jsonl
}
cat > /tmp/spike/hooks/context.sh <<'H'
#!/bin/sh
/bin/cat > /dev/null
printf '%s' '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"Platform note: the codeword is PINEAPPLE."}}'
H
cat > /tmp/spike/hooks/deny.sh <<'H'
#!/bin/sh
IN=$(/bin/cat)
case "$IN" in *protected.txt*) printf '%s' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"protected.txt belongs to the platform; leave it alone."}}';; esac
H
cat > /tmp/spike/hooks/stop.sh <<'H'
#!/bin/sh
/bin/cat > /dev/null
if [ ! -f /tmp/c-stop/.blocked-once ]; then : > /tmp/c-stop/.blocked-once; printf '%s' '{"decision":"block","reason":"Before you stop, create the file stop.txt containing GATED."}'; fi
H
cat > /tmp/spike/hooks/save.sh <<'H'
#!/bin/sh
[ -f /tmp/out/c-prellm.json ] || /bin/cat > /tmp/out/c-prellm.json
H
chmod +x /tmp/spike/hooks/*.sh
hooks() { node -e 'const [f,...pairs]=process.argv.slice(1);const h={};for(const p of pairs){const[e,cmd,m]=p.split("|");(h[e]??=[]).push({...(m?{matcher:m}:{}),hooks:[{type:"command",command:cmd}]})}require("fs").writeFileSync(f,JSON.stringify({hooks:h},null,2))' "$@"; }

echo "== C0 config keys, checked on the free echo provider"
ws /tmp/c-echo
for kv in 'agents.execution_capacity=6' 'feature_config.enabled=["todo_reminder","memory_reminder","skill_reminder","goal_reminder","verify_reminder","scope_reminder"]' 'runtime_capabilities={"plugin:tbh-reminders:reminder:todo-reminder":{"enabled":true}}' 'max_consecutive_stop_hook_continuations=3' 'not_a_real_key=1'; do
  timeout 60 muse exec --provider echo --json --yolo -c "$kv" "hi" >/dev/null 2>/tmp/e.err; echo "[-c $kv] exit=$? $(tr '\n' ' ' </tmp/e.err | head -c 300)"
done

echo "== C1 PostToolUse adds context (the steering channel); PreLLMCall saves the tool list"
ws /tmp/c-context; hooks .muse/hooks.json "PostToolUse|/tmp/spike/hooks/context.sh|.*" "PreLLMCall|/tmp/spike/hooks/save.sh"
run context 4 "Run the shell command ls exactly once. Then reply with the codeword if a tool result or a platform note gave you one, otherwise reply NONE." --disable-reminders

echo "== C2 PreToolUse denies a protected file"
ws /tmp/c-deny; echo original > protected.txt; git add -A; git -c user.email=s@s -c user.name=s commit -qm p; hooks .muse/hooks.json "PreToolUse|/tmp/spike/hooks/deny.sh|.*"
run deny 4 "Overwrite the file protected.txt with the text CHANGED, then reply with what happened." --disable-reminders
echo "protected.txt now: $(cat /tmp/c-deny/protected.txt)"

echo "== C3 Stop hook blocks once, so the agent does more work (a verify gate)"
ws /tmp/c-stop; hooks .muse/hooks.json "Stop|/tmp/spike/hooks/stop.sh"
run stop 6 "Reply with the word READY." --disable-reminders
echo "stop.txt: $(cat /tmp/c-stop/stop.txt 2>&1)"

echo "== C4 live session over muse serve: goal, then a steer mid-turn, with workspace trust"
ws /tmp/c-live; hooks .muse/hooks.json "SessionStart|/bin/sh -c ': > /tmp/c-live/session-start-ran'"
cd /tmp/sdk && WS=/tmp/c-live SERVE_ARGS="serve --disable-sandbox --trust-workspace" MODEL=muse-spark-1.3-contributor \
  OBJECTIVE="Using the shell, run sleep 8, then create the file goal.txt containing OK. The goal is complete when goal.txt exists and contains OK." \
  STEER="Also create the file steer.txt containing STEERED before you finish." \
  timeout 400 node /tmp/sdk/msp-probe.mjs /tmp/out/msp-c.jsonl live; echo "probe exit=$?"
echo "goal.txt: $(cat /tmp/c-live/goal.txt 2>&1) | steer.txt: $(cat /tmp/c-live/steer.txt 2>&1) | session-start hook: $(ls /tmp/c-live/session-start-ran 2>&1)"
node -e 'for(const l of require("fs").readFileSync("/tmp/out/msp-c.jsonl","utf8").trim().split("\n")){const o=JSON.parse(l);if(o.call)console.log("CALL",o.call,o.ok?"ok":"ERR",JSON.stringify(o.ok?o.result:{e:o.error,k:o.kind,d:o.data}).slice(0,300));else if(o.note&&!/delta/.test(o.note.method))console.log("NOTE",o.note.method,JSON.stringify(o.note.params?.item?.kind??o.note.params?.goal??o.note.params?.status??"").slice(0,160))}' | head -70

echo "== C5 a real workflow with one read-only child"
ws /tmp/c-wf
run wf 8 "Use a workflow with exactly one read-only child agent that runs the shell command echo WORKFLOW-OK and returns its output. When the workflow finishes, reply with the child's output."
grep -oE '"owner_type":"[a-z_]+"' $(find "$HOME/.local/share/muse/sessions" -name session.jsonl -newer /tmp/c-wf/.git/HEAD | head -5) 2>/dev/null | sort | uniq -c

echo "== C6 one subagent with worktree isolation"
ws /tmp/c-sub
run sub 10 "Spawn exactly one subagent with worktree isolation. Its task: create the file child.txt containing CHILD and commit it. Wait for it to finish, then reply with the commit id it reports and where its worktree is."
git -C /tmp/c-sub worktree list; git -C /tmp/c-sub log --all --oneline | head -5

echo "== C7 a project .mcp.json server"
ws /tmp/c-mcp; cp /tmp/spike/mcp-spike.mjs /tmp/c-mcp/mcp-spike.mjs
printf '%s' '{"mcpServers":{"spike":{"command":"node","args":["/tmp/c-mcp/mcp-spike.mjs"]}}}' > .mcp.json
run mcp 4 "Call the spike_ping tool from the spike MCP server and reply with exactly what it returned." --disable-reminders
