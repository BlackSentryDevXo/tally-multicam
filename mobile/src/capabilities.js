import { useEffect, useMemo, useState } from 'react';
import { CommonResolutions, VisionCamera, useCameraDevices } from 'react-native-vision-camera';
import { FPS_LIST, RES_LIST } from './config';

export const RES_SIZE = { 720: CommonResolutions.HD_16_9, 1080: CommonResolutions.FHD_16_9, 2160: CommonResolutions.UHD_16_9 };
const round1 = (n) => Math.round(n * 10) / 10;

/**
 * The phone's lenses as stock-camera style chips: ultra (0.5×), wide (1×), tele (2-5×), front.
 * Each lens is a physical device, so footage never jumps lenses mid-take the way a virtual multi-cam can.
 * Zoom factors are read from the virtual multi-cam's lens switch points (relative to the wide lens).
 */
export function useLenses() {
  const devices = useCameraDevices();
  return useMemo(() => {
    const back = devices.filter((d) => d.position === 'back');
    const physical = (type) => back.find((d) => !d.isVirtualDevice && d.type === type);
    const wide = physical('wide-angle') ?? back.find((d) => !d.isVirtualDevice) ?? back[0];
    const ultra = physical('ultra-wide-angle');
    const tele = physical('telephoto');
    const front = devices.find((d) => d.position === 'front' && !d.isVirtualDevice) ?? devices.find((d) => d.position === 'front');

    // The biggest virtual back camera knows where each lens kicks in, e.g. [2, 6] → ultra 0.5×, tele 3×.
    const virt = back.filter((d) => d.isVirtualDevice).sort((a, b) => b.physicalDevices.length - a.physicalDevices.length)[0];
    const f = [...(virt?.zoomLensSwitchFactors ?? [])].sort((a, b) => a - b);
    const virtHasUltra = virt?.physicalDevices.some((d) => d.type === 'ultra-wide-angle');
    const ultraX = virtHasUltra && f[0] > 1.01 ? round1(1 / f[0]) : 0.5;
    let teleX = 2;
    if (virtHasUltra && f.length >= 2) teleX = round1(f[f.length - 1] / f[0]);
    else if (!virtHasUltra && f.length >= 1) teleX = round1(f[0]);

    const list = [];
    if (ultra) list.push({ id: 'ultra', device: ultra, factor: ultraX });
    if (wide) list.push({ id: 'wide', device: wide, factor: 1 });
    if (tele) list.push({ id: 'tele', device: tele, factor: teleX });
    if (front) list.push({ id: 'front', device: front, factor: 1 });
    return list;
  }, [devices]);
}

const hasRes = (device, res) => {
  const want = RES_SIZE[res];
  try {
    return device.getSupportedResolutions('video').some(
      (s) => Math.min(s.width, s.height) >= want.width * 0.98 && Math.max(s.width, s.height) >= want.height * 0.98,
    );
  } catch {
    return res === 1080; // unknown HAL: assume the universal format
  }
};

/**
 * Which resolution × fps combos this exact device can record, plus HDR / stabilization / codec support.
 * resolveConstraints is asked with resolution ranked above fps, so selectedFPS tells whether that fps
 * holds at that resolution (e.g. 4K60). Results are cached per device id.
 * `learned` holds combos the live session later refused (see CameraScreen), so the picker greys them out too.
 */
const probeCache = new Map();
export function useFormatSupport(device, learned, codecs) {
  const [probed, setProbed] = useState(() => (device ? probeCache.get(device.id) : null));

  useEffect(() => {
    if (!device) return;
    if (probeCache.has(device.id)) return setProbed(probeCache.get(device.id));
    let cancelled = false;
    (async () => {
      const fps = {};
      for (const res of RES_LIST) {
        if (!hasRes(device, res)) continue;
        const output = VisionCamera.createVideoOutput({ targetResolution: RES_SIZE[res], enableAudio: false });
        const ok = [];
        for (const want of FPS_LIST.filter((x) => device.supportsFPS(x))) {
          try {
            const cfg = await VisionCamera.resolveConstraints(
              device, [{ output, mirrorMode: 'auto' }], [{ resolutionBias: output }, { fps: want }],
            );
            if (Math.round(cfg.selectedFPS ?? 0) >= want) ok.push(want);
          } catch {}
        }
        output.dispose?.();
        if (ok.length) fps[res] = ok;
      }
      // Fallback: if probing yielded nothing (very old Android HALs), trust the device-wide fps list.
      if (!Object.keys(fps).length) {
        for (const res of RES_LIST.filter((r) => hasRes(device, r))) fps[res] = FPS_LIST.filter((x) => device.supportsFPS(x));
        if (!Object.keys(fps).length) fps[1080] = [30];
      }
      const result = { fps };
      probeCache.set(device.id, result);
      if (!cancelled) setProbed(result);
    })();
    return () => { cancelled = true; };
  }, [device?.id]);

  return useMemo(() => {
    if (!device || !probed) return null;
    const bad = learned ?? {};
    const fps = {};
    for (const [res, list] of Object.entries(probed.fps)) {
      const ok = list.filter((f) => !bad[res]?.includes(f));
      if (ok.length) fps[res] = ok;
    }
    return {
      resolutions: RES_LIST.filter((r) => fps[r]),
      fps, // { [res]: [supported fps] }
      hdr: device.supportedVideoDynamicRanges.some((r) => r.bitDepth === 'hdr-10-bit'),
      stabilization: device.supportsVideoStabilizationMode('standard') || device.supportsVideoStabilizationMode('cinematic'),
      // Codec choice only where the encoder reports both (read from the live output after the camera starts).
      codec: !!codecs?.includes('h264') && !!codecs?.includes('h265'),
      torch: device.hasTorch,
      exposureBias: device.supportsExposureBias ? { min: device.minExposureBias, max: device.maxExposureBias } : null,
      // Manual 3A + lockCurrent*: gated on what this device reports, on both platforms
      // (Android support comes from the patched native side; failures are caught and toasted at call time).
      manualFocus: !!device.supportsFocusLocking,
      manualExposure: !!device.supportsExposureLocking,
      manualWB: !!device.supportsWhiteBalanceLocking,
      maxWBGain: device.maxWhiteBalanceGain,
      zoom: { min: device.minZoom, max: device.maxZoom },
    };
  }, [device, probed, learned, codecs]);
}
