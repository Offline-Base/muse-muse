#!/bin/bash
# After the runner sets the firewall to deny-all: every host setup used must now be unreachable, from curl and from Python.
set -uo pipefail
OUT=/tmp/out
mkdir -p "$OUT"
fail=0
for url in https://pypi.org/simple/ https://download.pytorch.org/whl/cpu/ https://ossci-datasets.s3.amazonaws.com/mnist/ \
  https://github.com/ https://huggingface.co/ https://registry.npmjs.org/ https://api.meta.ai/v1/models; do
  code=$(curl -s -o /dev/null -m 8 -w '%{http_code}' "$url"; echo " exit $?")
  echo "curl $url -> $code"
  case "$code" in
    000*) ;;
    *) fail=1 ;;
  esac
done
/tmp/rep/venv/bin/python - <<'PY' || fail=1
import urllib.request
ok = True
for url in ("https://pypi.org/simple/", "https://huggingface.co/"):
    try:
        urllib.request.urlopen(url, timeout=8)
        print("python", url, "REACHED")
        ok = False
    except Exception as e:
        print("python", url, "->", type(e).__name__)
raise SystemExit(0 if ok else 1)
PY
echo "egress closed: $([ $fail = 0 ] && echo yes || echo NO)" | tee "$OUT/closed.txt"
exit $fail
