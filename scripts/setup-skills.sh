#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
shopt -s nullglob dotglob
hosts=(.claude .agents)

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

[ ! -L skills ] || fail "Refusing symlinked source directory: skills"
[ -d skills ] || fail "Missing skill source directory: skills"

for host in "${hosts[@]}"; do
  for parent in "$host" "$host/skills"; do
    [ ! -L "$parent" ] || fail "Refusing symlinked directory: $parent"
    [ ! -e "$parent" ] || [ -d "$parent" ] || fail "Not a directory: $parent"
  done
done

for dir in skills/*; do
  [ -d "$dir" ] || { [ ! -L "$dir" ] || fail "Broken skill source: $dir"; continue; }
  [ -f "$dir/SKILL.md" ] && [ -r "$dir/SKILL.md" ] || fail "Missing readable SKILL.md: $dir"
  name="${dir##*/}"
  for host in "${hosts[@]}"; do
    link="$host/skills/$name"
    if [ -L "$link" ]; then
      [ "$(readlink "$link")" = "../../skills/$name" ] || fail "Unrelated symlink: $link"
    elif [ -e "$link" ]; then
      fail "Refusing to replace: $link"
    fi
  done
done

for host in "${hosts[@]}"; do
  mkdir -p "$host/skills"
  created=0
  kept=0
  removed=0
  for dir in skills/*; do
    [ -d "$dir" ] || continue
    name="${dir##*/}"
    link="$host/skills/$name"
    if [ -L "$link" ]; then
      kept=$((kept + 1))
    else
      ln -s "../../skills/$name" "$link"
      created=$((created + 1))
    fi
  done
  for link in "$host/skills/"*; do
    [ -L "$link" ] || continue
    name="${link##*/}"
    [ "$(readlink "$link")" = "../../skills/$name" ] || continue
    if [ ! -e "skills/$name" ] && [ ! -L "skills/$name" ]; then
      echo "Removing stale skill link: $link"
      rm "$link"
      removed=$((removed + 1))
    fi
  done
  echo "$host/skills: $created created, $kept kept, $removed removed."
done
