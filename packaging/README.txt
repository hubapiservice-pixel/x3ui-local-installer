X3-UI Offline Installer 1.2.1 (macOS Apple Silicon)

Double-click the app to open the installer at 127.0.0.1. The app includes its
own Node.js runtime, pinned 3X-UI and Xray files for Linux x86_64/aarch64,
and verified Windows, Android, and macOS client installers. The target server
must be reachable by SSH, but does not need to download the installer files.

iOS client apps are available only through the App Store and are not bundled.
The app is ad-hoc signed, not Apple-notarized. Read FIRST-OPEN-README.txt in
the ZIP before launching it on another Mac.

The target must be a clean supported Linux server with root SSH access,
systemd, tar, sha256sum, and openssl. Existing 3X-UI installations are not
overwritten. The result page reports the panel credentials and node link.
