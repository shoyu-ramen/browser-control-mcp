#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DIST_DIR="$SCRIPT_DIR/dist"
ZIP_FILE="$DIST_DIR/browser-control-mcp.zip"

mkdir -p "$DIST_DIR"
rm -f "$ZIP_FILE"

cd "$SCRIPT_DIR/extension"
zip -r "$ZIP_FILE" \
  manifest.json \
  background.js \
  offscreen.html \
  offscreen.js \
  license.js \
  popup.html \
  popup.js \
  popup.css \
  icon16.png \
  icon48.png \
  icon128.png \
  -x '*.DS_Store' -x '__MACOSX/*'

echo "Built: $ZIP_FILE ($(du -h "$ZIP_FILE" | cut -f1))"
