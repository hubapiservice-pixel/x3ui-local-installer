import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import clients from "../client-downloads.json" with { type: "json" };

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "offline-assets");
const verifyOnly = process.argv.includes("--verify-only");
const releaseBase = "http://193.134.210.145:18086/v3.9.0-xray-26.3.27";
const clientBase = "https://github.com/hubapiservice-pixel/x3ui-local-installer/releases/download/v1.2.1";

const manifestText = await readFile(path.join(root, "release/v3.9.0-xray-26.3.27/manifest.env"), "utf8");
const manifest = Object.fromEntries(manifestText.split(/\r?\n/)
  .filter((line) => /^[A-Z0-9_]+=/.test(line))
  .map((line) => line.split(/=(.*)/s).slice(0, 2)));
const releaseFiles = [
  ["X3UI_AMD64_FILE", "X3UI_AMD64_SHA256"],
  ["X3UI_ARM64_FILE", "X3UI_ARM64_SHA256"],
  ["X3UI_XRAY_AMD64_FILE", "X3UI_XRAY_AMD64_SHA256"],
  ["X3UI_XRAY_ARM64_FILE", "X3UI_XRAY_ARM64_SHA256"]
].map(([fileKey, hashKey]) => ({
  name: manifest[fileKey],
  sha256: manifest[hashKey],
  source: `${releaseBase}/${manifest[fileKey]}`,
  group: "release"
}));
const assets = [...releaseFiles, ...clients.assets.map((asset) => ({
  ...asset,
  source: `${clientBase}/${asset.name}`,
  group: "clients"
}))];

async function sha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function verified(file, asset) {
  try {
    const info = await stat(file);
    return (asset.size === undefined || info.size === asset.size) && await sha256(file) === asset.sha256;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

for (const asset of assets) {
  if (!asset.name || path.basename(asset.name) !== asset.name || !/^[a-f0-9]{64}$/.test(asset.sha256)) {
    throw new Error(`Invalid asset manifest entry: ${asset.name}`);
  }
  const dir = path.join(output, asset.group);
  const target = path.join(dir, asset.name);
  await mkdir(dir, { recursive: true });
  if (await verified(target, asset)) {
    console.log(`verified ${asset.group}/${asset.name}`);
    continue;
  }
  try {
    await stat(target);
    throw new Error(`Existing file failed verification: ${target}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (verifyOnly) throw new Error(`Missing asset: ${target}`);

  const temporary = `${target}.part-${process.pid}`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    console.log(`downloading ${asset.group}/${asset.name} (attempt ${attempt}/3)`);
    try {
      const response = await fetch(asset.source, { signal: AbortSignal.timeout(30 * 60 * 1000) });
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}: ${asset.name}`);
      await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary, { flags: "wx" }));
      if (!await verified(temporary, asset)) throw new Error(`Checksum mismatch: ${asset.name}`);
      await rename(temporary, target);
      console.log(`ready ${asset.group}/${asset.name}`);
      break;
    } catch (error) {
      if (attempt === 3 || /Checksum mismatch|HTTP 4\d\d/.test(error.message)) throw error;
      console.warn(`${asset.name}: ${error.message}; retrying`);
      await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
