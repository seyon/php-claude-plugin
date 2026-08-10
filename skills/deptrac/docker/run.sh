#!/usr/bin/env bash
# Builds (if needed) and runs an isolated, project-tailored Deptrac Docker
# container. Never invoked with ad-hoc deptrac flags -- all call parameters
# are fixed here / read from the project's "## Deptrac Skill" settings so
# results stay reproducible.
#
# The image (../../../lib/docker) is shared plugin-wide infrastructure,
# built with exactly the PHP version + extensions THIS project's
# composer.json/composer.lock declare -- see lib/docker/build-or-reuse.sh
# for why the (expensive) build only ever runs once per project per unique
# requirement set, and is skipped on every later run.
#
# Monorepo support: --project-root is always the directory that actually
# contains the analysed project's own composer.json (e.g. packages/api in
# a monorepo), used for both extension detection and resolving --config
# relative to it. --mount-root is what actually gets bind-mounted into the
# container; if omitted, it's auto-detected (see
# lib/docker/detect-mount-root.js) by scanning --project-root's own
# composer.json for autoload paths pointing outside --project-root --
# widening the mount just enough to cover them, capped at 4 directory
# levels above --project-root as a safety limit. For the common case (no
# such external autoload paths) this is a no-op: --mount-root defaults to
# --project-root. Pass --mount-root/--project-subdir explicitly to
# override detection, or if it hits the safety cap (it will say so on
# stderr).
#
# Cache: Deptrac would by default write `.deptrac.cache` into its working
# directory -- i.e. into the bind-mounted project tree. That's forbidden
# here (project files are never touched), so the cache is redirected via
# --cache-file into a plugin-managed host directory
# (~/.cache/php-claude-plugin/deptrac/<project>) mounted into the
# container. It persists across runs because it lives on the host, not in
# the ephemeral container.
#
# Baseline: a baseline (skip_violations) is wired into the project's own
# deptrac config via `imports:` -- Deptrac picks it up automatically from
# --config, nothing to pass here. Baselined violations show up as
# "skipped" in the JSON report and are excluded by scripts/parse-results.js.
#
# Usage:
#   run.sh --project-root DIR --binary PATH --config FILE --output FILE \
#          [--mount-root DIR] [--project-subdir PATH] \
#          [--extra-mount HOST:CONTAINER[:ro]]... \
#          [--php-version X.Y] [--extra-extensions ext1,ext2]
#
# --project-root     directory containing this project's own composer.json
# --binary            deptrac binary path *inside* the container, e.g.
#                     /app/vendor/bin/deptrac, or /app/packages/api/vendor/bin/deptrac
#                     for a monorepo sub-package
# --config            deptrac config (deptrac.yaml/depfile.yaml) path,
#                     relative to --project-root
# --output             host path to write the JSON report to
# --mount-root         host directory to bind-mount at /app; auto-detected
#                     if omitted (see above)
# --project-subdir     --project-root's path relative to --mount-root, used
#                     as the container's working directory; auto-detected
#                     alongside --mount-root if both are omitted
# --extra-mount         additional bind mount, HOST:CONTAINER[:ro]; repeatable.
#                     For anything the single --mount-root mount can't cover,
#                     e.g. a shared rules/helpers folder living elsewhere on
#                     the host. If the project config references it by
#                     *relative* path, pick the CONTAINER path where that
#                     relative reference resolves from /app.
# --php-version         override the auto-detected PHP version
# --extra-extensions    comma-separated extensions to install in addition
#                     to what was auto-detected

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
LIB_DOCKER_DIR="$PLUGIN_ROOT/lib/docker"

PROJECT_SUBDIR=""
EXTRA_EXTENSIONS=""
PHP_VERSION_OVERRIDE=""
EXTRA_MOUNTS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project-root) PROJECT_ROOT="$2"; shift 2 ;;
    --binary) DEPTRAC_BINARY="$2"; shift 2 ;;
    --config) CONFIG_FILE="$2"; shift 2 ;;
    --output) OUTPUT_FILE="$2"; shift 2 ;;
    --mount-root) MOUNT_ROOT="$2"; shift 2 ;;
    --project-subdir) PROJECT_SUBDIR="$2"; shift 2 ;;
    --extra-mount)
      [[ "$2" == *:* ]] || { echo "--extra-mount must be HOST:CONTAINER[:ro], got: $2" >&2; exit 1; }
      EXTRA_MOUNTS+=("$2"); shift 2 ;;
    --php-version) PHP_VERSION_OVERRIDE="$2"; shift 2 ;;
    --extra-extensions) EXTRA_EXTENSIONS="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

: "${PROJECT_ROOT:?--project-root is required}"
: "${DEPTRAC_BINARY:?--binary is required}"
: "${CONFIG_FILE:?--config is required}"
: "${OUTPUT_FILE:?--output is required}"

if [[ -z "${MOUNT_ROOT:-}" ]]; then
  DETECTED_MOUNT="$(node "$LIB_DOCKER_DIR/detect-mount-root.js" --project-root "$PROJECT_ROOT")"
  MOUNT_ROOT="$(echo "$DETECTED_MOUNT" | sed -n 's/^MOUNT_ROOT=//p')"
  if [[ -z "$PROJECT_SUBDIR" ]]; then
    PROJECT_SUBDIR="$(echo "$DETECTED_MOUNT" | sed -n 's/^PROJECT_SUBDIR=//p')"
  fi
fi
PROJECT_SUBDIR="${PROJECT_SUBDIR:-.}"

DETECTED="$(node "$LIB_DOCKER_DIR/detect-requirements.js" --project-root "$PROJECT_ROOT")"
PHP_VERSION="${PHP_VERSION_OVERRIDE:-$(echo "$DETECTED" | sed -n 's/^PHP_VERSION=//p')}"
PHP_EXTENSIONS="$(echo "$DETECTED" | sed -n 's/^PHP_EXTENSIONS=//p')"
if [[ -n "$EXTRA_EXTENSIONS" ]]; then
  PHP_EXTENSIONS="${PHP_EXTENSIONS:+$PHP_EXTENSIONS,}$EXTRA_EXTENSIONS"
fi

IMAGE_TAG="$("$LIB_DOCKER_DIR/build-or-reuse.sh" --skill deptrac --php-version "$PHP_VERSION" --extensions "$PHP_EXTENSIONS")"

WORKDIR="/app"
if [[ "$PROJECT_SUBDIR" != "." ]]; then
  WORKDIR="/app/$PROJECT_SUBDIR"
fi

# Plugin-managed cache (see header): keeps Deptrac's cache file out of the
# mounted project tree. Keyed by the project root path so distinct
# projects never share a cache.
CACHE_BASE="${XDG_CACHE_HOME:-$HOME/.cache}/php-claude-plugin/deptrac"
PROJECT_KEY="$(basename "$PROJECT_ROOT")-$(printf '%s' "$PROJECT_ROOT" | cksum | cut -d' ' -f1)"
CACHE_DIR="$CACHE_BASE/$PROJECT_KEY"
mkdir -p "$CACHE_DIR"

MOUNT_ARGS=(-v "$MOUNT_ROOT":/app -v "$CACHE_DIR":/deptrac-cache)
for m in ${EXTRA_MOUNTS[@]+"${EXTRA_MOUNTS[@]}"}; do
  MOUNT_ARGS+=(-v "$m")
done

# --formatter=json is fixed here, not left to the caller, so downstream
# parsing in scripts/parse-results.js can rely on a stable output shape.
# Deptrac also exits non-zero when violations are found (expected -- we're
# about to fix them), so don't let `set -e` treat that as a script failure.
docker run --rm \
  "${MOUNT_ARGS[@]}" \
  -w "$WORKDIR" \
  "$IMAGE_TAG" \
  php "$DEPTRAC_BINARY" analyse \
    --config-file="$CONFIG_FILE" \
    --cache-file=/deptrac-cache/deptrac.cache \
    --formatter=json \
    --no-progress \
    --no-interaction \
    > "$OUTPUT_FILE" || true

echo "$OUTPUT_FILE"
