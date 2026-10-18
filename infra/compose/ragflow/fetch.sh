#!/usr/bin/env bash
# Fetches the upstream RAGFlow docker/ deployment directory at the pinned tag.
set -euo pipefail
TAG="${RAGFLOW_TAG:-v0.27.2}"
DIR="$(cd "$(dirname "$0")" && pwd)/upstream"
rm -rf "$DIR"
git clone --depth 1 --branch "$TAG" --filter=blob:none --sparse https://github.com/infiniflow/ragflow.git "$DIR"
git -C "$DIR" sparse-checkout set docker
echo "RAGFlow $TAG deployment files are in $DIR/docker (commit $(git -C "$DIR" rev-parse HEAD))"
