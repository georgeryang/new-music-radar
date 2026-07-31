#!/usr/bin/env bash
# Link the repo's tracked skills into .claude/skills/ so Claude Code loads them
# in this directory and nowhere else.
#
# skills/ is tracked; .claude/ is gitignored (it also holds settings.local.json,
# which is per-machine). The symlinks are therefore local state, recreated here
# rather than committed. Idempotent — safe to re-run.
set -euo pipefail
cd "$(dirname "$0")/.."

mkdir -p .claude/skills
linked=0
for dir in skills/*/; do
  name="$(basename "$dir")"
  ln -sfn "../../skills/$name" ".claude/skills/$name"
  echo "  linked $name"
  linked=$((linked + 1))
done

# A skill renamed or dropped upstream leaves a dangling link that Claude Code
# would still try to read.
for link in .claude/skills/*; do
  [ -e "$link" ] || { echo "  removed stale link $(basename "$link")"; rm -f "$link"; }
done

echo "$linked skill(s) linked. They load only when Claude Code runs in this directory."
