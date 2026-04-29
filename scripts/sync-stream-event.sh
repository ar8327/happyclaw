#!/usr/bin/env bash
# Copy canonical shared types to all sub-projects.
# Called by `make build` and `make sync-types`.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# --- StreamEvent types (3 targets) ---
SRC_SE="$ROOT/shared/stream-event.ts"
TARGETS_SE=(
  "$ROOT/container/agent-runner/src/stream-event.types.ts"
  "$ROOT/src/stream-event.types.ts"
  "$ROOT/web/src/stream-event.types.ts"
)
for target in "${TARGETS_SE[@]}"; do
  cp "$SRC_SE" "$target"
done

# --- Image detector (2 targets: backend + agent-runner; not needed by web) ---
SRC_ID="$ROOT/shared/image-detector.ts"
TARGETS_ID=(
  "$ROOT/src/image-detector.ts"
  "$ROOT/container/agent-runner/src/image-detector.ts"
)
for target in "${TARGETS_ID[@]}"; do
  cp "$SRC_ID" "$target"
done

# --- Runner descriptor (3 targets) ---
SRC_RD="$ROOT/shared/runner-descriptor.ts"
TARGETS_RD=(
  "$ROOT/src/runner-descriptor.types.ts"
  "$ROOT/container/agent-runner/src/runner-descriptor.types.ts"
  "$ROOT/web/src/runner-descriptor.types.ts"
)
for target in "${TARGETS_RD[@]}"; do
  cp "$SRC_RD" "$target"
done
