#!/bin/sh
# shoggoth-config-merge — selectively merge dynamic configuration fragments or
# persisted HITL tool auto-approvals into the base configuration.
#
# Designed to run as the entrypoint of a throwaway container with the base
# configuration mounted read-write and the dynamic configuration mounted
# read-only:
#
#   docker run --rm -it \
#     --entrypoint /usr/local/bin/shoggoth-config-merge \
#     -v "$PWD/config/base:/etc/shoggoth/config.d/base" \
#     -v "$PWD/config/dynamic:/etc/shoggoth/config.d/dynamic:ro" \
#     shoggoth:local config
#
# A throwaway git repository in ephemeral storage holds a snapshot of the base
# configuration; reorganized copies of the dynamic fragments are staged against
# it and the operator interactively selects hunks with `git commit -p`.
# Uncommitted changes are discarded; committed files replace the mounted base
# configuration after being backed up as `<file name>.json.<timestamp>.bak`.
set -eu

HITL_FRAGMENT="z-hitl-agent-tool-auto-approve.json"
BASE_DIR="${SHOGGOTH_BASE_CONFIG_DIR:-/etc/shoggoth/config.d/base}"
DYN_DIR="${SHOGGOTH_DYNAMIC_CONFIG_DIR:-/etc/shoggoth/config.d/dynamic}"

usage() {
  cat <<EOF
Usage: shoggoth-config-merge <config|hitl>

Actions:
  config   merge dynamic configuration fragments (every *.json except ${HITL_FRAGMENT})
  hitl     merge persisted HITL tool auto-approvals (${HITL_FRAGMENT})

Environment:
  SHOGGOTH_BASE_CONFIG_DIR      base configuration directory (default: /etc/shoggoth/config.d/base)
  SHOGGOTH_DYNAMIC_CONFIG_DIR   dynamic configuration directory (default: /etc/shoggoth/config.d/dynamic)
EOF
}

log() { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

# --- argument parsing ---------------------------------------------------------

action="${1:-}"
case "$action" in
  config | hitl) ;;
  -h | --help | help)
    usage
    exit 0
    ;;
  "")
    usage >&2
    exit 2
    ;;
  *)
    printf 'error: unknown action: %s\n\n' "$action" >&2
    usage >&2
    exit 2
    ;;
esac

# --- environment validation ---------------------------------------------------

command -v git >/dev/null 2>&1 || die "git is required"
command -v jq >/dev/null 2>&1 || die "jq is required"
[ -d "$BASE_DIR" ] || die "base config directory not found: $BASE_DIR"
[ -d "$DYN_DIR" ] || die "dynamic config directory not found: $DYN_DIR"

WORKDIR=$(mktemp -d) || die "cannot create temporary directory"
trap 'rm -rf "$WORKDIR"' EXIT
trap 'exit 3' HUP INT TERM
REPO="$WORKDIR/repo"
mkdir "$REPO"

# --- select source fragments --------------------------------------------------

find "$DYN_DIR" -type f -name '*.json' | LC_ALL=C sort > "$WORKDIR/fragments.txt"

: > "$WORKDIR/selected.txt"
while IFS= read -r frag; do
  name=${frag##*/}
  if [ "$action" = hitl ]; then
    if [ "$name" = "$HITL_FRAGMENT" ]; then
      printf '%s\n' "$frag" >> "$WORKDIR/selected.txt"
    fi
  else
    if [ "$name" != "$HITL_FRAGMENT" ]; then
      printf '%s\n' "$frag" >> "$WORKDIR/selected.txt"
    fi
  fi
done < "$WORKDIR/fragments.txt"

if [ ! -s "$WORKDIR/selected.txt" ]; then
  if [ "$action" = hitl ]; then
    log "Nothing to merge: no persisted HITL approvals (${HITL_FRAGMENT}) in ${DYN_DIR}."
  else
    log "Nothing to merge: no dynamic configuration fragments in ${DYN_DIR}."
  fi
  exit 0
fi

# --- throwaway repository: commit the untouched base configuration ------------

cp -R "$BASE_DIR"/. "$REPO"/

git -C "$REPO" init -q -b main
# Identity comes from the environment, never from `git config`, because config writes
# resolve against the invoking checkout — the repo-local config inside a worktree, or the
# operator's global ~/.gitconfig when run from the repo root. Hermetic git settings keep the
# throwaway repo from reading or writing any caller config and from triggering caller hooks.
GIT_AUTHOR_NAME="shoggoth-config-merge"
GIT_AUTHOR_EMAIL="config-merge@shoggoth.local"
GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME"
GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"
GIT_CONFIG_NOSYSTEM=1
GIT_CONFIG_GLOBAL=/dev/null
GIT_CONFIG_SYSTEM=/dev/null
export GIT_AUTHOR_NAME GIT_AUTHOR_EMAIL GIT_COMMITTER_NAME GIT_COMMITTER_EMAIL
export GIT_CONFIG_NOSYSTEM GIT_CONFIG_GLOBAL GIT_CONFIG_SYSTEM
git -C "$REPO" config core.hooksPath /dev/null
git -C "$REPO" config commit.gpgSign false
git -C "$REPO" add -A
git -C "$REPO" commit -q --allow-empty -m "base configuration (untouched)"
BASE_SHA=$(git -C "$REPO" rev-parse HEAD)

# --- build the merge plan: route each top-most parent property to its target --
#
# Properties are merged into the first base file (recursively, ascending full
# path order) whose top-level object contains the property; when no file
# contains it, `<property name>.json` is created at the base root. Merge
# semantics mirror the daemon's deepMerge: objects merge recursively, arrays
# and scalars are replaced; later values win.

cat > "$WORKDIR/merge-one.jq" <<'JQ'
def dm(a; b):
  if (a | type) == "object" and (b | type) == "object" then
    a as $a
    | reduce (b | keys_unsorted[]) as $k ($a;
        .[$k] = (if ($a | has($k)) then dm($a[$k]; b[$k]) else b[$k] end))
  else
    b
  end;
.[$key] = dm(.[$key]; $value)
JQ

: > "$WORKDIR/plan.txt"
: > "$WORKDIR/newfiles.txt"

while IFS= read -r frag; do
  relfrag=${frag#"$DYN_DIR"/}
  if ! jq -e 'type == "object"' "$frag" >/dev/null 2>&1; then
    warn "skipping ${relfrag}: not a JSON object (invalid JSON or wrong type)"
    continue
  fi
  jq -r 'keys_unsorted[]' "$frag" > "$WORKDIR/keys.txt"
  while IFS= read -r key; do
    [ -n "$key" ] || continue
    value=$(jq -c --arg k "$key" '.[$k]' "$frag")

    # first repo file (ascending full path order) containing the property
    target=""
    find "$REPO" -type f -name '*.json' | LC_ALL=C sort > "$WORKDIR/candidates.txt"
    while IFS= read -r cand; do
      if jq -e --arg k "$key" 'if type == "object" then has($k) else false end' \
        "$cand" >/dev/null 2>&1; then
        target=$cand
        break
      fi
    done < "$WORKDIR/candidates.txt"

    if [ -z "$target" ]; then
      target="$REPO/$key.json"
      if [ -f "$target" ]; then
        : # fall through: merge into the existing <property name>.json
      else
        jq -n --arg key "$key" --argjson value "$value" '{ ($key): $value }' > "$target"
        printf '%s\n' "$target" >> "$WORKDIR/newfiles.txt"
        printf '%s\t%s\t%s\tnew\n' "$relfrag" "$key" "$key.json" >> "$WORKDIR/plan.txt"
        continue
      fi
    fi

    jq --arg key "$key" --argjson value "$value" -f "$WORKDIR/merge-one.jq" \
      "$target" > "$target.tmp"
    mv "$target.tmp" "$target"
    printf '%s\t%s\t%s\tmerged\n' "$relfrag" "$key" "${target#"$REPO"/}" \
      >> "$WORKDIR/plan.txt"
  done < "$WORKDIR/keys.txt"
done < "$WORKDIR/selected.txt"

if [ ! -s "$WORKDIR/plan.txt" ]; then
  log "Nothing to merge: no mergeable fragments found."
  exit 0
fi

# --- confirm the plan ---------------------------------------------------------

log ""
log "Merge plan (${action} action):"
while IFS='	' read -r src key tgt kind; do
  if [ "$kind" = new ]; then
    log "  ${src} [${key}] -> ${tgt} (new file)"
  else
    log "  ${src} [${key}] -> ${tgt}"
  fi
done < "$WORKDIR/plan.txt"
log ""
printf 'Proceed with interactive merge? [y/N] '
IFS= read -r answer || answer=""
case "$answer" in
  y | Y | yes | Yes | YES) ;;
  *)
    log "Aborted; nothing was changed."
    exit 0
    ;;
esac

# --- interactive hunk selection via `git commit -p` ---------------------------

# New files enter the index as intent-to-add so their content is offered as
# ordinary unstaged hunks; existing files are modified in the worktree only.
if [ -s "$WORKDIR/newfiles.txt" ]; then
  while IFS= read -r nf; do
    git -C "$REPO" add -N "${nf#"$REPO"/}"
  done < "$WORKDIR/newfiles.txt"
fi

log ""
log "Select the hunks to merge at each prompt (y = keep, n = skip, q = quit)."
log ""
set +e
git -C "$REPO" commit -p -m "merge dynamic configuration (${action})"
set -e

if [ "$(git -C "$REPO" rev-parse HEAD)" = "$BASE_SHA" ]; then
  log "No hunks were committed; nothing was changed."
  exit 0
fi

# Discard everything that was not committed.
git -C "$REPO" reset -q --hard HEAD
git -C "$REPO" clean -qfd

# --- apply committed files to the mounted base configuration ------------------

TS=$(date +%s)
DIR_OWNER=$(stat -c '%u:%g' "$BASE_DIR" 2>/dev/null || printf '')

git -C "$REPO" diff --name-only "$BASE_SHA" HEAD > "$WORKDIR/changed.txt"
while IFS= read -r rel; do
  src="$REPO/$rel"
  dest="$BASE_DIR/$rel"
  if [ -f "$dest" ]; then
    cp -p "$dest" "$dest.$TS.bak"
    if [ -n "$DIR_OWNER" ]; then
      chown "$DIR_OWNER" "$dest.$TS.bak" 2>/dev/null || true
    fi
    log "  updated ${rel} (backup: ${rel}.${TS}.bak)"
  else
    log "  created ${rel}"
  fi
  cp "$src" "$dest"
  if [ ! -f "$dest" ]; then
    die "failed to write ${dest}"
  fi
  chmod 0644 "$dest"
  if [ -n "$DIR_OWNER" ]; then
    chown "$DIR_OWNER" "$dest" 2>/dev/null || true
  fi
done < "$WORKDIR/changed.txt"

log ""
log "Done. The merged files are live in ${BASE_DIR}."
log "The dynamic fragments were left in place; the daemon layers both at runtime,"
log "so remove them once the merged base configuration is what you want."
