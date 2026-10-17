export const REMOVE_SCRIPT = `set -Eeuo pipefail
umask 077

marker=/etc/x3ui-bootstrap/managed.env
backup_dir=/root/x3ui-installer-backups
test -f "$marker" && test ! -L "$marker"
grep -qx X3UI_BOOTSTRAP_MANAGED=1 "$marker"
grep -qx X3UI_INSTALL_DIR=/usr/local/x-ui "$marker"
for item in /etc/x3ui-bootstrap /etc/x-ui /usr/local/x-ui; do
  test -d "$item" && test ! -L "$item"
done
test -f /etc/x-ui/install-result.env
test ! -L /etc/x-ui/install-result.env
test -f /etc/systemd/system/x-ui.service
test ! -L /etc/systemd/system/x-ui.service
test -f /usr/bin/x-ui
test ! -L /usr/bin/x-ui
command -v systemctl >/dev/null
command -v tar >/dev/null
command -v sha256sum >/dev/null
command -v openssl >/dev/null

install -d -m 700 "$backup_dir"
chmod 700 "$backup_dir"
backup="$backup_dir/x3ui-removal-$(date -u +%Y%m%dT%H%M%SZ)-$(openssl rand -hex 4).tar.gz"
was_active=0
was_enabled=0
if systemctl is-active --quiet x-ui; then was_active=1; fi
if systemctl is-enabled --quiet x-ui; then was_enabled=1; fi
mutating=0
backup_ready=0
restore_service_state() {
  systemctl daemon-reload || return 1
  if [ "$was_enabled" = 1 ]; then systemctl enable x-ui || return 1; else systemctl disable x-ui || return 1; fi
  if [ "$was_active" = 1 ]; then
    systemctl start x-ui && systemctl is-active --quiet x-ui
  else
    systemctl stop x-ui
  fi
}
restore_on_error() {
  code=$?
  trap - ERR
  if [ "$mutating" = 1 ]; then
    restored=1
    if [ "$backup_ready" = 1 ]; then tar -C / -xzf "$backup" || restored=0; fi
    if [ "$restored" = 1 ] && restore_service_state; then
      printf 'REMOVE_ROLLBACK=restored\n' >&2
    else
      printf 'REMOVE_ROLLBACK=failed; backup remains at %s\n' "$backup" >&2
    fi
  fi
  exit "$code"
}
trap restore_on_error ERR

mutating=1
systemctl stop x-ui
tar -C / -czf "$backup" etc/x3ui-bootstrap etc/x-ui usr/local/x-ui usr/bin/x-ui etc/systemd/system/x-ui.service
chmod 600 "$backup"
tar -tzf "$backup" >/dev/null
sha256sum "$backup" > "$backup.sha256"
chmod 600 "$backup.sha256"
sha256sum -c "$backup.sha256" >/dev/null
backup_ready=1
systemctl disable x-ui
rm -f -- /etc/systemd/system/x-ui.service /usr/bin/x-ui /etc/x3ui-bootstrap/managed.env
rm -rf -- /usr/local/x-ui /etc/x-ui
rmdir /etc/x3ui-bootstrap 2>/dev/null || true
systemctl daemon-reload
test ! -e /etc/systemd/system/x-ui.service
test ! -e /usr/bin/x-ui
test ! -e /usr/local/x-ui
test ! -e /etc/x-ui
test ! -e /etc/x3ui-bootstrap/managed.env
if systemctl is-active --quiet x-ui; then
  false
fi
mutating=0
trap - ERR
printf 'BACKUP_PATH=%s\n' "$backup"
printf 'BACKUP_SHA256=%s\n' "$(sha256sum "$backup" | cut -d ' ' -f 1)"
printf 'REMOVE_SUCCESS=1\n'`;

export function parseRemoveResult(output) {
  if (!/^REMOVE_SUCCESS=1$/m.test(output)) throw new Error("移除命令没有返回成功回执。");
  const backup = output.match(/^BACKUP_PATH=(\/root\/x3ui-installer-backups\/x3ui-removal-[0-9TZ-]+-[0-9a-f]{8}\.tar\.gz)$/m)?.[1];
  const sha256 = output.match(/^BACKUP_SHA256=([0-9a-f]{64})$/m)?.[1];
  if (!backup || !sha256) throw new Error("移除回执缺少已校验的备份路径或 SHA-256。");
  return { removed: true, service: "inactive", backupPath: backup, backupSha256: sha256 };
}
