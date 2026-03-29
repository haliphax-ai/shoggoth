#!/bin/sh
# Installed as /usr/local/bin/shoggoth in the runtime image — on PATH for shoggoth (daemon) and agent UIDs.
# Must run from /app so Node resolves workspace `tsx` (agent subprocess cwd is often a session workspace).
set -e
cd /app
exec node --import tsx/esm packages/cli/run-cli.mjs "$@"
