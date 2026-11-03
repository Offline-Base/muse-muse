#!/bin/bash
# The two intro clips from the owner's videos (Nov 2), full frame, no audio (the page washes them out to white, fades
# in, and the walking Muse takes over):
#  "curtain": Muse waves, opens a blue curtain onto a white stage and walks off right, trimmed to 9.4 s;
#  "shades" (the owner's pick): Muse waves, puts on sunglasses, throws a cream curtain open and strolls off right,
#  all 6 s, with the white stage cut out so the curtain opens onto the real page.
# Usage: intro.sh <curtain video> <shades video> [out dir]
set -euo pipefail
A="$1"; B="$2"; OUT="${3:-public/muse}"

ffmpeg -v error -y -i "$A" -t 9.4 -an -vf "scale=1280:-2" -c:v libvpx-vp9 -b:v 0 -crf 36 -row-mt 1 "$OUT/intro-curtain.webm"
ffmpeg -v error -y -i "$A" -t 9.4 -an -vf "scale=1280:-2" -c:v libx264 -crf 26 -preset slow -pix_fmt yuv420p -movflags +faststart "$OUT/intro-curtain.mp4"
ffmpeg -v error -y -i "$A" -vf "select=eq(n\,0),scale=1280:-2" -frames:v 1 -q:v 4 "$OUT/intro-curtain.jpg"

# "shades" is see-through: its white stage is cut out frame by frame (key_stage.py, needs numpy, Pillow and scipy),
# then encoded twice with alpha, VP9 for Chrome and Firefox, HEVC for Safari.
W="$TMPDIR/muse-intro"; rm -rf "$W"; mkdir -p "$W/in"
ffmpeg -v error -y -i "$B" -map 0:v:0 -vf "scale=1280:720" "$W/in/%03d.png"
"${PYTHON:-python3}" -I "$(dirname "$0")/key_stage.py" "$W/in" "$W/out"
ffmpeg -v error -y -framerate 24 -i "$W/out/%03d.png" -c:v libvpx-vp9 -pix_fmt yuva420p -b:v 0 -crf 34 -auto-alt-ref 0 -row-mt 1 "$OUT/intro-shades.webm"
ffmpeg -v error -y -framerate 24 -i "$W/out/%03d.png" -c:v hevc_videotoolbox -allow_sw 1 -alpha_quality 0.8 -q:v 55 -tag:v hvc1 -pix_fmt bgra "$OUT/intro-shades-hevc.mov"
ffmpeg -v error -y -i "$B" -map 0:v:0 -vf "select=eq(n\\,0),scale=1280:-2" -frames:v 1 -q:v 4 "$OUT/intro-shades.jpg"
ls -la "$OUT"/intro-*
