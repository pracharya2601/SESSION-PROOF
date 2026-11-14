// node --test scripts/band/usb-bridge.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import {
  buildPlist,
  parsePlist,
  encodeHeader,
  decodeHeader,
  encodeMessage,
  htons,
  listDevices,
  connectDevice,
  pickDevice,
  HEADER_SIZE,
} from './usbmux.mjs';
import { createBridge, parseTarget } from './usb-bridge.mjs';

const SECRET = '0123456789abcdef0123456789abcdef';
const once = (em, name) => new Promise((r) => em.once(name, r));
const listen = (srv, ...args) => new Promise((r) => srv.listen(...args, () => r(srv.address())));

// ------------------------------------------------------------------------------- plist ----

test('plist build/parse round trip', () => {
  const v = {
    MessageType: 'Connect',
    DeviceID: 7,
    PortNumber: htons(27015),
    Neg: -42,
    Esc: 'a <b> & "c"',
    Empty: '',
    Flag: true,
    Off: false,
    DeviceList: [
      { DeviceID: 1, Properties: { ConnectionType: 'USB', SerialNumber: '00008120-001170E422B9A01E', Nested: { x: [1, 2] } } },
      { DeviceID: 2, Properties: { ConnectionType: 'Network' } },
    ],
    EmptyArr: [],
    EmptyDict: {},
  };
  const xml = buildPlist(v);
  assert.match(xml, /^<\?xml/);
  assert.match(xml, /<key>PortNumber<\/key>\s*<integer>34665<\/integer>/);
  assert.deepEqual(parsePlist(xml), v);
});

test('plist parser handles usbmuxd-style output (self-closing, data, comments)', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><!-- hi --><dict><key>MessageType</key><string>Result</string>
<key>Number</key><integer>0</integer><key>Blob</key><data>AQID</data><key>S</key><string/></dict></plist>`;
  const r = parsePlist(Buffer.from(xml));
  assert.equal(r.MessageType, 'Result');
  assert.equal(r.Number, 0);
  assert.deepEqual([...r.Blob], [1, 2, 3]);
  assert.equal(r.S, '');
});

// ----------------------------------------------------------------------- header / htons ----

test('usbmux header encode/decode (16 bytes, little-endian)', () => {
  const h = encodeHeader({ length: 300, tag: 5 });
  assert.equal(h.length, 16);
  assert.equal(h.toString('hex'), '2c010000' + '01000000' + '08000000' + '05000000');
  assert.deepEqual(decodeHeader(h), { length: 300, version: 1, message: 8, tag: 5 });
  const m = encodeMessage({ MessageType: 'ListDevices' }, 9);
  const mh = decodeHeader(m);
  assert.equal(mh.length, m.length);
  assert.equal(mh.tag, 9);
  assert.equal(parsePlist(m.subarray(HEADER_SIZE)).MessageType, 'ListDevices');
});

test('htons port encoding', () => {
  // 27015 = 0x6987 → bytes swapped 0x8769 = 34665
  assert.equal(27015, 0x6987);
  assert.equal(htons(27015), 0x8769);
  assert.equal(htons(27015), 34665);
  assert.equal(htons(62078), 0x7ef2); // lockdownd 0xf27e
  assert.equal(htons(htons(8787)), 8787);
  assert.throws(() => htons(70000));
});

test('pickDevice prefers USB and filters by UDID ignoring dashes', () => {
  const devs = [
    { deviceId: 1, udid: '00008120-001170E422B9A01E', connectionType: 'Network' },
    { deviceId: 2, udid: '00008120-001170E422B9A01E', connectionType: 'USB' },
    { deviceId: 3, udid: 'OTHER', connectionType: 'USB' },
  ];
  assert.equal(pickDevice(devs).deviceId, 2);
  assert.equal(pickDevice(devs, '00008120001170e422b9a01e').deviceId, 2);
  assert.equal(pickDevice(devs, 'other').deviceId, 3);
  assert.equal(pickDevice(devs, 'nope'), null);
  assert.equal(parseTarget('127.0.0.1:8787').port, 8787);
  assert.throws(() => parseTarget('nohost'));
});

// --------------------------------------------------------------- fake usbmuxd (unix) ----

test('usbmux client against a fake usbmuxd: ListDevices + Connect becomes raw stream', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mux-'));
  const sockPath = path.join(dir, 'usbmuxd');
  const seen = [];
  const srv = net.createServer((c) => {
    let buf = Buffer.alloc(0);
    c.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length < 16) return;
      const h = decodeHeader(buf);
      if (buf.length < h.length) return;
      const req = parsePlist(buf.subarray(16, h.length));
      buf = buf.subarray(h.length);
      seen.push(req);
      if (req.MessageType === 'ListDevices') {
        c.write(
          encodeMessage(
            {
              DeviceList: [
                { DeviceID: 4, MessageType: 'Attached', Properties: { ConnectionType: 'Network', DeviceID: 4, SerialNumber: 'X' } },
                { DeviceID: 9, MessageType: 'Attached', Properties: { ConnectionType: 'USB', DeviceID: 9, SerialNumber: 'X', ProductID: 4776 } },
              ],
            },
            h.tag,
          ),
        );
      } else if (req.MessageType === 'Connect') {
        if (req.PortNumber !== htons(27015)) {
          c.end(encodeMessage({ MessageType: 'Result', Number: 3 }, h.tag));
          return;
        }
        // reply + first device bytes in the same chunk (must not be lost)
        c.write(Buffer.concat([encodeMessage({ MessageType: 'Result', Number: 0 }, h.tag), Buffer.from('HELLO')]));
        c.removeAllListeners('data');
        if (buf.length) c.unshift(buf);
        c.on('data', (x) => c.write(x)); // echo, like a device port
      }
    });
  });
  await listen(srv, sockPath);
  t.after(() => {
    srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const devs = await listDevices({ socketPath: sockPath });
  assert.equal(devs.length, 2);
  const d = pickDevice(devs);
  assert.equal(d.deviceId, 9);
  assert.equal(d.connectionType, 'USB');
  assert.equal(seen[0].ProgName, 'field-assist-usb-bridge');

  const s = await connectDevice(9, 27015, { socketPath: sockPath });
  assert.equal(seen[1].DeviceID, 9);
  assert.equal(seen[1].PortNumber, 34665);
  let got = '';
  s.setEncoding('utf8');
  s.on('data', (x) => (got += x));
  s.resume();
  s.write('ping');
  await new Promise((r) => {
    const iv = setInterval(() => got.length >= 9 && (clearInterval(iv), r()), 5);
  });
  assert.equal(got, 'HELLOping');
  s.destroy();

  await assert.rejects(connectDevice(9, 1234, { socketPath: sockPath }), (e) => e.code === 'MUX_RESULT' && e.number === 3);
});

// ------------------------------------------------------- full bridge with a fake phone ----

/** Fake phone: bridge listener (CONTROL/DATA), app listener, PING sender. */
async function fakePhone({ secret = SECRET, pingMs = 0 } = {}) {
  const ev = new (await import('node:events')).EventEmitter();
  let control = null;
  let nextId = 1;
  const pending = new Map();
  const log = [];
  const readLine = (sock, cb) => {
    let buf = Buffer.alloc(0);
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      const i = buf.indexOf(10);
      if (i < 0) return;
      sock.removeListener('data', onData);
      sock.pause();
      const rest = buf.subarray(i + 1);
      if (rest.length) sock.unshift(rest);
      cb(buf.subarray(0, i).toString('latin1'));
    };
    sock.on('data', onData);
  };
  const bridgeSrv = net.createServer((s) => {
    s.on('error', () => {});
    readLine(s, (line) => {
      const p = line.split(' ');
      if (p[0] !== 'FAUSB1') return s.destroy();
      if (p[1] === 'CONTROL' && p[2] === secret && p.length === 3) {
        control?.destroy();
        control = s;
        s.setEncoding('latin1');
        s.resume();
        s.on('data', (d) => {
          for (const l of d.split('\n').filter(Boolean)) {
            log.push(l);
            ev.emit('line', l);
          }
        });
        s.once('close', () => control === s && (control = null));
        ev.emit('control');
      } else if (p[1] === 'DATA' && p[3] === secret && pending.has(p[2])) {
        const app = pending.get(p[2]);
        pending.delete(p[2]);
        app.pipe(s);
        s.pipe(app);
        const close = () => (app.destroy(), s.destroy());
        app.once('close', close);
        s.once('close', close);
        app.resume();
      } else {
        s.destroy();
      }
    });
  });
  const appSrv = net.createServer((a) => {
    a.on('error', () => {});
    if (!control) return a.destroy();
    a.pause();
    const id = String(nextId++);
    pending.set(id, a);
    control.write(`OPEN ${id}\n`);
  });
  const b = await listen(bridgeSrv, 0, '127.0.0.1');
  const a = await listen(appSrv, 0, '127.0.0.1');
  let pinger = null;
  if (pingMs) pinger = setInterval(() => control?.write('PING\n'), pingMs);
  return {
    ev,
    log,
    bridgePort: b.port,
    appPort: a.port,
    get control() {
      return control;
    },
    close() {
      clearInterval(pinger);
      control?.destroy();
      bridgeSrv.close();
      appSrv.close();
    },
  };
}

async function fakeTarget() {
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ method: req.method, url: req.url, body }));
    });
  });
  // WebSocket-like upgrade: 101 then upper-case echo of every chunk
  srv.on('upgrade', (req, sock, head) => {
    sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: echo\r\nConnection: Upgrade\r\n\r\n');
    if (head.length) sock.write(head.toString().toUpperCase());
    sock.on('data', (d) => sock.write(d.toString().toUpperCase()));
  });
  const { port } = await listen(srv, 0, '127.0.0.1');
  return { port, close: () => (srv.closeAllConnections?.(), srv.close()) };
}

test('bridge: HTTP request and bidirectional upgrade stream through the tunnel', async (t) => {
  const phone = await fakePhone({ pingMs: 50 });
  const target = await fakeTarget();
  const logs = [];
  const purposes = [];
  const bridge = createBridge({
    secret: SECRET,
    target: { host: '127.0.0.1', port: target.port },
    connect: (purpose) =>
      new Promise((res, rej) => {
        purposes.push(purpose);
        const s = net.connect(phone.bridgePort, '127.0.0.1');
        s.once('connect', () => res(s));
        s.once('error', rej);
      }),
    log: (l) => logs.push(l),
    backoffMs: 50,
  });
  const connected = once(phone.ev, 'control');
  bridge.start();
  t.after(async () => {
    await bridge.stop();
    phone.close();
    target.close();
  });
  await connected;

  // PING → PONG
  await new Promise((r) => phone.ev.on('line', (l) => l === 'PONG' && r()));

  // 1) plain HTTP through the tunnel (app connects to the phone's "127.0.0.1:8787")
  const json = await new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: phone.appPort, method: 'POST', path: '/api/visit?x=1', agent: false },
      (res) => {
        let b = '';
        res.on('data', (d) => (b += d));
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(b) }));
      },
    );
    req.on('error', reject);
    req.end('hello-body');
  });
  assert.equal(json.status, 200);
  assert.deepEqual(json.body, { method: 'POST', url: '/api/visit?x=1', body: 'hello-body' });

  // 2) WebSocket-like: upgrade, then several round trips in both directions
  const sock = net.connect(phone.appPort, '127.0.0.1');
  sock.setEncoding('latin1');
  let rx = '';
  sock.on('data', (d) => (rx += d));
  const waitFor = (pred) =>
    new Promise((r, j) => {
      const to = setTimeout(() => j(new Error(`timeout; rx=${JSON.stringify(rx)}`)), 3000);
      const iv = setInterval(() => pred() && (clearInterval(iv), clearTimeout(to), r()), 5);
    });
  sock.write('GET /stream HTTP/1.1\r\nHost: 127.0.0.1:8787\r\nUpgrade: echo\r\nConnection: Upgrade\r\n\r\n');
  await waitFor(() => rx.includes('\r\n\r\n'));
  assert.match(rx, /^HTTP\/1\.1 101/);
  rx = '';
  for (const msg of ['frame-one', 'frame-two', 'x'.repeat(200_000)]) {
    sock.write(msg);
    await waitFor(() => rx.length >= msg.length);
    assert.equal(rx, msg.toUpperCase());
    rx = '';
  }
  const closed = once(bridge, 'data-close');
  sock.end();
  const info = await closed;
  assert.ok(info.up > 200_000, 'phone→mac bytes counted');

  assert.deepEqual(purposes.slice(0, 3), ['control', 'data', 'data']);
  assert.ok(logs.some((l) => /^connected/.test(l)));
  assert.ok(logs.some((l) => /^OPEN 1 → piping/.test(l)));
  assert.ok(logs.some((l) => /^OPEN 2 → piping/.test(l)));
  assert.ok(!logs.some((l) => l.includes(SECRET)), 'secret never logged');
  assert.ok(!logs.some((l) => l.includes('hello-body') || l.includes('frame-one')), 'payload never logged');
});

test('bridge: waits while the phone is absent, reconnects when it appears and after it drops', async (t) => {
  const logs = [];
  let phone = null;
  const bridge = createBridge({
    secret: SECRET,
    connect: () =>
      new Promise((res, rej) => {
        if (!phone) return rej(Object.assign(new Error('connection refused by the device'), { code: 'MUX_RESULT' }));
        const s = net.connect(phone.bridgePort, '127.0.0.1');
        s.once('connect', () => res(s));
        s.once('error', rej);
      }),
    log: (l) => logs.push(l),
    backoffMs: 30,
  });
  bridge.start();
  t.after(async () => {
    await bridge.stop();
    phone?.close();
  });
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(logs.filter((l) => l.startsWith('waiting for GlassCam')).length, 1, 'waiting logged once');
  phone = await fakePhone();
  await once(phone.ev, 'control');
  const reconnected = once(phone.ev, 'control');
  phone.control.destroy(); // phone app restarted / cable wiggle
  await reconnected;
  assert.ok(logs.filter((l) => l.startsWith('connected')).length >= 2);
});

test('bridge: wrong secret → phone closes immediately → hint logged', async (t) => {
  const phone = await fakePhone({ secret: 'f'.repeat(32) });
  const logs = [];
  const bridge = createBridge({
    secret: SECRET,
    connect: () =>
      new Promise((res, rej) => {
        const s = net.connect(phone.bridgePort, '127.0.0.1');
        s.once('connect', () => res(s));
        s.once('error', rej);
      }),
    log: (l) => logs.push(l),
    backoffMs: 1000,
  });
  bridge.start();
  t.after(async () => {
    await bridge.stop();
    phone.close();
  });
  await new Promise((r) => {
    const iv = setInterval(() => logs.some((l) => l.includes('--secret')) && (clearInterval(iv), r()), 5);
  });
  assert.ok(!logs.some((l) => l.includes(SECRET)));
});

test('createBridge validates the secret', () => {
  assert.throws(() => createBridge({ secret: 'abc', connect: async () => null }));
});
