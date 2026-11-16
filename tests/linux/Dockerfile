# Disposable Ubuntu 26.04 validation image. Build context is `git archive HEAD`
# (tracked files only: no node_modules, dist, untracked files, credentials or home dir).
FROM ubuntu:26.04
ARG NODE_VERSION=22.23.5
ARG NODE_SHA256=cdeb8670a0c81f51b4dc4ac61919f9b1ad917b304bf8221eb939570663d240f8
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl xz-utils python3 python3-venv bubblewrap gcc libc6-dev iproute2 procps \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSLo /tmp/node.tar.xz "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
    && echo "${NODE_SHA256}  /tmp/node.tar.xz" | sha256sum -c - \
    && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 --no-same-owner \
    && rm /tmp/node.tar.xz \
    && (id ubuntu >/dev/null 2>&1 && userdel -r ubuntu || true) \
    && useradd --create-home --uid 1001 linux-test \
    && mkdir /work && chown linux-test:linux-test /work
# The strict contained-ACP launcher only runs a root-owned /usr/bin/node (a real file, not a
# symlink into /usr/local), so install the verified tarball binary there too.
RUN install -m 755 -o root -g root /usr/local/bin/node /usr/bin/node
# Ubuntu's Debian-patched pip wheel (/usr/share/python-wheels) loads /etc/ssl/certs at import,
# which the offline sandbox deliberately does not mount, so it cannot run there. Provide the
# upstream wheel (pinned checksum) where the executor looks first, as python.org builds do.
ARG PIP_WHEEL=pip-25.3-py3-none-any.whl
ARG PIP_URL=https://files.pythonhosted.org/packages/44/3c/d717024885424591d5376220b5e836c2d5293ce2011523c9de23ff7bf068/pip-25.3-py3-none-any.whl
ARG PIP_SHA256=9655943313a94722b7774661c21049070f6bbb0a1516bf02f7c8d5d9201514cd
RUN d="$(python3 -c 'import sys;print(sys.base_prefix+"/lib/python%d.%d/ensurepip/_bundled"%sys.version_info[:2])')" \
    && mkdir -p "$d" && curl -fsSLo "$d/$PIP_WHEEL" "$PIP_URL" \
    && echo "$PIP_SHA256  $d/$PIP_WHEEL" | sha256sum -c - && chmod 644 "$d/$PIP_WHEEL"
USER linux-test
ENV HOME=/home/linux-test CI=1 npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false
WORKDIR /work
COPY --chown=linux-test:linux-test . /work
# Network is available only here (image build): dependency installation.
RUN node --version && npm ci
