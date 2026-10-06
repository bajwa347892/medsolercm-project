#!/usr/bin/env bash
# Usage: scripts/sheet.sh <in.mp4> <out.png> [every_n_frames=3] [cols=4]
# Contact sheet of a rendered clip; each tile is labelled with its index in the clip.
set -euo pipefail
n="${3:-3}"; c="${4:-4}"
ffmpeg -v error -y -i "$1" -vf "select='not(mod(n,$n))',scale=480:-2,drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:text='%{n}':x=6:y=6:fontsize=20:fontcolor=yellow:box=1:boxcolor=black@0.6,tile=${c}x4" -frames:v 1 -vsync vfr "$2"
