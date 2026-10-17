#!/usr/bin/env bash
# Remove only the isolated 117 compatibility test instance.
set -euo pipefail

readonly ROOT=/opt/x3ui-compat-test-20261015
readonly UNIT=/etc/systemd/system/x-ui-compat-test.service

[[ $(id -u) == 0 ]] || { echo 'root required' >&2; exit 1; }
[[ -f $ROOT/panel.env && -f $ROOT/db/x-ui.db && -f $UNIT ]] || {
  echo 'test instance marker or unit missing; refusing removal' >&2
  exit 1
}
grep -q "WorkingDirectory=$ROOT/app" "$UNIT" || {
  echo 'service unit does not match this test instance' >&2
  exit 1
}

systemctl disable --now x-ui-compat-test.service
rm -f "$UNIT"
systemctl daemon-reload
rm -rf "$ROOT"
systemctl is-active --quiet x-ui || {
  echo 'original x-ui is not active after removal' >&2
  exit 1
}
echo 'SIDECAR_REMOVED=1'
