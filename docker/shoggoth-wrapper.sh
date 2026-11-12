#!/bin/sh
# Installed as /usr/local/bin/shoggoth in the runtime image — on PATH for shoggoth (daemon) and agent UIDs.
# Runs the compiled CLI bundle directly (no child process, no tsx loader).
# Must run from /app so Node resolves workspace `node_modules` deps
# (agent subprocess cwd is often a session workspace).
set -e
export SHOGGOTH_CALLER_CWD="$PWD"
cd /app
# Self-heal: build the bundle once if the image was built without it.
[ -f packages/cli/dist/cli.mjs ] || npm run build:cli >/dev/null 2>&1
exec node packages/cli/dist/cli.mjs "$@"
