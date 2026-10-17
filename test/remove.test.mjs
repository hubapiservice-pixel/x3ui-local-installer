import assert from "node:assert/strict";
import test from "node:test";
import { REMOVE_SCRIPT, parseRemoveResult } from "../remove.mjs";

test("remove requires a managed marker and never deletes SSH identity settings", () => {
  assert.match(REMOVE_SCRIPT, /X3UI_BOOTSTRAP_MANAGED=1/);
  assert.match(REMOVE_SCRIPT, /X3UI_INSTALL_DIR=\/usr\/local\/x-ui/);
  assert.match(REMOVE_SCRIPT, /systemctl stop x-ui[\s\S]*tar -C \/ -czf/);
  assert.match(REMOVE_SCRIPT, /sha256sum -c/);
  assert.match(REMOVE_SCRIPT, /trap restore_on_error ERR/);
  assert.doesNotMatch(REMOVE_SCRIPT, /rm .*\/etc\/ssh|rm .*\/etc\/sudoers|userdel|passwd\s/);
});

test("remove receipt accepts only a verified fixed backup path and SHA-256", () => {
  const backupPath = "/root/x3ui-installer-backups/x3ui-removal-20261018T010203Z-0123abcd.tar.gz";
  const backupSha256 = "f".repeat(64);
  assert.deepEqual(parseRemoveResult(`BACKUP_PATH=${backupPath}\nBACKUP_SHA256=${backupSha256}\nREMOVE_SUCCESS=1\n`), {
    removed: true, service: "inactive", backupPath, backupSha256
  });
  assert.throws(() => parseRemoveResult(`BACKUP_PATH=/tmp/other.tar.gz\nBACKUP_SHA256=${backupSha256}\nREMOVE_SUCCESS=1`), /缺少/);
  assert.throws(() => parseRemoveResult(`BACKUP_PATH=${backupPath}\nBACKUP_SHA256=${backupSha256}`), /成功回执/);
});
