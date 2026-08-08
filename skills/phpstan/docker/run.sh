#!/usr/bin/env bash
# Builds (if needed) and runs an isolated, project-tailored PHPStan Docker
# container. Never invoked with ad-hoc phpstan flags -- all call parameters
# are fixed here / read from the project's "## PHPStan Skill" settings so
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
# composer.json for autoload paths pointing outside --project-root (e.g. a
# shared custom-PHPStan-rules folder kept elsewhere in a monorepo and wired
# in via a relative psr-4/classmap autoload entry) -- widening the mount
# just enough to cover them, capped at 4 directory levels above
# --project-root as a safety limit. For the common case (no such external
# autoload paths) this is a no-op: --mount-root defaults to --project-root.
# Pass --mount-root/--project-subdir explicitly to override detection, or
# if it hits the safety cap (it will say so on stderr).
#
# Usage:
#   run.sh --project-root DIR --binary PATH --config FILE --output FILE \
#          [--mount-root DIR] [--project-subdir PATH] \
#          [--php-version X.Y] [--extra-extensions ext1,ext2]
#
# --project-root     directory containing this project's own composer.json
# --binary            phpstan binary path *inside* the container, e.g.
#                     /app/vendor/bin/phpstan, or /app/packages/api/vendor/bin/phpstan
#                     for a monorepo sub-package
# --config            phpstan config file, relative to --project-root
# --output             host path to write the JSON report to
# --mount-root         host directory to bind-mount at /app; auto-detected
#                     if omitted (see above)
# --project-subdir     --project-root's path relative to --mount-root, used
#                     as the container's working directory; auto-detected
#                     alongside --mount-root if both are omitted
# --php-version         override the auto-detected PHP version
# --extra-extensions    comma-separated extensions to install in addition
#                     to what was auto-detected (safety valve for anything
#                     detection misses, e.g. extensions phpstan needs at
#                     runtime but that no composer.* declares)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
LIB_DOCKER_DIR="$PLUGIN_ROOT/lib/docker"

PROJECT_SUBDIR=""
EXTRA_EXTENSIONS=""
PHP_VERSION_OVERRIDE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project-root) PROJECT_ROOT="$2"; shift 2 ;;
    --binary) PHPSTAN_BINARY="$2"; shift 2 ;;
    --config) CONFIG_FILE="$2"; shift 2 ;;
    --output) OUTPUT_FILE="$2"; shift 2 ;;
    --mount-root) MOUNT_ROOT="$2"; shift 2 ;;
    --project-subdir) PROJECT_SUBDIR="$2"; shift 2 ;;
    --php-version) PHP_VERSION_OVERRIDE="$2"; shift 2 ;;
    --extra-extensions) EXTRA_EXTENSIONS="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

: "${PROJECT_ROOT:?--project-root is required}"
: "${PHPSTAN_BINARY:?--binary is required}"
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

IMAGE_TAG="$("$LIB_DOCKER_DIR/build-or-reuse.sh" --skill phpstan --php-version "$PHP_VERSION" --extensions "$PHP_EXTENSIONS")"

WORKDIR="/app"
if [[ "$PROJECT_SUBDIR" != "." ]]; then
  WORKDIR="/app/$PROJECT_SUBDIR"
fi

# phpstan exits non-zero when it finds errors -- that's the expected case
# here (we're about to fix them), so don't let `set -e` treat it as a
# script failure. A genuine crash still produces empty/invalid JSON, which
# parse-results.js will reject explicitly.
docker run --rm \
  -v "$MOUNT_ROOT":/app \
  -w "$WORKDIR" \
  "$IMAGE_TAG" \
  php "$PHPSTAN_BINARY" analyse \
    --configuration="$CONFIG_FILE" \
    --error-format=json \
    --no-progress \
    > "$OUTPUT_FILE" || true

echo "$OUTPUT_FILE"
