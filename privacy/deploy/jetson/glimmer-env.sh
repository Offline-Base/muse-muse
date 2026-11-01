#!/bin/sh
# ExecStartPre for muse-privacy-glimmer.service: writes GLIMMER_GGUF and LORA_ARGS for llama-server.
# The model is the last GLIMMER_GGUF= line of the site settings (install.sh --model-file writes it),
# else the i1-IQ1_S file; a missing model file stops the start here with a plain message.
# With a router adapter on disk, llama-server loads it without applying it, so the router can turn
# it on per request (or adapter_sync.sh can turn it on for all requests). Without one, no LoRA.
set -eu

ADAPTER="${MUSE_ADAPTER:-/var/lib/muse-privacy/adapters/router.gguf}"
OUT="${MUSE_GLIMMER_ENV:-/var/lib/muse-privacy/glimmer.env}"
SITE="${MUSE_SITE_ENV:-/etc/muse-privacy/env}"
DEFAULT_MODEL="${MUSE_DEFAULT_MODEL:-/opt/muse-privacy/models/Muse-Glimmer-30B.i1-IQ1_S.gguf}"

# Read from the file, not this process's environment: glimmer.env from the last start is loaded
# into it too, and would otherwise keep an old model after the site settings change.
MODEL="$( (sed -n 's/^GLIMMER_GGUF=//p' "$SITE" 2>/dev/null || true) | tail -n 1 | tr -d '"')"
[ -n "$MODEL" ] || MODEL="$DEFAULT_MODEL"
case "$MODEL" in
  /*.gguf) ;;
  *) echo "glimmer-env.sh: GLIMMER_GGUF must be an absolute path to a .gguf file" >&2; exit 1 ;;
esac
if [ ! -f "$MODEL" ]; then
  echo "glimmer-env.sh: no model at $MODEL (see deploy/jetson/README.md)" >&2
  exit 1
fi

printf 'GLIMMER_GGUF=%s\n' "$MODEL" > "$OUT.tmp"
if [ -f "$ADAPTER" ]; then
  printf 'LORA_ARGS="--lora %s --lora-init-without-apply"\n' "$ADAPTER" >> "$OUT.tmp"
else
  printf 'LORA_ARGS=\n' >> "$OUT.tmp"
fi
mv -f "$OUT.tmp" "$OUT"
