#!/bin/bash
# Two intro clips from the owner's videos (Nov 2):
#  A "curtain": Muse waves, opens a blue curtain onto a white stage and walks off right. Full frame, trimmed to 9.4 s,
#     no audio (the page fades it out and the walking Muse takes over).
#  B "hello": Muse on white, blinking, smiling and gesturing. White keyed to alpha like walk.sh, so it sits on either theme.
# Usage: intro.sh <curtain video> <hello video> [out dir]
set -euo pipefail
A="$1"; B="$2"; OUT="${3:-public/muse}"
W="$TMPDIR/muse-intro"; rm -rf "$W"; mkdir -p "$W/hello"

ffmpeg -v error -y -i "$A" -t 9.4 -an -vf "scale=1280:-2" -c:v libvpx-vp9 -b:v 0 -crf 36 -row-mt 1 "$OUT/intro-curtain.webm"
ffmpeg -v error -y -i "$A" -t 9.4 -an -vf "scale=1280:-2" -c:v libx264 -crf 26 -preset slow -pix_fmt yuv420p -movflags +faststart "$OUT/intro-curtain.mp4"
ffmpeg -v error -y -i "$A" -vf "select=eq(n\,0),scale=1280:-2" -frames:v 1 -q:v 4 "$OUT/intro-curtain.jpg"

M='min(min(r(X,Y),g(X,Y)),b(X,Y))'
SH="lt((r(X,Y)-b(X,Y)),10)*gt($M,170)"
GEQ="geq=r='if($SH,0,r(X,Y))':g='if($SH,0,g(X,Y))':b='if($SH,0,b(X,Y))':a='if($SH,clip((255-$M)*3-30,0,110),clip((255-$M)*10-70,0,255))'"
ffmpeg -v error -y -i "$B" -map 0:v:0 -an -vf "crop=960:840:0:60,scale=-2:400:flags=lanczos,format=rgba,$GEQ" "$W/hello/%03d.png"
ffmpeg -v error -y -framerate 24 -i "$W/hello/%03d.png" -c:v libvpx-vp9 -pix_fmt yuva420p -b:v 0 -crf 34 -auto-alt-ref 0 -row-mt 1 "$OUT/muse-hello.webm"
ffmpeg -v error -y -framerate 24 -i "$W/hello/%03d.png" -c:v hevc_videotoolbox -allow_sw 1 -alpha_quality 0.8 -q:v 55 -tag:v hvc1 -pix_fmt bgra "$OUT/muse-hello-hevc.mov"
cp "$W/hello/001.png" "$OUT/muse-hello.png"
ls -la "$OUT"/intro-curtain.* "$OUT"/muse-hello*
