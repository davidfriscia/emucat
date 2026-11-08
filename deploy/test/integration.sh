#!/usr/bin/env bash
# Runs emucatctl and the deployment service against disposable hosts, in a Linux container with fakes
# for docker, systemctl, curl and the MariaDB clients (see deploy/test/fakes). Then, in a second fresh
# container and as root, a full installation into /opt/emucat. Nothing on this machine is touched besides
# the emucat-deploy-test image.
#
#   bash deploy/test/integration.sh              (pnpm test:deploy)
set -Eeuo pipefail
export MSYS_NO_PATHCONV=1
host_path() { if command -v cygpath >/dev/null; then cygpath -m "$1"; else printf '%s' "$1"; fi; }
repo=$(host_path "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)")
docker build --quiet --tag emucat-deploy-test "$repo/deploy/test" >/dev/null
node_test=(node --disable-warning=ExperimentalWarning --test --test-concurrency=1)
docker run --rm --volume "$repo:/src:ro" --workdir /src emucat-deploy-test \
  "${node_test[@]}" 'apps/deployer/integration/*.test.ts'
docker run --rm --user root --volume "$repo:/src:ro" --workdir /src emucat-deploy-test \
  "${node_test[@]}" apps/deployer/integration/install.test.ts
