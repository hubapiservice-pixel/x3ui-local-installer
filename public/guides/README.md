# Client guide image provenance

The original, unaltered window and emulator captures from 2026-10-16 are in `raw/`. The same filenames in this directory are browser-rendered instruction cards: they place numbered steps beside those captures and number only controls visible in each capture. None of the captures contain target VPS credentials or user node links.

| File | Actual app and build | Capture environment |
| --- | --- | --- |
| `v2rayn-7.25.6-macos-main.png` | v2rayN 7.25.6 | macOS arm64 from the pinned DMG; only the upper window region was captured to omit local paths |
| `v2rayng-2.2.6-android-import.png` | v2rayNG 2.2.6 | Isolated Android arm64 emulator; import menu |
| `clash-verge-2.5.8-macos-local.png` | Clash Verge Rev 2.5.8 | macOS arm64 from the pinned DMG; temporary app and its fresh data directory removed after capture |
| `clash-meta-2.11.35-android-home.png` | Clash Meta for Android 2.11.35.Meta | Isolated Android arm64 emulator; initial home screen |
| `clash-meta-2.11.35-android-add.png` | Clash Meta for Android 2.11.35.Meta | Isolated Android arm64 emulator; local file import menu |
| `shadowrocket-2.2.92-macos-add.png` | Shadowrocket 2.2.92 | Installed macOS app; unsaved blank add-node screen |

`shadowrocket-ios-flow.png` and `hiddify-ios-flow.png` are labeled flow diagrams, not iPhone screenshots. The App Store listings were checked on 2026-10-16: Hiddify 4.0 and Shadowrocket 2.2.92. Their store screenshots were made for older builds, so they are not presented as current-version app screenshots. The macOS captures are not labeled as Windows or iOS captures. Regenerate the instruction cards with `bash scripts/render-guide-cards.sh` from the project root; the renderer reads the unaltered images in `raw/`.

Official references: [v2rayN UI wiki](https://github.com/2dust/v2rayN/wiki/Description-of-some-ui), [Clash Verge profile guide](https://github.com/clash-verge-rev/clash-verge-rev.github.io/blob/main/docs/guide/profile.md), [Hiddify App Store](https://apps.apple.com/us/app/hiddify-proxy-vpn/id6596777532), [Shadowrocket App Store](https://apps.apple.com/us/app/shadowrocket/id932747118).
