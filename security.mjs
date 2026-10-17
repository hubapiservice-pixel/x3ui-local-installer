import crypto from "node:crypto";

const ROOT_DROPIN = "/etc/ssh/sshd_config.d/00-x3ui-disable-root.conf";
const ROOT_RESTORE = `rm -f -- ${ROOT_DROPIN}; sshd -t && (systemctl reload ssh || systemctl reload sshd)`;

function quote(value) {
  return "'" + String(value).replace(/'/g, "'\"'\"'") + "'";
}

export function securityInput(body) {
  const checked = (name) => {
    const value = body[name];
    if (value === undefined || value === false) return false;
    if (value === true || value === "on") return true;
    throw new Error("安全设置选项格式不正确。");
  };
  const createUser = checked("createAdminUser");
  const grantSudo = checked("grantSudo");
  const disableRoot = checked("disableRootSsh");
  if (grantSudo && !createUser) throw new Error("授予 sudo 前必须创建并验证管理员用户。");
  if (disableRoot && !grantSudo) throw new Error("禁用 root SSH 前必须验证管理员登录和 sudo -i。");
  if (!createUser) return { enabled: false };

  const username = String(body.adminUsername || "").trim();
  const password = String(body.adminPassword || "");
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(username) || username === "root") {
    throw new Error("新用户名须以小写字母或下划线开头，仅含小写字母、数字、下划线或短横线，最长 32 位，且不能为 root。");
  }
  if (password.length < 12 || password.length > 128 || /[\x00-\x1f\x7f]/.test(password)) {
    throw new Error("新用户密码须为 12 到 128 位，且不能包含控制字符或换行。");
  }
  return { enabled: true, username, password, grantSudo, disableRoot };
}

export async function applySecurity(rootConn, target, options, { exec, connect, log = () => {} }) {
  if (!options.enabled) return null;
  const { username, password, grantSudo, disableRoot } = options;
  const marker = `/etc/x3ui-bootstrap/admin-${username}.managed`;
  const sudoers = `/etc/sudoers.d/90-x3ui-${username}`;
  const report = { username, login: "待验证", sudo: grantSudo ? "待验证" : "未启用", rootSsh: "保持启用" };
  const checked = async (conn, command, message, stdin) => {
    const result = await exec(conn, command, stdin);
    if (result.code !== 0) throw new Error(message);
    return result;
  };
  const adminTarget = { ...target, username, password };
  const sameHostKey = rootConn.x3uiHostKey;
  const verifyAdmin = async () => {
    const adminConn = await connect(adminTarget, sameHostKey);
    try {
      const identity = await checked(adminConn, "id -un", "新用户 SSH 登录后身份校验失败。");
      if (identity.stdout.trim() !== username) throw new Error("新用户 SSH 登录后的用户名不匹配。");
      report.login = "独立 SSH 登录已验证";
      if (grantSudo) {
        const sudo = await checked(adminConn, "sudo -k -S -p '' -i id -u", "新用户 sudo -i 验证失败。", `${password}\n`);
        if (sudo.stdout.trim() !== "0") throw new Error("新用户 sudo -i 未取得 root 权限。");
        report.sudo = "sudo -i 已验证";
      }
    } finally {
      adminConn.end();
    }
  };

  await checked(rootConn, "test \"$(id -u)\" = 0 && command -v useradd && command -v chpasswd", "创建用户需要 root 权限及 useradd/chpasswd。");
  const createCommand = [
    "set -eu",
    `if id -u ${quote(username)} >/dev/null 2>&1; then`,
    `  test -f ${quote(marker)} && grep -qx X3UI_ADMIN_MANAGED=1 ${quote(marker)}`,
    "else",
    `  useradd -m -s /bin/bash ${quote(username)}`,
    "  install -d -m 700 /etc/x3ui-bootstrap",
    `  (umask 077; printf 'X3UI_ADMIN_MANAGED=1\\n' > ${quote(marker)})`,
    "fi"
  ].join("\n");
  await checked(rootConn, `bash -c ${quote(createCommand)}`, "用户已存在且非本安装器创建，或创建新用户失败；root SSH 未禁用。");
  await checked(rootConn, "chpasswd", "设置新用户密码失败；root SSH 未禁用。", `${username}:${password}\n`);
  log(`已创建或更新 ${username}，正在从独立 SSH 连接验证密码登录。`);

  if (grantSudo) {
    const sudoCommand = [
      "set -eu",
      "command -v visudo >/dev/null",
      "visudo -cf /etc/sudoers >/dev/null",
      `test ! -L ${quote(sudoers)}`,
      `if test -e ${quote(sudoers)}; then grep -qx ${quote(`${username} ALL=(ALL:ALL) ALL`)} ${quote(sudoers)}; fi`,
      "tmp=$(mktemp /etc/sudoers.d/.x3ui-admin.XXXXXXXX)",
      "trap 'rm -f -- \"$tmp\"' EXIT",
      `printf '%s\\n' ${quote(`${username} ALL=(ALL:ALL) ALL`)} > "$tmp"`,
      "chmod 440 \"$tmp\"",
      "visudo -cf \"$tmp\" >/dev/null",
      `mv -f -- "$tmp" ${quote(sudoers)}`,
      "visudo -cf /etc/sudoers >/dev/null"
    ].join("\n");
    await checked(rootConn, `bash -c ${quote(sudoCommand)}`, "sudoers 检查或写入失败；root SSH 未禁用。");
  }
  await verifyAdmin();
  log(`${username} 的密码 SSH 登录${grantSudo ? "和 sudo -i" : ""}已通过独立连接验证。`);
  if (!disableRoot) return report;

  const unit = `x3ui-root-rollback-${crypto.randomBytes(6).toString("hex")}`;
  const timer = `${unit}.timer`;
  await checked(rootConn,
    `test ! -e ${quote(ROOT_DROPIN)} && test ! -L ${quote(ROOT_DROPIN)} && command -v systemd-run && command -v sshd && sshd -t`,
    "SSH 配置或自动回滚能力检查失败，未禁用 root。"
  );
  await checked(rootConn,
    `systemd-run --quiet --unit=${quote(unit)} --on-active=180s /bin/sh -c ${quote(ROOT_RESTORE)}`,
    "无法启动自动回滚定时器，未禁用 root。"
  );
  log("已设置 3 分钟 SSH 自动回滚保护，准备禁用 root SSH。");
  try {
    await checked(rootConn,
      `umask 077; printf 'PermitRootLogin no\\n' > ${quote(ROOT_DROPIN)} && sshd -t && sshd -T -C user=root,host=localhost,addr=127.0.0.1 | grep -qx 'permitrootlogin no' && (systemctl reload ssh || systemctl reload sshd)`,
      "禁用 root 的 SSH 配置校验或服务重载失败。"
    );
    await verifyAdmin();
    let rootConnected = false;
    try {
      const probe = await connect(target, sameHostKey);
      rootConnected = true;
      probe.end();
    } catch (error) {
      if (error.level !== "client-authentication") throw error;
    }
    if (rootConnected) throw new Error("root 仍能通过密码建立新 SSH 会话。");
    await checked(rootConn,
      `systemctl stop ${quote(timer)} && ! systemctl is-active --quiet ${quote(timer)} && sshd -T -C user=root,host=localhost,addr=127.0.0.1 | grep -qx 'permitrootlogin no'`,
      "无法确认自动回滚已撤销且 root SSH 仍被禁用。"
    );
    report.rootSsh = "独立连接已确认 root 登录被拒绝";
    log("新用户登录和 sudo -i 复验通过；root 新 SSH 登录已被拒绝，自动回滚已撤销。");
    return report;
  } catch (error) {
    try {
      await checked(rootConn, ROOT_RESTORE, "手动恢复 root SSH 失败。");
      const rootProbe = await connect(target, sameHostKey);
      rootProbe.end();
      await checked(rootConn, `systemctl stop ${quote(timer)}`, "停止自动回滚定时器失败。");
      report.rootSsh = "已恢复并重新验证 root SSH";
      throw Object.assign(new Error(`${error.message} 已恢复并重新验证 root SSH 登录。`), { securityReport: report });
    } catch (rollbackError) {
      if (rollbackError.securityReport) throw rollbackError;
      report.rootSsh = "自动回滚保护仍保留，需人工核查";
      throw Object.assign(new Error(`${error.message} 手动回滚未确认；3 分钟自动回滚仍保留，请立即核查 SSH。`), { securityReport: report });
    }
  }
}
