#!/bin/bash
# Checks every file on this drive against SHA256SUMS. Double-click it in Finder. It reads the files and changes nothing.

cd "$(dirname "$0")" || exit 1
# Where to write about a drive that fails, as the drive's own support/model.tsv says it.
CONTACT="reply to the email your invoice came from"
if [ -f support/model.tsv ]; then
  while IFS=$'\t' read -r key value; do
    if [ "$key" = "contact" ] && [ -n "$value" ]; then CONTACT="$value"; fi
  done < support/model.tsv
fi
# How much there is to read: the sizes of the files SHA256SUMS lists.
BYTES=0
while read -r _sum path; do
  size="$(stat -f %z "$path" 2>/dev/null)"
  case "$size" in '' | *[!0-9]*) size=0 ;; esac
  BYTES=$((BYTES + size))
done < SHA256SUMS
GB=$(((BYTES + 500000000) / 1000000000))
# At 45 to 90 MB/s, as a USB drive reads.
echo "Checking every file on this drive against SHA256SUMS."
echo "Reading about $GB GB from a USB drive takes $((BYTES / 5400000000 + 1)) to $((BYTES / 2700000000 + 1)) minutes."
echo ""
if shasum -a 256 -c SHA256SUMS; then
  echo ""
  echo "PASS: every file matches its checksum."
else
  echo ""
  echo "FAIL: the files marked FAILED above don't match. Copy nothing from this drive. For a new one, $CONTACT."
fi
echo ""
read -r -p "Press Return to close this window. " _ || true
