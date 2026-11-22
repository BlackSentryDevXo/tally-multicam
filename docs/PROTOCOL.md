# Tally protocol

How Tally Cam (phones) and Tally Hub (computer) talk to each other. Useful if you want to write your own camera
client, debug a connection, or extend either side.

## Network layout

Star network: each phone opens a WebSocket to the hub on **port 7777** (TCP). Everything else hangs off that link.

| Port | Protocol | Who listens | Used for |
|---|---|---|---|
| 7777 | WebSocket + HTTP | Tally Hub | Control messages, preview snapshots, `POST /upload` for finished clips |
| 8890 | SRT (UDP) | MediaMTX (bundled) | Phones push their H.264 feeds (monitor + live) |
| 8889 | HTTP (WHEP) | MediaMTX, **localhost only** | Hub tiles play the feeds over WebRTC |
| 8189 | UDP (ICE) | MediaMTX, **localhost only** | WebRTC media for the tiles |
| 9997 | HTTP | MediaMTX API, **localhost only** | Hub reads per-camera bitrate and readers |

## Pairing

The pairing QR code is:

```
tally://<name>.local,<ip1>,<ip2>,…:7777?key=<key>&name=<computer name>
```

It lists the hub's Bonjour name and every LAN address; the phone tries them all at once and keeps the first that
answers. `key` is a random secret stored in the hub's `config.json`. A connection that doesn't send a valid
`hello` within 10 s, sends binary data before `hello`, or presents the wrong key is closed (close code `4003` for a
wrong key). Uploads without the key get `403`.

## Clock sync and synced start

Phones measure their clock offset to the hub with NTP-style pings (`ping {t0}` → `pong {t0, hubT}`), keep the
lowest-round-trip half of the samples and take the median (`mobile/clock.js`). REC sends
`record {session, atHubMs}` with `atHubMs` = now + 1.5 s, so every phone starts at the same instant regardless of
Wi-Fi lag; each phone reports `started {lateMs}`. STOP is scheduled the same way. OBS gets `StartRecord` at the
same moment.

## Messages

JSON text frames, except preview snapshots (binary JPEG frames, phone → hub).

| Phone → Hub | Hub → Phone |
|---|---|
| `hello {key, id, name, platform, status}` | `pong {t0, hubT}` |
| `ping {t0}` | `record {session, atHubMs}` / `stop {atHubMs}` |
| `status {…}` (see below) | `settings {res, fps, lens, zoom, exposure, torch, stabilization, hdr, codec}` |
| `level {db}` (peak dBFS, ~5 Hz, only when the phone's meter is on) | `focus {x, y}` (0–1) / `lock {on}` |
| `requestRecord` / `requestStop` (phone's own button starts/stops all) | `stream {on, role, url, width, height, fps, bitrateKbps, profile}` |
| binary JPEG preview | `preview {fps, maxWidth}` (snapshot rate) |
| `started {lateMs}`, `error {message}` | `close {reason}` (disconnect, keep pairing) / `forget` (drop pairing) |
| | `manual {iso, shutter, wbTemp, wbTint, focus}` (manual 3A, see below) |
| | `inspect {on}` (the hub's inspector opened/closed on this camera) |

**`status` fields:** `battery` (0–1), `charging`, `free` (bytes), `remainingSec` (recording time left),
`recording`, `duration`, `session`, `settings`, `lenses` (any of `ultra`, `wide`, `tele`, `front`),
`orientation` (`portrait` | `landscape-left` | `landscape-right`), `platform` (`ios` | `android`),
`preview` (`ok` | `unavailable`), `thermal` (`{level 0–3, label, tempC, headroom}`),
`stream` (`{state, width, height, fps, kbps, droppedFrames, error}`), and:

- `locked`: AE/AF/WB lock is on (hub "Lock", the phone's long-press or Pro panel).
- `lensX`: `{lensId: factor}`, each lens's field of view relative to the main lens (`{ultra: 0.5, wide: 1, tele: 3}`),
  so the hub labels lenses the way the phone does.
- `manual`: `{iso, shutter, wbTemp, wbTint, focus}`, the phone's current manual values; `null` = auto.
  `shutter` is in seconds, `wbTemp` in Kelvin, `wbTint` −100…100, `focus` the lens position 0 (near) … 1 (∞).
- `ranges`: what this lens allows, `{iso: [min, max], shutter: [min, max] (seconds, never longer than one frame),
  wbTemp: [min, max], wbTint: [min, max], focus: true | false}`; `null` = not available on this lens.
- `auto`: `{iso, shutter, focus}`, what auto exposure and autofocus are doing right now, or `null`. Only filled
  while the hub's inspector is open on this camera (`inspect {on: true}`); the phone then sends `status` every
  second instead of every two.

Older phone builds send no `manual`/`ranges`/`auto`; the hub then offers only the automatic controls.

**`manual`:** only the keys present are applied, so the hub can change one control at a time; `null` returns that
control to auto (`wbTemp: null` also resets the tint). Values are clamped to `ranges`. A control this lens can't
do is refused with an `error {message}` such as `this lens has no manual focus`. Manual ISO and shutter replace
exposure bias; with only one of them set, the other holds its current auto value. The phone's own Pro panel shows
the same values.

**`session`:** the hub's take name, `''` when idle, or `standalone_…` for a take recorded with no hub. On
reconnect the hub stops a phone only if it is still recording a take **this hub started** that has since ended.
Standalone takes are never stopped.

## Video feeds

Each phone hardware-encodes H.264 (Main profile, no B-frames, 1 s keyframes) and pushes MPEG-TS over SRT as the
caller:

```
srt://<hub>:8890?streamid=publish:cam-<id>:tally:<password>&latency=120
```

The publish password is derived from the pairing key. `stream.role` is:

- `monitor`: a light 720p feed (25/30 fps, ~2.5 Mb/s) for smooth hub tiles. On by default for iPhones, off for
  Android (Settings → Smooth preview).
- `live`: the OBS feed, 720p30, 1080p30 or 1080p60 (25/50 fps when mains power is set to 50 Hz).

**Live quality** (hub setting, applies to every live feed; the monitor feed is unaffected) sets `bitrateKbps`:

| Live preset | Standard | High | Max |
|---|---|---|---|
| 720p30 | 4 Mb/s | 6 Mb/s | 8 Mb/s |
| 1080p30 | 8 Mb/s | 12 Mb/s | 16 Mb/s |
| 1080p60 | 12 Mb/s | 20 Mb/s | 30 Mb/s |

Changing it re-sends `stream` to every phone. A hot phone (thermal level 2+) still caps its feed at 30 fps / 4 Mb/s.

Reading feeds and using the MediaMTX API require the hub's own local user (`hubread`, random password in the
hub's `config.json`), from this computer only; browsers get no CORS access. OBS reads:

```
srt://127.0.0.1:8890?streamid=read:cam-<id>:hubread:<password>
```

for any custom setup. **Add to OBS** instead creates one Browser Source per camera
(`http://127.0.0.1:7777/obs/cam-<id>?k=<token>`, a page on the hub that plays the feed over WebRTC like the tiles), a
**Tally Cameras** multiview scene and a scene per camera. It also attaches OBS's Color Correction filter to each
camera source, named **Tally colour** and disabled, for matching cameras in OBS. If a camera shows black in OBS, untick
OBS → Settings → Advanced → Sources → **Browser Source Hardware Acceleration** and restart OBS.

**Framing** (hub inspector, per camera, stored in the hub's `config.json` as `framing[id] = {zoom, x, y, portraitX}`)
is a digital pan + zoom of the live view only: zoom 1–3, `x`/`y` the normalised centre of the crop (kept inside the
frame). The phone never sees it, so recordings stay full frame. The OBS page reads it from
`GET /obs/cam-<id>/framing?k=<token>` (loopback + token, like the page itself): JSON, or with
`Accept: text/event-stream` a live SSE stream that pushes every change, applied as a CSS scale/translate on the video
without reloading. The hub's tiles show the same crop. `portraitX` places the hub-only 9:16 portrait guide
(`portraitGuide` in `config.json`, global); it never appears in OBS.

Hub tiles read WebRTC (WHEP) from `http://127.0.0.1:8889/cam-<id>/whep`; the hub's main process does the signalling
with the credentials, so the page itself never touches the network.

## Snapshot rate

When no video plays in a tile, the hub asks each phone for JPEG snapshots with `preview {fps, maxWidth}`: 12/s while
its tile is on screen, 1/s behind video (fallback only), 2/s when the hub window is hidden. Snapshots are capped at
640 px wide and 1 MB.
