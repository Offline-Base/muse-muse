#!/bin/bash
# Turns the owner's three agent clips (Nov 2) into transparent loops for the build room's agents
# (components/mascot/AgentMuse.tsx): the orchestrator, and a sub-agent looking each way.
#
# All three are 896 x 1008 at 24 fps on plain white, 6 s. key_white.py cuts Muse out; one crop (868 x 840 from 24,96, the
# union of where he goes in all three) keeps them at the same scale and on the same floor line; 248 x 240 out (twice the
# Muse mode size). The sub-agent clips end where they start, so they loop whole; the orchestrator ends mid-point, so it
# stops at frame 114, the one closest to its first. VP9 WebM with alpha for Chrome and Firefox, HEVC with alpha for
# Safari, and the first frame as a PNG poster (also what reduced motion shows).
#
# Usage: scripts/dev/mascot/agents.sh <orchestrator.mp4> <sub left.mp4> <sub right.mp4> [out dir, default public/muse]
# PYTHON= a python with numpy, scipy and Pillow (default python3).
set -euo pipefail
OUT="${4:-public/muse}"
PY="${PYTHON:-python3}"
HERE="$(cd "$(dirname "$0")" && pwd)"
W="${TMPDIR:-/tmp}/muse-mascot/agents"; rm -rf "$W"; mkdir -p "$W"

clip() { # <video> <name> <last frame, 1-based>
  local f="$1" name="$2" last="$3"
  mkdir -p "$W/$name/in" "$W/$name/key"
  ffmpeg -v error -y -i "$f" -an -vf "fps=24" -frames:v "$last" "$W/$name/in/%04d.png"
  "$PY" -I "$HERE/key_white.py" "$W/$name/in" "$W/$name/key"
  ffmpeg -v error -y -framerate 24 -i "$W/$name/key/%04d.png" -vf "crop=868:840:24:96,scale=248:240:flags=lanczos,format=rgba" "$W/$name/%04d.png"
  ffmpeg -v error -y -framerate 24 -i "$W/$name/%04d.png" -c:v libvpx-vp9 -pix_fmt yuva420p -b:v 0 -crf 36 -auto-alt-ref 0 -row-mt 1 "$OUT/agent-$name.webm"
  ffmpeg -v error -y -framerate 24 -i "$W/$name/%04d.png" -c:v hevc_videotoolbox -allow_sw 1 -alpha_quality 0.8 -q:v 50 -tag:v hvc1 -pix_fmt bgra "$OUT/agent-$name-hevc.mov"
  cp "$W/$name/0001.png" "$OUT/agent-$name.png"
}

clip "$1" orchestrator 114
clip "$2" sub-left 145
clip "$3" sub-right 145
ls -la "$OUT"/agent-*
