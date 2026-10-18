const NAME_PATTERN = /^x3ui-[a-z0-9](?:[a-z0-9-]{0,26}[a-z0-9])?$/;

export function containerInput(body) {
  const mode = String(body.installMode || "host");
  if (mode === "host") return null;
  if (mode !== "lxd") throw new Error("安装方式无效。");
  const name = String(body.containerName || "").trim();
  const panelPort = Number(body.containerPanelPort);
  const nodePort = Number(body.containerNodePort);
  if (!NAME_PATTERN.test(name)) throw new Error("容器名须以 x3ui- 开头，只能使用小写字母、数字和短横线。");
  if (![panelPort, nodePort].every((port) => Number.isInteger(port) && port >= 1024 && port <= 65535) || panelPort === nodePort) {
    throw new Error("容器面板和节点须使用两个不同的 1024-65535 端口。");
  }
  return { name, panelPort, nodePort };
}

export function containerPortUrl(url, port) {
  const address = new URL(url);
  if (address.protocol !== "https:") throw new Error("容器面板未启用 HTTPS。");
  address.port = String(port);
  return address.toString();
}

export function containerNodeLink(link, port) {
  const address = new URL(link);
  if (address.protocol !== "vless:") throw new Error("容器节点格式无效。");
  address.port = String(port);
  return address.toString();
}
