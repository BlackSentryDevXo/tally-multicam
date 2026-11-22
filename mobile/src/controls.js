import { createContext, forwardRef, useContext, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native';
import { GestureDetector, usePanGesture } from 'react-native-gesture-handler';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';

// UI rotation of the canvas these controls live in (see orientation.js). Gesture translations arrive in
// window coordinates, so a "horizontal" scrub on a rotated canvas is a vertical drag on the window.
export const RotContext = createContext(0);

// Design tokens. Restrained: near-black translucent surfaces, white text, tally red ONLY for recording/live,
// amber ONLY for locks, manual values and warnings. Spacing on an 8pt grid.
export const C = {
  bg: '#000',
  surface: 'rgba(12,12,14,0.62)',
  surfaceHi: 'rgba(255,255,255,0.12)',
  sheet: 'rgba(18,18,20,0.97)',
  line: 'rgba(255,255,255,0.12)',
  text: '#fff',
  dim: 'rgba(255,255,255,0.64)',
  faint: 'rgba(255,255,255,0.40)',
  red: '#ff3b30',
  amber: '#ffb340',
  green: '#30d158',
};
C.accent = C.amber; // back-compat alias
export const SP = { xs: 4, s: 8, m: 16, l: 24, xl: 32 };
export const T = { fast: 150, base: 200, slow: 250 };
export const mono = { fontVariant: ['tabular-nums'] };

export const haptic = {
  tap: () => Haptics.selectionAsync().catch(() => {}),
  thud: () => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {}),
  warn: () => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {}),
};

const pressedStyle = ({ pressed }) => pressed && { opacity: 0.55 };

// Round icon button, 44pt target.
export function IconButton({ icon, label, onPress, onLongPress, active, tone, size = 22, style, disabled }) {
  const bg = active ? (tone === 'amber' ? C.amber : C.text) : null;
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: !!active, disabled: !!disabled }}
      hitSlop={8}
      style={(st) => [s.iconBtn, bg && { backgroundColor: bg }, pressedStyle(st), disabled && { opacity: 0.3 }, style]}
    >
      <Ionicons name={icon} size={size} color={active ? '#000' : C.text} />
    </Pressable>
  );
}

// Text pill (sheet options, quick toggles).
export function Pill({ text, onPress, onLongPress, active, label, style, disabled }) {
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label ?? text}
      accessibilityState={{ selected: !!active, disabled: !!disabled }}
      hitSlop={8}
      style={(st) => [s.pill, active && s.pillActive, pressedStyle(st), disabled && { opacity: 0.35 }, style]}
    >
      <Text style={[s.pillText, mono, active && { color: '#000' }]} allowFontScaling={false}>{text}</Text>
    </Pressable>
  );
}

// iOS-style segmented control.
export function Segmented({ options, value, onChange, disabled }) {
  return (
    <View style={[s.seg, disabled && { opacity: 0.4 }]}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Pressable
            key={String(o.value)}
            disabled={disabled}
            onPress={() => { if (!on) { haptic.tap(); onChange(o.value); } }}
            accessibilityRole="button"
            accessibilityLabel={o.a11y ?? o.label}
            accessibilityState={{ selected: on, disabled: !!disabled }}
            style={[s.segItem, on && s.segItemOn]}
          >
            <Text style={[s.segText, mono, on && { color: '#000' }]} allowFontScaling={false}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

// One cell of the pro status strip: tiny caps label over a big tabular value. Tap / long-press to change.
export function StatCell({ label, value, tone, onPress, onLongPress, a11y, flex = 1 }) {
  const color = tone === 'amber' ? C.amber : tone === 'red' ? C.red : C.text;
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      disabled={!onPress && !onLongPress}
      accessibilityRole="button"
      accessibilityLabel={a11y ?? `${label} ${value}`}
      style={(st) => [s.cell, { flex }, pressedStyle(st)]}
    >
      <Text style={s.cellLabel} allowFontScaling={false} numberOfLines={1}>{label}</Text>
      <Text style={[s.cellValue, mono, { color }]} allowFontScaling={false} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.75}>
        {value}
      </Text>
    </Pressable>
  );
}

// Small status tag (AE/AF LOCK, HDR …).
export function Tag({ text, tone }) {
  const amber = tone === 'amber';
  return (
    <View style={[s.tag, amber ? { backgroundColor: C.amber } : { borderColor: C.line, borderWidth: 1 }]}>
      <Text style={[s.tagText, { color: amber ? '#000' : C.dim }]} allowFontScaling={false}>{text}</Text>
    </View>
  );
}

// Shutter. `recording` is the target state, so it morphs the instant it's pressed;
// `pending` (waiting for the hub to confirm) adds a subtle breathing ring.
export function RecordButton({ recording, pending, onPress, disabled, size = 76 }) {
  const v = useRef(new Animated.Value(recording ? 1 : 0)).current;
  useEffect(() => {
    Animated.timing(v, { toValue: recording ? 1 : 0, duration: T.fast, useNativeDriver: false }).start();
  }, [recording]);
  const ring = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!pending) { ring.stopAnimation(); ring.setValue(1); return; }
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(ring, { toValue: 0.35, duration: 450, useNativeDriver: true }),
      Animated.timing(ring, { toValue: 1, duration: 450, useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [pending]);
  const inner = size - 14;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={recording ? 'Stop recording' : 'Start recording'}
      accessibilityHint={pending ? 'Waiting for Tally Hub' : undefined}
      hitSlop={8}
      style={({ pressed }) => [{ width: size, height: size, alignItems: 'center', justifyContent: 'center' },
        pressed && { transform: [{ scale: 0.95 }] }, disabled && { opacity: 0.4 }]}
    >
      <Animated.View style={[StyleSheet.absoluteFill, s.shutterRing, { borderRadius: size / 2, opacity: ring }]} />
      <Animated.View
        style={{
          backgroundColor: C.red,
          width: v.interpolate({ inputRange: [0, 1], outputRange: [inner, inner * 0.46] }),
          height: v.interpolate({ inputRange: [0, 1], outputRange: [inner, inner * 0.46] }),
          borderRadius: v.interpolate({ inputRange: [0, 1], outputRange: [inner / 2, 6] }),
        }}
      />
    </Pressable>
  );
}

// Blackmagic-style scrubbing ruler. Only a deliberate horizontal drag changes it (vertical moves fail the
// gesture and scroll the sheet instead); tapping the track does nothing. Values snap to `stops`.
// AUTO: shows the camera's current auto value in grey; tap the value to switch AUTO ↔ manual (or reset).
const TICK = 14;
export function Ruler({ label, stops, value, autoValue, auto, format, short, isMajor, onChange, onAuto, onReset, note }) {
  const [w, setW] = useState(0);
  const [drag, setDrag] = useState(null); // fractional index while dragging
  const shown = auto ? autoValue : value;
  const idxOf = (v) => {
    if (v == null || !stops.length) return Math.floor(stops.length / 2);
    let best = 0;
    for (let i = 1; i < stops.length; i++) if (Math.abs(stops[i] - v) < Math.abs(stops[best] - v)) best = i;
    return best;
  };
  const cur = idxOf(shown);
  const rot = useContext(RotContext);
  const r = useRef({});
  Object.assign(r.current, { cur, stops, onChange, rot });
  // Only a deliberate drag along the ruler's own (physical) axis activates; the cross axis fails → scroll.
  const axis = rot ? { activeOffsetY: [-12, 12], failOffsetX: [-8, 8] } : { activeOffsetX: [-12, 12], failOffsetY: [-8, 8] };
  const pan = usePanGesture({
    ...axis,
    runOnJS: true,
    onActivate: () => { r.current.start = r.current.cur; r.current.last = r.current.cur; },
    onUpdate: (e) => {
      const n = r.current.stops.length;
      const k = r.current.rot;
      const dx = k === 90 ? e.translationY : k === -90 ? -e.translationY : e.translationX;
      const pos = Math.min(n - 1, Math.max(0, r.current.start - dx / TICK));
      setDrag(pos);
      const i = Math.round(pos);
      if (i !== r.current.last) { r.current.last = i; haptic.tap(); r.current.onChange(r.current.stops[i]); }
    },
    onFinalize: () => setDrag(null),
  });
  const pos = drag ?? cur;
  const half = Math.ceil(w / 2 / TICK) + 1;
  const ticks = [];
  for (let i = Math.max(0, Math.floor(pos) - half); i <= Math.min(stops.length - 1, Math.ceil(pos) + half); i++) {
    const major = isMajor ? isMajor(stops[i], i) : i % 5 === 0;
    const x = w / 2 + (i - pos) * TICK;
    ticks.push(
      <View key={i} style={[s.rTick, { left: x - 0.5, height: major ? 14 : 7, opacity: major ? 0.9 : 0.45 }]} />,
      major && short ? (
        <Text key={`l${i}`} style={[s.rLabel, mono, { left: x - 24 }]} allowFontScaling={false} numberOfLines={1}>{short(stops[i])}</Text>
      ) : null,
    );
  }
  const manual = !auto;
  const tapValue = onAuto ? () => { haptic.tap(); auto ? onChange(stops[cur]) : onAuto(); } : onReset;
  return (
    <View style={s.ruler}>
      <View style={s.sliderHead}>
        <Text style={s.sliderLabel} allowFontScaling={false}>{label}</Text>
        {note ? <Text style={[s.rNote, mono]} allowFontScaling={false}>{note}</Text> : null}
        <Pressable onPress={tapValue} disabled={!tapValue} hitSlop={10} accessibilityRole="button"
          accessibilityLabel={`${label} ${auto ? 'automatic' : format(shown)}. ${onAuto ? (auto ? 'Tap to set manually.' : 'Tap for automatic.') : 'Tap to reset.'}`}
          style={[s.rValueBtn, auto && onAuto && s.rValueAuto]}>
          {auto && onAuto && <Text style={s.rAutoTag} allowFontScaling={false}>AUTO</Text>}
          <Text style={[s.sliderValue, mono, auto ? { color: C.dim } : onAuto && { color: C.amber }]} allowFontScaling={false}>
            {shown == null ? '—' : format(stops[Math.round(drag ?? cur)] ?? shown)}
          </Text>
        </Pressable>
      </View>
      <GestureDetector gesture={pan}>
        <View style={s.rTrack} onLayout={(e) => setW(e.nativeEvent.layout.width)} accessibilityRole="adjustable"
          accessibilityLabel={`${label} ruler. Drag sideways to change.`}
          accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
          onAccessibilityAction={(e) => {
            const i = Math.min(stops.length - 1, Math.max(0, cur + (e.nativeEvent.actionName === 'increment' ? 1 : -1)));
            onChange(stops[i]);
          }}>
          {w > 0 && ticks}
          <View style={[s.rNeedle, { left: w / 2 - 1, backgroundColor: manual && onAuto ? C.amber : C.text }]} />
        </View>
      </GestureDetector>
    </View>
  );
}

// Brief message pill. toast.current.show('4K60 isn’t supported — using 4K30', { tone: 'warn' })
export const Toast = forwardRef(function Toast({ top = 110 }, ref) {
  const [msg, setMsg] = useState({ text: '', tone: null });
  const o = useRef(new Animated.Value(0)).current;
  const y = useRef(new Animated.Value(-8)).current;
  const timer = useRef();
  useImperativeHandle(ref, () => ({
    show(text, opts = {}) {
      setMsg({ text, tone: opts.tone ?? null });
      clearTimeout(timer.current);
      Animated.parallel([
        Animated.timing(o, { toValue: 1, duration: T.fast, useNativeDriver: true }),
        Animated.timing(y, { toValue: 0, duration: T.base, useNativeDriver: true }),
      ]).start();
      timer.current = setTimeout(() => {
        Animated.parallel([
          Animated.timing(o, { toValue: 0, duration: T.slow, useNativeDriver: true }),
          Animated.timing(y, { toValue: -8, duration: T.slow, useNativeDriver: true }),
        ]).start();
      }, opts.ms ?? 2400);
    },
  }));
  const warn = msg.tone === 'warn';
  return (
    <Animated.View pointerEvents="none" style={[s.toast, { top, opacity: o, transform: [{ translateY: y }] }]} accessibilityLiveRegion="polite">
      {warn && <Ionicons name="warning" size={15} color={C.amber} />}
      <Text style={s.toastText}>{msg.text}</Text>
    </Animated.View>
  );
});

// Focus square with an exposure "sun" readout; pops in on tap, dims after a moment, stays bright when locked.
// `rot` turns the readout so it reads upright when the phone is held sideways (the square is symmetric).
export function FocusReticle({ point, locked, exposure, rot = 0 }) {
  const scale = useRef(new Animated.Value(1)).current;
  const opacity = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!point) return;
    scale.setValue(1.4);
    opacity.setValue(1);
    Animated.timing(scale, { toValue: 1, duration: T.slow, useNativeDriver: true }).start();
    if (!locked) {
      const t = setTimeout(() => Animated.timing(opacity, { toValue: 0.3, duration: 600, useNativeDriver: true }).start(), 2500);
      return () => clearTimeout(t);
    }
  }, [point?.id, locked]);
  if (!point) return null;
  return (
    <Animated.View pointerEvents="none" style={[s.reticle, { left: point.x - 36, top: point.y - 36, opacity, transform: [{ scale }, { rotate: `${rot}deg` }] }]}>
      {['tl', 'tr', 'bl', 'br'].map((c) => <View key={c} style={[s.rc, s[`rc_${c}`]]} />)}
      <View style={s.sun}>
        <Ionicons name="sunny" size={13} color={C.amber} />
        {exposure !== 0 && <Text style={[s.sunText, mono]}>{exposure > 0 ? '+' : ''}{exposure.toFixed(1)}</Text>}
      </View>
    </Animated.View>
  );
}

export function Grid() {
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      {[1, 2].map((i) => <View key={`v${i}`} style={[s.gridV, { left: `${(i * 100) / 3}%` }]} />)}
      {[1, 2].map((i) => <View key={`h${i}`} style={[s.gridH, { top: `${(i * 100) / 3}%` }]} />)}
    </View>
  );
}

const RC = 14;
const s = StyleSheet.create({
  iconBtn: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: C.surface },
  pill: { minHeight: 32, paddingHorizontal: 12, borderRadius: 16, justifyContent: 'center', backgroundColor: C.surfaceHi },
  pillActive: { backgroundColor: C.text },
  pillText: { color: C.text, fontSize: 13, fontWeight: '600', letterSpacing: 0.2 },
  seg: { flexDirection: 'row', padding: 2, borderRadius: 10, backgroundColor: C.surfaceHi },
  segItem: { minWidth: 56, minHeight: 32, paddingHorizontal: 12, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  segItemOn: { backgroundColor: C.text },
  segText: { color: C.text, fontSize: 13, fontWeight: '600' },
  cell: { minHeight: 44, paddingHorizontal: 4, alignItems: 'center', justifyContent: 'center' },
  cellLabel: { color: C.faint, fontSize: 9, fontWeight: '700', letterSpacing: 1 },
  cellValue: { fontSize: 15, fontWeight: '600', marginTop: 1 },
  tag: { height: 20, paddingHorizontal: 6, borderRadius: 4, justifyContent: 'center' },
  tagText: { fontSize: 10, fontWeight: '800', letterSpacing: 0.6 },
  shutterRing: { borderWidth: 4, borderColor: '#fff' },
  sliderHead: { flexDirection: 'row', alignItems: 'center', gap: SP.s },
  sliderLabel: { color: C.dim, fontSize: 11, fontWeight: '700', letterSpacing: 1, flex: 1, textTransform: 'uppercase' },
  sliderValue: { color: C.text, fontSize: 15, fontWeight: '600' },
  ruler: { paddingVertical: SP.xs },
  rTrack: { height: 48, overflow: 'hidden', borderRadius: 10, backgroundColor: 'rgba(255,255,255,0.05)' },
  rTick: { position: 'absolute', bottom: 8, width: 1, backgroundColor: '#fff' },
  rLabel: { position: 'absolute', top: 4, width: 48, textAlign: 'center', color: C.dim, fontSize: 10, fontWeight: '600' },
  rNeedle: { position: 'absolute', top: 4, bottom: 4, width: 2, borderRadius: 1 },
  rValueBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 32, paddingHorizontal: 8, borderRadius: 8 },
  rValueAuto: { backgroundColor: 'rgba(255,255,255,0.08)' },
  rAutoTag: { color: C.dim, fontSize: 9, fontWeight: '800', letterSpacing: 0.8 },
  rNote: { color: C.faint, fontSize: 12, fontWeight: '600' },
  toast: { position: 'absolute', alignSelf: 'center', maxWidth: '86%', flexDirection: 'row', alignItems: 'center', gap: SP.s, paddingHorizontal: SP.m, paddingVertical: 10, borderRadius: 20, backgroundColor: 'rgba(28,28,30,0.94)' },
  toastText: { color: '#fff', fontSize: 14, fontWeight: '500', textAlign: 'center', flexShrink: 1 },
  reticle: { position: 'absolute', width: 72, height: 72 },
  rc: { position: 'absolute', width: RC, height: RC, borderColor: C.amber },
  rc_tl: { top: 0, left: 0, borderTopWidth: 1.5, borderLeftWidth: 1.5 },
  rc_tr: { top: 0, right: 0, borderTopWidth: 1.5, borderRightWidth: 1.5 },
  rc_bl: { bottom: 0, left: 0, borderBottomWidth: 1.5, borderLeftWidth: 1.5 },
  rc_br: { bottom: 0, right: 0, borderBottomWidth: 1.5, borderRightWidth: 1.5 },
  sun: { position: 'absolute', left: 78, top: 27, flexDirection: 'row', alignItems: 'center', gap: 2 },
  sunText: { color: C.amber, fontSize: 12, fontWeight: '700' },
  gridV: { position: 'absolute', top: 0, bottom: 0, width: StyleSheet.hairlineWidth, backgroundColor: 'rgba(255,255,255,0.45)' },
  gridH: { position: 'absolute', left: 0, right: 0, height: StyleSheet.hairlineWidth, backgroundColor: 'rgba(255,255,255,0.45)' },
});
