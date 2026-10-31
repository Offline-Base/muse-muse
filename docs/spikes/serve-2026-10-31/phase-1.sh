# Free. The firewall answers 403 to model calls, so a PreLLMCall hook shows exactly what each setting offers the model.
export PATH="$HOME/.local/bin:$PATH" MUSE_NO_AUTO_UPDATE=1 MUSE_LOGIN=0
mkdir -p /tmp/out /tmp/hooks
cat /vercel/musemuse/builder.json 2>/dev/null | head -20 || true
muse --version; uname -m
cat > /tmp/hooks/save.sh <<'H'
#!/bin/sh
/bin/cat > "/tmp/out/prellm-$CASE_NAME.json.tmp"
[ -f "/tmp/out/prellm-$CASE_NAME.json" ] || cp "/tmp/out/prellm-$CASE_NAME.json.tmp" "/tmp/out/prellm-$CASE_NAME.json"
rm -f "/tmp/out/prellm-$CASE_NAME.json.tmp"
H
chmod +x /tmp/hooks/save.sh
ws() { rm -rf "$1"; mkdir -p "$1/.muse" && cd "$1" && git init -q && git -c user.email=s@s -c user.name=s commit -q --allow-empty -m init; }
one() { # one <name> <setting or empty>
  local name=$1 setting=$2
  ws "/tmp/w-$name"
  printf '{"hooks":{"PreLLMCall":[{"hooks":[{"type":"command","command":"/bin/sh -c '"'"'CASE_NAME=%s /tmp/hooks/save.sh'"'"'"}]}]}}' "$name" > .muse/hooks.json
  cd /tmp/sdk
  SETTING="$setting" WS="/tmp/w-$name" WAIT_S=25 MODEL=muse-wonder-1.0 SERVE_ARGS="serve --disable-sandbox --trust-workspace --disable-request-user-input --model muse-wonder-1.0" \
    timeout 80 node /tmp/sdk/msp-host-probe.mjs "/tmp/out/p1-$name.jsonl" tools
  echo "[$name] setting=[$setting] probe exit=$?"
  grep -m3 -E 'fatal|protocolError|"ok":false' "/tmp/out/p1-$name.jsonl" | cut -c1-500
  if [ -f "/tmp/out/prellm-$name.json" ]; then
    node -e 'const o=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const names=(o.tools||[]).map(t=>typeof t==="string"?t:(t.name||t.function?.name||t.type||JSON.stringify(t).slice(0,60)));console.log("  tools",names.length,JSON.stringify(names));' "/tmp/out/prellm-$name.json"
  else echo "  no PreLLMCall fired"; fi
}
one default ""
one off 'tools.web_search.mode="off"'
one hosted 'tools.web_search.mode="hosted"'
one client 'tools.web_search.mode="client"'
one bogus 'tools.web_search.mode="bogus"'
echo "== serve refusal of an unknown key and of a bare value"
ws /tmp/w-x
for kv in 'tools.web_search.nope="off"' 'tools.web_search.mode=off'; do
  echo '{}' | timeout 15 muse serve --disable-sandbox -c "$kv" >/tmp/o.txt 2>/tmp/e.txt; echo "[-c $kv] exit=$? $(tr '\n' ' ' </tmp/e.txt | head -c 300)"
done
