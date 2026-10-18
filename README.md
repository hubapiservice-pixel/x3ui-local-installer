# X3-UI Online Installer

Password-protected web installer for a pinned, self-hosted 3X-UI v3.9.0 release with Xray 26.3.27.

## Current deployment

- Open `https://193.134.210.145/` and enter the separate page access password.
- The installer accepts a public IPv4 address, SSH port, root username, and one-time SSH password.
- The backend listens on `172.17.0.1:4182`; OpenResty serves the page with an IP-address TLS certificate.
- `x3ui-installer-web.service` keeps the backend running. `x3ui-ip-cert-renew.timer` checks the short-lived IP certificate twice daily and reloads OpenResty after renewal.
- Local source changes are not considered live until the 193 host is updated and read back; keep this distinction when using the public URL.
- New installs use `http://193.134.210.145:18086/v3.9.0-xray-26.3.27`; the original `/v3.9.0` mirror remains unchanged for rollback. Bootstrap, panel archives, and the AMD64/ARM64 Xray binaries have pinned checksums.

## Installation behavior

- Version 1.4.0 adds an optional LXD container mode to the source and offline packages. It creates a separately named `x3ui-*` Ubuntu 22.04 container, maps configurable external panel and node ports to internal 2053/443, and leaves the host's existing X3-UI untouched. The target must already have an initialized LXD `default` storage pool and `lxdbr0` bridge; its firewall and cloud security group must allow the selected ports. The installer waits for IPv4 and DNS before installing dependencies, then uploads the pinned payload. It refuses to overwrite an unrecognized same-name container. Container mode requires root SSH and does not change host SSH hardening. This describes the new source/package, not a confirmed deployment to the public 193 site.
- First-time installation and SSH hardening require root SSH. Recovery and removal also accept a separately verified sudo-capable administrator after root SSH has been disabled.
- Existing 3X-UI files or an occupied panel port `2053` stop the installation before changes are made.
- The compatibility bootstrap verifies the panel archive and Xray binary before writing the installation directory. Existing managed installations are read back, not silently downgraded.
- The result shows the verified service state, panel URL, generated panel credentials, and one VLESS + REALITY client link. The installer uses port 443, or 8443 if 443 is occupied.
- The installer form, progress, panel credentials, and node result share one viewport. On narrow screens, the install and result views are separate tabs; client downloads and instructions open in a dialog.
- Windows, Android, and macOS client installers are served from this site's `/downloads/` path. Only Apple App Store links remain external. The Mac sing-box 1.13.11 to Xray 26.3.27 handshake was verified through an SSH tunnel; that does not establish compatibility for every app version or network.
- The client guide uses numbered, step-by-step instruction images built around screenshots captured from the mirrored v2rayN 7.25.6 and Clash Verge Rev 2.5.8 macOS builds, the mirrored v2rayNG 2.2.6 and Clash Meta 2.11.35 Android builds in an isolated emulator, and an installed Shadowrocket 2.2.92 macOS build. Windows layout and iPhone app screens were not captured; the iOS flows are labeled as diagrams, not screenshots. Original unaltered captures and provenance are in `public/guides/raw/` and `public/guides/README.md`.
- The `补建节点` action can recover the existing link or create a missing node only on instances marked as installed by this bootstrap. It will not reinstall the panel or add a duplicate inbound.
- The new source offers optional administrator creation, sudo verification, and root SSH disablement. New installs configure a self-signed HTTPS panel certificate before starting the service. Existing installs are not changed automatically.
- The installed 3X-UI panel handles additional inbounds and protocol selection in its native Inbounds > Add screen. The installer only creates one default VLESS + REALITY inbound.
- The new `移除 X3-UI` action only accepts an instance with this installer's managed marker. It stops the panel, creates and verifies a root-only backup on the VPS, removes fixed panel paths, and checks the service is inactive. SSH users, sudoers, and root SSH settings are left unchanged. If removal fails after the service is stopped, it attempts to restore the original files and service state.

## Security

- `X3UI_REQUIRE_ACCESS=1` requires `X3UI_WEB_ACCESS_PASSWORD`. The password protects both install requests and job results.
- Online SSH hardening and removal additionally require a distinct `X3UI_ADMIN_ACTION_PASSWORD` of at least 16 characters. Without it, these actions return 503 and are not executed. The ordinary page password is still required. The local offline edition does not need either web password.
- SSH passwords remain in the running process for the task and are not persisted by the application.
- The backend is reachable only through the Docker bridge and the HTTPS reverse proxy. The public API accepts public IPv4 destinations only.
- Job results are held in memory for at most 30 minutes. The application allows at most two concurrent installations.
- SSH host keys are not pinned by this release. Operators should verify target identity through their VPS provider before entering root credentials.
- New target panels serve HTTPS only on port 2053. The generated certificate is self-signed, so browsers will show a trust warning; for authenticated public access, install a CA-trusted certificate for the target IP or domain. Older managed instances can still use HTTP until separately migrated.
- Xray 26.3.27 is an older compatibility build and does not include newer security fixes. A reachable TCP port and active service do not prove that a particular client network can reach the VPS.

## Local development

```bash
npm install
npm start
```

The default bind address is `127.0.0.1:4178`. Production uses `X3UI_BIND_HOST` and `PORT` from its service configuration.

## Separate offline Windows x64 edition

The Windows x64 ZIP bundles Node.js 24.15.0, Xray 26.3.27 for local node testing, the pinned 3X-UI/Linux Xray payloads, all 14 desktop/mobile client installers, and the illustrated guide. It runs locally and SFTP-uploads the Linux payloads to the target VPS; the target does not fetch upstream packages. iOS clients remain App Store links.

After downloading `X3-UI-Offline-Installer-Windows-x64-v1.4.0.zip`, verify its adjacent `.sha256` file, extract the whole ZIP, and double-click `Start-X3UI.cmd`. It opens the installer on `127.0.0.1` without installing Node.js system-wide or requiring administrator rights on Windows. Node testing on Windows follows the system route; the macOS `en0` interface selector is hidden. A first run may still show Windows security prompts because this package has no publisher code-signing certificate. Do not disable Defender or SmartScreen globally.

The reproducible build runs on Windows x64 with Node.js 24.15.0 and PowerShell 7:

```powershell
npm ci
npm test
npm run build:offline:win
npm run smoke:offline:win
```

The build downloads only fixed-version assets, verifies SHA-256 before packaging, and writes the ZIP and checksum under `dist/`. The smoke test extracts that ZIP, runs the bundled executables and launcher, checks the loopback-only API and local client download, then stops its test process. The v1.4.0 release workflow additionally requires a real installation and node probe from the extracted Windows package against a separately named LXD container. GitHub Actions runs these checks before publishing the Windows release. This is a Windows runner check, not a claim that every consumer PC or network path has been tested.

## Separate offline macOS edition

The offline edition is a self-contained Apple Silicon app. It bundles Node.js, the pinned 3X-UI/Xray Linux x86_64 and aarch64 payloads, an arm64 Xray probe binary, all 14 Windows/Android/macOS client installers, and the illustrated client guide. iOS clients remain App Store links because their store-distributed packages cannot be bundled. It does not replace or update the public installer.

```bash
node scripts/fetch-offline-assets.mjs
bash scripts/build-offline-macos-app.sh
```

The fetch step copies assets from the self-hosted 193 mirror into `offline-assets/` and checks the pinned hashes in the release and client manifests. The build step also checks the bundled macOS probe binary, then writes `dist/X3-UI-Offline-Installer-macOS-arm64-v1.4.0.zip` and its `.sha256` file. After extraction, double-click the app. It opens a loopback-only page and uses its embedded runtime; Node.js does not need to be installed on the receiving Mac. The ZIP is ad-hoc signed but not notarized, so macOS may require Control-click and Open on first launch.

Only the SSH connection to the target VPS is needed during installation. The app detects the target CPU, SFTP-uploads the matching files to a root-only temporary directory, checks them again with `sha256sum`, and runs the offline bootstrap without `curl` or an upstream fallback. The target must be a clean Linux x86_64/aarch64 system with root SSH, systemd, tar, sha256sum, and openssl. Existing 3X-UI files are not overwritten. A successful install removes only its temporary upload files; a failed upload or install leaves them for diagnosis. The result confirms the server-side panel and listener. The local probe performs a separate end-to-end HTTPS request through a VLESS + REALITY TCP node from the Mac, including Shadowrocket's encoded VLESS-encryption links; it can optionally bind to an `en` physical interface. Other protocols must be tested in a compatible client.

Both editions offer optional SSH hardening after panel and node setup. Enter a new admin username and a 12+ character password; the form then allows checking `sudo -i` and, only after that, disabling root SSH. The app establishes a separate password-authenticated SSH connection and verifies `sudo -i` both before and after changing sshd. A three-minute systemd rollback timer is armed before the change. It verifies that a new root password login is rejected, then cancels the timer; on failure it attempts to restore and independently verify root access. The result records each check. To recover results after disabling root, enter the new username and password and use the recover action; sudo is verified again. Existing non-installer users are not silently modified. The removal action retains a root-only verified panel backup on the target; it does not revert SSH hardening.

For local UI development without packaging, run `X3UI_OFFLINE=1 PORT=4180 npm start`. Client links will return 404 until `offline-assets/clients/` is populated. Do not use the legacy `scripts/build-macos-app.sh` for this edition; it still builds the older mirror-dependent launcher.

## Client download mirror

- `client-downloads.json` pins 14 installer files, their upstream release URLs, byte sizes, and SHA-256 hashes. The browser links point only to local `public/downloads/` files or Apple App Store listings.
- On the hosting server, run `node scripts/mirror-client-downloads.mjs` from the project root to fetch missing pinned files. It verifies size and SHA-256 before atomically publishing each file. Run `node scripts/mirror-client-downloads.mjs --verify-only` before deploying changed links or after restoring a backup.
- Keep `public/downloads/` with the deployed site when upgrading the web process. Do not replace a pinned file with an unverified download under the same name.

## Offline deployment test on 117 and 203

- On 2026-10-16, the previous installations were stopped and moved to root-only preservation directories after readable archives had been verified: `/root/x3ui-before-offline-20261016-117.tar.gz`, `/root/x3ui-disabled-20261016-117/`, `/root/x3ui-before-offline-20261016-203.tar.gz`, and `/root/x3ui-disabled-20261016-203/` on their respective hosts. These backups may contain credentials and must not be served publicly.
- The final offline app ZIP uploaded 3X-UI 3.9.0 and Xray 26.3.27 to each host through SSH/SFTP, verified checksums on each host, started the panel, created a VLESS + REALITY inbound on port 443, and read back both results. No mirror download occurred on either target.
- Using the matching macOS Xray 26.3.27 client, each new node completed an HTTPS request with status 200 through an SSH tunnel to the target's loopback port 443. From this Mac to either target's public port 443, the same client request was reset. Server-side success therefore does not establish direct Shadowrocket reachability from this network.
- The old 117 compatibility sidecar on port 8443 was removed from its active path, so its old node link is invalid. The `193:18443` relay was updated, with a unit backup, to forward to the new 117 port 443. Both 193 relay services completed TLS handshakes from 193 itself. From this Mac, requests to their public ports timed out; neither relay is verified usable from this local network after the reinstall.

## Client-path relays on 193

- `x3ui-117-compat-relay.service` listens on `193.134.210.145:18443` and forwards to the new `117.55.224.148:443` node. Its previous 8443 link remains invalid because the node keys changed. The previous unit is backed up as `~/.config/systemd/user/x3ui-117-compat-relay.service.backup-20261016` on 193.
- `x3ui-203-compat-relay.service` listens on `193.134.210.145:18444` and forwards only to `203.88.123.62:443`.
- Both are independent `sysadmin` user services with linger enabled. Their unit files are in `ops/`. They do not change either target's panel, database, inbound, or original node link.
- Before the offline reinstallation, both old relay links completed HTTPS requests with Xray 26.3.27 from this Mac's physical network. After the reinstallation, the newly generated nodes work through SSH tunnels, but their direct and public-relay paths from this Mac did not pass. Shadowrocket still needs an import-and-test check on the user's device.
- To remove a relay on 193, run `systemctl --user disable --now x3ui-117-compat-relay.service` or `systemctl --user disable --now x3ui-203-compat-relay.service` as `sysadmin`. The other relay and installer remain untouched. The website's previous static files are backed up under `/home/sysadmin/x3ui-installer-backups/20261016-clash-usage/`.
