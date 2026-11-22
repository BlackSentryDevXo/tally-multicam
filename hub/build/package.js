// Packages Tally Hub: `node build/package.js mac` (signed arm64 .app) or `node build/package.js win` (x64 folder).
// Only this machine's MediaMTX binary is shipped, as Resources/bin/<platform>/.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const target = process.argv[2];
const root = path.join(__dirname, '..');
const mtxPlatform = { mac: process.env.TALLY_ARCH === 'x64' ? 'darwin_amd64' : 'darwin_arm64', win: 'windows_amd64' }[target];
if (!mtxPlatform) { console.error('usage: node build/package.js mac|win'); process.exit(2); }

const exe = target === 'win' ? 'mediamtx.exe' : 'mediamtx';
const bin = path.join(root, 'bin', mtxPlatform, exe);
if (!fs.existsSync(bin)) { console.error(`MediaMTX for ${mtxPlatform} is missing. Run: node build/fetch-mediamtx.js ${mtxPlatform}`); process.exit(1); }

// Stage just the one platform's binary so the package doesn't carry the others.
const stage = path.join(root, 'dist', `res-${mtxPlatform}`);
fs.rmSync(stage, { recursive: true, force: true });
fs.cpSync(path.join(root, 'bin', mtxPlatform), path.join(stage, 'bin', mtxPlatform), { recursive: true });

const args = ['.', 'Tally Hub', '--out=dist', '--overwrite', '--ignore=^/(dist|build|bin|\\.gitignore|mediamtx\\.yml)$',
  `--extra-resource=${path.join(stage, 'bin')}`, '--extra-resource=mediamtx.yml', '--app-bundle-id=com.tally.hub'];
if (target === 'mac') {
  // TALLY_SIGN_ID="Apple Development: Name (ID)" signs with your identity (macOS then remembers the firewall
  // permission across launches). TALLY_SIGN_ID=- makes an ad-hoc build (what the public release ships).
  const id = process.env.TALLY_SIGN_ID;
  if (!id) {
    console.error('Set TALLY_SIGN_ID, e.g.\n  TALLY_SIGN_ID="Apple Development: Name (TEAMID)" npm run package:mac   (signed; list identities with: security find-identity -v -p codesigning)\n  TALLY_SIGN_ID=- npm run package:mac                                     (ad-hoc; with the macOS firewall on you may need to click Allow again after updates)');
    process.exit(1);
  }
  const arch = process.env.TALLY_ARCH === 'x64' ? 'x64' : 'arm64';
  args.push('--platform=darwin', `--arch=${arch}`, '--icon=icon.icns');
  if (id !== '-') args.push(`--osx-sign.identity=${id}`);
} else {
  // Cross-packaging from macOS/Linux works without Wine: @electron/packager 18 edits the .exe with pure-JS resedit.
  args.push('--platform=win32', '--arch=x64');
  if (fs.existsSync(path.join(root, 'icon.ico'))) args.push('--icon=icon.ico');
}
// Run the packager's own JS entry with this Node: no .bin shims, so it works the same on macOS and Windows hosts.
const pkgDir = path.join(root, 'node_modules', '@electron', 'packager'); // its package.json isn't in "exports", so read it from disk
const binField = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')).bin;
const entry = path.join(pkgDir, typeof binField === 'string' ? binField : Object.values(binField)[0]);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE; // set by some editors' terminals; would break the packaged app's test launch
const r = spawnSync(process.execPath, [entry, ...args], { cwd: root, stdio: 'inherit', env });
fs.rmSync(stage, { recursive: true, force: true });
if (r.error) console.error(`Could not run the packager: ${r.error.message}`);
process.exit(r.status ?? 1);
