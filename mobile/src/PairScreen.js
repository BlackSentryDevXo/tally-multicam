import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Camera, useObjectOutput } from 'react-native-vision-camera';
import { C, SP, haptic } from './controls';
import { candidates, parsePairUrl } from './pairing';

// QR codes: VisionCamera's object output on iOS; it doesn't exist on Android, where its ML Kit scanner does the job.
// (Platform never changes at runtime, so the hook order stays fixed.)
const QR_ANDROID = ['qr-code'];
const useQrOutput = Platform.OS === 'android'
  ? (onCode) => require('react-native-vision-camera-barcode-scanner').useBarcodeScannerOutput({
    barcodeFormats: QR_ANDROID,
    onBarcodeScanned: (codes) => { for (const c of codes) if (onCode(c.rawValue)) return; },
    onError: () => {},
  })
  : (onCode) => useObjectOutput({
    types: ['qr'],
    onObjectsScanned: (objs) => { for (const o of objs) if (onCode(o.value)) return; },
  });

const HOST = /^[\w.-]+(:\d{2,5})?$/;
const PROBE_MS = 6000;
const newId = () => Math.random().toString(36).slice(2, 10);

// Open a socket to every candidate; resolve with the first that connects (or null after PROBE_MS).
// Doing this here, right after the scan, is what makes iOS show its Local Network prompt in context.
function probe(list) {
  return new Promise((resolve) => {
    let done = false;
    const socks = [];
    const finish = (addr) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socks.forEach((s) => { try { s.close(); } catch {} });
      resolve(addr);
    };
    const timer = setTimeout(() => finish(null), PROBE_MS);
    for (const addr of list) {
      try {
        const s = new WebSocket(`ws://${addr}`);
        s.onopen = () => finish(addr);
        s.onerror = () => {};
        socks.push(s);
      } catch {}
    }
  });
}

// Scan the QR in Tally Hub (or type host + key). Name the camera first.
export function PairScreen({ prev, onPaired }) {
  const insets = useSafeAreaInsets();
  const [name, setName] = useState(prev?.name || `Cam ${'ABCDEFGH'[Math.floor(Math.random() * 8)]}`);
  const [manual, setManual] = useState(false);
  const [host, setHost] = useState('');
  const [key, setKey] = useState('');
  const [err, setErr] = useState('');
  const [connecting, setConnecting] = useState(null); // { hubName } while probing
  const nameRef = useRef(name);
  nameRef.current = name;
  const busy = useRef(false);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  async function connect(p) {
    if (busy.current) return;
    busy.current = true;
    haptic.thud();
    setErr('');
    setConnecting({ hubName: p.hubName });
    const base = { hosts: p.hosts, port: p.port, key: p.key, hubName: p.hubName, name: nameRef.current.trim() || 'Cam', id: prev?.id || newId() };
    const list = candidates(base);
    const winner = await probe(list);
    if (!alive.current) return;
    // No answer yet still pairs: the camera screen keeps searching and explains how to fix the network.
    onPaired({ ...base, host: winner ?? list[0] });
  }

  const qr = useQrOutput((value) => {
    const p = parsePairUrl(value);
    if (p) { connect(p); return true; }
    if (value?.startsWith('cemedia://')) setErr('That QR is from an older hub. Update Tally Hub and scan again.');
    return false;
  });

  const submitManual = () => {
    const h = host.trim(), k = key.trim();
    if (!HOST.test(h)) return setErr('Enter the address shown in Tally Hub, e.g. 192.168.1.20');
    if (!/^\w{4,}$/.test(k)) return setErr('Enter the pairing key shown in Tally Hub.');
    const [hh, port] = h.split(':');
    connect({ hosts: [hh], port: port ? +port : 7777, key: k, hubName: null });
  };

  return (
    <KeyboardAvoidingView style={s.fill} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <StatusBar hidden />
      {!manual && !connecting && <Camera style={StyleSheet.absoluteFill} device="back" isActive outputs={[qr]} resizeMode="cover" />}
      {!manual && !connecting && (
        <View pointerEvents="none" style={s.guideWrap}>
          <View style={s.guide}>
            {['tl', 'tr', 'bl', 'br'].map((c) => <View key={c} style={[s.corner, s[c]]} />)}
          </View>
          <Text style={s.guideText}>Point at the QR code in Tally Hub</Text>
        </View>
      )}

      <View style={[s.brand, { top: insets.top + SP.m }]}>
        <View style={s.tallyLight} />
        <Text style={s.brandText} allowFontScaling={false}>TALLY CAM</Text>
      </View>

      {connecting ? (
        <View style={[s.fill, s.center]}>
          <ActivityIndicator color="#fff" />
          <Text style={s.title}>Connecting to {connecting.hubName || 'Tally Hub'}…</Text>
          {Platform.OS === 'ios' && <Text style={s.body}>If iPhone asks to find devices on your local network, tap Allow.</Text>}
        </View>
      ) : (
        <View style={[s.card, { bottom: insets.bottom + SP.m, marginLeft: insets.left, marginRight: insets.right }]}>
          <Text style={s.label} allowFontScaling={false}>CAMERA NAME</Text>
          <TextInput
            style={s.input}
            value={name}
            onChangeText={setName}
            maxLength={24}
            placeholder="e.g. Wide, Host, Guest"
            placeholderTextColor="#777"
            accessibilityLabel="Camera name"
            returnKeyType="done"
          />
          {manual && (
            <>
              <Text style={s.label} allowFontScaling={false}>HUB ADDRESS</Text>
              <TextInput style={s.input} value={host} onChangeText={setHost} placeholder="192.168.1.20" placeholderTextColor="#777"
                autoCapitalize="none" autoCorrect={false} keyboardType={Platform.OS === 'ios' ? 'numbers-and-punctuation' : 'url'} accessibilityLabel="Hub address" />
              <Text style={s.label} allowFontScaling={false}>PAIRING KEY</Text>
              <TextInput style={s.input} value={key} onChangeText={setKey} placeholder="shown in Tally Hub" placeholderTextColor="#777"
                autoCapitalize="none" autoCorrect={false} accessibilityLabel="Pairing key" onSubmitEditing={submitManual} />
              <Pressable style={({ pressed }) => [s.primary, pressed && { opacity: 0.8 }]} onPress={submitManual} accessibilityRole="button" accessibilityLabel="Connect">
                <Text style={s.primaryText}>Connect</Text>
              </Pressable>
            </>
          )}
          {err ? <Text style={s.err}>{err}</Text> : null}
          <Pressable onPress={() => { setErr(''); setManual(!manual); }} style={s.link} accessibilityRole="button">
            <Text style={s.linkText}>{manual ? 'Scan QR code instead' : 'Enter address manually'}</Text>
          </Pressable>
          {prev?.name && !manual && <Text style={s.hint}>Previously paired as “{prev.name}”.</Text>}
        </View>
      )}
    </KeyboardAvoidingView>
  );
}

const CORNER = 28;
const s = StyleSheet.create({
  fill: { flex: 1, backgroundColor: '#000' },
  center: { alignItems: 'center', justifyContent: 'center', padding: SP.xl, gap: SP.m },
  title: { color: '#fff', fontSize: 18, fontWeight: '600', textAlign: 'center' },
  body: { color: C.dim, fontSize: 14, textAlign: 'center', lineHeight: 20 },
  guideWrap: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', gap: SP.m },
  guide: { width: 232, height: 232 },
  corner: { position: 'absolute', width: CORNER, height: CORNER, borderColor: '#fff' },
  tl: { top: 0, left: 0, borderTopWidth: 3, borderLeftWidth: 3, borderTopLeftRadius: 12 },
  tr: { top: 0, right: 0, borderTopWidth: 3, borderRightWidth: 3, borderTopRightRadius: 12 },
  bl: { bottom: 0, left: 0, borderBottomWidth: 3, borderLeftWidth: 3, borderBottomLeftRadius: 12 },
  br: { bottom: 0, right: 0, borderBottomWidth: 3, borderRightWidth: 3, borderBottomRightRadius: 12 },
  guideText: { color: '#fff', fontSize: 15, fontWeight: '500', textShadowColor: '#000', textShadowRadius: 4 },
  brand: { position: 'absolute', alignSelf: 'center', flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: SP.m, paddingVertical: SP.s, borderRadius: 20, backgroundColor: C.surface },
  tallyLight: { width: 12, height: 12, borderRadius: 6, backgroundColor: C.red, shadowColor: C.red, shadowOpacity: 0.9, shadowRadius: 8 },
  brandText: { color: '#fff', fontSize: 15, fontWeight: '800', letterSpacing: 3 },
  card: { position: 'absolute', padding: SP.m, gap: 6, borderRadius: 16, backgroundColor: C.sheet, maxWidth: 520, alignSelf: 'center', width: '92%' },
  label: { color: C.faint, fontSize: 11, fontWeight: '700', letterSpacing: 1, marginTop: SP.xs },
  input: { color: '#fff', fontSize: 17, minHeight: 48, borderRadius: 10, paddingHorizontal: 12, backgroundColor: 'rgba(255,255,255,0.08)' },
  primary: { marginTop: SP.s, minHeight: 48, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: '#fff' },
  primaryText: { color: '#000', fontSize: 16, fontWeight: '700' },
  link: { minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  linkText: { color: '#fff', fontSize: 15, fontWeight: '500', opacity: 0.85 },
  hint: { color: C.dim, fontSize: 12, textAlign: 'center' },
  err: { color: C.amber, fontSize: 13, marginTop: SP.xs },
});
