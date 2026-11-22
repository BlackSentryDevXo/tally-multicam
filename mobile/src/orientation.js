import { useContext, useEffect, useRef } from 'react';
import { Animated, Platform } from 'react-native';
import { useOrientation } from 'react-native-vision-camera';
import { RotContext, T } from './controls';

// The window is locked to portrait (app.json "orientation": "portrait"), so the UI rotates itself from the
// PHYSICAL orientation, which VisionCamera reads straight from the accelerometer (CoreMotion on iOS,
// OrientationEventListener on Android). That works with the OS rotation lock on, like the stock Camera app.
//
// rot = degrees to rotate the UI canvas clockwise so it reads upright for the user:
//   top of the phone pointing LEFT  (phone turned counter-clockwise) → +90
//   top of the phone pointing RIGHT (phone turned clockwise)         → −90
// VisionCamera names these per platform (read from its native sources):
//   iOS     CMAccelerometerData: x < 0 → 'left'  = top points left.
//   Android OrientationEventListener 90° ("left side at the top", i.e. top points right) → 'left'.
// So Android's 'left'/'right' are the mirror of iOS's. ponytail: one-time device check on Android: if the
// landscape UI appears upside-down on the S21, flip ANDROID_MIRRORED.
const ANDROID_MIRRORED = true;
const toRot = (o) => {
  if (o !== 'left' && o !== 'right') return 0; // 'up', 'down' (and unknown / flat) keep the portrait layout
  const topLeft = Platform.OS === 'android' && ANDROID_MIRRORED ? o === 'right' : o === 'left';
  return topLeft ? 90 : -90;
};
export const orientationName = (rot) => (rot === 90 ? 'landscape-left' : rot === -90 ? 'landscape-right' : 'portrait');

export const useRot = () => useContext(RotContext); // the canvas provides it (CameraScreen)

// { rot, landscape, name, rotAnim, upsideDown } — rotAnim eases to rot over T.base ms (native driver).
export function useDeviceRotation() {
  let o;
  try { o = useOrientation('device'); } catch { o = undefined; }
  const rot = toRot(o);
  const rotAnim = useRef(new Animated.Value(rot)).current;
  useEffect(() => {
    Animated.timing(rotAnim, { toValue: rot, duration: T.base, useNativeDriver: true }).start();
  }, [rot]);
  return { rot, landscape: rot !== 0, name: orientationName(rot), rotAnim, upsideDown: o === 'down' };
}

// Window safe-area insets → insets of the rotated canvas (the physical top/bottom/left/right the user sees).
export function physicalInsets(insets, rot) {
  if (rot === 90) return { top: insets.right, bottom: insets.left, left: insets.top, right: insets.bottom };
  if (rot === -90) return { top: insets.left, bottom: insets.right, left: insets.bottom, right: insets.top };
  return insets;
}

// Window-space drag deltas → physical (what the user did with their finger).
export function physicalDelta(dx, dy, rot) {
  if (rot === 90) return { dx: dy, dy: -dx };
  if (rot === -90) return { dx: -dy, dy: dx };
  return { dx, dy };
}

// Normalised point in a physically-oriented landscape image → normalised point in the portrait window.
export function physicalToWindow(nx, ny, rot) {
  if (rot === 90) return { x: 1 - ny, y: nx };
  if (rot === -90) return { x: ny, y: 1 - nx };
  return { x: nx, y: ny };
}
