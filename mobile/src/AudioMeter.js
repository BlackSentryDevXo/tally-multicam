import { memo, useEffect, useRef, useState } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
import { useAudioStream } from 'expo-audio';

// Pro peak meter in dBFS. Green < -18, yellow -18…-6, red -6…0. Peak-hold tick, CLIP latches for 2 s.
// Mic PCM comes from expo-audio's AudioStream (VisionCamera v5 has no audio level/sample API).
//
// <MicSource> (exactly one, headless) owns the mic stream and drives shared Animated values.
// <LevelMeter> (any number) only displays them, via native-driver transforms: nothing re-renders per buffer.

const FLOOR = -60;
const RELEASE_DB_PER_S = 24; // meter fall-back speed (PPM-ish)
const HOLD_MS = 1500;
const CLIP_MS = 2000;
const ZONES = [
  { from: FLOOR, to: -18, color: '#30d158' },
  { from: -18, to: -6, color: '#ffd60a' },
  { from: -6, to: 0, color: '#ff3b30' },
];
const TICKS = [-40, -18, -6, 0];
const frac = (db) => Math.min(1, Math.max(0, (db - FLOOR) / -FLOOR));

const bus = {
  level: new Animated.Value(0),
  hold: new Animated.Value(0),
  clip: new Animated.Value(0),
  status: { live: false, label: '…' },
  subs: new Set(),
};
function setStatus(p) {
  const next = { ...bus.status, ...p };
  if (next.live === bus.status.live && next.label === bus.status.label) return;
  bus.status = next;
  bus.subs.forEach((f) => f(next));
}

function MicSourceImpl({ enabled, recording, pausedLabel, onLevel }) {
  const st = useRef({ shown: FLOOR, holdDb: FLOOR, holdAt: 0, last: 0, win: -Infinity, clipTimer: null }).current;
  const onLevelRef = useRef(onLevel);
  onLevelRef.current = onLevel;
  const recordingRef = useRef(!!recording);
  recordingRef.current = !!recording;
  const [failed, setFailed] = useState(null);

  function onBuffer(buf) {
    const pcm = new Float32Array(buf.data);
    let peak = 0;
    for (let i = 0; i < pcm.length; i++) {
      const a = pcm[i] < 0 ? -pcm[i] : pcm[i];
      if (a > peak) peak = a;
    }
    const now = Date.now();
    const dt = st.last ? Math.min(0.5, (now - st.last) / 1000) : 0.05;
    st.last = now;
    const db = peak > 0 ? 20 * Math.log10(peak) : FLOOR;
    st.win = Math.max(st.win, db);

    // Instant attack, steady release; the timing animation interpolates between buffers.
    st.shown = Math.max(db, st.shown - RELEASE_DB_PER_S * dt);
    Animated.timing(bus.level, { toValue: frac(st.shown), duration: Math.round(dt * 1000), useNativeDriver: true }).start();

    if (db >= st.holdDb) { st.holdDb = db; st.holdAt = now; }
    else if (now - st.holdAt > HOLD_MS) st.holdDb = Math.max(FLOOR, st.holdDb - RELEASE_DB_PER_S * dt);
    bus.hold.setValue(frac(st.holdDb));

    if (peak >= 0.999) {
      bus.clip.setValue(1);
      clearTimeout(st.clipTimer);
      st.clipTimer = setTimeout(() => bus.clip.setValue(0), CLIP_MS);
    }
  }

  const { stream, isStreaming } = useAudioStream({ sampleRate: 48000, channels: 1, encoding: 'float32', onBuffer });

  // Start/stop with `enabled`. A watchdog restarts the stream if buffers stop (e.g. iOS reconfigures the
  // audio session when the camera starts recording), but only between takes: restarting the meter mid-take
  // could reconfigure the audio session under the recorder, and the recording always wins.
  useEffect(() => {
    if (!enabled) {
      stream.stop();
      bus.level.setValue(0);
      bus.hold.setValue(0);
      st.shown = st.holdDb = FLOOR;
      return;
    }
    let lastRestart = 0;
    const start = () => {
      lastRestart = Date.now();
      st.last = Date.now();
      stream.start().then(() => setFailed(null)).catch((e) => setFailed(e.message));
    };
    start();
    const watchdog = setInterval(() => {
      if (recordingRef.current) return;
      if (Date.now() - st.last > 1500 && Date.now() - lastRestart > 3000) {
        try { stream.stop(); } catch {}
        start();
      }
    }, 1000);
    // ~5 Hz peak report for the hub (peak over the last 200 ms, 0.5 dB steps).
    const reporter = setInterval(() => {
      if (Date.now() - st.last < 600 && isFinite(st.win)) onLevelRef.current?.(Math.round(st.win * 2) / 2);
      st.win = -Infinity;
    }, 200);
    return () => { clearInterval(watchdog); clearInterval(reporter); stream.stop(); };
  }, [enabled, stream]);

  useEffect(() => () => clearTimeout(st.clipTimer), []);
  useEffect(() => {
    setStatus({ live: enabled && isStreaming && !failed, label: !enabled ? pausedLabel : failed ? 'MIC N/A' : null });
  }, [enabled, isStreaming, failed, pausedLabel]);
  return null;
}
export const MicSource = memo(MicSourceImpl);

function LevelMeterImpl({ vertical, compact }) {
  const [status, setS] = useState(bus.status);
  const [len, setLen] = useState(1);
  useEffect(() => { bus.subs.add(setS); setS(bus.status); return () => bus.subs.delete(setS); }, []);
  const move = (v) => v.interpolate({ inputRange: [0, 1], outputRange: [0, vertical ? -len : len] });
  const axis = (v) => [vertical ? { translateY: move(v) } : { translateX: move(v) }];
  const showScale = !compact;

  return (
    <View style={[vertical ? s.wrapV : s.wrapH, compact && (vertical ? s.compactV : s.compactH)]} pointerEvents="none" accessibilityLabel="Audio level meter">
      <Animated.View style={[s.clip, { opacity: bus.clip.interpolate({ inputRange: [0, 1], outputRange: [0.25, 1] }) }]}>
        <Text style={s.clipText} allowFontScaling={false}>CLIP</Text>
      </Animated.View>
      <View style={{ flex: 1, alignSelf: 'stretch', justifyContent: 'center', alignItems: 'center' }}>
        <View
          style={[vertical ? s.barV : s.barH, !status.live && { opacity: 0.35 }]}
          onLayout={(e) => setLen(vertical ? e.nativeEvent.layout.height : e.nativeEvent.layout.width)}
        >
          <View style={[StyleSheet.absoluteFill, { flexDirection: vertical ? 'column-reverse' : 'row' }]}>
            {ZONES.map((z) => <View key={z.color} style={{ flex: z.to - z.from, backgroundColor: z.color }} />)}
          </View>
          {/* The cover slides away to reveal the lit zones; the peak tick rides the same axis. */}
          <Animated.View style={[StyleSheet.absoluteFill, s.cover, { transform: axis(bus.level) }]} />
          <Animated.View style={[vertical ? s.tickV : s.tickH, { transform: axis(bus.hold) }]} />
          {TICKS.map((t) => (
            <View key={t} style={[vertical ? s.markV : s.markH, vertical ? { bottom: `${frac(t) * 100}%` } : { left: `${frac(t) * 100}%` }]} />
          ))}
        </View>
        {showScale && !(vertical && status.label) && (
          <View style={vertical ? s.scaleV : s.scaleH}>
            {status.label ? (
              <Text style={s.paused} allowFontScaling={false} numberOfLines={1}>{status.label}</Text>
            ) : TICKS.map((t) => (
              <Text
                key={t}
                allowFontScaling={false}
                style={[s.scaleText, vertical
                  ? { position: 'absolute', bottom: `${frac(t) * 100}%`, marginBottom: -5, left: 0 }
                  : { position: 'absolute', left: `${frac(t) * 100}%`, marginLeft: t === 0 ? -6 : -8 }]}
              >
                {t}
              </Text>
            ))}
          </View>
        )}
      </View>
      {vertical && status.label && !compact ? (
        <Text style={[s.paused, { textAlign: 'center' }]} allowFontScaling={false} numberOfLines={2}>{status.label}</Text>
      ) : null}
    </View>
  );
}
export const LevelMeter = memo(LevelMeterImpl);

const s = StyleSheet.create({
  wrapH: { flexDirection: 'row', alignItems: 'center', gap: 8, height: 30, paddingHorizontal: 10, borderRadius: 8, backgroundColor: '#000a' },
  wrapV: { flexDirection: 'column-reverse', alignItems: 'center', gap: 8, width: 44, paddingVertical: 10, borderRadius: 8, backgroundColor: '#000a' },
  compactH: { height: 16, paddingHorizontal: 0, gap: 6, backgroundColor: 'transparent' },
  compactV: { width: 16, paddingVertical: 0, gap: 6, backgroundColor: 'transparent' },
  barH: { alignSelf: 'stretch', height: 6, marginTop: -6, borderRadius: 3, overflow: 'hidden', backgroundColor: '#222' },
  barV: { flex: 1, width: 6, marginRight: 14, borderRadius: 3, overflow: 'hidden', backgroundColor: '#222' },
  cover: { backgroundColor: '#1c1c1e' },
  tickH: { position: 'absolute', left: -1, top: 0, bottom: 0, width: 2, backgroundColor: '#fff' },
  tickV: { position: 'absolute', bottom: -1, left: 0, right: 0, height: 2, backgroundColor: '#fff' },
  markH: { position: 'absolute', top: 0, bottom: 0, width: 1, backgroundColor: '#0008' },
  markV: { position: 'absolute', left: 0, right: 0, height: 1, backgroundColor: '#0008' },
  scaleH: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 11 },
  scaleV: { position: 'absolute', top: 0, bottom: 0, right: 0, width: 16 },
  scaleText: { color: '#aaa', fontSize: 8, fontVariant: ['tabular-nums'] },
  paused: { color: '#aaa', fontSize: 8, fontWeight: '700', letterSpacing: 0.5 },
  clip: { paddingHorizontal: 4, paddingVertical: 2, borderRadius: 3, backgroundColor: '#ff3b30' },
  clipText: { color: '#fff', fontSize: 8, fontWeight: '800', letterSpacing: 0.5 },
});
