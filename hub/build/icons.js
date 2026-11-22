// Renders the Tally mark to every icon size. Run: cd hub && env -u ELECTRON_RUN_AS_NODE npx electron build/icons.js
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');
const RED = '#FF2D2D';

// The mark: viewfinder focus brackets + a glowing tally light. `s` = mark scale (1 = fills a 100-unit box).
const mark = (s, { fg = '#F5F5F7', dot = RED, glow = true } = {}) => {
  const k = (v) => 50 + (v - 50) * s;
  const w = 7 * s, a = 30 * s; // stroke width, bracket arm length
  const c = (x, y, dx, dy) => `<path d="M${k(x)} ${k(y) + dy * a}V${k(y)}H${k(x) + dx * a}" />`;
  return `
  ${glow ? `<circle cx="50" cy="50" r="${30 * s}" fill="url(#glow)"/>` : ''}
  <g fill="none" stroke="${fg}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round">
    ${c(12, 12, 1, 1)}${c(88, 12, -1, 1)}${c(12, 88, 1, -1)}${c(88, 88, -1, -1)}
  </g>
  <circle cx="50" cy="50" r="${15 * s}" fill="${dot}"/>
  ${glow ? `<circle cx="${50 - 4.5 * s}" cy="${50 - 4.5 * s}" r="${4.5 * s}" fill="#fff" opacity=".35"/>` : ''}`;
};
const defs = `<defs>
  <radialGradient id="glow"><stop offset="0" stop-color="${RED}" stop-opacity=".55"/><stop offset="1" stop-color="${RED}" stop-opacity="0"/></radialGradient>
  <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1c1c21"/><stop offset="1" stop-color="#0a0a0c"/></linearGradient>
</defs>`;
const svg = (body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="1024" height="1024">${defs}${body}</svg>`;

const ICONS = {
  // iOS / store icon: full bleed, the OS rounds the corners.
  full: svg(`<rect width="100" height="100" fill="url(#bg)"/>${mark(0.78)}`),
  // macOS icon: Big Sur grid, 824/1024 rounded body with a little shadow room.
  mac: svg(`<rect x="9.8" y="9.8" width="80.4" height="80.4" rx="18" fill="url(#bg)" stroke="#ffffff14" stroke-width=".4"/>${mark(0.62)}`),
  // Android adaptive: foreground inside the 66% safe zone, transparent.
  fg: svg(mark(0.5)),
  bg: svg(`<rect width="100" height="100" fill="url(#bg)"/>`),
  mono: svg(mark(0.5, { fg: '#fff', dot: '#fff', glow: false })),
  // Splash: the mark alone on transparent; app background shows through.
  splash: svg(mark(0.9)),
};

const OUT = [
  ['full', 'mobile/assets/icon.png', 1024],
  ['fg', 'mobile/assets/android-icon-foreground.png', 512],
  ['bg', 'mobile/assets/android-icon-background.png', 512],
  ['mono', 'mobile/assets/android-icon-monochrome.png', 432],
  ['splash', 'mobile/assets/splash-icon.png', 1024],
  ['full', 'mobile/assets/favicon.png', 48],
  ['mac', 'hub/icon.png', 1024],
];

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1024, height: 1024, show: false, transparent: true, frame: false, webPreferences: { offscreen: true } });
  win.webContents.setFrameRate(1);
  const render = async (key) => {
    const html = `<html><body style="margin:0;background:transparent">${ICONS[key]}</body></html>`;
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    await new Promise((r) => setTimeout(r, 150));
    return win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 });
  };
  fs.writeFileSync(path.join(__dirname, 'icon.svg'), ICONS.mac);
  for (const [key, rel, size] of OUT) {
    const img = (await render(key)).resize({ width: size, height: size, quality: 'best' });
    fs.writeFileSync(path.join(ROOT, rel), img.toPNG());
    console.log('wrote', rel, size);
  }
  // macOS .icns from an iconset
  const mac = await render('mac');
  const set = path.join(__dirname, 'icon.iconset');
  fs.rmSync(set, { recursive: true, force: true });
  fs.mkdirSync(set);
  for (const s of [16, 32, 128, 256, 512]) {
    fs.writeFileSync(path.join(set, `icon_${s}x${s}.png`), mac.resize({ width: s, height: s, quality: 'best' }).toPNG());
    fs.writeFileSync(path.join(set, `icon_${s}x${s}@2x.png`), mac.resize({ width: s * 2, height: s * 2, quality: 'best' }).toPNG());
  }
  execFileSync('iconutil', ['-c', 'icns', set, '-o', path.join(ROOT, 'hub/icon.icns')]);
  fs.rmSync(set, { recursive: true });
  console.log('wrote hub/icon.icns');
  app.quit();
});
