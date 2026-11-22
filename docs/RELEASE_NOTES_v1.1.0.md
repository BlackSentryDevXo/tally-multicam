# Tally 1.1.0

Real lenses, a cleaner live picture, and a full camera settings panel in the hub.

## Downloads

| File | For |
|---|---|
| `Tally-Hub-macOS-arm64.zip` | Tally Hub on Macs with Apple silicon (M1 and newer) |
| `Tally-Hub-Windows-x64.zip` | Tally Hub on 64-bit Windows PCs |
| `Tally-Cam-Android.apk` | Tally Cam on Android 8.0 and newer (installs over 1.0.0) |
| `SHA256SUMS.txt` | Checksums to verify the downloads |

iPhone: build Tally Cam from source with your own Apple account (see the README). Intel Macs: run Tally Hub from
source.

## Highlights

- **Real lenses on Android:** the 0.5× and telephoto chips now switch to the actual physical sensors, including
  telephotos that phones only expose inside their multi-camera (e.g. the Galaxy S24's 3×). Before, Android's 3×
  was a crop of the main camera.
- **Cleaner, cooler Android live feed:** frames go from the camera straight into the hardware encoder on the GPU
  (no CPU copies), stabilized like the recording when Stabilize is on, always 16:9 and upright.
- **Settings panel in the hub:** click a camera for lens, zoom, format, focus (auto / manual position), exposure
  (auto + bias / manual ISO + shutter), white balance (auto / Kelvin + tint), stabilization, HDR, torch and lock,
  with live readouts of what the camera is doing on auto.
- **Framing:** pan and zoom each camera's live picture from a minimap. OBS follows instantly; recordings stay
  full-frame.
- **Portrait guide:** a 9:16 box over every preview, for shots that also work as vertical clips.
- **Live quality:** Standard / High / Max bitrate (1080p60: 12 / 20 / 30 Mb/s), changed on the fly.
- **OBS:** cameras arrive as low-latency WebRTC Browser Sources (no extra buffering), each with a ready-to-use
  colour-correction filter. The OBS connection no longer depends on the record-sync switch and retries on its own.
- **Lower latency, fewer glitches:** each phone sizes its SRT buffer from its measured round trip (120–250 ms).
- **iPhone encoder:** steadier quality (no once-a-second dip at keyframes), High profile for OBS feeds.

## Fixes

- Tally Cam crashed on launch on Android (QR pairing used an iOS-only scanner).
- Android live feed missing in release builds, 4:3 instead of 16:9, and "No flash unit" warnings.
- Phones that found the hub by its network name couldn't start the live feed (IPv6 link-local address).
- AE/AF lock, HDR and stabilization from the hub now show the phone's real state and say why when refused
  (e.g. no HDR at 1080p60 on iPhone 12).
- The phone dims during live, not only while recording.

## Known limitations

- The macOS build is not notarized: right-click → **Open** on first launch. With the macOS firewall on, you may
  need to click **Allow** again after updates, or sign your own copy (see the README).
- If a camera shows black in OBS, untick OBS → Settings → Advanced → Sources → **Browser Source Hardware
  Acceleration** and restart OBS.
- Framing is a digital crop of the live view; use a lens or the phone's zoom for big changes.
- With HDR recording on, Android phones pause their live feed (the GPU path is 8-bit).
- Phones still run warm during long live sessions, mostly from the camera hardware and charging; give them airflow
  and turn off Stabilize on tripod shots.
- The Windows build has not yet been tested on a real Windows PC. Please report issues.
- iPhone builds can't be distributed as downloads; build from source.
