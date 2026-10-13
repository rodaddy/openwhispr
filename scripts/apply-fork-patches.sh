#!/opt/homebrew/bin/bash
# Reapply the fork's patches (patches/*.patch) on top of the current HEAD.
# Uses 3-way merge so small upstream drift resolves automatically.
set -euo pipefail
cd "$(dirname "$0")/.."
git am --3way patches/*.patch
