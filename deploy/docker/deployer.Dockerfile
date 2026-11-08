# syntax=docker/dockerfile:1.7
#
# Builds the EmuCat deployment service into plain JavaScript. It is not an image that runs: the service
# runs on the host under systemd, and `emucatctl install` exports the `artifact` stage into
# EMUCAT_ROOT/tooling/deployer:
#
#   docker build -f deploy/docker/deployer.Dockerfile --target artifact --output type=local,dest=out .
#
# The host then needs only Node.js 22, with or without its TypeScript support: no global packages, no
# TypeScript runner, no node_modules.

ARG NODE_IMAGE=node:22.22.3-bookworm-slim

FROM ${NODE_IMAGE} AS build
ENV PNPM_HOME=/pnpm \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    CI=true
ENV PATH=$PNPM_HOME:$PATH
WORKDIR /src
COPY package.json ./
RUN corepack enable && corepack install
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/contracts/package.json packages/contracts/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/deployer/package.json apps/deployer/
RUN --mount=type=cache,id=emucat-pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @emucat/deployer
COPY tsconfig.base.json ./
COPY apps/deployer apps/deployer
# Compile (which type-checks the sources), then prove the output loads with TypeScript support switched
# off, as on a Node.js built without it: every module must parse, and main.js must get as far as reading
# its configuration.
RUN pnpm --filter @emucat/deployer build \
    && cd apps/deployer/dist \
    && for file in *.js; do node --no-experimental-strip-types --check "$file"; done \
    && ! find . -name '*.ts' | grep . \
    && EMUCAT_DEPLOY_CONFIG=/nonexistent/deploy.env node --no-experimental-strip-types main.js 2>&1 \
       | grep -q 'DeployerConfigError: Cannot read /nonexistent/deploy.env'

FROM scratch AS artifact
COPY --from=build /src/apps/deployer/dist/ /
