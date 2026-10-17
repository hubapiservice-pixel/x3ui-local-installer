#!/usr/bin/env bash
# Offline 3X-UI bootstrap. Assets must already be uploaded over SSH.
set -euo pipefail

readonly RELEASE_VERSION="3.9.0"
readonly CORE_VERSION="26.3.27"
readonly MANAGED_DIR="/etc/x3ui-bootstrap"
readonly MANAGED_FILE="${MANAGED_DIR}/managed.env"

ASSET_DIR="${X3UI_LOCAL_ASSET_DIR:-}"
PUBLIC_HOST="${X3UI_PUBLIC_HOST:-}"
PANEL_PORT="${X3UI_PANEL_PORT:-2053}"
INSTALL_DIR="${X3UI_INSTALL_DIR:-/usr/local/x-ui}"
SKIP_SYSTEMD="${X3UI_SKIP_SYSTEMD:-0}"
ROLLBACK="${X3UI_ROLLBACK:-0}"

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

require_root() {
  [[ "$(id -u)" == "0" ]] || fail "请使用 root 执行安装。"
}

validate_input() {
  [[ "$ASSET_DIR" =~ ^/[A-Za-z0-9._/-]+$ && "$ASSET_DIR" != *".."* && -d "$ASSET_DIR" ]] || fail "上传文件目录无效。"
  [[ "$PANEL_PORT" =~ ^[0-9]{2,5}$ ]] && (( PANEL_PORT >= 1 && PANEL_PORT <= 65535 )) || fail "面板端口无效。"
  [[ -z "$PUBLIC_HOST" || "$PUBLIC_HOST" =~ ^[A-Za-z0-9.-]+$ ]] || fail "面板主机名格式不正确。"
  [[ "$INSTALL_DIR" =~ ^/[A-Za-z0-9._/-]+$ && "$INSTALL_DIR" != "/" && "$INSTALL_DIR" != *".."* ]] || fail "安装目录格式不正确。"
}

rollback() {
  [[ -f "$MANAGED_FILE" ]] || fail "未找到本发行包的安装标记，拒绝删除未知的 x-ui 安装。"
  grep -qx 'X3UI_BOOTSTRAP_MANAGED=1' "$MANAGED_FILE" || fail "安装标记不匹配，拒绝删除。"

  if [[ "$SKIP_SYSTEMD" != "1" ]] && command -v systemctl >/dev/null 2>&1; then
    systemctl disable --now x-ui >/dev/null 2>&1 || true
  fi
  rm -f /etc/systemd/system/x-ui.service /usr/bin/x-ui /etc/x-ui/install-result.env
  rm -rf "$INSTALL_DIR" /etc/x-ui "$MANAGED_DIR"
  if [[ "$SKIP_SYSTEMD" != "1" ]] && command -v systemctl >/dev/null 2>&1; then
    systemctl daemon-reload
  fi
  printf 'ROLLBACK_SUCCESS=1\n'
}

if [[ "$ROLLBACK" == "1" ]]; then
  require_root
  rollback
  exit 0
fi

require_root
validate_input
command -v cp >/dev/null 2>&1 || fail "缺少 cp。"
command -v tar >/dev/null 2>&1 || fail "缺少 tar。"
command -v sha256sum >/dev/null 2>&1 || fail "缺少 sha256sum。"
command -v openssl >/dev/null 2>&1 || fail "缺少 openssl。"

for protected_path in "$INSTALL_DIR" /usr/bin/x-ui /etc/systemd/system/x-ui.service; do
  [[ ! -e "$protected_path" ]] || fail "检测到已有 3X-UI 相关文件 (${protected_path})，为保护现有服务已拒绝覆盖。"
done
[[ ! -f /etc/x-ui/x-ui.db && ! -f /etc/x-ui/install-result.env ]] || fail "检测到已有 3X-UI 配置数据，为保护现有服务已拒绝覆盖。"

case "$(uname -m)" in
  x86_64|amd64) asset="x-ui-linux-amd64.tar.gz"; expected_sha="d7cbe0bf6358ee0d2117c24fd2efb483502e411d38e2ea59bd0bf5e7a3e39390"; core_asset="xray-linux-amd64"; core_sha="8255dd939c34cf966cc91517b6324dd3c8d0bcf49ffac8beca049a38c46845ed" ;;
  aarch64|arm64) asset="x-ui-linux-arm64.tar.gz"; expected_sha="9a2e43c976a2e71618a30d8f38b52476b25ed363c6989599e2f625cc52f51a81"; core_asset="xray-linux-arm64"; core_sha="c2d20a7045250497083afea0d79db0672f6c89a25aaaf37c92de034d6b764b04" ;;
  *) fail "不支持的 CPU 架构: $(uname -m)" ;;
esac

tmp_dir="$(mktemp -d)"
cleanup() { rm -rf "$tmp_dir"; }
trap cleanup EXIT

printf '正在校验已上传的 %s %s\n' "$RELEASE_VERSION" "$asset"
cp -- "$ASSET_DIR/$asset" "$tmp_dir/$asset"
printf '%s  %s\n' "$expected_sha" "$tmp_dir/$asset" | sha256sum -c -

tar -xzf "$tmp_dir/$asset" -C "$tmp_dir"
[[ -f "$tmp_dir/x-ui/x-ui" ]] || fail "发行包结构无效：缺少 x-ui 二进制文件。"
[[ -f "$tmp_dir/x-ui/x-ui.sh" ]] || fail "发行包结构无效：缺少 x-ui 命令包装器。"
chmod +x "$tmp_dir/x-ui/x-ui" "$tmp_dir/x-ui/x-ui.sh"
find "$tmp_dir/x-ui/bin" -maxdepth 1 -type f \( -name 'xray-linux-*' -o -name 'mtg-linux-*' \) -exec chmod +x {} +

printf '正在校验已上传的 Xray %s %s\n' "$CORE_VERSION" "$core_asset"
cp -- "$ASSET_DIR/$core_asset" "$tmp_dir/$core_asset"
printf '%s  %s\n' "$core_sha" "$tmp_dir/$core_asset" | sha256sum -c -
install -m 755 "$tmp_dir/$core_asset" "$tmp_dir/x-ui/bin/$core_asset"
core_output="$("$tmp_dir/x-ui/bin/$core_asset" version)"
[[ "$core_output" == "Xray ${CORE_VERSION} "* ]] || fail "内核版本校验失败。"

install -d "$(dirname "$INSTALL_DIR")"
install -d -m 700 "$MANAGED_DIR" /etc/x-ui
mv "$tmp_dir/x-ui" "$INSTALL_DIR"
install -m 755 "$INSTALL_DIR/x-ui.sh" /usr/bin/x-ui

panel_user="x3admin"
panel_password="$(openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c 24)"
panel_path="$(openssl rand -hex 12)"
[[ ${#panel_password} -ge 20 ]] || fail "无法生成安全的面板密码。"

"$INSTALL_DIR/x-ui" setting -username "$panel_user" -password "$panel_password" -port "$PANEL_PORT" -webBasePath "$panel_path" >/dev/null

[[ -f "$INSTALL_DIR/x-ui.service.debian" ]] || fail "发行包结构无效：缺少 Debian 服务单元。"
sed "s|/usr/local/x-ui|${INSTALL_DIR}|g" "$INSTALL_DIR/x-ui.service.debian" >/etc/systemd/system/x-ui.service

panel_host="${PUBLIC_HOST:-<server-ip>}"
cat >"$MANAGED_FILE" <<EOF
X3UI_BOOTSTRAP_MANAGED=1
X3UI_RELEASE_VERSION=${RELEASE_VERSION}
X3UI_CORE_VERSION=${CORE_VERSION}
X3UI_INSTALL_DIR=${INSTALL_DIR}
EOF
cat >/etc/x-ui/install-result.env <<EOF
PANEL_URL=http://${panel_host}:${PANEL_PORT}/${panel_path}
PANEL_PORT=${PANEL_PORT}
PANEL_PATH=${panel_path}
PANEL_USERNAME=${panel_user}
PANEL_PASSWORD=${panel_password}
X3UI_RELEASE_VERSION=${RELEASE_VERSION}
X3UI_CORE_VERSION=${CORE_VERSION}
EOF
chmod 600 /etc/x-ui/install-result.env

if [[ "$SKIP_SYSTEMD" == "1" ]]; then
  printf 'SYSTEMD_SKIPPED=1\n'
else
  command -v systemctl >/dev/null 2>&1 || fail "当前系统没有 systemctl，无法托管面板服务。"
  systemctl daemon-reload
  systemctl enable --now x-ui
  systemctl is-active --quiet x-ui || fail "x-ui 服务未能启动。"
fi

printf 'INSTALL_SUCCESS=1\n'
printf 'X3UI_RELEASE_VERSION=%s\n' "$RELEASE_VERSION"
printf 'X3UI_CORE_VERSION=%s\n' "$CORE_VERSION"
