# Resolve a node binary into $NODE (empty if none found). Sourced, not run.
#
# launchd and Finder both start processes with a PATH that has no nvm shims, so
# `command -v node` alone fails in exactly the two contexts that matter here:
# the nightly update and a double-clicked prefs.command.
NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then
  NODE="$(ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -1)"
fi
