# The Linux environment for the deployment tests: real bash, Git, flock, runuser, ssh-keygen and Node.js,
# with fake docker, systemctl, mariadb, mariadb-dump and curl first on the PATH. Nothing in it can reach a
# real Docker daemon, systemd or database. Run with `pnpm test:deploy`.
#
# The accounts exist as on a prepared server (david is UID/GID 1000, sharing the IDs of the image's
# `node` account), there is no account with UID 10001, and nothing exists under /opt/emucat, so that the
# installation test (run as root) starts from a fresh host. Everything else runs as `node`.
FROM node:22.22.3-bookworm-slim
RUN apt-get update \
    && apt-get install --yes --no-install-recommends git ca-certificates openssh-client \
    && rm -rf /var/lib/apt/lists/*
RUN groupadd --system docker \
    && groupadd --system emucat-socket \
    && useradd --system --user-group --no-create-home --home-dir /opt/emucat/state/home \
       --groups docker,emucat-socket --shell /usr/sbin/nologin emucat-deploy \
    && groupadd --non-unique --gid 1000 david \
    && useradd --non-unique --uid 1000 --gid 1000 --no-create-home --shell /usr/sbin/nologin david \
    && mkdir -p /etc/systemd/system \
    && test ! -e /opt/emucat \
    && ! getent passwd 10001
COPY --chmod=0755 fakes/ /usr/local/bin/
USER node
RUN git config --global user.email test@example.invalid \
    && git config --global user.name "EmuCat deployment tests" \
    && git config --global init.defaultBranch main
WORKDIR /src
