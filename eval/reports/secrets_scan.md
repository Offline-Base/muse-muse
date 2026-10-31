# Secrets scan

Command: `uv run python -m scripts.secrets_scan --history --report eval/reports/secrets_scan.md`

Checks every file git tracks or would add, and every added line in git history, for API key shapes (Modal tokens included), long values assigned to this project's secret names (META_API_KEY, OPENROUTER_API_KEY, JETSON_LFM_API_KEY, CHECKER_API_KEY, HEAVY_TOKEN and others), Cloudflare tokens, 32-hex ids in wrangler configs, real values in .env.example, IPv4 addresses (other than loopback, the documentation ranges and the private ranges' base addresses), home-network host names and this machine's user name. In the invented data (demo/, eval/, tests/fixtures/, current files only) it also checks that phones use 555-01xx, emails use example domains, SSNs start with 9 or 000 and card numbers are test numbers. Findings give the place and the kind, never the value.

Findings: 1

- history b76a8a4 tests/test_model_matrix.py:111: ip address
