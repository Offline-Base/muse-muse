#!/bin/bash
# Turns the Muse walk video into a transparent loop for the site: one 1.75 s stride (frames 24 to 65), cropped to the
# mascot, white keyed out, neutral greys kept as a soft black shadow. Writes into public/muse/ (or the second argument). Run from the repo root.
set -euo pipefail
S="$(cd "$(dirname "$0")" && pwd)"
W_DIR="${TMPDIR:-/tmp}/muse-mascot"; mkdir -p "$W_DIR"
F="${1:?usage: walk.sh <muse walk video> [out dir]}"
OUT="${2:-public/muse}"
M='min(min(r(X,Y),g(X,Y)),b(X,Y))'
W='(r(X,Y)-b(X,Y))'
SH="lt($W,10)*gt($M,170)"
GEQ="geq=r='if($SH,0,r(X,Y))':g='if($SH,0,g(X,Y))':b='if($SH,0,b(X,Y))':a='if($SH,clip((255-$M)*3-30,0,110),clip((255-$M)*10-70,0,255))'"
VF="trim=start_frame=24:end_frame=66,setpts=PTS-STARTPTS,crop=528:688:330:44,scale=-2:256:flags=lanczos,format=rgba,$GEQ"

# Keyed frames once, as PNGs, so both encoders read the same pixels.
rm -rf "$W_DIR/frames" && mkdir -p "$W_DIR/frames"
ffmpeg -v error -y -i "$F" -an -vf "$VF" "$W_DIR/frames/%03d.png"

ffmpeg -v error -y -framerate 24 -i "$W_DIR/frames/%03d.png" -c:v libvpx-vp9 -pix_fmt yuva420p -b:v 0 -crf 32 -auto-alt-ref 0 -row-mt 1 "$OUT/muse-walk.webm"
ffmpeg -v error -y -framerate 24 -i "$W_DIR/frames/%03d.png" -c:v hevc_videotoolbox -allow_sw 1 -alpha_quality 0.8 -q:v 60 -tag:v hvc1 -pix_fmt bgra "$OUT/muse-walk-hevc.mov"
cp "$W_DIR/frames/001.png" "$OUT/muse-walk.png"
ls -la "$OUT"/muse-walk*
