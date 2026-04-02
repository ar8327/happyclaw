#!/bin/bash
# Build the HappyClaw agent container image

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

IMAGE_NAME="happyclaw-agent"
TAG="${1:-latest}"

echo "Building HappyClaw agent container image..."
echo "Image: ${IMAGE_NAME}:${TAG}"

# Build with Docker (CACHEBUST ensures claude-code is always latest).
# Older legacy docker builders do not support --progress, so fall back automatically.
BUILD_ARGS=(--build-arg "CACHEBUST=$(date +%s)" -t "${IMAGE_NAME}:${TAG}" .)
if docker build --help 2>/dev/null | grep -q -- '--progress'; then
  # BuildKit-compatible path keeps line-based output for log capture.
  docker build --progress=plain "${BUILD_ARGS[@]}"
else
  docker build "${BUILD_ARGS[@]}"
fi

echo ""
echo "Build complete!"
echo "Image: ${IMAGE_NAME}:${TAG}"

# Touch sentinel so Makefile can detect stale image
touch "$SCRIPT_DIR/../.docker-build-sentinel"

echo ""
echo "Test with:"
echo "  echo '{\"prompt\":\"What is 2+2?\",\"groupFolder\":\"test\",\"chatJid\":\"test@g.us\",\"isMain\":false}' | docker run -i ${IMAGE_NAME}:${TAG}"
