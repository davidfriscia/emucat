# syntax=docker/dockerfile:1.7
#
# Production image of the EmuCat API (Fastify). Build from the repository root:
#
#   docker build -f deploy/docker/api.Dockerfile -t emucat-api:local .
#
# Stages: `deps` installs the workspace from the lockfile, `build` compiles contracts and API, `verify`
# runs the checks that need no database (used by the update procedure), `prod` keeps only production
# dependencies, and `runtime` is the image that runs.

ARG NODE_IMAGE=node:22.22.3-bookworm-slim

FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    CI=true
ENV PATH=$PNPM_HOME:$PATH
WORKDIR /src
# The exact pnpm version from package.json's packageManager field.
COPY package.json ./
RUN corepack enable && corepack install

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/contracts/package.json packages/contracts/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/deployer/package.json apps/deployer/
RUN --mount=type=cache,id=emucat-pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @emucat/api... --filter @emucat/contracts

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/contracts packages/contracts
COPY apps/api apps/api
RUN pnpm --filter @emucat/contracts build && pnpm --filter @emucat/api build

# Checks that need no database. The API's own tests need a MariaDB root account and run in development
# and CI instead; see docs/deployment.md.
FROM build AS verify
RUN pnpm --filter @emucat/contracts check \
    && pnpm --filter @emucat/api check \
    && pnpm --filter @emucat/contracts test \
    && pnpm --filter @emucat/api exec vitest run test/config.test.ts test/auth-units.test.ts \
       test/system-routes.test.ts test/media-decoders.test.ts test/deployment-units.test.ts \
    && touch /verified

FROM build AS prod
RUN --mount=type=cache,id=emucat-pnpm-store,target=/pnpm/store \
    pnpm --filter @emucat/api --prod deploy --legacy /prod/api \
    && rm -rf /prod/api/src /prod/api/test /prod/api/e2e /prod/api/tsconfig*.json /prod/api/vitest.config.ts \
    && chmod -R u=rwX,go=rX /prod/api
# ^ The build context keeps the modes it was exported with: emucatctl extracts releases under umask 027,
#   so files arrive as 0640 and directories as 0750, which the runtime user (UID 1000, "other" to these
#   root-owned files) could neither read nor enter. Everything the API runs or reads, migrations
#   included, is made readable and traversable by all and writable by root only.

FROM ${NODE_IMAGE} AS runtime
ARG EMUCAT_COMMIT=
ARG EMUCAT_BUILD_TIME=
LABEL org.opencontainers.image.title="emucat-api" \
      org.opencontainers.image.revision="${EMUCAT_COMMIT}" \
      org.opencontainers.image.created="${EMUCAT_BUILD_TIME}" \
      info.dfri.emucat.component="api"
ENV NODE_ENV=production \
    API_HOST=0.0.0.0 \
    API_PORT=4000 \
    LOG_PRETTY=false \
    STORAGE_PATH=/data/storage \
    EMUCAT_BUILD_COMMIT=${EMUCAT_COMMIT} \
    EMUCAT_BUILD_TIME=${EMUCAT_BUILD_TIME}
# Unprivileged: UID/GID 1000 (the base image's `node` account), the homelab's application identity.
# Compose sets the same IDs from the host account that owns the media (EMUCAT_APP_USER). The application
# files stay root-owned, so the process cannot change them.
RUN mkdir -p /data/storage && chown 1000:1000 /data/storage
WORKDIR /app
COPY --from=prod --chown=root:root /prod/api ./
USER 1000:1000
EXPOSE 4000
VOLUME ["/data/storage"]
# Readiness, not just liveness: healthy means the database answers and the schema matches this build.
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=4 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:4000/api/v1/ready').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
# server.ts handles SIGTERM itself: it stops accepting, closes agent sockets and the pool, then exits.
STOPSIGNAL SIGTERM
CMD ["node", "dist/server.js"]
