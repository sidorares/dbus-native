#!/bin/bash
# Build the container and run the end-to-end checks against it.
#
#   e2e/run.sh                      # everything
#   e2e/run.sh 02-types.js          # one file
#   e2e/run.sh --shell              # a prompt inside, buses already up
#
# See E2E_DOCKER_TESTING.md.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/.." && pwd)"
image="${E2E_IMAGE:-dbus-native-e2e}"

echo "building $image"
docker build -q -t "$image" -f "$here/docker/Dockerfile" "$here/docker" >/dev/null

mount=(-v "$repo:/work:ro")

case "${1:-}" in
  --shell)
    exec docker run --rm -it "${mount[@]}" "$image" bash
    ;;
  '')
    exec docker run --rm -t "${mount[@]}" "$image" node /work/e2e/tests/run.js
    ;;
  *)
    exec docker run --rm -t "${mount[@]}" "$image" \
      node --test-reporter=spec --test-timeout=60000 "/work/e2e/tests/$1"
    ;;
esac
