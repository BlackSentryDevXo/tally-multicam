# Tally

Named after the red tally light that tells a crew which camera is live.

Press record once and every camera starts together: all the phones plus OBS. Before you roll, each tile shows the camera's picture as live video, its audio level, battery, storage and temperature. Each phone can also feed OBS live (up to 1080p60) for switching, while it records full quality on its own. After you stop, the clips copy to your computer.

- `hub/`: **Tally Hub**, the desktop control room (Electron, macOS and Windows)
- `mobile/`: **Tally Cam**, the pro camera app for phones (Expo / React Native, Android 8+ and iOS)

## First-time setup

### Tally Hub on a Mac
```sh
cd hub && npm install
npm run fetch:mediamtx        # live-feed server (MediaMTX, MIT): pinned version, sha256-checked, into hub/bin/<platform>/
npm start                     # dev copy: own settings folder ("Tally Hub Dev"), never touches the installed app
```
Clips are saved to `~/Movies/Tally/<date>_<session>/<camera name>.mp4` (the computer's local date; running the same session name twice in a day adds the time, so takes never share a folder).

Closing the Tally Hub window quits it, on macOS too: it's a single-window control app. If a take is recording or clips are still copying, it asks first. While a take runs, clips copy or any camera is connected, Tally Hub keeps the computer from going to sleep.

To build it as a normal Mac app (**Tally Hub** in Applications), it must be **signed**, so macOS remembers the firewall permission. Unsigned (ad-hoc) builds are blocked silently and phones can't connect:
```sh
security find-identity -v -p codesigning            # pick your "Apple Development: Name (TEAMID)" line
TALLY_SIGN_ID="Apple Development: Name (TEAMID)" npm run package:mac
rm -rf "/Applications/Tally Hub.app" && cp -R "dist/Tally Hub-darwin-arm64/Tally Hub.app" /Applications/
```
Signing covers the bundled MediaMTX too. On first launch macOS asks whether Tally Hub (and `mediamtx`) may **accept incoming connections**: click **Allow**. If the hub shows the **"macOS Firewall is blocking cameras"** banner, click **Allow Tally Hub**; it asks for your Mac password through the standard macOS prompt.
To regenerate the icons after changing the mark in `hub/build/icons.js`: `npm run icons`.

### Tally Hub on a Windows PC
Build from any computer (no Wine needed; the packager edits the .exe in pure JavaScript):
```sh
cd hub && npm install
node build/fetch-mediamtx.js windows_amd64
npm run package:win                                 # -> dist/Tally Hub-win32-x64/
```
`package:win` runs the packager through Node itself, so it also works when run on a Windows PC. Copy the `Tally Hub-win32-x64` folder to the PC and run `Tally Hub.exe`. On first launch **Windows Defender Firewall** asks to allow **Tally Hub** and **mediamtx.exe**: click **Allow access** with *Private networks* ticked, or no camera can connect. Clips are saved to `Videos\Tally\`. The Windows build is cross-packaged from macOS and has **not yet been run on a real Windows PC**; the hub's code paths are platform-aware (paths, firewall hints, MediaMTX binary) but expect to test it once.

### Tally Cam on Android (Android 8+)
Plug the phone in over USB with USB debugging on:
```sh
cd mobile && npm install && npx expo run:android --variant release
```
To sideload on other phones, use the APK in `mobile/android/app/build/outputs/apk/release/`.

### Tally Cam on iPhone
Plug the iPhone into the Mac:
```sh
cd mobile && npx expo run:ios --device --configuration Release
```
With a free Apple account the app expires after 7 days. Rerun the command to reinstall.

### OBS (optional)
In OBS, go to Tools → WebSocket Server Settings → Enable, and copy the password. In Tally Hub, open **OBS**, tick the box and paste the password.

**Live camera feeds in OBS:** pick a quality under **Live** in the toolbar: 720p30, 1080p30 or 1080p60 (25/50 when **Mains power** in Settings is 50 Hz, to match local lighting). Then click **Add to OBS**. Tally Hub creates one *Media Source* per phone, named `Tally · <camera>`, a **Tally Cameras** multiview scene, and a full-frame scene **Tally – <camera>** for each, ready to switch. Running it again updates them without duplicates. Each tile's green **LIVE** badge shows the bitrate the hub is receiving, with **OBS** once OBS is reading it.

## Tile previews
Each tile plays the phone's picture as real video. iPhones send a light **monitor feed** (720p, 25/30 fps, about 2.5 Mb/s, hardware-encoded) to the hub's media server, and the tile plays it back through WebRTC on the same computer: smooth motion, about half a second behind. When a Live quality is selected, that feed replaces the monitor feed and the tile plays the same stream OBS gets. The blue **MON** badge shows the monitor feed and its bitrate.

- **Heat:** the feed uses the phone's hardware encoder, so the cost is small, but on a hot day or a long shoot you can turn it off: **Settings → Smooth preview (iPhone)**. Tiles then fall back to snapshots, up to 12 per second while the tile is on screen (1 per second when the window is hidden).
- **Android:** off by default. The extra camera stream can affect 4K recording on some Android phones. Turn on **Settings → Smooth preview on Android too** to try it; check a test clip afterwards.
- Snapshots keep arriving at 1 per second behind the video, so a tile never goes black if the feed drops. The last picture stays on the tile when a phone goes offline.

## Tally Cam
It works like a stock camera app, with pro controls:
- **Lenses:** one-tap switching between ultra-wide (0.5×), wide (1×), telephoto and front, plus pinch to zoom.
- **Focus and exposure:** tap to focus and expose, double-tap or long-press for an AE/AF lock, drag to adjust exposure.
- **Manual mode:** focus, ISO, shutter and white balance, with scrub rulers that only move on a deliberate sideways drag.
- **Format picker:** resolution, frame rate, codec (HEVC/H.264), stabilization, HDR; mains-frequency flicker warnings; a Podcast preset.
- **Framing aids:** grid, histogram, an optional audio meter, battery, storage and temperature.
- **Rotation:** Tally Cam rotates its controls itself from the phone's physical orientation, so the iPhone's **Portrait Lock can stay on**. Recordings are tagged with the right orientation either way.
- **Record button:** when the phone is connected to the hub, its record button starts and stops **all** cameras, so the person at the camera can roll the whole shoot. With no connection it records on its own, and the clip copies to the hub later.

## On the day
1. Computer and phones on the **same Wi-Fi**. Church Wi-Fi often blocks devices from seeing each other. If phones won't connect, use the computer's hotspot or a small dedicated router. If no phone connects within 30 s, the pairing dialog lists what to check.
2. Open Tally Hub. On each phone, open Tally Cam, name the camera ("Wide", "Pastor", "Guest") and scan the code from **Pair camera**. Phones remember the hub after that.
3. Plug the phones into power. Turn on Do Not Disturb. On iPhone, use Guided Access so the app stays open, because iOS stops the camera in the background.
4. In the hub: **Apply to all** for one format everywhere. Click a preview to focus there. **Lock AE/AF/WB** so colour and brightness don't drift.
5. Name the session and press **REC** (or **Space**). The computer beeps at the start: that beep is your sync point.
6. Press **STOP**. Each tile shows a progress bar, then ✓ copied. Every clip is also saved to the phone's gallery. Nothing is deleted from the phones automatically.

**Camera controls → Close camera** disconnects a phone for now (it reconnects when someone taps it on the phone). **Forget camera** makes the phone drop the pairing and return to its pairing screen.

## Editing
Clips start within a few frames of each other. For frame-perfect alignment, use your editor's audio sync: DaVinci Resolve → *Auto Sync Audio → Based on Waveform*, or Premiere → *Synchronize → Audio*. The start beep gives it a clean spike to lock onto.

## If something goes wrong
- **A phone drops off Wi-Fi mid-take:** it keeps recording. When it reconnects after the take, the hub stops it and the clip uploads. The hub only ever stops takes it started itself: a take recorded on the phone without a hub (standalone) is never stopped by reconnecting.
- **The hub crashed or was quit mid-take:** the phones keep recording. Reopen Tally Hub: it picks the running take up again (REC stays lit, phones aren't stopped), and STOP works as normal.
- **Close camera on a recording phone:** that phone's recording is stopped first, so its clip is finished and queued; the other cameras keep recording.
- **An upload fails:** the phone retries, and the clip stays in its gallery. A copy that stalls for a minute (phone left the Wi-Fi) is dropped and retried later; half-copied files are removed, so a clip never appears twice. Quitting the hub while clips are copying asks you to wait up to 10 s.
- **The hub log shows "X started (N ms after target)":** that's how late each phone started. Under ~100 ms is normal.
- **A tile meter shows "no audio":** the phone's audio meter is off (the default when you record with external mics) or it lacks microphone permission.
- **A tile chip turns amber "Warm" or red "Hot":** the phone is heating up. Shade it, give it airflow, lower the live-feed quality or turn off Smooth preview, or take a break. The hub warns before recording if any phone is hot.
- **A tile shows "NO MONITOR" / "NO FEED":** the phone isn't sending its feed. Check it's online, that MediaMTX is running (the log says if it's missing) and that the firewall allows `mediamtx` (UDP 8890).
- **"macOS Firewall is blocking cameras":** click **Allow Tally Hub**. If it says the app is ad-hoc signed, rebuild it with `npm run package:mac` and a signing identity.
- **Log file:** Settings → **Open log** (`~/Library/Application Support/Tally Hub/hub.log` on a Mac, `%APPDATA%\Tally Hub\hub.log` on Windows). It holds the activity history, MediaMTX output and any internal errors.

## How it works
Star network: each phone opens a WebSocket to the hub on port 7777. The pairing code `tally://<name>.local,<ip>,…:7777?key=<key>&name=<computer>` lists the hub's Bonjour name and every LAN address (the phone tries them in order) plus a key. Connections or uploads without the key are rejected, and nothing is answered before a valid `hello`. Phones measure their clock offset to the hub with NTP-style pings (`mobile/clock.js`). REC sends "start at hub time T+1.5 s", so every phone starts at the same instant regardless of Wi-Fi lag. Finished clips stream to `POST /upload` on the hub.

| Phone → Hub | Hub → Phone |
|---|---|
| `hello {key,id,name,platform,status}` | `pong {t0,hubT}` |
| `ping {t0}` | `record {session,atHubMs}` / `stop {atHubMs}` |
| `status {battery,charging,free,recording,duration,settings,lenses,orientation,session,remainingSec,preview,thermal,stream}` | `settings {res,fps,lens,zoom,exposure,torch,stabilization,hdr,codec}` |
| `level {db}` (peak dBFS, ~5 Hz) | `focus {x,y}` (0–1) / `lock {on}` |
| `requestRecord` / `requestStop` (starts/stops all) | `stream {on,role,url,width,height,fps,bitrateKbps,profile}` |
| binary JPEG preview, `started {lateMs}`, `error {message}` | `preview {fps,maxWidth}` (snapshot rate) |
| | `close {reason}` (disconnect, keep pairing) / `forget` (drop pairing) |

`platform` is `ios` or `android`. `lenses` is any of `ultra`, `wide`, `tele`, `front`. `preview` is `ok`/`unavailable`; `thermal` is `{level 0–3, tempC}`; `stream` is `{state, width, height, fps, kbps, error}`. `stream.role` is `monitor` (hub tiles) or `live` (OBS); `profile` is `main`, which Chromium's WebRTC decoder is safe with.

**Feeds:** each phone hardware-encodes H.264 and pushes MPEG-TS over SRT (caller) to MediaMTX on the hub, `srt://<hub>:8890?streamid=publish:cam-<id>:tally:<password>`. The password is derived from the pairing key, and only `publish` is allowed from the network. Reading streams and the MediaMTX API need the hub's own local user `hubread` with a random password stored in the hub's `config.json`, and only from this computer; browsers get no CORS access. So a web page open on the hub computer can't watch the cameras or reconfigure the server. On the hub, OBS reads `srt://127.0.0.1:8890?streamid=read:cam-<id>:hubread:<password>` (Media Source: `input_format=mpegts`, hardware decode, buffering 0 MB, reconnect 1 s, `fflags=nobuffer flags=low_delay`), and the tiles read WebRTC (WHEP) from `http://127.0.0.1:8889/cam-<id>/whep`, localhost only, no STUN/TURN; the hub's main process does the signalling with the credentials, and the page itself never touches the network. **Add to OBS** writes the credentials into each source, and every time OBS connects the hub refreshes any existing `Tally · …` sources, so sources made by an older version keep working. SRT latency is 120 ms (`srtMinLatency` in `hub/mediamtx.yml`). The hub reads MediaMTX's local API (127.0.0.1:9997) for the per-camera bitrate and whether OBS is reading.

**Snapshot rate:** the hub tells each phone how many JPEG snapshots to send (`preview`): 12/s while its tile is on screen with no video playing, 1/s behind video, 2/s when the window is hidden. Only what is on screen costs the phone anything.

Test the sync math with: `cd mobile && npm test`

## Not built yet
- **Over-the-internet mode:** same protocol through a cloud relay keyed by room code.
