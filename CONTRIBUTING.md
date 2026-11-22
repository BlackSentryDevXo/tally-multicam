# Contributing to Tally

Thanks for helping. Bug reports, device test results (especially Windows and Android phones) and pull requests are
all welcome.

## Layout

- `hub/`: Tally Hub (Electron). `main.js` is the server side (phone connections, uploads, MediaMTX, OBS),
  `renderer.js` + `index.html` the UI, `preload.js` the allow-listed bridge between them.
- `mobile/`: Tally Cam (Expo / React Native). `src/` holds the app, `modules/tally-stream` the native live-feed
  and thumbnail module (Swift + Kotlin, Nitro), `modules/tally-thermal` the thermal readout, `patches/` the
  VisionCamera Android manual-controls patch.
- `docs/PROTOCOL.md`: the phone ↔ hub protocol.

## Dev setup

```sh
cd hub && npm install && npm run fetch:mediamtx && npm start
cd mobile && npm install && npx expo run:android      # or: npx expo run:ios --device
```

A dev hub uses its own settings folder ("Tally Hub Dev"), so it never touches an installed Tally Hub. To run a dev
hub alongside an installed one, give it other ports: `TALLY_PORT=7787 TALLY_SRT_PORT=8891 TALLY_MTX_API=9987
TALLY_WEBRTC_PORT=8899 npm start`.

## Tests

```sh
cd mobile && npm test     # clock sync, pairing-code parsing, status-row layout
cd hub && npm test        # integration test: starts its own hub on test ports, simulates phones
```

The hub test writes a few files under `~/Movies/Tally/zz-test-*` (Windows: `Videos\Tally`) and deletes them at
the end. Camera, recording and streaming changes also need a check on a real phone; say which devices you tested
on in your pull request.

## Guidelines

- Recordings must never be lost: the local recording always wins over previews and live feeds, and nothing
  deletes clips from phones.
- Keep changes small and focused; match the existing style.
- Never commit signing keys, `~/.tally/` files, or personal identifiers.
