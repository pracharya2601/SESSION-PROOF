// Minimal usbmuxd client (no dependencies). Speaks the binary-header + XML-plist protocol over
// the unix socket /var/run/usbmuxd, the same channel Xcode uses to reach a cabled iPhone.
//
// Wire format: 16-byte little-endian header [length (incl. header), version=1, message=8 (plist),
// tag] followed by an XML plist payload. After a successful `Connect` the same socket becomes a
// raw TCP stream to the device port.

import net from 'node:net';

export const USBMUXD_SOCKET = '/var/run/usbmuxd';
export const HEADER_SIZE = 16;
export const MUX_VERSION = 1;
export const MUX_MESSAGE_PLIST = 8;
const PROG_NAME = 'field-assist-usb-bridge';
const CLIENT_VERSION = 'field-assist-usb-bridge-1';

/** Result codes from usbmuxd's `Result` message. */
export const RESULT_TEXT = {
  0: 'ok',
  1: 'bad command',
  2: 'bad device (device not attached)',
  3: 'connection refused by the device (nothing listening on that port)',
  6: 'bad version',
};

// ---------------------------------------------------------------- XML plist (tiny subset) ----

const escapeXml = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const unescapeXml = (s) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');

function buildValue(v, indent) {
  const pad = '\t'.repeat(indent);
  if (typeof v === 'string') return `${pad}<string>${escapeXml(v)}</string>\n`;
  if (typeof v === 'bigint') return `${pad}<integer>${v}</integer>\n`;
  if (typeof v === 'number') {
    if (Number.isInteger(v)) return `${pad}<integer>${v}</integer>\n`;
    return `${pad}<real>${v}</real>\n`;
  }
  if (typeof v === 'boolean') return `${pad}<${v}/>\n`;
  if (Buffer.isBuffer(v)) return `${pad}<data>${v.toString('base64')}</data>\n`;
  if (Array.isArray(v)) {
    if (!v.length) return `${pad}<array/>\n`;
    return `${pad}<array>\n${v.map((x) => buildValue(x, indent + 1)).join('')}${pad}</array>\n`;
  }
  if (v && typeof v === 'object') {
    const keys = Object.keys(v).filter((k) => v[k] !== undefined);
    if (!keys.length) return `${pad}<dict/>\n`;
    let out = `${pad}<dict>\n`;
    for (const k of keys) out += `${pad}\t<key>${escapeXml(k)}</key>\n${buildValue(v[k], indent + 1)}`;
    return `${out}${pad}</dict>\n`;
  }
  throw new TypeError(`plist: unsupported value ${typeof v}`);
}

/** Build an XML plist document from a JS value (strings, integers, booleans, arrays, dicts). */
export function buildPlist(value) {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
    '<plist version="1.0">\n' +
    buildValue(value, 0) +
    '</plist>\n'
  );
}

/** Parse an XML plist document (dict/array/string/integer/real/true/false/data/date). */
export function parsePlist(xml) {
  const text = Buffer.isBuffer(xml) ? xml.toString('utf8') : String(xml);
  const re = /<(\/?)([A-Za-z]+)[^>]*?(\/?)>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<![^>]*>/g;
  const tokens = [];
  let m;
  let last = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) tokens.push({ text: text.slice(last, m.index) });
    last = re.lastIndex;
    if (!m[2]) continue; // comment / declaration / doctype
    tokens.push({ name: m[2], close: m[1] === '/', selfClose: m[3] === '/' });
  }
  let i = 0;
  const skipWs = () => {
    while (i < tokens.length && tokens[i].text !== undefined && !tokens[i].text.trim()) i++;
  };
  const readText = (name) => {
    let s = '';
    while (i < tokens.length && tokens[i].text !== undefined) s += tokens[i++].text;
    const end = tokens[i++];
    if (!end || !end.close || end.name !== name) throw new Error(`plist: expected </${name}>`);
    return unescapeXml(s);
  };
  const parseValue = () => {
    skipWs();
    const t = tokens[i++];
    if (!t || t.text !== undefined || t.close) throw new Error('plist: expected a value element');
    switch (t.name) {
      case 'dict': {
        const out = {};
        if (t.selfClose) return out;
        for (;;) {
          skipWs();
          const k = tokens[i];
          if (k && k.close && k.name === 'dict') {
            i++;
            return out;
          }
          if (!k || k.name !== 'key' || k.close) throw new Error('plist: expected <key>');
          i++;
          const key = k.selfClose ? '' : readText('key');
          out[key] = parseValue();
        }
      }
      case 'array': {
        const out = [];
        if (t.selfClose) return out;
        for (;;) {
          skipWs();
          const e = tokens[i];
          if (e && e.close && e.name === 'array') {
            i++;
            return out;
          }
          out.push(parseValue());
        }
      }
      case 'string':
        return t.selfClose ? '' : readText('string');
      case 'integer': {
        const s = readText('integer').trim();
        const n = Number(s);
        return Number.isSafeInteger(n) ? n : BigInt(s);
      }
      case 'real':
        return Number(readText('real').trim());
      case 'true':
        return true;
      case 'false':
        return false;
      case 'data':
        return t.selfClose ? Buffer.alloc(0) : Buffer.from(readText('data').replace(/\s+/g, ''), 'base64');
      case 'date':
        return new Date(readText('date').trim());
      default:
        throw new Error(`plist: unsupported element <${t.name}>`);
    }
  };
  skipWs();
  const root = tokens[i];
  if (root && root.name === 'plist' && !root.close) i++;
  return parseValue();
}

// ---------------------------------------------------------------------- header + framing ----

export function encodeHeader({ length, version = MUX_VERSION, message = MUX_MESSAGE_PLIST, tag }) {
  const b = Buffer.alloc(HEADER_SIZE);
  b.writeUInt32LE(length, 0);
  b.writeUInt32LE(version, 4);
  b.writeUInt32LE(message, 8);
  b.writeUInt32LE(tag, 12);
  return b;
}

export function decodeHeader(buf) {
  if (buf.length < HEADER_SIZE) throw new Error('usbmux: short header');
  return {
    length: buf.readUInt32LE(0),
    version: buf.readUInt32LE(4),
    message: buf.readUInt32LE(8),
    tag: buf.readUInt32LE(12),
  };
}

/** Encode one plist message (header + payload). */
export function encodeMessage(dict, tag) {
  const payload = Buffer.from(buildPlist(dict), 'utf8');
  return Buffer.concat([encodeHeader({ length: HEADER_SIZE + payload.length, tag }), payload]);
}

/** 16-bit port in network byte order, as usbmuxd expects in `PortNumber`. */
export function htons(port) {
  if (!Number.isInteger(port) || port < 0 || port > 0xffff) throw new RangeError(`bad port ${port}`);
  return ((port & 0xff) << 8) | ((port >> 8) & 0xff);
}

// ------------------------------------------------------------------------------ client ----

let nextTag = 1;

/**
 * Open a socket to usbmuxd, send one request and resolve with { socket, reply, rest } where
 * `rest` is any bytes received after the reply (only relevant after Connect).
 */
function request(dict, { socketPath = USBMUXD_SOCKET, timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const tag = nextTag;
    nextTag = nextTag >= 0x7fffffff ? 1 : nextTag + 1;
    const socket = net.connect(socketPath);
    let buf = Buffer.alloc(0);
    let done = false;
    const fail = (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      reject(err);
    };
    const timer = setTimeout(() => fail(new Error('usbmux: timed out waiting for usbmuxd')), timeoutMs);
    socket.on('error', (err) =>
      fail(
        err.code === 'ENOENT' || err.code === 'ECONNREFUSED'
          ? Object.assign(new Error(`usbmux: cannot reach usbmuxd at ${socketPath} (${err.code})`), { code: err.code })
          : err,
      ),
    );
    socket.on('close', () => fail(new Error('usbmux: usbmuxd closed the connection')));
    socket.on('connect', () => socket.write(encodeMessage(dict, tag)));
    const onData = (chunk) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      if (buf.length < HEADER_SIZE) return;
      const h = decodeHeader(buf);
      if (h.length < HEADER_SIZE) return fail(new Error('usbmux: bad header length'));
      if (buf.length < h.length) return;
      let reply;
      try {
        if (h.message !== MUX_MESSAGE_PLIST) throw new Error(`usbmux: unexpected message type ${h.message}`);
        reply = parsePlist(buf.subarray(HEADER_SIZE, h.length));
      } catch (err) {
        return fail(err);
      }
      done = true;
      clearTimeout(timer);
      socket.removeListener('data', onData);
      socket.removeAllListeners('close');
      socket.removeAllListeners('error');
      socket.pause();
      resolve({ socket, reply, rest: buf.subarray(h.length) });
    };
    socket.on('data', onData);
  });
}

const baseRequest = (MessageType) => ({
  MessageType,
  ClientVersionString: CLIENT_VERSION,
  ProgName: PROG_NAME,
  kLibUSBMuxVersion: 3,
});

/**
 * List attached devices. Resolves to [{ deviceId, udid, connectionType, properties }].
 */
export async function listDevices(opts = {}) {
  const { socket, reply } = await request(baseRequest('ListDevices'), opts);
  socket.destroy();
  const list = Array.isArray(reply.DeviceList) ? reply.DeviceList : [];
  return list.map((d) => {
    const p = d.Properties || {};
    return {
      deviceId: p.DeviceID ?? d.DeviceID,
      udid: p.SerialNumber || p.UDID || '',
      connectionType: p.ConnectionType || 'unknown',
      properties: p,
    };
  });
}

const normUdid = (s) => String(s || '').replace(/-/g, '').toUpperCase();

/** Pick a device: USB preferred over Network; optional UDID filter (dashes/case ignored). */
export function pickDevice(devices, udid) {
  let pool = devices;
  if (udid) pool = pool.filter((d) => normUdid(d.udid) === normUdid(udid));
  return pool.find((d) => d.connectionType === 'USB') || pool[0] || null;
}

/**
 * Connect to `port` on device `deviceId`. Resolves with a net.Socket that is now a raw TCP
 * stream to the device port. The socket is PAUSED (so no device bytes are lost before the caller
 * attaches); pipe() or resume() it. Rejects with err.code = 'MUX_RESULT' and err.number on failure.
 */
export async function connectDevice(deviceId, port, opts = {}) {
  const { socket, reply, rest } = await request(
    { ...baseRequest('Connect'), DeviceID: deviceId, PortNumber: htons(port) },
    opts,
  );
  if (reply.MessageType !== 'Result' || reply.Number !== 0) {
    socket.destroy();
    const n = reply.Number;
    const err = new Error(`usbmux Connect to port ${port} failed: ${RESULT_TEXT[n] || `result ${n}`}`);
    err.code = 'MUX_RESULT';
    err.number = n;
    throw err;
  }
  if (rest.length) socket.unshift(rest);
  return socket;
}
