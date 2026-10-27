#!/bin/sh
# ExecStartPre for muse-privacy-glimmer.service: writes LORA_ARGS for llama-server.
# With a router adapter on disk, llama-server loads it without applying it, so the router can turn
# it on per request (or adapter_sync.sh can turn it on for all requests). Without one, no LoRA.
set -eu

ADAPTER="${MUSE_ADAPTER:-/var/lib/muse-privacy/adapters/router.gguf}"
OUT="${MUSE_GLIMMER_ENV:-/var/lib/muse-privacy/glimmer.env}"

if [ -f "$ADAPTER" ]; then
  printf 'LORA_ARGS="--lora %s --lora-init-without-apply"\n' "$ADAPTER" > "$OUT.tmp"
else
  printf 'LORA_ARGS=\n' > "$OUT.tmp"
fi
mv -f "$OUT.tmp" "$OUT"
