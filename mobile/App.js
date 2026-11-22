import { useEffect, useState } from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider, initialWindowMetrics } from 'react-native-safe-area-context';
import { useCameraPermission, useMicrophonePermission } from 'react-native-vision-camera';
import { requestPermissionsAsync } from 'expo-media-library';
import { loadCfg, saveCfg } from './src/config';
import { PairScreen } from './src/PairScreen';
import { CameraScreen } from './src/CameraScreen';
import { C, SP } from './src/controls';

export default function App() {
  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: '#000' }}>
      <SafeAreaProvider initialMetrics={initialWindowMetrics} style={{ backgroundColor: '#000' }}>
        <Root />
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

function Root() {
  const cam = useCameraPermission();
  const mic = useMicrophonePermission();
  const [cfg, setCfg] = useState(loadCfg);
  const [asked, setAsked] = useState(false);

  useEffect(() => {
    (async () => {
      if (!cam.hasPermission) await cam.requestPermission();
      if (!mic.hasPermission) await mic.requestPermission();
      await requestPermissionsAsync(true).catch(() => {}); // write-only: gallery backup copy of each clip
      setAsked(true);
    })();
  }, []);

  const update = (c) => { if (c) saveCfg(c); setCfg(c); };

  if (!cam.hasPermission) {
    if (!asked) return <View style={s.fill} />;
    return (
      <View style={[s.fill, s.center]}>
        <StatusBar hidden />
        <View style={s.tallyLight} />
        <Text style={s.title}>Camera access needed</Text>
        <Text style={s.body}>Tally Cam records video for your production. Allow Camera and Microphone for Tally Cam in Settings.</Text>
        <Pressable style={({ pressed }) => [s.btn, pressed && { opacity: 0.8 }]} onPress={() => (cam.canRequestPermission ? cam.requestPermission() : Linking.openSettings())} accessibilityRole="button">
          <Text style={s.btnText}>{cam.canRequestPermission ? 'Allow camera' : 'Open Settings'}</Text>
        </Pressable>
      </View>
    );
  }
  if (!cfg?.host) return <PairScreen prev={cfg} onPaired={(p) => update({ pending: [], ...cfg, ...p })} />;
  return <CameraScreen cfg={cfg} update={update} hasMic={mic.hasPermission} />;
}

const s = StyleSheet.create({
  fill: { flex: 1, backgroundColor: '#000' },
  center: { alignItems: 'center', justifyContent: 'center', padding: SP.xl, gap: SP.m },
  tallyLight: { width: 16, height: 16, borderRadius: 8, backgroundColor: C.red, shadowColor: C.red, shadowOpacity: 0.9, shadowRadius: 10 },
  title: { color: '#fff', fontSize: 22, fontWeight: '700', textAlign: 'center' },
  body: { color: C.dim, fontSize: 15, textAlign: 'center', lineHeight: 21, maxWidth: 420 },
  btn: { marginTop: SP.s, minHeight: 48, paddingHorizontal: SP.l, borderRadius: 12, justifyContent: 'center', backgroundColor: '#fff' },
  btnText: { color: '#000', fontSize: 16, fontWeight: '700' },
});
