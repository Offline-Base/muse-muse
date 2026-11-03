#!/bin/bash
# Turns the owner's talking clip into the plan card's transparent loop (components/build/PlanCard.tsx, PLAN_TALK):
# frames 0 to 239 (the clip loops on its own), cropped to the card's box at 424 x 480 (twice its widest, 240 px), the off-white keyed out the way
# walk.sh does it (neutral light greys become a soft black shadow, warm fur stays solid). VP9 WebM with alpha for Chrome
# and Firefox, HEVC with alpha for Safari, and the first frame as a PNG poster.
# Usage: scripts/dev/mascot/talk.sh <video> [out dir, default public/muse]
set -euo pipefail
F="$1"; OUT="${2:-public/muse}"
W="${TMPDIR:-/tmp}/muse-mascot/talk"; rm -rf "$W"; mkdir -p "$W"
M='min(min(r(X,Y),g(X,Y)),b(X,Y))'
D='(r(X,Y)-b(X,Y))'
SH="lt($D,10)*gt($M,170)"
GEQ="geq=r='if($SH,0,r(X,Y))':g='if($SH,0,g(X,Y))':b='if($SH,0,b(X,Y))':a='if($SH,clip((255-$M)*3-30,0,110),clip((255-$M)*10-70,0,255))'"
ffmpeg -v error -y -i "$F" -an -vf "trim=start_frame=0:end_frame=240,setpts=PTS-STARTPTS,crop=846:960:57:0,scale=424:480:flags=lanczos,format=rgba,$GEQ" "$W/%03d.png"
ffmpeg -v error -y -framerate 24 -i "$W/%03d.png" -c:v libvpx-vp9 -pix_fmt yuva420p -b:v 0 -crf 38 -auto-alt-ref 0 -row-mt 1 "$OUT/muse-talk.webm"
ffmpeg -v error -y -framerate 24 -i "$W/%03d.png" -c:v hevc_videotoolbox -allow_sw 1 -alpha_quality 0.8 -q:v 45 -tag:v hvc1 -pix_fmt bgra "$OUT/muse-talk-hevc.mov"
cp "$W/001.png" "$OUT/muse-talk.png"
ls -la "$OUT"/muse-talk*
