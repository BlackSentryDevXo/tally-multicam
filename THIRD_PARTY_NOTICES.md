# Third-party notices

Tally is MIT-licensed (see [LICENSE](LICENSE)). It builds on the open-source work below. The release builds
(Tally Hub for macOS/Windows, Tally Cam for Android) include some of these components in binary form; their
licenses and source locations are listed here.

## Bundled in Tally Hub (macOS / Windows)

| Component | Version | License | Source |
|---|---|---|---|
| Electron (includes Chromium, Node.js; full notices ship in the app as `LICENSES.chromium.html`) | 45.4.1 | MIT and others | https://github.com/electron/electron |
| MediaMTX (bundled as a separate executable, unmodified) | 1.21.4 | MIT | https://github.com/bluenviron/mediamtx |
| ws | 8.x | MIT | https://github.com/websockets/ws |
| qrcode | 1.5.x | MIT | https://github.com/soldair/node-qrcode |
| obs-websocket-js | 5.x | MIT | https://github.com/obs-websocket-community-projects/obs-websocket-js |

## Bundled in Tally Cam (iOS / Android)

| Component | Version | License | Source |
|---|---|---|---|
| React Native | 0.88.x | MIT | https://github.com/facebook/react-native |
| Expo SDK and modules | 58 | MIT | https://github.com/expo/expo |
| react-native-vision-camera (Android manual-controls patch in `mobile/patches/`) | 5.2.4 | MIT | https://github.com/mrousavy/react-native-vision-camera |
| react-native-nitro-modules / react-native-nitro-image | 0.37 / 0.15 | MIT | https://github.com/mrousavy/nitro |
| react-native-gesture-handler, react-native-safe-area-context | — | MIT | https://github.com/software-mansion/react-native-gesture-handler, https://github.com/AppAndFlow/react-native-safe-area-context |
| SRT (libsrt, iOS; unmodified static build from HaishinKit/libsrt-xcframework) | 1.5.7 | MPL-2.0 | https://github.com/Haivision/srt (source for the exact version: tag v1.5.7) |
| OpenSSL (iOS, via the OpenSSL-Universal pod) | 3.x | Apache-2.0 | https://github.com/openssl/openssl |
| RootEncoder SRT module (Android) | 2.8.2 | Apache-2.0 | https://github.com/pedroSG94/RootEncoder |

libsrt is used unmodified under the Mozilla Public License 2.0; its source code is available at the link above.
Other JavaScript dependencies are listed in `hub/package.json` and `mobile/package.json` with their licenses in
`node_modules/*/package.json`.

OBS Studio is not bundled; Tally Hub talks to it over its built-in WebSocket API.
