# The Linux environment for the deployment tests: real bash, Git, flock and Node.js, with fake docker,
# mariadb, mariadb-dump and curl first on the PATH. Nothing in it can reach a real Docker daemon or
# database. Run with `pnpm test:deploy`.
FROM node:22.22.3-bookworm-slim
RUN apt-get update \
    && apt-get install --yes --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --chmod=0755 fakes/ /usr/local/bin/
USER node
RUN git config --global user.email test@example.invalid \
    && git config --global user.name "EmuCat deployment tests" \
    && git config --global init.defaultBranch main
WORKDIR /src
