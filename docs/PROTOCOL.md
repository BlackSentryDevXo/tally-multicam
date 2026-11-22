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

**`status` fields:** `battery` (0–1), `charging`, `free` (bytes), `remainingSec` (recording time left),
`recording`, `duration`, `session`, `settings`, `lenses` (any of `ultra`, `wide`, `tele`, `front`),
`orientation` (`portrait` | `landscape-left` | `landscape-right`), `platform` (`ios` | `android`),
`preview` (`ok` | `unavailable`), `thermal` (`{level 0–3, label, tempC, headroom}`), and
`stream` (`{state, width, height, fps, kbps, droppedFrames, error}`).

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

Reading feeds and using the MediaMTX API require the hub's own local user (`hubread`, random password in the
hub's `config.json`), from this computer only; browsers get no CORS access. OBS reads:

```
srt://127.0.0.1:8890?streamid=read:cam-<id>:hubread:<password>
```

as a Media Source (`input_format=mpegts`, hardware decode, buffering 0 MB, reconnect 1 s,
`fflags=nobuffer flags=low_delay`). **Add to OBS** writes these settings for you and keeps them up to date.

Hub tiles read WebRTC (WHEP) from `http://127.0.0.1:8889/cam-<id>/whep`; the hub's main process does the signalling
with the credentials, so the page itself never touches the network.

## Snapshot rate

When no video plays in a tile, the hub asks each phone for JPEG snapshots with `preview {fps, maxWidth}`: 12/s while
its tile is on screen, 1/s behind video (fallback only), 2/s when the hub window is hidden. Snapshots are capped at
640 px wide and 1 MB.
