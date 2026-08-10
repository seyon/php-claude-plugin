#!/usr/bin/env bash
# Shared across every skill: given a skill name + detected PHP version +
# extension set, computes a content-derived image tag and builds the
# shared base image (../Dockerfile) only if that exact tag doesn't already
# exist locally. Prints the resolved tag on stdout.
#
# Because the tag is derived purely from (skill, php version, extensions)
# -- never from a project path -- the (expensive) docker build only ever
# runs once per unique requirement set: once per project normally, but
# harmlessly shared across projects (including different packages in a
# monorepo) that happen to declare identical requirements. If a project's
# requirements change, the tag changes with them and a fresh image gets
# built automatically -- no manual cache-busting needed.
#
# Usage:
#   build-or-reuse.sh --skill <name> --php-version X.Y --extensions "ext1,ext2,..."
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skill) SKILL="$2"; shift 2 ;;
    --php-version) PHP_VERSION="$2"; shift 2 ;;
    --extensions) EXTENSIONS="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

: "${SKILL:?--skill is required}"
: "${PHP_VERSION:?--php-version is required}"
EXTENSIONS="${EXTENSIONS:-}"

HASH="$(printf '%s' "$EXTENSIONS" | sha256sum | cut -c1-10)"
IMAGE_TAG="php-tools-${SKILL}:php${PHP_VERSION}-${HASH}"

if [[ -z "$(docker images -q "$IMAGE_TAG" 2>/dev/null)" ]]; then
  # Build output goes to a log file, NOT to stderr -- a first-time build
  # emits thousands of lines of apt/pecl noise that would otherwise land
  # verbatim in the calling agent's conversation context.
  LOG_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/php-claude-plugin/build-logs"
  mkdir -p "$LOG_DIR"
  LOG_FILE="$LOG_DIR/$(echo "$IMAGE_TAG" | tr '/:' '__').log"
  if ! docker build \
    --build-arg PHP_VERSION="$PHP_VERSION" \
    --build-arg PHP_EXTENSIONS="$(echo "$EXTENSIONS" | tr ',' ' ')" \
    -t "$IMAGE_TAG" \
    "$SCRIPT_DIR" > "$LOG_FILE" 2>&1; then
    echo "docker build failed for $IMAGE_TAG -- last 30 log lines (full log: $LOG_FILE):" >&2
    tail -n 30 "$LOG_FILE" >&2
    exit 1
  fi
  echo "built $IMAGE_TAG (build log: $LOG_FILE)" >&2
fi

echo "$IMAGE_TAG"
