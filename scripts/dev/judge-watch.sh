#!/usr/bin/env bash
# Judging week health check. Public URLs only: it needs no key and reads no env. One model call, about $0.0001, on made-up text.
# Usage: scripts/dev/judge-watch.sh [base-url]
# Options by env: JUDGE_CAP (dollars to warn against, default 100), JUDGE_BUILD_QUOTA (shared guest builds, default 25),
# JUDGE_PRODUCT (a live product's slug, default pack-ready-list). Exits 1 on any FAIL. WARN does not fail it.
set -u
BASE="${1:-https://muse-muse.vercel.app}"
BASE="${BASE%/}"
CAP="${JUDGE_CAP:-100}"
QUOTA="${JUDGE_BUILD_QUOTA:-25}"
PRODUCT="${JUDGE_PRODUCT:-pack-ready-list}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fails=0

ok() { echo "ok    $1"; }
warn() { echo "WARN  $1"; }
fail() { echo "FAIL  $1"; fails=$((fails + 1)); }
status() { curl -s -o /dev/null -m 30 -w '%{http_code}' "$@"; }

# Pages a judge reaches from the sidebar.
for path in / /dashboard /builds /gallery /usage /models /fine-tuning /private /how-it-works /docs/overview /gadgets; do
  code="$(status "$BASE$path")"
  if [ "$code" = 200 ]; then ok "$path"; else fail "$path answered $code"; fi
done

# One live product: its page here and the app itself.
code="$(status "$BASE/p/$PRODUCT")"
if [ "$code" = 200 ]; then ok "/p/$PRODUCT"; else fail "/p/$PRODUCT answered $code"; fi
code="$(status "https://musemuse-$PRODUCT.vercel.app")"
if [ "$code" = 200 ]; then ok "live app $PRODUCT"; else fail "live app $PRODUCT answered $code"; fi

# Routes that must exist and must refuse a stranger. A 503 on a cron means CRON_SECRET is gone.
code="$(status -X POST -H 'content-type: application/json' -d '{}' "$BASE/api/gateway/v1/responses")"
if [ "$code" = 401 ]; then ok "gateway route refuses no token (401)"; else fail "gateway route answered $code, expected 401"; fi
code="$(status "$BASE/api/cron/cleanup")"
if [ "$code" = 401 ]; then ok "cron route refuses no secret (401)"; else fail "cron route answered $code, expected 401"; fi

# One model call through the docs demos, on the cheapest model. Only the status and model are shown.
code="$(curl -s -o /dev/null -D "$TMP/head" -m 90 -w '%{http_code}' -X POST "$BASE/api/docs/v1/responses" \
  -H "origin: $BASE" -H 'content-type: application/json' \
  -d '{"model":"muse-spark-1.3-contributor","input":"Reply with the single word ok.","max_output_tokens":64}')"
model="$(grep -i '^x-docs-model:' "$TMP/head" | tr -d '\r' | cut -d' ' -f2)"
if [ "$code" = 200 ]; then ok "model call answered 200 on ${model:-unknown model}"; else fail "model call answered $code"; fi

# Spend and limits, from the same public numbers any visitor can see.
curl -s -m 30 "$BASE/api/docs/limits" >"$TMP/limits"
curl -s -m 30 "$BASE/usage" >"$TMP/usage"
curl -s -m 30 "$BASE/builds" >"$TMP/builds"
python3 -I - "$TMP" "$CAP" "$QUOTA" <<'PY' || fails=$((fails + 1))
import json, re, sys
from urllib.parse import unquote

tmp, cap, quota = sys.argv[1], float(sys.argv[2]), int(sys.argv[3])
bad = False

try:
    d = json.load(open(f"{tmp}/limits"))
    print(f"{'ok   ' if d.get('live') else 'FAIL '} docs demos live, ${d['docsSpentUsd']:.2f} of ${d['docsDailyCapUsd']:.0f} today")
    bad = bad or not d.get("live")
except Exception:
    print("FAIL  /api/docs/limits did not answer JSON")
    bad = True

m = re.search(r"data:text/csv[^\"]*", open(f"{tmp}/usage").read())
if not m:
    print("FAIL  /usage has no spend table, so the database may be down")
    bad = True
else:
    lines = unquote(m.group(0).replace("&amp;", "&")).split(",", 1)[1].splitlines()
    head, last = lines[0].split(","), lines[-1].split(",")
    spent = sum(float(last[i]) for i, name in enumerate(head) if name.startswith("usd_"))
    level = spent / cap if cap else 1
    word = "FAIL " if level >= 1 else "WARN " if level >= 0.5 else "ok   "
    print(f"{word} {last[0]} UTC spend ${spent:.2f}, {level:.0%} of the ${cap:.0f} cap. Resets 00:00 UTC")
    bad = bad or level >= 1

text = re.sub(r"<script.*?</script>|<[^>]+>", " ", open(f"{tmp}/builds").read(), flags=re.S)
n = len(re.findall(r"\b\d+\s*[mh]\s+ago\b", text))
word = "FAIL " if n >= quota else "WARN " if n >= quota * 0.6 else "ok   "
print(f"{word} shared guest started about {n} builds in 24 h, against a quota of {quota}")
bad = bad or n >= quota
sys.exit(1 if bad else 0)
PY

if grep -qi 'not set up' <(curl -s -m 30 "$BASE/gadgets"); then warn "/gadgets says Not set up"; fi

if [ "$fails" -gt 0 ]; then echo "$fails problem(s)"; exit 1; fi
echo "all good"
