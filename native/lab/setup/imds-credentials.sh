#!/bin/bash
# Gives the aws CLI the instance role's credentials on the Mac. macOS's Local Network privacy check refuses the instance
# metadata address for ec2-user's Homebrew tools ("No route to host"), and only a person at the screen could answer its
# prompt. Apple's own curl isn't subject to it, so ~/.aws/config runs this as its credential_process. It prints the
# credentials only to the CLI that asked.
set -euo pipefail
IMDS="http://169.254.169.254/latest"
TOKEN="$(/usr/bin/curl -fsS -m 5 -X PUT -H "X-aws-ec2-metadata-token-ttl-seconds: 300" "$IMDS/api/token")"
get() { /usr/bin/curl -fsS -m 5 -H "X-aws-ec2-metadata-token: $TOKEN" "$IMDS/meta-data/iam/security-credentials/$1"; }
ROLE="$(get "")"
get "$ROLE" | /opt/homebrew/opt/node@22/bin/node -e '
  let text = "";
  process.stdin.on("data", (chunk) => (text += chunk)).on("end", () => {
    const c = JSON.parse(text);
    console.log(JSON.stringify({ Version: 1, AccessKeyId: c.AccessKeyId, SecretAccessKey: c.SecretAccessKey, SessionToken: c.Token, Expiration: c.Expiration }));
  });
'
