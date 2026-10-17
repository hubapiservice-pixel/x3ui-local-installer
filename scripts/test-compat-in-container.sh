#!/usr/bin/env bash
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl openssl >/dev/null

export X3UI_BASE_URL="http://193.134.210.145:18086/v3.9.0-xray-26.3.27"
export X3UI_PUBLIC_HOST="127.0.0.1"
export X3UI_INSTALL_DIR="/opt/x3ui/app"
export X3UI_SKIP_SYSTEMD=1

bash /release/bootstrap.sh >/tmp/x3ui-install-test.log
grep -qx 'INSTALL_SUCCESS=1' /tmp/x3ui-install-test.log
grep -qx 'X3UI_CORE_VERSION=26.3.27' /tmp/x3ui-install-test.log
test "$(sha256sum "$X3UI_INSTALL_DIR/bin/xray-linux-amd64" | cut -d ' ' -f 1)" = \
  '8255dd939c34cf966cc91517b6324dd3c8d0bcf49ffac8beca049a38c46845ed'
"$X3UI_INSTALL_DIR/bin/xray-linux-amd64" version | grep -q '^Xray 26.3.27 '
grep -qx 'X3UI_CORE_VERSION=26.3.27' /etc/x-ui/install-result.env

X3UI_ROLLBACK=1 bash /release/bootstrap.sh | grep -qx 'ROLLBACK_SUCCESS=1'
test ! -e "$X3UI_INSTALL_DIR"
test ! -e /etc/x-ui
test ! -e /etc/x3ui-bootstrap
test ! -e /usr/bin/x-ui
printf 'COMPAT_INSTALL_ROLLBACK_OK\n'
