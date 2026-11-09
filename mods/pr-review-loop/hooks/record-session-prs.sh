#!/bin/bash
input=$(cat)
tool=$(jq -r '.tool_name' <<<"$input")
if [[ $tool == Bash ]]; then
  jq -e '.tool_input.command | test("gh pr create")' <<<"$input" >/dev/null || exit 0
elif [[ $tool != *create_pull_request* ]]; then
  exit 0
fi
jq -c --arg terminal "${HC_TERMINAL_ID:-}" --arg at "$(date -u +%FT%TZ)" '
  .session_id as $s | .cwd as $c
  | [.tool_response | tostring | scan("https://github\\.com/[^/\\s\"\\\\]+/[^/\\s\"\\\\]+/pull/[0-9]+")] | unique[]
  | {url: ., terminal: $terminal, session: $s, cwd: $c, at: $at}
' <<<"$input" >> ~/.local/state/claude-session-prs.jsonl
