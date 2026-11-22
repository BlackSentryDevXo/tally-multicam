// Downloads the pinned MediaMTX release into hub/bin/<platform>/ and verifies its sha256.
// Run: node build/fetch-mediamtx.js [darwin_arm64 | darwin_amd64 | windows_amd64 | linux_amd64]   (default: this machine)
// MediaMTX is MIT-licensed: https://github.com/bluenviron/mediamtx
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const VERSION = 'v1.21.4';
const here = `${process.platform === 'win32' ? 'windows' : process.platform}_${process.arch === 'arm64' ? 'arm64' : 'amd64'}`;
const platform = process.argv[2] || here;
if (!/^(darwin|windows|linux)_(arm64|amd64)$/.test(platform)) { console.error(`unknown platform ${platform}`); process.exit(2); }
const windows = platform.startsWith('windows');
const file = `mediamtx_${VERSION}_${platform}.${windows ? 'zip' : 'tar.gz'}`;
const base = `https://github.com/bluenviron/mediamtx/releases/download/${VERSION}`;
const dir = path.join(__dirname, '..', 'bin', platform);
const exe = windows ? 'mediamtx.exe' : 'mediamtx';

(async () => {
  const get = async (url) => {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  };
  const sums = (await get(`${base}/checksums.sha256`)).toString();
  const want = sums.split('\n').find((l) => l.trim().endsWith(file))?.split(/\s+/)[0];
  if (!want) throw new Error(`no checksum listed for ${file}`);
  const archive = await get(`${base}/${file}`);
  const got = crypto.createHash('sha256').update(archive).digest('hex');
  if (got !== want) throw new Error(`sha256 mismatch for ${file}: ${got} != ${want}`);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, file);
  fs.writeFileSync(tmp, archive);
  if (windows) {
    // `unzip` on mac/linux, PowerShell on Windows; only the binary and licence are kept.
    if (process.platform === 'win32') execFileSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -Force -LiteralPath '${tmp}' -DestinationPath '${dir}'`]);
    else execFileSync('unzip', ['-o', '-q', tmp, exe, 'LICENSE', '-d', dir]);
  } else {
    execFileSync('tar', ['-xzf', tmp, '-C', dir, exe, 'LICENSE']);
    fs.chmodSync(path.join(dir, exe), 0o755);
  }
  for (const f of fs.readdirSync(dir)) if (![exe, 'LICENSE', 'MEDIAMTX-LICENSE'].includes(f)) fs.rmSync(path.join(dir, f), { recursive: true, force: true });
  if (fs.existsSync(path.join(dir, 'LICENSE'))) fs.renameSync(path.join(dir, 'LICENSE'), path.join(dir, 'MEDIAMTX-LICENSE'));
  console.log(`MediaMTX ${VERSION} (${platform}) -> ${path.join(dir, exe)}  sha256 ok`);
})().catch((e) => { console.error(e.message); process.exit(1); });
