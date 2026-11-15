# Disposable Ubuntu 26.04 validation image. Build context is `git archive HEAD`
# (tracked files only: no node_modules, dist, untracked files, credentials or home dir).
FROM ubuntu:26.04
ARG NODE_VERSION=22.23.5
ARG NODE_SHA256=cdeb8670a0c81f51b4dc4ac61919f9b1ad917b304bf8221eb939570663d240f8
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl xz-utils python3 python3-venv bubblewrap gcc libc6-dev \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSLo /tmp/node.tar.xz "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
    && echo "${NODE_SHA256}  /tmp/node.tar.xz" | sha256sum -c - \
    && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 --no-same-owner \
    && rm /tmp/node.tar.xz \
    && (id ubuntu >/dev/null 2>&1 && userdel -r ubuntu || true) \
    && useradd --create-home --uid 1001 linux-test \
    && mkdir /work && chown linux-test:linux-test /work
USER linux-test
ENV HOME=/home/linux-test CI=1 npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false
WORKDIR /work
COPY --chown=linux-test:linux-test . /work
# Network is available only here (image build): dependency installation.
RUN node --version && npm ci
