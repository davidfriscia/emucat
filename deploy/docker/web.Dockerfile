# syntax=docker/dockerfile:1.7
#
# Production image of the EmuCat web application: the Vite build, served by an unprivileged nginx that
# also forwards /api (REST and WebSocket) to the API container. Build from the repository root:
#
#   docker build -f deploy/docker/web.Dockerfile -t emucat-web:local .

ARG NODE_IMAGE=node:22.22.3-bookworm-slim
ARG NGINX_IMAGE=nginxinc/nginx-unprivileged:1.28.0-alpine

FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    CI=true
ENV PATH=$PNPM_HOME:$PATH
WORKDIR /src
COPY package.json ./
RUN corepack enable && corepack install

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/contracts/package.json packages/contracts/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/deployer/package.json apps/deployer/
RUN --mount=type=cache,id=emucat-pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @emucat/web... --filter @emucat/contracts

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/contracts packages/contracts
COPY apps/web apps/web
# The site is readable by all whatever modes the build context had (emucatctl exports releases under
# umask 027, and Vite copies public/ with its modes): nginx runs as UID 101.
RUN pnpm --filter @emucat/contracts build && pnpm --filter @emucat/web build \
    && chmod -R u=rwX,go=rX apps/web/dist

FROM build AS verify
RUN pnpm --filter @emucat/web check && pnpm --filter @emucat/web test && touch /verified

FROM ${NGINX_IMAGE} AS runtime
ARG EMUCAT_COMMIT=
ARG EMUCAT_BUILD_TIME=
LABEL org.opencontainers.image.title="emucat-web" \
      org.opencontainers.image.revision="${EMUCAT_COMMIT}" \
      org.opencontainers.image.created="${EMUCAT_BUILD_TIME}" \
      info.dfri.emucat.component="web"
USER root
# The stock entrypoint scripts rewrite configuration files, which a read-only root filesystem forbids.
RUN rm -f /etc/nginx/conf.d/default.conf /docker-entrypoint.d/* \
    && mkdir -p /run/emucat-web && chown 101:101 /run/emucat-web
COPY --chmod=0644 deploy/docker/web/nginx.conf /etc/nginx/nginx.conf
COPY --chmod=0644 deploy/docker/web/emucat.conf /etc/nginx/conf.d/emucat.conf
COPY --chmod=0755 deploy/docker/web/40-emucat-real-ip.sh /docker-entrypoint.d/40-emucat-real-ip.sh
COPY --from=build /src/apps/web/dist /usr/share/nginx/html
USER 101
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
    CMD ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8080/healthz"]
STOPSIGNAL SIGQUIT
