#!/usr/bin/env bash
# Runs the pr-review-loop skill's pr-status.sh and puts its output in place.
#
# Usage: refresh.sh SCRIPT JSON_TARGET LINKS_FILE OWNER/REPO#N [...]
#   JSON_TARGET is a project's pr-status.json: the new pr-status.json and pr-status.md replace
#   the old ones by rename, unless the file changed while the script ran (exit 4).
#   JSON_TARGET "-" prints the classified JSON array instead and writes nothing.
# Exit 3: the installed skill is too old to write JSON.
set -euo pipefail

script=$1 target=$2 links=$3
shift 3

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
# pr-status.sh reads an empty links file as invalid JSON; a missing one means no links.
[ -s "$links" ] || links="$tmp/no-links.json"

generated_at() { jq -r '.generatedAt // empty' "$1" 2>/dev/null || true; }

before=""
[ "$target" = - ] || before=$(generated_at "$target")

if ! PR_STATUS_FILE="$tmp/pr-status.md" PR_STATUS_JSON_FILE="$tmp/pr-status.json" PR_REVIEW_LINKS_FILE="$links" \
  "$script" "$@" >"$tmp/out" 2>"$tmp/err"; then
  code=$?
  grep -m1 -v '^[[:space:]]*$' "$tmp/err" >&2 || echo "pr-status.sh exited with code $code" >&2
  exit 1
fi

if [ ! -f "$tmp/pr-status.json" ]; then
  echo "the installed skill is too old to write pr-status.json; update it with: claude plugin update pr-review-loop@skills" >&2
  exit 3
fi

if [ "$target" = - ]; then
  cat "$tmp/out"
  exit 0
fi

if [ "$(generated_at "$target")" != "$before" ]; then
  echo "file changed during refresh" >&2
  exit 4
fi

dir=$(dirname "$target")
for name in pr-status.md pr-status.json; do
  [ ! -L "$dir/$name" ] || { echo "$dir/$name is a symlink; not replacing it" >&2; exit 1; }
  part=$(mktemp "$dir/.$name.XXXXXX")
  cp "$tmp/$name" "$part"
  mv "$part" "$dir/$name"
done
