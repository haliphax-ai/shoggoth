#!/bin/sh
set -e

# Writable volume roots: enforce owner/mode on every start (named volumes often mount as root:root).
# Agent pool user must not read operator/daemon trees (state, operator secrets, socket dir, config).
fix_dir() {
  _path=$1
  _mode=$2
  _user=$3
  _group=$4
  mkdir -p "$_path"
  chown "$_user:$_group" "$_path"
  chmod "$_mode" "$_path"
}

# Config may be a read-only bind mount; never fail startup if chown/chmod is rejected.
(
  mkdir -p /etc/shoggoth/config.d
  chown shoggoth:shoggoth /etc/shoggoth/config.d
  chmod 0750 /etc/shoggoth/config.d
) 2>/dev/null || true

# Config directory; bind mounts should go in subfolders
fix_dir /etc/shoggoth/config.d 0700 shoggoth shoggoth
# Dynamic config subdirectory (optional volume mount for agent-writable config overrides)
if [ -d /etc/shoggoth/config.d/dynamic ]; then
  fix_dir /etc/shoggoth/config.d/dynamic 0700 shoggoth shoggoth
fi
fix_dir /var/lib/shoggoth/state 0700 shoggoth shoggoth
# Workspaces root: setgid (2…) so new session dirs inherit group `agent`; agent UID 900 matches group perms.
fix_dir /var/lib/shoggoth/workspaces 2770 shoggoth agent
# Heal trees created before setgid / wrong umask (bootstrap runs as shoggoth: agent could not write).
# Only fix the workspaces root and immediate agent workspace dirs — deeper contents are the agent's responsibility.
find /var/lib/shoggoth/workspaces -maxdepth 1 -exec chown shoggoth:agent {} + 2>/dev/null || true
find /var/lib/shoggoth/workspaces -maxdepth 1 -type d -exec chmod 2770 {} + 2>/dev/null || true
fix_dir /var/lib/shoggoth/operator 0700 shoggoth shoggoth
fix_dir /var/lib/shoggoth/media/inbound 0750 shoggoth shoggoth
fix_dir /run/shoggoth 0750 shoggoth shoggoth

# Compose secrets land under /run/secrets; default perms are root-only — do not loosen.
if [ -d /run/secrets ]; then
  chown root:root /run/secrets 2>/dev/null || true
  chmod 0700 /run/secrets 2>/dev/null || true
fi

# gosu drops all capabilities on setuid; builtins need CAP_SETUID/CAP_SETGID on the daemon to spawn as agent (900).
# Compose must set cap_add: SETUID, SETGID. setpriv keeps them in inh+ambient across the reuid/regid drop.
exec setpriv --reuid shoggoth --regid shoggoth --init-groups \
  --inh-caps +setuid,+setgid \
  --ambient-caps +setuid,+setgid \
  -- "$@"
