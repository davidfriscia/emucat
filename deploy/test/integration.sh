#!/usr/bin/env bash
# Runs emucatctl and the deployment service against disposable hosts, in a Linux container with fakes
# for docker, curl and the MariaDB clients (see deploy/test/fakes). Nothing on this machine is touched
# besides the emucat-deploy-test image.
#
#   bash deploy/test/integration.sh              (pnpm test:deploy)
set -Eeuo pipefail
export MSYS_NO_PATHCONV=1
host_path() { if command -v cygpath >/dev/null; then cygpath -m "$1"; else printf '%s' "$1"; fi; }
repo=$(host_path "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)")
docker build --quiet --tag emucat-deploy-test "$repo/deploy/test" >/dev/null
docker run --rm --volume "$repo:/src:ro" --workdir /src emucat-deploy-test \
  node --disable-warning=ExperimentalWarning --test --test-concurrency=1 'apps/deployer/integration/*.test.ts'
