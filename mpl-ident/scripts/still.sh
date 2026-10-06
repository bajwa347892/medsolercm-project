#!/usr/bin/env bash
# Usage: scripts/still.sh <CompositionId> <frame> <out.png> [scale]
# Renders one frame. Default scale 0.5 (960x540) for speed; pass 1 for full 1080p.
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/env.sh
npx remotion still "$1" "$3" --frame="$2" --scale="${4:-0.5}" --log=error
