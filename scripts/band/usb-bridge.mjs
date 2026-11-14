#!/usr/bin/env node
// Mac side of the GlassCam USB reverse tunnel (protocol: docs/usb-bridge.md, FROZEN v1).
//
//   node scripts/band/usb-bridge.mjs --secret <32 hex from the app> [--target 127.0.0.1:8787]
//                                    [--udid <UDID>] [--port 27015] [--verbose]
//   node scripts/band/usb-bridge.mjs --list
//
// The transport to the phone is pluggable (`connect` option of createBridge) so the bridge can be
// tested without a phone; the CLI plugs in the usbmuxd connector from ./usbmux.mjs.

import net from 'node:net';
import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';
import { listDevices, pickDevice, connectDevice } from './usbmux.mjs';

export const DEFAULT_DEVICE_PORT = 27015;
export const DEFAULT_TARGET = '127.0.0.1:8787';
const MAX_LINE = 1024;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function parseTarget(s) {
  const m = /^(?:\[([^\]]+)\]|([^:]+)):(\d{1,5})$/.exec(String(s || ''));
  if (!m) throw new Error(`bad --target "${s}" (expected host:port)`);
  const port = Number(m[3]);
  if (port < 1 || port > 65535) throw new Error(`bad --target port ${port}`);
  return { host: m[1] || m[2], port };
}

/** Read newline-terminated ASCII lines from a socket. Calls onLine(line) per line. */
function lineReader(socket, onLine, onOverflow) {
  let buf = '';
  socket.setEncoding('latin1');
  socket.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      onLine(line);
    }
    if (buf.length > MAX_LINE) onOverflow();
  });
  socket.resume(); // usbmux sockets are handed over paused
}

/**
 * Create a bridge.
 * @param {object} o
 * @param {string} o.secret                 32 hex chars (never logged)
 * @param {(purpose:'control'|'data') => Promise<import('node:stream').Duplex>} o.connect
 *        opens a raw stream to the phone's bridge port
 * @param {{host:string,port:number}} [o.target]   Mac-side TCP target (default 127.0.0.1:8787)
 * @param {(line:string)=>void} [o.log]
 * @param {(line:string)=>void} [o.debug]   verbose log (default: none)
 * @param {number} [o.backoffMs=2000]
 * @param {number} [o.idleTimeoutMs=35000]  drop the control connection if no line arrives
 */
export function createBridge({
  secret,
  connect,
  target = parseTarget(DEFAULT_TARGET),
  log = (l) => console.log(l),
  debug = () => {},
  backoffMs = 2000,
  idleTimeoutMs = 35000,
}) {
  if (!/^[0-9a-fA-F]{32}$/.test(secret || '')) throw new Error('secret must be 32 hex characters');
  if (typeof connect !== 'function') throw new Error('connect function required');

  const ev = new EventEmitter();
  const stats = { opened: 0, active: 0, failed: 0, bytesUp: 0, bytesDown: 0 };
  const sockets = new Set();
  let stopped = false;
  let control = null;
  let waiting = false;
  let wake = null;

  const track = (s) => {
    sockets.add(s);
    s.once('close', () => sockets.delete(s));
    return s;
  };

  function openData(id) {
    stats.opened++;
    stats.active++;
    const t0 = Date.now();
    let phone = null;
    let mac = null;
    let finished = false;
    const finish = (reason) => {
      if (finished) return;
      finished = true;
      stats.active--;
      const up = mac ? mac.bytesWritten : 0;
      const down = mac ? mac.bytesRead : 0;
      stats.bytesUp += up;
      stats.bytesDown += down;
      if (reason) stats.failed++;
      for (const s of [phone, mac]) {
        if (!s || s.destroyed) continue;
        s.end();
        setTimeout(() => s.destroy(), 5000).unref();
      }
      log(
        `OPEN ${id} closed${reason ? ` (${reason})` : ''} — phone→mac ${formatBytes(up)}, mac→phone ${formatBytes(down)}, ` +
          `${Date.now() - t0} ms · ${stats.active} active, ${stats.opened} total`,
      );
      ev.emit('data-close', { id, up, down, reason });
    };

    connect('data')
      .then((s) => {
        phone = track(s);
        if (finished || stopped) return phone.destroy();
        phone.on('error', (e) => finish(`phone side: ${e.message}`));
        phone.once('close', () => finish());
        phone.write(`FAUSB1 DATA ${id} ${secret}\n`);
        mac = track(net.connect(target.port, target.host));
        mac.setNoDelay(true);
        mac.on('error', (e) =>
          finish(e.code === 'ECONNREFUSED' ? `target ${target.host}:${target.port} refused — is the dev server running?` : `target: ${e.message}`),
        );
        mac.once('close', () => finish());
        mac.once('connect', () => {
          log(`OPEN ${id} → piping to ${target.host}:${target.port}`);
          ev.emit('data-open', { id });
          // pipe() handles backpressure (pauses the source while the destination buffer is full)
          phone.pipe(mac);
          mac.pipe(phone);
        });
      })
      .catch((e) => finish(`could not open data connection: ${e.message}`));
  }

  async function runControl() {
    let sock;
    try {
      sock = await connect('control');
    } catch (e) {
      if (!waiting) {
        log('waiting for GlassCam on the phone (open the Band visit tab)…');
        waiting = true;
      }
      debug(`  (${e.message}; retrying in ${backoffMs / 1000} s)`);
      return;
    }
    if (stopped) return sock.destroy();
    track(sock);
    control = sock;
    const t0 = Date.now();
    let gotLine = false;
    if (sock.setKeepAlive) sock.setKeepAlive(true, 5000);
    if (sock.setNoDelay) sock.setNoDelay(true);
    sock.write(`FAUSB1 CONTROL ${secret}\n`);
    log('connected — control channel up, waiting for app connections');
    waiting = false;
    ev.emit('control-connected');

    let idle = null;
    const armIdle = () => {
      clearTimeout(idle);
      idle = setTimeout(() => {
        log(`no PING from the phone for ${Math.round(idleTimeoutMs / 1000)} s — reconnecting`);
        sock.destroy();
      }, idleTimeoutMs);
      idle.unref?.();
    };
    armIdle();

    await new Promise((resolve) => {
      lineReader(
        sock,
        (line) => {
          gotLine = true;
          armIdle();
          if (line === 'PING') {
            sock.write('PONG\n');
            debug('  PING → PONG');
          } else if (/^OPEN \d{1,18}$/.test(line)) {
            openData(line.slice(5));
          } else {
            debug(`  ignoring unknown control line (${line.length} chars)`);
          }
        },
        () => {
          log('control line too long — dropping control connection');
          sock.destroy();
        },
      );
      sock.on('error', (e) => debug(`  control error: ${e.message}`));
      sock.once('close', resolve);
    });
    clearTimeout(idle);
    control = null;
    if (stopped) return;
    if (!gotLine && Date.now() - t0 < 6000) {
      log('control connection closed by the phone right away — is --secret current? (it changes every app launch)');
    } else {
      log('disconnected from the phone — reconnecting');
    }
    ev.emit('control-closed');
  }

  async function loop() {
    while (!stopped) {
      await runControl();
      if (stopped) break;
      await new Promise((r) => {
        // Keep the process alive while waiting to retry (an unref'd timer let the CLI exit).
        const t = setTimeout(r, backoffMs);
        wake = () => {
          clearTimeout(t);
          r();
        };
      });
      wake = null;
    }
  }

  let loopPromise = null;
  return Object.assign(ev, {
    stats,
    start() {
      loopPromise ??= loop();
      return this;
    },
    async stop() {
      stopped = true;
      wake?.();
      for (const s of sockets) s.destroy();
      await loopPromise;
    },
    get controlConnected() {
      return !!control;
    },
  });
}

/** Connector that reaches the phone through usbmuxd. */
export function usbmuxConnector({ port = DEFAULT_DEVICE_PORT, udid, socketPath, debug = () => {} } = {}) {
  let deviceId = null;
  return async (purpose) => {
    if (purpose === 'control' || deviceId == null) {
      const devices = await listDevices({ socketPath });
      const d = pickDevice(devices, udid);
      if (!d) {
        throw Object.assign(new Error(udid ? `iPhone ${udid} not attached` : 'no iPhone attached'), { code: 'NO_DEVICE' });
      }
      if (d.deviceId !== deviceId) debug(`  using device ${d.udid} (${d.connectionType}, id ${d.deviceId})`);
      deviceId = d.deviceId;
    }
    return connectDevice(deviceId, port, { socketPath });
  };
}

// ---------------------------------------------------------------------------------- CLI ----

function parseArgs(argv) {
  const o = { target: DEFAULT_TARGET, port: DEFAULT_DEVICE_PORT, verbose: false, list: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const [flag, inline] = a.startsWith('--') && a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, undefined];
    const val = () => {
      const v = inline ?? argv[++i];
      if (v === undefined) throw new Error(`${flag} needs a value`);
      return v;
    };
    switch (flag) {
      case '--secret': o.secret = val(); break;
      case '--target': o.target = val(); break;
      case '--udid': o.udid = val(); break;
      case '--port': o.port = Number(val()); break;
      case '--verbose': case '-v': o.verbose = true; break;
      case '--list': o.list = true; break;
      case '--help': case '-h': o.help = true; break;
      default: throw new Error(`unknown argument ${a}`);
    }
  }
  return o;
}

const USAGE = `Usage:
  node scripts/band/usb-bridge.mjs --secret <32 hex from the app's Band visit tab>
        [--target 127.0.0.1:8787] [--udid <UDID>] [--port 27015] [--verbose]
  node scripts/band/usb-bridge.mjs --list      # show attached devices and exit`;

async function main() {
  let o;
  try {
    o = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`${e.message}\n\n${USAGE}`);
    process.exit(2);
  }
  if (o.help) {
    console.log(USAGE);
    return;
  }
  if (o.list) {
    try {
      const devices = await listDevices();
      if (!devices.length) {
        console.log('usbmuxd: no devices attached');
        return;
      }
      console.log(['UDID'.padEnd(28), 'CONNECTION', 'DEVICE ID', 'PRODUCT ID'].join('  '));
      for (const d of devices) {
        const pid = d.properties.ProductID;
        console.log(
          [String(d.udid).padEnd(28), String(d.connectionType).padEnd(10), String(d.deviceId).padEnd(9),
            pid != null ? `0x${pid.toString(16)}` : '-'].join('  '),
        );
      }
    } catch (e) {
      console.error(`usbmuxd error: ${e.message}`);
      process.exit(1);
    }
    return;
  }
  if (!/^[0-9a-fA-F]{32}$/.test(o.secret || '')) {
    console.error(`--secret is required (32 hex characters, shown in the app's Band visit tab)\n\n${USAGE}`);
    process.exit(2);
  }
  if (!Number.isInteger(o.port) || o.port < 1 || o.port > 65535) {
    console.error(`bad --port ${o.port}`);
    process.exit(2);
  }
  let target;
  try {
    target = parseTarget(o.target);
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
  const ts = () => new Date().toTimeString().slice(0, 8);
  const log = (l) => console.log(`[${ts()}] ${l}`);
  const debug = o.verbose ? log : () => {};
  log(`usb-bridge: phone port ${o.port}${o.udid ? ` on ${o.udid}` : ''} ⇄ ${target.host}:${target.port}`);
  const bridge = createBridge({
    secret: o.secret,
    target,
    log,
    debug,
    connect: usbmuxConnector({ port: o.port, udid: o.udid, debug }),
  }).start();
  const shutdown = async () => {
    log(`stopping — ${bridge.stats.opened} connections, phone→mac ${formatBytes(bridge.stats.bytesUp)}, mac→phone ${formatBytes(bridge.stats.bytesDown)}`);
    await bridge.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
