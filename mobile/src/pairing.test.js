// Run: node src/pairing.test.js
import assert from 'node:assert';
import { candidates, fpsBeats, parsePairUrl, shutterAngle, shutterFlickers } from './pairing.js';

assert.deepEqual(parsePairUrl('tally://192.168.1.5:7777?key=abcd1234'), { hosts: ['192.168.1.5'], port: 7777, key: 'abcd1234', hubName: null });
assert.deepEqual(parsePairUrl('tally://Studio-Mac.local,192.168.1.20,10.0.0.4:7777?key=deadbeef&name=Church%20Hub'),
  { hosts: ['Studio-Mac.local', '192.168.1.20', '10.0.0.4'], port: 7777, key: 'deadbeef', hubName: 'Church Hub' });
assert.equal(parsePairUrl('tally://10.0.0.4?key=abcd').port, 7777);
assert.equal(parsePairUrl('cemedia://1.2.3.4:7777?key=abcd'), null);
assert.equal(parsePairUrl('tally://1.2.3.4:7777?key=ab'), null);
assert.equal(parsePairUrl('tally://bad host:7777?key=abcd'), null);
assert.deepEqual(candidates({ host: '10.0.0.4:7777', hosts: ['a.local', '10.0.0.4'], port: 7777 }), ['10.0.0.4:7777', 'a.local:7777']);
assert.deepEqual(candidates({ host: '1.2.3.4:7777' }), ['1.2.3.4:7777']);

assert.equal(shutterFlickers(1 / 50, 50), false);
assert.equal(shutterFlickers(1 / 100, 50), false);
assert.equal(shutterFlickers(1 / 60, 50), true);
assert.equal(shutterFlickers(1 / 120, 60), false);
assert.equal(shutterFlickers(1 / 500, 50), true);
assert.equal(fpsBeats(30, 50), true);
assert.equal(fpsBeats(25, 50), false);
assert.equal(shutterAngle(1 / 50, 25), 180);
console.log('pairing ok');
