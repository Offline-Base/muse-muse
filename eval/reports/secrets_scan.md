# Secrets scan

Command: `uv run python -m scripts.secrets_scan --history --report eval/reports/secrets_scan.md`

Checks every file git tracks or would add, and every added line in git history, for API key shapes, IPv4 addresses (other than loopback and the private ranges' base addresses), home-network host names and this machine's user name. Findings give the place and the kind, never the value.

Findings: 0

