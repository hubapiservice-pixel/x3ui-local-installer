import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import manifest from "../client-downloads.json" with { type: "json" };

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "public", "downloads");
const verifyOnly = process.argv.includes("--verify-only");

async function sha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function verified(file, asset) {
  try {
    return (await stat(file)).size === asset.size && (await sha256(file)) === asset.sha256;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

await mkdir(output, { recursive: true });
for (const asset of manifest.assets) {
  if (path.basename(asset.name) !== asset.name || !/^https:\/\/github\.com\//.test(asset.source)) {
    throw new Error(`Invalid manifest entry: ${asset.name}`);
  }
  const target = path.join(output, asset.name);
  if (await verified(target, asset)) {
    console.log(`verified ${asset.name}`);
    continue;
  }
  if (verifyOnly) throw new Error(`Missing or invalid: ${asset.name}`);
  try {
    await stat(target);
    throw new Error(`Existing file failed verification: ${asset.name}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const temporary = `${target}.part-${process.pid}`;
  console.log(`downloading ${asset.name}`);
  try {
    const response = await fetch(asset.source, {
      headers: { "User-Agent": "x3ui-installer-client-mirror" },
      signal: AbortSignal.timeout(30 * 60 * 1000)
    });
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}: ${asset.name}`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary, { flags: "wx" }));
    if (!(await verified(temporary, asset))) throw new Error(`Checksum mismatch: ${asset.name}`);
    await rename(temporary, target);
    console.log(`ready ${asset.name}`);
  } finally {
    await rm(temporary, { force: true });
  }
}
