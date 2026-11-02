#!/bin/bash
# Builds the agent bundle from this folder, puts it in the lab's bucket and pins it in Parameter Store for both lanes, so
# the update-agent action installs it. Run it from a laptop with the lab's AWS profile. The bucket and the pin hold no secret.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# The lab bucket is muse-knowledge-<account id>, with the id read from the profile in use, so it stays out of the repo.
BUCKET="${MUSE_LAB_BUCKET:-muse-knowledge-$(aws sts get-caller-identity --query Account --output text)}"
REGION="${AWS_REGION:-us-east-1}"
BASE="$(node -p "require('$HERE/package.json').version")"
HASH="$(git -C "$HERE" rev-parse --short HEAD 2>/dev/null || echo local)"
VERSION="${1:-$BASE-$HASH}"
FILE="$(mktemp)"
trap 'rm -f "$FILE"' EXIT
# COPYFILE_DISABLE keeps macOS's ._ files out of the tarball.
COPYFILE_DISABLE=1 tar -czf "$FILE" --exclude __tests__ --exclude node_modules -C "$HERE" .
SHA="$(shasum -a 256 "$FILE" | cut -d' ' -f1)"
KEY="lab/bundles/musemuse-lab-$VERSION.tgz"
aws s3 cp --only-show-errors --region "$REGION" "$FILE" "s3://$BUCKET/$KEY"
PIN="{\"version\":\"$VERSION\",\"url\":\"s3://$BUCKET/$KEY\",\"sha256\":\"$SHA\"}"
for LANE in mac windows; do
  aws ssm put-parameter --region "$REGION" --name "/musemuse/lab/$LANE/bundle" --type String --overwrite --value "$PIN" >/dev/null
done
echo "$PIN"
