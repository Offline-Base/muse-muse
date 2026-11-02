#!/bin/bash
# Builds the climbing loop for the site's right edge from the "climbing the right side" video (1168x768, 24 fps):
#  1. frames 187..240, the 54-frame stretch (2.25 s) whose last frame leads most cleanly back into its first, found by
#     comparing every start and length in the steady part of the clip;
#  2. each frame cropped so the wall's left edge sits exactly on the right border, so on the site the window's edge is the
#     wall (the edge drifts as the camera eases in; climb-edges.txt has it per source frame, measured from the top rows);
#  3. white keyed to alpha as in walk.sh (T=0: no cross-fade, which ghosted his face when tried);
#  4. VP9 WebM (Chrome, Firefox) and HEVC (Safari), up and down (down is the same frames reversed).
# Run from the repo root: scripts/dev/mascot/climb.sh <video> [out dir]
set -euo pipefail
S="$(cd "$(dirname "$0")" && pwd)"
W_DIR="${TMPDIR:-/tmp}/muse-mascot"; mkdir -p "$W_DIR"
F="${1:?usage: climb.sh <muse climbing video> [out dir]}"
OUT="${2:-public/muse}"
START=187; L=54; T=0; CW=460; CY=0; CH=768
M='min(min(r(X,Y),g(X,Y)),b(X,Y))'
W='(r(X,Y)-b(X,Y))'
SH="lt($W,10)*gt($M,170)"
GEQ="geq=r='if($SH,0,r(X,Y))':g='if($SH,0,g(X,Y))':b='if($SH,0,b(X,Y))':a='if($SH,clip((255-$M)*3-30,0,110),clip((255-$M)*10-70,0,255))'"

rm -rf "$W_DIR/climb-raw" "$W_DIR/climb-key" "$W_DIR/climb-loop" "$W_DIR/climb-down"
mkdir -p "$W_DIR/climb-raw" "$W_DIR/climb-key" "$W_DIR/climb-loop" "$W_DIR/climb-down"
ffmpeg -v error -y -i "$F" -an -vf "select='between(n,$START,$((START+L+T-1)))'" -vsync 0 -start_number 0 "$W_DIR/climb-raw/%03d.png"

EDGES=( $(cat "$S/climb-edges.txt") )  # one wall-edge x per source frame; see the header
for i in $(seq 0 $((L+T-1))); do
  e=${EDGES[$((START+i))]}
  x=$((e-CW))
  n=$(printf %03d $i)
  ffmpeg -v error -y -i "$W_DIR/climb-raw/$n.png" -vf "crop=$CW:$CH:$x:$CY,scale=-2:300:flags=lanczos,format=rgba,$GEQ" "$W_DIR/climb-key/$n.png"
done

# The loop: frames T..L-1 as they are; frames 0..T-1 fade from frame L+k (what follows the loop's end) into frame k.
for k in $(seq 0 $((L-1))); do
  n=$(printf %03d $k)
  if [ "$k" -lt "$T" ]; then
    a=$(printf %03d $((L+k)))
    wb=$(awk "BEGIN{print ($k+0.5)/$T}")
    ffmpeg -v error -y -i "$W_DIR/climb-key/$a.png" -i "$W_DIR/climb-key/$n.png" -filter_complex "[0][1]blend=all_expr='A*(1-$wb)+B*$wb'" "$W_DIR/climb-loop/$n.png"
  else
    cp "$W_DIR/climb-key/$n.png" "$W_DIR/climb-loop/$n.png"
  fi
done
for k in $(seq 0 $((L-1))); do cp "$W_DIR/climb-loop/$(printf %03d $k).png" "$W_DIR/climb-down/$(printf %03d $((L-1-k))).png"; done

for dir in up down; do
  src="$W_DIR/climb-loop"; [ "$dir" = down ] && src="$W_DIR/climb-down"
  ffmpeg -v error -y -framerate 24 -i "$src/%03d.png" -c:v libvpx-vp9 -pix_fmt yuva420p -b:v 0 -crf 32 -auto-alt-ref 0 -row-mt 1 "$OUT/muse-climb-$dir.webm"
  ffmpeg -v error -y -framerate 24 -i "$src/%03d.png" -c:v hevc_videotoolbox -allow_sw 1 -alpha_quality 0.8 -q:v 60 -tag:v hvc1 -pix_fmt bgra "$OUT/muse-climb-$dir-hevc.mov"
done
cp "$W_DIR/climb-loop/000.png" "$OUT/muse-climb.png"
rm -rf "$W_DIR/climb-raw"
ls -la "$OUT"/muse-climb*
