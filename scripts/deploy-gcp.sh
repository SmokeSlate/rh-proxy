#!/usr/bin/env bash
set -euo pipefail

APP_NAME="${APP_NAME:-rh-proxy}"
APP_USER="${APP_USER:-rhproxy}"
APP_DIR="${APP_DIR:-/opt/rh-proxy}"
ENV_FILE="${ENV_FILE:-/etc/rh-proxy.env}"
REPO_URL="${REPO_URL:-https://github.com/SmokeSlate/rh-proxy.git}"
BRANCH="${BRANCH:-main}"
NODE_MAJOR="${NODE_MAJOR:-22}"
PROXY_PORT="${PROXY_PORT:-80}"
MANAGE_HOST="${MANAGE_HOST:-0.0.0.0}"
MANAGE_PORT="${MANAGE_PORT:-9999}"
UPDATE_INTERVAL="${UPDATE_INTERVAL:-5min}"
MEMORY_MAX="${MEMORY_MAX:-768M}"
SWAP_FILE="${SWAP_FILE:-/swapfile}"
SWAP_SIZE_MB="${SWAP_SIZE_MB:-1024}"
MIN_MEMORY_WITHOUT_SWAP_MB="${MIN_MEMORY_WITHOUT_SWAP_MB:-1400}"
DEFAULT_PROXY_LIST_URL="https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&proxy_format=protocolipport&format=text&protocol=http&country=af%2Cal%2Cdz%2Cad%2Cao%2Car%2Cam%2Cau%2Cat%2Caz%2Cbd%2Cby%2Cbe%2Cbj%2Cbm%2Cbt%2Cbo%2Cbw%2Cbg%2Cbf%2Cbi%2Ckh%2Ccm%2Cca%2Ctd%2Ccl%2Ccn%2Cco%2Ccg%2Ccr%2Chr%2Ccy%2Ccz%2Cdk%2Cdo%2Cec%2Ceg%2Csv%2Cgq%2Cee%2Csz%2Cet%2Cfj%2Cfi%2Cfr%2Cgm%2Cge%2Cde%2Cgh%2Cgi%2Cgr%2Cgu%2Cgt%2Cgn%2Cht%2Chn%2Chk%2Chu%2Cin%2Cid%2Cir%2Ciq%2Cie%2Cil%2Cit%2Cjm%2Cjp%2Cjo%2Ckz%2Cke%2Ckr%2Ckg%2Clv%2Clb%2Cls%2Clt%2Cmg%2Cmw%2Cmy%2Cmv%2Cml%2Cmt%2Cmu%2Cmx%2Cmd%2Cmn%2Cme%2Cma%2Cmz%2Cmm%2Cna%2Cnp%2Cnl%2Cnz%2Cni%2Cng%2Cmk%2Cno%2Cpk%2Cps%2Cpa%2Cpy%2Cpe%2Cph%2Cpl%2Cpt%2Cpr%2Cqa%2Cro%2Crw%2Ckn%2Csa%2Csn%2Crs%2Csc%2Csl%2Csg%2Csk%2Csi%2Cso%2Cza%2Ces%2Clk%2Csd%2Cse%2Cch%2Csy%2Ctw%2Ctj%2Ctz%2Cth%2Ctl%2Ctg%2Ctn%2Ctr%2Cug%2Cua%2Cae%2Cgb%2Cus%2Cuy%2Cuz%2Cve%2Cvn%2Cvi%2Cye%2Czw&timeout=251"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this script as root, for example: sudo bash scripts/deploy-gcp.sh" >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive

log() {
  printf '[rh-proxy deploy] %s\n' "$*" >&2
}

apt_install() {
  apt-get install -y --no-install-recommends "$@"
}

memory_total_mb() {
  awk '/MemTotal:/ { printf "%d\n", $2 / 1024 }' /proc/meminfo
}

swap_total_mb() {
  awk '/SwapTotal:/ { printf "%d\n", $2 / 1024 }' /proc/meminfo
}

ensure_swap() {
  local memory_mb
  local swap_mb
  memory_mb="$(memory_total_mb)"
  swap_mb="$(swap_total_mb)"

  if [[ "${memory_mb}" -ge "${MIN_MEMORY_WITHOUT_SWAP_MB}" || "${swap_mb}" -gt 0 ]]; then
    log "Memory ${memory_mb}MB, swap ${swap_mb}MB"
    return
  fi

  log "Memory is ${memory_mb}MB with no swap; creating ${SWAP_SIZE_MB}MB swap at ${SWAP_FILE}"
  if [[ ! -f "${SWAP_FILE}" ]]; then
    if command -v fallocate >/dev/null 2>&1; then
      fallocate -l "${SWAP_SIZE_MB}M" "${SWAP_FILE}" || dd if=/dev/zero of="${SWAP_FILE}" bs=1M count="${SWAP_SIZE_MB}"
    else
      dd if=/dev/zero of="${SWAP_FILE}" bs=1M count="${SWAP_SIZE_MB}"
    fi
    chmod 0600 "${SWAP_FILE}"
    mkswap "${SWAP_FILE}"
  fi

  swapon "${SWAP_FILE}" || true
  if ! grep -qE "^[^#].*[[:space:]]${SWAP_FILE//\//\\/}[[:space:]]" /etc/fstab; then
    printf '%s none swap sw 0 0\n' "${SWAP_FILE}" >>/etc/fstab
  fi
}

node_major() {
  if ! command -v node >/dev/null 2>&1; then
    echo 0
    return
  fi

  node -p "Number(process.versions.node.split('.')[0])"
}

install_node() {
  if [[ "$(node_major)" -ge 20 ]]; then
    log "Node $(node -v) already installed"
    return
  fi

  log "Installing Node.js ${NODE_MAJOR}.x"
  install -d -m 0755 /etc/apt/keyrings
  rm -f /etc/apt/keyrings/nodesource.gpg
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
  chmod 0644 /etc/apt/keyrings/nodesource.gpg
  printf 'deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_%s.x nodistro main\n' "${NODE_MAJOR}" \
    >/etc/apt/sources.list.d/nodesource.list
  apt-get update
  apt_install nodejs
}

install_chromium() {
  if command -v chromium >/dev/null 2>&1; then
    command -v chromium
    return
  fi

  if command -v chromium-browser >/dev/null 2>&1; then
    command -v chromium-browser
    return
  fi

  log "Installing Chromium"
  apt-get update
  if apt-cache show chromium >/dev/null 2>&1; then
    apt_install chromium fonts-liberation
  elif apt-cache show chromium-browser >/dev/null 2>&1; then
    apt_install chromium-browser fonts-liberation
  else
    log "Chromium package not found; installing Google Chrome stable"
    rm -f /etc/apt/keyrings/google-linux.gpg
    curl -fsSL https://dl.google.com/linux/linux_signing_key.pub \
      | gpg --dearmor -o /etc/apt/keyrings/google-linux.gpg
    chmod 0644 /etc/apt/keyrings/google-linux.gpg
    printf 'deb [arch=amd64 signed-by=/etc/apt/keyrings/google-linux.gpg] http://dl.google.com/linux/chrome/deb/ stable main\n' \
      >/etc/apt/sources.list.d/google-chrome.list
    apt-get update
    apt_install google-chrome-stable fonts-liberation
  fi

  if command -v chromium >/dev/null 2>&1; then
    command -v chromium
  elif command -v chromium-browser >/dev/null 2>&1; then
    command -v chromium-browser
  else
    command -v google-chrome
  fi
}

read_env_value() {
  local key="$1"
  local file="$2"
  if [[ ! -f "${file}" ]]; then
    return 1
  fi

  grep -E "^${key}=" "${file}" | tail -n 1 | cut -d= -f2-
}

write_env_file() {
  local chrome_path="$1"
  local token="${MANAGE_TOKEN:-}"
  if [[ -z "${token}" ]]; then
    token="$(read_env_value MANAGE_TOKEN "${ENV_FILE}" || true)"
  fi
  if [[ -z "${token}" ]]; then
    token="$(openssl rand -hex 32)"
  fi

  local outbound_proxy="${OUTBOUND_PROXY_URL:-}"
  if [[ -z "${outbound_proxy}" ]]; then
    outbound_proxy="$(read_env_value OUTBOUND_PROXY_URL "${ENV_FILE}" || true)"
  fi
  local proxy_list_url="${PROXY_LIST_URL:-}"
  if [[ -z "${proxy_list_url}" ]]; then
    proxy_list_url="$(read_env_value PROXY_LIST_URL "${ENV_FILE}" || true)"
  fi
  if [[ -z "${proxy_list_url}" ]]; then
    proxy_list_url="${DEFAULT_PROXY_LIST_URL}"
  fi

  cat >"${ENV_FILE}" <<EOF_ENV
NODE_ENV=production
HOST=0.0.0.0
PORT=${PROXY_PORT}
MANAGE_ENABLED=true
MANAGE_HOST=${MANAGE_HOST}
MANAGE_PORT=${MANAGE_PORT}
MANAGE_TOKEN=${token}
PUPPETEER_EXECUTABLE_PATH=${chrome_path}
ROUTINEHUB_API_BASE=https://routinehub.co/api/v1/
CACHE_TTL_MS=60000
MAX_CACHE_ENTRIES=200
MAX_BROWSER_PAGES=1
REQUEST_TIMEOUT_MS=30000
RATE_LIMIT_MAX=120
DIRECT_FETCH_FIRST=true
OUTBOUND_PROXY_URL=${outbound_proxy}
PROXY_LIST_URL=${proxy_list_url}
AUTO_PROXY_ENABLED=${AUTO_PROXY_ENABLED:-true}
PROXY_LIST_REFRESH_MS=${PROXY_LIST_REFRESH_MS:-600000}
PROXY_TEST_TIMEOUT_MS=${PROXY_TEST_TIMEOUT_MS:-5000}
PROXY_TEST_CANDIDATES=${PROXY_TEST_CANDIDATES:-40}
PROXY_TEST_CONCURRENCY=${PROXY_TEST_CONCURRENCY:-4}
PROXY_BAD_TTL_MS=${PROXY_BAD_TTL_MS:-1800000}
PROXY_RETRY_LIMIT=${PROXY_RETRY_LIMIT:-6}
EOF_ENV
  chmod 0600 "${ENV_FILE}"
}

install_repo() {
  if ! id -u "${APP_USER}" >/dev/null 2>&1; then
    log "Creating service user ${APP_USER}"
    useradd --system --home-dir "${APP_DIR}" --shell /usr/sbin/nologin "${APP_USER}"
  fi

  git config --global --add safe.directory "${APP_DIR}" >/dev/null 2>&1 || true

  if [[ -d "${APP_DIR}/.git" ]]; then
    log "Updating existing checkout"
    git -c safe.directory="${APP_DIR}" -C "${APP_DIR}" fetch --depth 1 origin "${BRANCH}"
    git -c safe.directory="${APP_DIR}" -C "${APP_DIR}" checkout -q "${BRANCH}" || true
    git -c safe.directory="${APP_DIR}" -C "${APP_DIR}" reset --hard "origin/${BRANCH}"
  else
    log "Cloning ${REPO_URL}"
    rm -rf "${APP_DIR}"
    git clone --depth 1 --branch "${BRANCH}" "${REPO_URL}" "${APP_DIR}"
  fi

  chown -R "${APP_USER}:${APP_USER}" "${APP_DIR}"
}

install_dependencies() {
  log "Installing production npm dependencies"
  sudo -u "${APP_USER}" \
    env HOME="${APP_DIR}" npm --prefix "${APP_DIR}" ci --omit=dev --no-audit --no-fund
  sudo -u "${APP_USER}" \
    env HOME="${APP_DIR}" node --check "${APP_DIR}/server.js"
}

write_service() {
  cat >/etc/systemd/system/${APP_NAME}.service <<EOF_SERVICE
[Unit]
Description=RoutineHub Proxy
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${APP_USER}
Group=${APP_USER}
WorkingDirectory=${APP_DIR}
EnvironmentFile=${ENV_FILE}
ExecStart=/usr/bin/node ${APP_DIR}/server.js
Restart=on-failure
RestartSec=3
TimeoutStopSec=15
KillSignal=SIGTERM
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true
ReadWritePaths=${APP_DIR}
MemoryMax=${MEMORY_MAX}
TasksMax=128

[Install]
WantedBy=multi-user.target
EOF_SERVICE
}

write_updater() {
  cat >/usr/local/bin/${APP_NAME}-update <<EOF_UPDATE
#!/usr/bin/env bash
set -euo pipefail

APP_NAME="${APP_NAME}"
APP_USER="${APP_USER}"
APP_DIR="${APP_DIR}"
BRANCH="${BRANCH}"

exec 9>/run/\${APP_NAME}-update.lock
flock -n 9 || exit 0

cd "\${APP_DIR}"
git_safe() {
  git -c safe.directory="\${APP_DIR}" "\$@"
}

current="\$(git_safe rev-parse HEAD)"
git_safe fetch --quiet --depth 1 origin "\${BRANCH}"
latest="\$(git_safe rev-parse "origin/\${BRANCH}")"

if [[ "\${current}" == "\${latest}" ]]; then
  exit 0
fi

logger -t "\${APP_NAME}-update" "Updating from \${current} to \${latest}"
git_safe reset --hard "\${latest}"
chown -R "\${APP_USER}:\${APP_USER}" "\${APP_DIR}"
sudo -u "\${APP_USER}" env HOME="\${APP_DIR}" npm --prefix "\${APP_DIR}" ci --omit=dev --no-audit --no-fund
sudo -u "\${APP_USER}" env HOME="\${APP_DIR}" node --check "\${APP_DIR}/server.js"
systemctl restart "\${APP_NAME}.service"
logger -t "\${APP_NAME}-update" "Updated to \${latest}"
EOF_UPDATE
  chmod 0755 /usr/local/bin/${APP_NAME}-update

  cat >/etc/systemd/system/${APP_NAME}-update.service <<EOF_UPDATE_SERVICE
[Unit]
Description=Update RoutineHub Proxy from GitHub
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/bin/${APP_NAME}-update
EOF_UPDATE_SERVICE

  cat >/etc/systemd/system/${APP_NAME}-update.timer <<EOF_UPDATE_TIMER
[Unit]
Description=Periodically update RoutineHub Proxy from GitHub

[Timer]
OnBootSec=2min
OnUnitActiveSec=${UPDATE_INTERVAL}
AccuracySec=30s
Persistent=true
Unit=${APP_NAME}-update.service

[Install]
WantedBy=timers.target
EOF_UPDATE_TIMER
}

main() {
  log "Installing OS packages"
  apt-get update
  apt_install ca-certificates curl git gnupg openssl sudo util-linux
  ensure_swap
  install_node
  chrome_path="$(install_chromium | tail -n 1)"
  log "Using Chromium at ${chrome_path}"

  install_repo
  write_env_file "${chrome_path}"
  install_dependencies
  write_service
  write_updater

  systemctl daemon-reload
  systemctl enable "${APP_NAME}.service"
  systemctl restart "${APP_NAME}.service"
  systemctl enable --now "${APP_NAME}-update.timer"

  manage_token="$(read_env_value MANAGE_TOKEN "${ENV_FILE}")"

  log "Service status:"
  systemctl --no-pager --full status "${APP_NAME}.service" || true

  cat <<EOF_DONE

RoutineHub Proxy is installed.

Proxy:
  http://<instance-ip>:${PROXY_PORT}

Management UI:
  http://<instance-ip>:${MANAGE_PORT}/?token=${manage_token}

Updater:
  systemctl status ${APP_NAME}-update.timer
  journalctl -u ${APP_NAME}-update.service -n 100 --no-pager

If external access fails, open these GCP firewall ports:
  tcp:${PROXY_PORT}
  tcp:${MANAGE_PORT}

EOF_DONE
}

main "$@"
