/**
 * Minimal RFC 2822 / RFC 2045 MIME builder for Gmail drafts.
 * Output is pure 7-bit ASCII with CRLF line endings: headers are RFC 2047
 * encoded-words when non-ASCII, the text body and attachments are base64
 * (76-column lines). Callers must run validateDraft() first; this module
 * re-checks CR/LF defensively.
 */
import { assertNoControl, bytesToBase64, type DraftInput, validateDraft } from "./http";

const CRLF = "\r\n";
const enc = new TextEncoder();

const isAscii = (s: string) => /^[\x20-\x7e]*$/.test(s);

/** base64 wrapped at 76 columns. */
export function base64Lines(bytes: Uint8Array): string {
  const b64 = bytesToBase64(bytes);
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 76) lines.push(b64.slice(i, i + 76));
  return lines.join(CRLF);
}

/**
 * RFC 2047 "B" encoded-words, each ≤ 75 chars, split on code-point
 * boundaries; joined with folding whitespace.
 */
export function encodeHeaderValue(value: string, prefixLen = 0): string {
  assertNoControl("Header", value);
  if (isAscii(value)) return value;
  const words: string[] = [];
  // "=?UTF-8?B?" + "?=" = 12 chars; keep each physical line ≤ 76 chars.
  // Continuation lines start with one space → 63 base64 chars → 45 bytes.
  const bytesFor = (lead: number) => Math.max(3, Math.floor((76 - lead - 12) / 4) * 3);
  let maxBytes = bytesFor(prefixLen);
  let cur: number[] = [];
  for (const ch of value) {
    const b = enc.encode(ch);
    if (cur.length > 0 && cur.length + b.length > maxBytes) {
      maxBytes = bytesFor(1);
      words.push(`=?UTF-8?B?${bytesToBase64(Uint8Array.from(cur))}?=`);
      cur = [];
    }
    cur.push(...b);
  }
  if (cur.length) words.push(`=?UTF-8?B?${bytesToBase64(Uint8Array.from(cur))}?=`);
  return words.join(`${CRLF} `);
}

/** Content-Disposition / Content-Type filename params (RFC 2231 for non-ASCII). */
function filenameParams(filename: string): { type: string; disposition: string } {
  assertNoControl("File name", filename);
  if (isAscii(filename)) {
    const q = `"${filename.replace(/(["\\])/g, "\\$1")}"`;
    return { type: `name=${q}`, disposition: `filename=${q}` };
  }
  const pct = encodeURIComponent(filename).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return { type: `name="${encodeHeaderValue(filename)}"`, disposition: `filename*=UTF-8''${pct}` };
}

export interface MimeOptions {
  now?: Date;
  messageId?: string;
  boundary?: string;
}

/** Addresses folded one per line when the list is long. */
function addressList(xs: string[]): string {
  const flat = xs.join(", ");
  return flat.length <= 70 ? flat : xs.join(`,${CRLF} `);
}

function rfc2822Date(d: Date): string {
  // toUTCString → "Fri, 13 Nov 2026 18:00:00 GMT"
  return d.toUTCString().replace(/GMT$/, "+0000");
}

export function buildMime(d: DraftInput, opts: MimeOptions = {}): string {
  validateDraft(d);
  const boundary = opts.boundary ?? `=_fa_${crypto.randomUUID().replace(/-/g, "")}`;
  const messageId = opts.messageId ?? `<${crypto.randomUUID()}@field-assist.invalid>`;
  assertNoControl("Message-ID", messageId);
  assertNoControl("Boundary", boundary);

  const headers = [
    `MIME-Version: 1.0`,
    `Date: ${rfc2822Date(opts.now ?? new Date())}`,
    `Message-ID: ${messageId}`,
    `To: ${addressList(d.to)}`,
    ...(d.cc.length ? [`Cc: ${addressList(d.cc)}`] : []),
    `Subject: ${encodeHeaderValue(d.subject, "Subject: ".length)}`,
    `Content-Type: multipart/mixed;${CRLF} boundary="${boundary}"`,
  ];

  const parts: string[] = [];
  parts.push(
    [
      `Content-Type: text/plain; charset="UTF-8"`,
      `Content-Transfer-Encoding: base64`,
      ``,
      base64Lines(enc.encode(d.bodyText.replace(/\r?\n/g, CRLF))),
    ].join(CRLF),
  );
  for (const a of d.attachments) {
    const p = filenameParams(a.filename);
    parts.push(
      [
        `Content-Type: ${a.contentType};${CRLF} ${p.type}`,
        `Content-Disposition: attachment;${CRLF} ${p.disposition}`,
        `Content-Transfer-Encoding: base64`,
        ``,
        base64Lines(a.bytes),
      ].join(CRLF),
    );
  }

  return (
    headers.join(CRLF) +
    CRLF +
    CRLF +
    parts.map((p) => `--${boundary}${CRLF}${p}${CRLF}`).join("") +
    `--${boundary}--${CRLF}`
  );
}
