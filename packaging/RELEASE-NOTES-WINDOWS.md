Windows x64 offline installer with the same pinned 3X-UI 3.9.0 and Xray 26.3.27 server payloads as the macOS edition. The ZIP includes its own Node.js runtime, Windows Xray probe, all 14 client installers, and the illustrated guide. No runtime download is needed on the Windows PC or the target Linux VPS.

Download the ZIP and its `.sha256` file, verify the hash, fully extract the ZIP, and run `Start-X3UI.cmd`. The page binds to `127.0.0.1` only. Supported host: Windows 10/11 x64. This package has no publisher code-signing certificate, so Windows may show a security prompt; do not disable Defender or SmartScreen globally.

The GitHub Actions Windows runner checks the extracted bundle, embedded Node.js and Xray executables, launcher, API host restriction, and local client download before this release is published. A client node still needs to be tested from the user's actual network.
