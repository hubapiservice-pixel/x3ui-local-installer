#!/usr/bin/env bash
# Install a separate, removable 3X-UI compatibility instance on the test VPS.
set -euo pipefail

readonly ROOT=/opt/x3ui-compat-test-20261015
readonly UNIT=/etc/systemd/system/x-ui-compat-test.service
readonly MIRROR=http://193.134.210.145:18086/v3.9.0-xray-26.3.27
readonly PANEL_PORT=22053
readonly NODE_PORT=8443
readonly PANEL_SHA=d7cbe0bf6358ee0d2117c24fd2efb483502e411d38e2ea59bd0bf5e7a3e39390
readonly CORE_SHA=8255dd939c34cf966cc91517b6324dd3c8d0bcf49ffac8beca049a38c46845ed
readonly SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)

disable_test_subscription() {
  python3 - "$ROOT/db/x-ui.db" <<'PY'
import sqlite3
import sys

with sqlite3.connect(sys.argv[1]) as db:
    row = db.execute('SELECT id FROM settings WHERE key = ?', ('subEnable',)).fetchone()
    if row is None:
        db.execute('INSERT INTO settings (key, value) VALUES (?, ?)', ('subEnable', 'false'))
    else:
        db.execute('UPDATE settings SET value = ? WHERE id = ?', ('false', row[0]))
PY
}

if [[ ${1:-} == --repair-subscription ]]; then
  [[ $(id -u) == 0 && -f $ROOT/db/x-ui.db && -f $UNIT ]] || exit 1
  systemctl stop x-ui-compat-test.service
  cp -a "$ROOT/db/x-ui.db" "$ROOT/db/x-ui.db.before-subscription-disable"
  disable_test_subscription
  systemctl restart x-ui-compat-test.service
  sleep 5
  systemctl is-active --quiet x-ui-compat-test.service || exit 1
  systemctl is-active --quiet x-ui || exit 1
  echo 'SUBSCRIPTION_DISABLED=1'
  exit 0
fi

[[ $(id -u) == 0 ]] || { echo 'root required' >&2; exit 1; }
[[ $(uname -m) == x86_64 ]] || { echo 'x86_64 required' >&2; exit 1; }
[[ -f $SCRIPT_DIR/repair-compat-xray-ports.py ]] || {
  echo 'companion repair-compat-xray-ports.py is required' >&2
  exit 1
}
[[ ! -e $ROOT && ! -e $UNIT ]] || { echo 'test instance already exists' >&2; exit 1; }
systemctl is-active --quiet x-ui || { echo 'original x-ui is not active' >&2; exit 1; }
for port in "$PANEL_PORT" "$NODE_PORT"; do
  if ss -ltnH "sport = :$port" | grep -q .; then
    echo "port $port is occupied" >&2
    exit 1
  fi
done

original_db_sha=$(sha256sum /etc/x-ui/x-ui.db | cut -d ' ' -f 1)
tmp=$(mktemp -d)
created=0
finished=0
cleanup() {
  status=$?
  rm -rf "$tmp"
  if (( finished == 0 && created == 1 )); then
    systemctl disable --now x-ui-compat-test.service >/dev/null 2>&1 || true
    rm -f "$UNIT"
    systemctl daemon-reload || true
    rm -rf "$ROOT"
  fi
  exit "$status"
}
trap cleanup EXIT

curl -fLsS --retry 3 --connect-timeout 15 "$MIRROR/x-ui-linux-amd64.tar.gz" -o "$tmp/x-ui.tar.gz"
printf '%s  %s\n' "$PANEL_SHA" "$tmp/x-ui.tar.gz" | sha256sum -c - >/dev/null
curl -fLsS --retry 3 --connect-timeout 15 "$MIRROR/xray-linux-amd64" -o "$tmp/xray"
printf '%s  %s\n' "$CORE_SHA" "$tmp/xray" | sha256sum -c - >/dev/null
tar -xzf "$tmp/x-ui.tar.gz" -C "$tmp"
[[ -x $tmp/x-ui/x-ui && -f $tmp/x-ui/bin/xray-linux-amd64 ]] || {
  echo 'invalid panel archive' >&2
  exit 1
}

install -d -m 700 "$ROOT"
created=1
mv "$tmp/x-ui" "$ROOT/app"
install -d -m 700 "$ROOT/db" "$ROOT/logs"
install -m 755 "$tmp/xray" "$ROOT/app/bin/xray-linux-amd64"
"$ROOT/app/bin/xray-linux-amd64" version | grep -q '^Xray 26\.3\.27 '

export XUI_DB_FOLDER="$ROOT/db"
export XUI_LOG_FOLDER="$ROOT/logs"
export XUI_BIN_FOLDER="$ROOT/app/bin"
export XUI_ENABLE_FAIL2BAN=false
panel_user=x3compat
panel_password=$(openssl rand -hex 18)
panel_path=$(openssl rand -hex 12)
"$ROOT/app/x-ui" setting \
  -username "$panel_user" -password "$panel_password" \
  -port "$PANEL_PORT" -webBasePath "$panel_path" -listenIP 127.0.0.1 >/dev/null
[[ -f $ROOT/db/x-ui.db ]] || { echo 'isolated panel database missing' >&2; exit 1; }
disable_test_subscription
[[ $(sha256sum /etc/x-ui/x-ui.db | cut -d ' ' -f 1) == "$original_db_sha" ]] || {
  echo 'original panel database changed; stopping' >&2
  exit 1
}

umask 077
printf 'PANEL_USER=%s\nPANEL_PASSWORD=%s\nPANEL_PATH=%s\n' \
  "$panel_user" "$panel_password" "$panel_path" >"$ROOT/panel.env"
cat >"$UNIT" <<EOF
[Unit]
Description=Isolated 3X-UI compatibility test
After=network.target
Wants=network.target

[Service]
Type=simple
WorkingDirectory=$ROOT/app
Environment=XUI_DB_FOLDER=$ROOT/db
Environment=XUI_LOG_FOLDER=$ROOT/logs
Environment=XUI_BIN_FOLDER=$ROOT/app/bin
Environment=XUI_ENABLE_FAIL2BAN=false
Environment=XRAY_VMESS_AEAD_FORCED=false
ExecStart=$ROOT/app/x-ui
Restart=on-failure
RestartSec=3s

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now x-ui-compat-test.service >/dev/null
for _ in {1..15}; do
  systemctl is-active --quiet x-ui-compat-test.service && \
    curl -fsS --max-time 2 "http://127.0.0.1:$PANEL_PORT/$panel_path/" -o /dev/null && break
  sleep 1
done
systemctl is-active --quiet x-ui-compat-test.service || { echo 'test service failed' >&2; exit 1; }
curl -fsS --max-time 3 "http://127.0.0.1:$PANEL_PORT/$panel_path/" -o /dev/null
python3 "$SCRIPT_DIR/repair-compat-xray-ports.py"
for _ in {1..15}; do
  if ss -ltnH "sport = :62790" | grep -q . &&
     ss -ltnH "sport = :11112" | grep -q .; then
    break
  fi
  sleep 1
done
ss -ltnH 'sport = :62790' | grep -q . || { echo 'isolated Xray API is not listening' >&2; exit 1; }
ss -ltnH 'sport = :11112' | grep -q . || { echo 'isolated Xray metrics is not listening' >&2; exit 1; }
systemctl is-active --quiet x-ui || { echo 'original service stopped' >&2; exit 1; }
[[ $(sha256sum /etc/x-ui/x-ui.db | cut -d ' ' -f 1) == "$original_db_sha" ]] || {
  echo 'original panel database changed after startup' >&2
  exit 1
}

finished=1
echo 'SIDECAR_INSTALL_OK=1'
echo 'PANEL_BIND=127.0.0.1:22053'
echo 'XRAY_VERSION=26.3.27'
