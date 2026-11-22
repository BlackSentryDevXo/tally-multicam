const { contextBridge, ipcRenderer } = require('electron');

// Only these channels exist for the page. Anything else is refused here, before it reaches the main process.
const CALLS = new Set([
  'close', 'copy', 'firewall', 'firewallFix', 'firewallSettings', 'focus', 'forget', 'init', 'live', 'lock', 'mains',
  'obs', 'obsAddCameras', 'openFolder', 'openLog', 'pairing', 'preview', 'record', 'rlog', 'session', 'settings',
  'smooth', 'stop', 'whep', 'whepEnd',
  '__test', // dev-only: the main process registers it only in an unpackaged build started with TALLY_TEST
]);
const EVENTS = new Set([
  'frame', 'level', 'live', 'liveCfg', 'log', 'obs', 'phoneError', 'phones', 'state', 'status', 'upload', 'winVisible',
]);

contextBridge.exposeInMainWorld('hub', {
  call: (name, ...args) => (CALLS.has(name) ? ipcRenderer.invoke(name, ...args) : Promise.reject(new Error(`unknown call ${name}`))),
  on: (ch, fn) => { if (EVENTS.has(ch)) ipcRenderer.on(ch, (_e, data) => fn(data)); },
});
