#!/usr/bin/env bash
#
# Provision a dsh web deployment on a Linux host, running the
# instance-runtimes overlay behind an nginx reverse proxy.
#
# Run this ON the deployment host. It is idempotent: rerun it to redeploy a
# newer commit onto the same paths.
#
# No credential is ever accepted as an argument. A private-source token is
# read from stdin, and the model key lives only in DSH_ENV_FILE on the host.
#
# Required:
#   DSH_SOURCE_URL      tarball URL of the source tree to deploy, or
#   DSH_SOURCE_GIT      git URL to clone (DSH_SOURCE_REF selects the ref)
#   DSH_PUBLIC_HOST     public hostname or bare IP the browser addresses
#
# Optional:
#   DSH_ROOT            checkout root                 (default /srv/dsh/app)
#   DSH_STATE           harness state root            (default /srv/dsh/home)
#   DSH_ENV_FILE        credential file               (default /srv/dsh/etc/dsh.env)
#   DSH_PORT            loopback port dsh listens on  (default 3082)
#   DSH_LISTEN_PORT     public nginx port             (default 80)
#   DSH_RUN_USER        service account               (default current user)
#   NODE_PREFIX         Node install prefix           (default /opt/node22)
#   NODE_VERSION        Node tag, >=22.19             (default v22.22.2)
#   NPM_REGISTRY        registry mirror               (default https://registry.npmjs.org)
#   DSH_COMMIT          source commit; required when the tree has no .git
#   DSH_BUILD_HEAP_MB   V8 old-space cap for the build (default 4096)
#
# A source tarball is the fallback when the host cannot reach a git remote:
# some networks block github.com while codeload.github.com and api.github.com
# still answer, and the GitHub tarball API serves private repositories to a
# token supplied on stdin.
set -euo pipefail

DSH_ROOT="${DSH_ROOT:-/srv/dsh/app}"
DSH_STATE="${DSH_STATE:-/srv/dsh/home}"
DSH_ENV_FILE="${DSH_ENV_FILE:-/srv/dsh/etc/dsh.env}"
DSH_PORT="${DSH_PORT:-3082}"
DSH_LISTEN_PORT="${DSH_LISTEN_PORT:-80}"
DSH_RUN_USER="${DSH_RUN_USER:-$(id -un)}"
NODE_PREFIX="${NODE_PREFIX:-/opt/node22}"
NODE_VERSION="${NODE_VERSION:-v22.22.2}"
NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmjs.org}"
DSH_BUILD_HEAP_MB="${DSH_BUILD_HEAP_MB:-4096}"

: "${DSH_PUBLIC_HOST:?set DSH_PUBLIC_HOST to the authority the browser addresses}"

TEMPLATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

say() { printf '\n== %s\n' "$1"; }

say "Node ${NODE_VERSION} at ${NODE_PREFIX}"
# Installed beside the distro's Node rather than over it: other services on a
# shared host keep whatever /usr/bin/node they were built against.
if [ ! -x "${NODE_PREFIX}/bin/node" ]; then
  curl -fsSL --retry 3 -o /tmp/dsh-node.tar.xz \
    "https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-linux-x64.tar.xz"
  sudo mkdir -p "${NODE_PREFIX}"
  sudo tar -xJf /tmp/dsh-node.tar.xz -C "${NODE_PREFIX}" --strip-components=1
  rm -f /tmp/dsh-node.tar.xz
fi
export PATH="${NODE_PREFIX}/bin:${PATH}"
node --version

say "source tree at ${DSH_ROOT}"
sudo mkdir -p "$(dirname "${DSH_ROOT}")"
sudo chown "${DSH_RUN_USER}" "$(dirname "${DSH_ROOT}")"
if [ -n "${DSH_SOURCE_GIT:-}" ]; then
  rm -rf "${DSH_ROOT}"
  git clone --depth 1 ${DSH_SOURCE_REF:+--branch "${DSH_SOURCE_REF}"} "${DSH_SOURCE_GIT}" "${DSH_ROOT}"
elif [ -n "${DSH_SOURCE_URL:-}" ]; then
  # Any token arrives on stdin so it stays out of argv and shell history.
  TOKEN=''
  if [ ! -t 0 ]; then IFS= read -r TOKEN || true; fi
  rm -rf "${DSH_ROOT}" && mkdir -p "${DSH_ROOT}"
  curl -fsSL --retry 3 ${TOKEN:+-H "Authorization: Bearer ${TOKEN}"} \
    -o /tmp/dsh-src.tar.gz "${DSH_SOURCE_URL}"
  unset TOKEN
  tar -xzf /tmp/dsh-src.tar.gz -C "${DSH_ROOT}" --strip-components=1
  rm -f /tmp/dsh-src.tar.gz
else
  echo "provision-remote: set DSH_SOURCE_GIT or DSH_SOURCE_URL" >&2
  exit 2
fi

say "install and build"
cd "${DSH_ROOT}"
PNPM_VERSION="$(node -p "require('./package.json').packageManager.split('@')[1]")"
if [ "$("${NODE_PREFIX}/bin/pnpm" --version 2>/dev/null || true)" != "${PNPM_VERSION}" ]; then
  sudo "${NODE_PREFIX}/bin/node" "${NODE_PREFIX}/lib/node_modules/npm/bin/npm-cli.js" \
    install -g --prefix "${NODE_PREFIX}" --registry="${NPM_REGISTRY}" "pnpm@${PNPM_VERSION}"
fi

# CI=true keeps the repository's Git-hook installer out of a deployment tree.
export CI=true
export npm_config_registry="${NPM_REGISTRY}"
pnpm install --frozen-lockfile

# The client build stamps the source commit and reads it from Git; a tree
# unpacked from a tarball has no .git, so the commit must be supplied.
if [ ! -d "${DSH_ROOT}/.git" ]; then
  : "${DSH_COMMIT:?set DSH_COMMIT when deploying a tree without .git}"
  export DSH_CLIENT_COMMIT_HASH="${DSH_COMMIT}"
fi
# tsc needs well over a small host's default old-space cap across this workspace.
NODE_OPTIONS="--max-old-space-size=${DSH_BUILD_HEAP_MB}" pnpm run build

say "service state and credentials"
mkdir -p "${DSH_STATE}" "$(dirname "${DSH_ENV_FILE}")"
chmod 700 "$(dirname "${DSH_ENV_FILE}")"
if [ ! -f "${DSH_ENV_FILE}" ]; then
  cat > "${DSH_ENV_FILE}" <<'ENVEOF'
# Environment for the dsh-web service. Host-local; never commit this file.
#
# ACTION REQUIRED: the model credential is not configured. Uncomment the line
# below, paste a real key, then: sudo systemctl restart dsh-web
# The control plane and browser UI start without it; a key is needed only to
# drive a conversation.
#
#DEEPSEEK_API_KEY=
#DEEPSEEK_BASE_URL=https://api.deepseek.com
ENVEOF
  chmod 600 "${DSH_ENV_FILE}"
fi

say "systemd unit"
sed -e "s#__DSH_ROOT__#${DSH_ROOT}#g" \
    -e "s#__DSH_HOME__#${DSH_STATE}#g" \
    -e "s#__DSH_ENV_FILE__#${DSH_ENV_FILE}#g" \
    -e "s#__NODE_BIN_DIR__#${NODE_PREFIX}/bin#g" \
    -e "s#__RUN_USER__#${DSH_RUN_USER}#g" \
    -e "s#__PUBLIC_AUTHORITY__#${DSH_PUBLIC_HOST}#g" \
    "${TEMPLATE_DIR}/systemd/dsh-web.service.template" > /tmp/dsh-web.service
sudo install -m 644 -o root -g root /tmp/dsh-web.service /etc/systemd/system/dsh-web.service
rm -f /tmp/dsh-web.service
sudo systemctl daemon-reload
sudo systemctl enable dsh-web
sudo systemctl restart dsh-web

say "nginx reverse proxy"
HTPASSWD="${DSH_HTPASSWD:-/etc/nginx/dsh.htpasswd}"
if [ ! -f "${HTPASSWD}" ]; then
  echo "provision-remote: create ${HTPASSWD} first, e.g." >&2
  echo "  printf '%s:%s\\n' USER \"\$(openssl passwd -apr1)\" | sudo tee ${HTPASSWD}" >&2
  exit 2
fi
# The z- prefix keeps existing sites first, preserving their default-server role.
sed -e "s#__PUBLIC_HOST__#${DSH_PUBLIC_HOST%%:*}#g" \
    -e "s#__LISTEN_PORT__#${DSH_LISTEN_PORT}#g" \
    -e "s#__UPSTREAM__#127.0.0.1:${DSH_PORT}#g" \
    -e "s#__HTPASSWD__#${HTPASSWD}#g" \
    "${TEMPLATE_DIR}/nginx/dsh-web.conf.template" > /tmp/zz-dsh.conf
sudo install -m 644 -o root -g root /tmp/zz-dsh.conf /etc/nginx/sites-enabled/zz-dsh.conf
rm -f /tmp/zz-dsh.conf
sudo nginx -t
sudo systemctl reload nginx

say "done"
printf 'service : systemctl status dsh-web\n'
printf 'logs    : journalctl -u dsh-web -f\n'
printf 'url     : http://%s:%s/\n' "${DSH_PUBLIC_HOST%%:*}" "${DSH_LISTEN_PORT}"
