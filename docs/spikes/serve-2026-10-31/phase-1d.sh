# Free. Looking for the setting behind background_agent_model.
export PATH="$HOME/.local/bin:$PATH" MUSE_NO_AUTO_UPDATE=1 MUSE_LOGIN=0
mkdir -p /tmp/out
B=$(ls "$HOME"/.local/bin/muse-bin-* | head -1)
g() { grep -a -o -E "$1" "$B" | tr -c '[:print:]\n' '.' | sort -u | head -"${2:-12}"; }
echo "-- background_agent_model"; g '.{0,300}background_agent_model.{0,300}' 14 | cut -c1-640
echo "-- model_catalog"; g '.{0,300}model_catalog.{0,300}' 14 | cut -c1-640
echo "-- MODEL CATALOG env"; g 'MUSE_[A-Z_]*(CATALOG|MODEL|MODELS)[A-Z_]*' 30
echo "-- Reminder defaults"; g '.{0,50}ReminderAgentDefaultsV1.{0,400}' 6 | cut -c1-460; g '.{0,400}reminder_reasoning_effort.{0,400}' 8 | cut -c1-800
echo "-- home"; find "$HOME/.cache/muse" "$HOME/.local/state/muse" "$HOME/.config/muse" -maxdepth 3 2>/dev/null | head -30; ls -la "$HOME/.local/share/muse" 2>/dev/null | head -20
muse schema --help 2>&1 | head -12
muse model-profile --help 2>&1 | head -30
cd /tmp; for kv in 'model_catalog={}' 'model_catalog=[]' 'model_catalog="x"' 'reminders={}' 'reminders.model_policy="main"' 'reminders.reasoning_effort="low"' 'background_agent_model="x"' 'providers={}' 'provider_retry.max_retries=2'; do
  timeout 15 muse exec --provider echo --json --yolo -c "$kv" "hi" >/dev/null 2>/tmp/e.err; echo "[-c $kv] exit=$? $(grep -m1 -E 'refusing|invalid|error' /tmp/e.err | cut -c1-220)"
done
