import { useEffect, useRef, useState } from 'react';
import { Animated, Pressable, StyleSheet, Switch, Text, View, useWindowDimensions } from 'react-native';
import { ScrollView } from 'react-native-gesture-handler';
import { Ionicons } from '@expo/vector-icons';
import { C, Pill, Ruler, SP, Segmented, T, mono } from './controls';
import { FPS_LIST, RES_LABEL, RES_LIST, bitrate } from './config';
import { fpsBeats, shutterAngle, shutterFlickers } from './pairing';

// ---------- standard stops ----------
const SHUTTER_DENOMS = [24, 25, 30, 40, 48, 50, 60, 80, 96, 100, 120, 125, 160, 192, 200, 240, 250, 320, 400, 500, 640, 800, 1000, 1250, 1600, 2000, 2500, 3200, 4000, 5000, 6400, 8000];
const ISO_THIRDS = [25, 32, 40, 50, 64, 80, 100, 125, 160, 200, 250, 320, 400, 500, 640, 800, 1000, 1250, 1600, 2000, 2500, 3200, 4000, 5000, 6400, 8000, 10000, 12800];
const ISO_FULL = new Set([25, 50, 100, 200, 400, 800, 1600, 3200, 6400, 12800]);
const range = (a, b, step) => { const out = []; for (let v = a; v <= b + 1e-9; v += step) out.push(Math.round(v * 100) / 100); return out; };
const WB_STOPS = range(2500, 8000, 100);
const TINT_STOPS = range(-100, 100, 5);
const FOCUS_STOPS = range(0, 1, 0.01);
export const fmtShutter = (sec) => (!sec ? '—' : sec >= 0.5 ? `${sec.toFixed(1)}s` : `1/${Math.round(1 / sec)}`);
const signed = (v, d = 1) => `${v > 0 ? '+' : ''}${v.toFixed(d)}`;

export function shutterStops(live, fps) {
  const max = Math.min(live.maxDur || 1, 1 / fps); // can't expose longer than one frame
  const min = live.minDur || 1 / 8000;
  return SHUTTER_DENOMS.map((d) => 1 / d).filter((s) => s <= max * 1.001 && s >= min * 0.999).sort((a, b) => b - a);
}
export function isoStops(live) {
  const lo = live.minISO || 50, hi = live.maxISO || 3200;
  const list = ISO_THIRDS.filter((v) => v >= lo * 0.98 && v <= hi * 1.02);
  return list.length ? list : [Math.round(lo), Math.round(hi)];
}

// Live readouts of what the camera is doing right now (auto ISO/shutter, lens position), polled while mounted.
export function useLiveReadout(getController, ms = 500) {
  const [live, setLive] = useState({});
  useEffect(() => {
    const read = () => {
      const c = getController();
      if (!c) return;
      try {
        const next = { iso: c.iso, dur: c.exposureDuration, lens: c.lensPosition, minISO: c.minISO, maxISO: c.maxISO, minDur: c.minExposureDuration, maxDur: c.maxExposureDuration };
        setLive((p) => (Object.keys(next).every((k) => p[k] === next[k]) ? p : next));
      } catch {}
    };
    read();
    const t = setInterval(read, ms);
    return () => clearInterval(t);
  }, []);
  return live;
}

// Bottom sheet, sliding up from the PHYSICAL bottom of the canvas it's rendered in (portrait or the rotated
// landscape canvas; `size` is that canvas, `insets` its physical safe-area insets). Tap outside to close.
// Capped and centred on tablets; shorter canvases (landscape phones) get a taller share of the height.
function Sheet({ title, landscape, size, insets, onClose, children, header }) {
  const win = useWindowDimensions();
  const width = size?.width ?? win.width, height = size?.height ?? win.height;
  const anim = useRef(new Animated.Value(0)).current;
  useEffect(() => { Animated.timing(anim, { toValue: 1, duration: T.slow, useNativeDriver: true }).start(); }, []);
  const close = () => Animated.timing(anim, { toValue: 0, duration: T.fast, useNativeDriver: true }).start(() => onClose());

  const side = Math.max(0, (width - 640) / 2);
  const pos = {
    left: side + (side ? 0 : insets.left), right: side + (side ? 0 : insets.right),
    maxHeight: height * (landscape ? 0.86 : 0.7),
    paddingBottom: insets.bottom + SP.s,
  };
  const slide = { translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [height * 0.5, 0] }) };

  return (
    <View style={StyleSheet.absoluteFill}>
      <Pressable style={StyleSheet.absoluteFill} onPress={close} accessibilityLabel={`Close ${title}`}>
        <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.25)', opacity: anim }]} />
      </Pressable>
      <Animated.View style={[s.sheet, s.sheetBottom, pos, { transform: [slide] }]}>
        <View style={s.handle} />
        <View style={s.sheetHead}>
          <Text style={s.sheetTitle} allowFontScaling={false}>{title}</Text>
          <Pressable onPress={close} hitSlop={12} accessibilityRole="button" accessibilityLabel={`Close ${title}`} style={s.done}>
            <Text style={s.doneText} allowFontScaling={false}>Done</Text>
          </Pressable>
        </View>
        {header}
        <ScrollView contentContainerStyle={{ paddingBottom: SP.m }} showsVerticalScrollIndicator={false}>{children}</ScrollView>
      </Animated.View>
    </View>
  );
}

function Section({ title, children }) {
  return (
    <View style={s.section}>
      <Text style={s.sectionTitle} allowFontScaling={false}>{title}</Text>
      <View style={s.group}>{children}</View>
    </View>
  );
}

function Row({ label, hint, children, disabled, last }) {
  return (
    <View style={[s.row, !last && s.rowLine, disabled && { opacity: 0.4 }]}>
      <View style={{ flex: 1 }}>
        <Text style={s.rowLabel}>{label}</Text>
        {hint ? <Text style={s.hint}>{hint}</Text> : null}
      </View>
      {children}
    </View>
  );
}

function Toggle({ label, value, onChange, disabled, hint, last }) {
  return (
    <Row label={label} hint={hint} disabled={disabled} last={last}>
      <Switch value={!!value} onValueChange={onChange} disabled={disabled}
        trackColor={{ true: C.green, false: 'rgba(255,255,255,0.18)' }} thumbColor="#fff" accessibilityLabel={label} />
    </Row>
  );
}

function Warn({ children }) {
  return (
    <View style={s.warn}>
      <Ionicons name="warning-outline" size={15} color={C.amber} />
      <Text style={s.warnText}>{children}</Text>
    </View>
  );
}

// ---------- FORMAT ----------
export function FormatSheet({ caps, settings, recording, landscape, size, insets, snapshots, clips, onSet, onPreset, onClose }) {
  const locked = recording;
  const mbps = bitrate(settings) / 1e6;
  const gbPerHour = (bitrate(settings) / 8) * 3600 / 1e9;
  const rows = RES_LIST.filter((r) => caps.fps[r]);
  const beat = fpsBeats(settings.fps, settings.mains);
  const presetFps = settings.mains === 50 ? 25 : 30;
  return (
    <Sheet title="Format" landscape={landscape} size={size} insets={insets} onClose={onClose}>
      {locked && <Text style={s.notice}>Stop recording to change format.</Text>}

      <Pressable disabled={locked} onPress={onPreset} accessibilityRole="button"
        accessibilityLabel={`Podcast preset: ${presetFps} fps, 180 degree shutter, white balance locked, stabilization off`}
        style={({ pressed }) => [s.preset, pressed && { opacity: 0.7 }, locked && { opacity: 0.4 }]}>
        <Ionicons name="mic-outline" size={20} color="#000" />
        <View style={{ flex: 1 }}>
          <Text style={s.presetTitle}>Podcast preset</Text>
          <Text style={s.presetSub}>{presetFps} fps · 1/{presetFps * 2} shutter · WB locked · stabilization off</Text>
        </View>
        <Ionicons name="chevron-forward" size={18} color="#000" />
      </Pressable>

      <Section title="RESOLUTION · FRAME RATE">
        <View style={{ padding: SP.s }}>
          <View style={s.matrixRow}>
            <View style={s.matrixLabelCell} />
            {FPS_LIST.map((f) => <Text key={f} style={[s.matrixHead, mono]} allowFontScaling={false}>{f}</Text>)}
          </View>
          {rows.map((res) => (
            <View key={res} style={s.matrixRow}>
              <Text style={[s.matrixLabel, mono]} allowFontScaling={false}>{RES_LABEL[res]}</Text>
              {FPS_LIST.map((f) => {
                const ok = caps.fps[res]?.includes(f);
                const on = settings.res === res && settings.fps === f;
                return (
                  <Pressable
                    key={f}
                    disabled={!ok || locked}
                    onPress={() => onSet({ res, fps: f })}
                    accessibilityRole="button"
                    accessibilityLabel={`${RES_LABEL[res]} at ${f} frames per second${ok ? '' : ', not supported'}`}
                    accessibilityState={{ selected: on, disabled: !ok || locked }}
                    style={[s.cell, on && s.cellOn, !ok && s.cellOff]}
                  >
                    {ok ? <View style={[s.cellDot, on && { backgroundColor: '#000' }, fpsBeats(f, settings.mains) && !on && { backgroundColor: C.faint }]} /> : <Text style={s.cellNo}>—</Text>}
                  </Pressable>
                );
              })}
            </View>
          ))}
          <Text style={[s.hint, mono, { marginTop: SP.s }]}>
            {RES_LABEL[settings.res]} · {settings.fps} fps · {mbps.toFixed(0)} Mbps · ~{gbPerHour.toFixed(1)} GB per hour
          </Text>
          {beat && <Warn>{settings.fps} fps can flicker under {settings.mains} Hz lights. Use {settings.mains === 50 ? '25 or 50' : '30 or 60'} fps.</Warn>}
        </View>
      </Section>

      <Section title="LIGHTING">
        <Row label="Mains power" hint="Matches frame rate and shutter to your lights so they don’t flicker. Europe, Africa, most of Asia: 50 Hz. Americas: 60 Hz." last>
          <Segmented value={settings.mains} onChange={(v) => onSet({ mains: v })}
            options={[{ value: 50, label: '50 Hz' }, { value: 60, label: '60 Hz' }]} />
        </Row>
      </Section>

      <Section title="VIDEO">
        {caps.codec && (
          <Row label="Codec" hint={settings.codec === 'hevc' ? 'Half the size, same quality.' : 'Most compatible with older editors.'}>
            <Segmented disabled={locked} value={settings.codec} onChange={(v) => onSet({ codec: v })}
              options={[{ value: 'hevc', label: 'HEVC' }, { value: 'h264', label: 'H.264' }]} />
          </Row>
        )}
        {caps.stabilization && (
          <Toggle label="Stabilization" value={settings.stabilization} disabled={locked} onChange={(v) => onSet({ stabilization: v })}
            hint="Off for tripods: sharper, uncropped frame." />
        )}
        {caps.hdr && (
          <Toggle label="HDR (10-bit HLG)" value={settings.hdr} disabled={locked} onChange={(v) => onSet({ hdr: v })}
            hint="Keep every camera the same: mixing HDR and SDR makes grading harder." last />
        )}
        {!caps.codec && !caps.stabilization && !caps.hdr && <Row label="No extra video options on this lens." last />}
      </Section>

      <Section title="DISPLAY">
        <Toggle label="Rule-of-thirds grid" value={settings.grid} onChange={(v) => onSet({ grid: v })} />
        <Toggle label="Histogram" value={settings.histogram} disabled={!snapshots} onChange={(v) => onSet({ histogram: v })}
          hint={snapshots ? 'Brightness spread of the image. Keep the right edge from piling up (clipped highlights).' : 'Not available on this phone yet.'} />
        <Toggle label="Dim screen while recording" value={settings.recSaver} onChange={(v) => onSet({ recSaver: v })}
          hint="After 5 s untouched the screen goes dark to cut heat and battery. Tap to wake." />
        <Toggle label="Audio meter" value={settings.meter} disabled={locked} onChange={(v) => onSet({ meter: v })} last
          hint={locked ? 'Change after this take: the phone’s audio setup is never touched mid-recording.' : 'Off by default: your show audio comes from the mics. Turn on to check the phone’s reference sound.'} />
      </Section>

      {(clips?.queued > 0 || clips?.previous?.length > 0) && (
        <Section title="CLIPS ON THIS PHONE">
          {clips.queued > 0 && (
            <Row label={`${clips.queued} clip${clips.queued > 1 ? 's' : ''} waiting to copy to ${clips.hubName || 'Tally Hub'}`}
              hint="Copies automatically when the hub is connected. Nothing is deleted from this phone." last={!clips.previous?.length} />
          )}
          {clips.previous?.length > 0 && (
            <Row label={`${clips.previous.length} clip${clips.previous.length > 1 ? 's' : ''} from a previous hub`}
              hint={`Kept on this phone (also in your Photos). Pair with that hub again to copy them:\n${clips.previous.map((c) => c.name).join('\n')}`} last />
          )}
        </Section>
      )}
    </Sheet>
  );
}

// ---------- PRO: exposure / focus / white balance, each only where this phone supports it ----------
const WB_PRESETS = [
  { label: 'Tungsten', k: 3200 }, { label: 'Fluorescent', k: 4000 }, { label: 'Daylight', k: 5600 }, { label: 'Cloudy', k: 6500 },
];

export function ProPanel({ caps, settings, manual, aeLocked, landscape, size, insets, getController, tab: initialTab, onSet, onManual, onToggleLock, onClose }) {
  const live = useLiveReadout(getController);
  const hasExposureManual = caps.manualExposure && live.minISO > 0 && live.maxISO > live.minISO && live.minDur > 0;
  const tabs = [
    { value: 'exposure', label: 'Exposure' },
    caps.manualFocus && { value: 'focus', label: 'Focus' },
    caps.manualWB && { value: 'wb', label: 'White bal.' },
  ].filter(Boolean);
  const [tab, setTab] = useState(tabs.some((t) => t.value === initialTab) ? initialTab : 'exposure');

  const ev = caps.exposureBias;
  const evStops = ev ? range(Math.ceil(ev.min * 10) / 10, Math.floor(ev.max * 10) / 10, 0.1) : [];
  const shStops = shutterStops(live, settings.fps);
  const shutter = manual.shutter ?? live.dur;
  const target = 1 / (settings.fps * 2);
  const flicker = manual.shutter != null && shutterFlickers(manual.shutter, settings.mains);
  const anyManual = manual.focus != null || manual.iso != null || manual.shutter != null || manual.wbTemp != null;

  const header = tabs.length > 1 && (
    <View style={{ marginBottom: SP.s }}>
      <Segmented value={tab} onChange={setTab} options={tabs} />
    </View>
  );

  return (
    <Sheet title="Pro controls" landscape={landscape} size={size} insets={insets} onClose={onClose} header={header}>
      {tab === 'exposure' && (
        <>
          <Section title="LOCK">
            <Row label="AE / AF lock" hint="Or double-tap / long-press the subject." last>
              <Pill text={aeLocked ? 'LOCKED' : 'AUTO'} active={aeLocked} onPress={onToggleLock}
                style={aeLocked && { backgroundColor: C.amber }} label="Toggle exposure and focus lock" />
            </Row>
          </Section>
          {hasExposureManual && (
            <Section title="SHUTTER · ISO">
              <View style={s.pad}>
                <Ruler label="Shutter" stops={shStops} value={manual.shutter} autoValue={live.dur} auto={manual.shutter == null}
                  note={shutter ? `${shutterAngle(shutter, settings.fps)}°` : null}
                  format={fmtShutter} short={fmtShutter}
                  isMajor={(v) => [24, 25, 30, 50, 60, 100, 120, 200, 250, 500, 1000, 2000, 4000].includes(Math.round(1 / v))}
                  onChange={(v) => onManual({ shutter: v })} onAuto={() => onManual({ iso: null, shutter: null })} />
                {flicker
                  ? <Warn>{fmtShutter(manual.shutter)} can flicker under {settings.mains} Hz lights. Use {fmtShutter(target)} ({settings.mains === 50 ? '1/50, 1/100' : '1/60, 1/120'}).</Warn>
                  : <Text style={s.hint}>180° rule: {fmtShutter(target)} at {settings.fps} fps for natural motion.</Text>}
                <Ruler label="ISO" stops={isoStops(live)} value={manual.iso} autoValue={live.iso} auto={manual.iso == null}
                  format={(v) => `${Math.round(v)}`} short={(v) => `${v}`} isMajor={(v) => ISO_FULL.has(v)}
                  onChange={(v) => onManual({ iso: v })} onAuto={() => onManual({ iso: null, shutter: null })} />
                <Text style={s.hint}>Set shutter first, then raise ISO for brightness. Lower ISO = cleaner image.</Text>
              </View>
            </Section>
          )}
          {ev && (
            <Section title="COMPENSATION">
              <View style={s.pad}>
                <Ruler label="Exposure (EV)" stops={evStops} value={settings.exposure} auto={false}
                  format={(v) => signed(v)} short={(v) => signed(v, 0)} isMajor={(v) => Math.abs(v - Math.round(v)) < 1e-6}
                  onChange={(v) => onSet({ exposure: v })} onReset={() => onSet({ exposure: 0 })} />
              </View>
            </Section>
          )}
          {!hasExposureManual && (
            <Text style={[s.hint, { marginTop: SP.s }]}>
              Manual ISO and shutter aren’t available on this lens. Use EV and AE/AF lock to keep cameras matched.
            </Text>
          )}
        </>
      )}

      {tab === 'focus' && (
        <Section title="FOCUS">
          <View style={s.pad}>
            <Ruler label="Lens position" stops={FOCUS_STOPS} value={manual.focus} autoValue={live.lens} auto={manual.focus == null}
              format={(v) => (v <= 0.01 ? 'Near' : v >= 0.99 ? '∞' : v.toFixed(2))}
              short={(v) => (v === 0 ? 'Near' : v === 1 ? '∞' : v.toFixed(1))} isMajor={(v, i) => i % 10 === 0}
              onChange={(v) => onManual({ focus: v })} onAuto={() => onManual({ focus: null })} />
            <Text style={s.hint}>Focus on the subject, then leave it: it won’t hunt during the show.</Text>
          </View>
        </Section>
      )}

      {tab === 'wb' && (
        <Section title="WHITE BALANCE">
          <View style={s.pad}>
            <Ruler label="Temperature" stops={WB_STOPS} value={manual.wbTemp} autoValue={null} auto={manual.wbTemp == null}
              format={(v) => `${Math.round(v)}K`} short={(v) => `${(v / 1000).toFixed(1)}K`} isMajor={(v) => v % 500 === 0}
              onChange={(v) => onManual({ wbTemp: v })} onAuto={() => onManual({ wbTemp: null, wbTint: 0 })} />
            <View style={s.presets}>
              {WB_PRESETS.map((p) => (
                <Pill key={p.k} text={`${p.label} · ${p.k}K`} active={manual.wbTemp === p.k} onPress={() => onManual({ wbTemp: p.k })} />
              ))}
            </View>
            {manual.wbTemp != null && (
              <Ruler label="Tint" stops={TINT_STOPS} value={manual.wbTint ?? 0} auto={false}
                format={(v) => signed(v, 0)} short={(v) => signed(v, 0)} isMajor={(v) => v % 50 === 0}
                onChange={(v) => onManual({ wbTint: v })} onReset={() => onManual({ wbTint: 0 })} />
            )}
            <Text style={s.hint}>Use the same Kelvin on every camera so skin tones match between angles.</Text>
          </View>
        </Section>
      )}

      {anyManual && (
        <Text style={[s.hint, mono, { marginTop: SP.s, color: C.amber }]}>
          Manual: {[manual.focus != null && 'focus', (manual.iso != null || manual.shutter != null) && 'exposure', manual.wbTemp != null && 'white balance'].filter(Boolean).join(' · ')}
        </Text>
      )}
    </Sheet>
  );
}

const s = StyleSheet.create({
  sheet: { position: 'absolute', backgroundColor: C.sheet, paddingHorizontal: SP.m, shadowColor: '#000', shadowOpacity: 0.5, shadowRadius: 24, elevation: 24 },
  sheetBottom: { bottom: 0, borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingTop: SP.s },
  handle: { alignSelf: 'center', width: 36, height: 5, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.25)', marginBottom: SP.xs },
  sheetHead: { flexDirection: 'row', alignItems: 'center', minHeight: 44 },
  sheetTitle: { color: C.text, fontSize: 17, fontWeight: '600', flex: 1 },
  done: { minHeight: 44, justifyContent: 'center', paddingLeft: SP.m },
  doneText: { color: C.text, fontSize: 16, fontWeight: '600' },
  section: { marginTop: SP.m },
  sectionTitle: { color: C.faint, fontSize: 11, fontWeight: '700', letterSpacing: 1, marginBottom: SP.s, marginLeft: SP.xs },
  group: { borderRadius: 12, backgroundColor: 'rgba(255,255,255,0.06)', overflow: 'hidden' },
  pad: { paddingHorizontal: SP.m, paddingVertical: SP.s, gap: SP.xs },
  row: { flexDirection: 'row', alignItems: 'center', minHeight: 52, gap: SP.m, paddingHorizontal: SP.m, paddingVertical: SP.s },
  rowLine: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.line },
  rowLabel: { color: C.text, fontSize: 15 },
  hint: { color: C.dim, fontSize: 12, marginTop: 2, lineHeight: 16 },
  notice: { color: C.amber, fontSize: 13, marginTop: SP.s },
  warn: { flexDirection: 'row', gap: 6, alignItems: 'flex-start', marginTop: SP.xs },
  warnText: { color: C.amber, fontSize: 12, lineHeight: 16, flex: 1 },
  preset: { flexDirection: 'row', alignItems: 'center', gap: SP.m, marginTop: SP.s, minHeight: 56, paddingHorizontal: SP.m, borderRadius: 12, backgroundColor: C.text },
  presetTitle: { color: '#000', fontSize: 15, fontWeight: '700' },
  presetSub: { color: 'rgba(0,0,0,0.6)', fontSize: 12, marginTop: 1 },
  presets: { flexDirection: 'row', flexWrap: 'wrap', gap: SP.s, marginVertical: SP.s },
  matrixRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 6 },
  matrixLabelCell: { width: 52 },
  matrixHead: { flex: 1, textAlign: 'center', color: C.faint, fontSize: 12, fontWeight: '700' },
  matrixLabel: { color: C.text, width: 52, fontSize: 14, fontWeight: '700' },
  cell: { flex: 1, height: 40, borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: C.surfaceHi },
  cellOn: { backgroundColor: C.text },
  cellOff: { backgroundColor: 'transparent' },
  cellDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: C.dim },
  cellNo: { color: 'rgba(255,255,255,0.2)', fontSize: 14 },
});
