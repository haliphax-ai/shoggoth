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

fix_dir /var/lib/shoggoth/state 0700 shoggoth shoggoth
# Workspaces root: setgid (2…) so new session dirs inherit group `agent`; agent UID 901 matches group perms.
fix_dir /var/lib/shoggoth/workspaces 2770 shoggoth agent
# Heal trees created before setgid / wrong umask (bootstrap runs as shoggoth: agent could not write).
find /var/lib/shoggoth/workspaces -mindepth 1 -exec chown shoggoth:agent {} + 2>/dev/null || true
find /var/lib/shoggoth/workspaces -type d -exec chmod 2770 {} + 2>/dev/null || true
find /var/lib/shoggoth/workspaces -type f -exec chmod 660 {} + 2>/dev/null || true
fix_dir /var/lib/shoggoth/operator 0700 shoggoth shoggoth
fix_dir /var/lib/shoggoth/media/inbound 0750 shoggoth shoggoth
fix_dir /run/shoggoth 0750 shoggoth shoggoth

# Compose secrets land under /run/secrets; default perms are root-only — do not loosen.
if [ -d /run/secrets ]; then
  chown root:root /run/secrets 2>/dev/null || true
  chmod 0700 /run/secrets 2>/dev/null || true
fi

# gosu drops all capabilities on setuid; builtins need CAP_SETUID/CAP_SETGID on the daemon to spawn as agent (901).
# Compose must set cap_add: SETUID, SETGID. setpriv keeps them in inh+ambient across the reuid/regid drop.
exec setpriv --reuid shoggoth --regid shoggoth --init-groups \
  --inh-caps +setuid,+setgid \
  --ambient-caps +setuid,+setgid \
  -- "$@"
