#!/usr/bin/env bash
# Pick the tests a pull request needs, from the files it changed.
#
# Usage: scripts/ci/select-tests.sh <base-sha> <head-sha>
# Prints exactly one of:
#   FULL            run the whole suite (npm test)
#   NONE            docs-only change, no tests needed
#   <test files>    one test/**/*.test.js path per line
#
# Partial selection is for test-only changes: a PR that changes nothing but
# test files (and docs) runs exactly the changed tests. Any other change runs
# FULL. A filename match is not coverage: a shared helper's own test can pass
# while a consumer's test, never selected, breaks. Docs are
# top-level *.md, docs/, _DOCS/ and LICENSE only; Markdown elsewhere can be a
# runtime input and runs FULL.
set -euo pipefail

base="${1:?base sha}"
head="${2:?head sha}"

# --no-renames lists both sides of a rename, so a file moved into docs/ or
# test/ is still seen at its old path
changed="$(git diff --name-only --no-renames "$base...$head")"

full() { echo "FULL"; exit 0; }

declare -A picked=()
tests_changed=0

while IFS= read -r f; do
  [ -n "$f" ] || continue
  case "$f" in
    docs/* | _DOCS/* | LICENSE) continue ;;
    */*) ;; # not top-level: a .md here falls through to FULL
    *.md) continue ;;
  esac
  case "$f" in
    # node --test reads each argument as a glob, so a test path holding glob
    # characters would run other files, not this one
    *[][*?{}]*) full ;;
    # * in a case pattern also matches /, so this is a test at any depth
    test/*.test.js)
      tests_changed=1
      # a test the PR deleted cannot be run
      [ -f "$f" ] && picked["$f"]=1
      continue ;;
  esac
  # source, config, CI, harness, fixtures, schema: anything may depend on it
  full
done <<<"$changed"

if [ "${#picked[@]}" -eq 0 ]; then
  # only deleted tests changed: run everything rather than nothing
  if [ "$tests_changed" -eq 1 ]; then full; fi
  echo "NONE"
  exit 0
fi

printf '%s\n' "${!picked[@]}" | sort
