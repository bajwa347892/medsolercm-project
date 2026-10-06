#!/usr/bin/env bash
# Usage: scripts/clip.sh <CompositionId> <from> <to> <out.mp4> [scale]
# Renders a frame range (inclusive) to mp4. Default scale 0.5.
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/env.sh
npx remotion render "$1" "$4" --frames="$2-$3" --scale="${5:-0.5}" --concurrency=2 --log=error
