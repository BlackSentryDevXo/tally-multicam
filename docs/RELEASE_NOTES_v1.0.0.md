# Tally 1.0.0

First public release: turn phones into a synced multi-camera rig.

## Downloads

| File | For |
|---|---|
| `Tally-Hub-macOS-arm64.zip` | Tally Hub on Macs with Apple silicon (M1 and newer) |
| `Tally-Hub-Windows-x64.zip` | Tally Hub on 64-bit Windows PCs |
| `Tally-Cam-Android.apk` | Tally Cam on Android 8.0 and newer |
| `SHA256SUMS.txt` | Checksums to verify the downloads |

iPhone: build Tally Cam from source with your own Apple account (see the README). Intel Macs: run Tally Hub from
source.

## Highlights

- **One-button recording** for every phone and OBS, clock-synced over Wi-Fi, with a start beep for audio sync.
- **Pro camera app:** lens switching, tap and double-tap AE/AF lock, manual focus/ISO/shutter/white balance,
  one-tap resolution and frame rate, flicker-safe 50/60 Hz presets, controls that rotate with the phone.
- **Live to OBS:** hardware-encoded SRT feeds up to 1080p60, and **Add to OBS** builds the scenes for you.
- **Monitoring:** smooth tile video, battery, time left, temperature and audio meters for every camera.
- **Automatic copy** of every clip to the computer, with gallery backups and retry; nothing is deleted on phones.
- **Reliability:** phones keep recording through Wi-Fi drops and hub restarts; heat protection steps live feeds
  down before the recording is affected.

## Known limitations

- The macOS build is not notarized: right-click → **Open** on first launch. With the macOS firewall on, you may
  need to click **Allow** again after updates, or sign your own copy (see the README).
- The Windows build has not yet been tested on a real Windows PC. Please report issues.
- Android manual controls need a phone with manual sensor support; the live feed on older Android phones may need
  720p30.
- iPhone builds can't be distributed as downloads; build from source.
