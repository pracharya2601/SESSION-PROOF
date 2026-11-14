/**
 * Notification texts. Inputs are restricted to: client REF, service date, minutes, blocker count,
 * revision and the review link. Never client names, transcript text, facts or amounts.
 */
import type { OutboundEmail } from "./email";

/** Client refs are ids (e.g. "C-104"); anything outside a conservative charset is replaced. */
export function safeRef(ref: string | null | undefined): string {
  const r = (ref ?? "").replace(/[^A-Za-z0-9._-]/g, "").slice(0, 40);
  return r || "a client";
}

export function formatServiceDate(startAt: string, timezone: string): string {
  const d = new Date(startAt);
  if (Number.isNaN(d.getTime())) return "unknown date";
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      weekday: "short",
      year: "numeric",
      month: "short",
      day: "numeric",
    }).format(d);
  } catch {
    return startAt.slice(0, 10);
  }
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export function readyTitle(clientRef: string): string {
  return `Visit for ${safeRef(clientRef)} is ready for review`;
}
export function readyPhoneTitle(clientRef: string): string {
  return `Visit for ${safeRef(clientRef)} is ready — tap to review`;
}
export function approvedTitle(clientRef: string): string {
  return `Visit for ${safeRef(clientRef)} was approved and finalized`;
}
export function visitSentTitle(clientRef: string): string {
  return `Visit for ${safeRef(clientRef)} was sent for processing`;
}

export interface ReadyEmailInput {
  clientRef: string;
  startAt: string;
  timezone: string;
  minutes: { value: number | null; confirmed: boolean };
  blockingCount: number;
  url: string;
  expiresAt: string;
}

function rows(pairs: [string, string][]): { text: string; html: string } {
  return {
    text: pairs.map(([k, v]) => `${k}: ${v}`).join("\n"),
    html: pairs
      .map(([k, v]) => `<tr><td style="padding:4px 12px 4px 0;color:#555">${esc(k)}</td><td style="padding:4px 0"><strong>${esc(v)}</strong></td></tr>`)
      .join(""),
  };
}

function wrapHtml(title: string, tableHtml: string, extra: string): string {
  return `<!doctype html><html><body style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:15px;color:#111;margin:0;padding:24px">
<h1 style="font-size:18px;margin:0 0 16px">${esc(title)}</h1>
<table style="border-collapse:collapse;margin:0 0 20px">${tableHtml}</table>
${extra}
<p style="color:#777;font-size:12px;margin-top:28px">Vexo Field Assistant. This email has no client names or visit content on purpose.</p>
</body></html>`;
}

export function readyEmail(i: ReadyEmailInput): Omit<OutboundEmail, "to"> {
  const title = readyTitle(i.clientRef);
  const minutes =
    i.minutes.value === null ? "not set yet" : `${i.minutes.value} min${i.minutes.confirmed ? " (confirmed)" : " (estimate)"}`;
  const t = rows([
    ["Client", safeRef(i.clientRef)],
    ["Service date", formatServiceDate(i.startAt, i.timezone)],
    ["Minutes", minutes],
    ["Blockers to fix", String(i.blockingCount)],
  ]);
  const expires = formatServiceDate(i.expiresAt, "UTC");
  const text = `${title}.\n\n${t.text}\n\nReview and approve (you will see the full draft and the approval checklist first):\n${i.url}\n\nThe link works until ${expires} and stops working once the visit is approved.\n`;
  const html = wrapHtml(
    title,
    t.html,
    `<p><a href="${esc(i.url)}" style="display:inline-block;background:#5b4cff;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600">Review visit</a></p>
<p style="color:#555;font-size:13px">You will see the full draft and the approval checklist before anything is approved. The link works until ${esc(expires)} and stops working once the visit is approved.</p>`,
  );
  return { subject: title, text, html };
}

export interface ApprovedEmailInput {
  clientRef: string;
  startAt: string;
  timezone: string;
  confirmedMinutes: number | null;
  bundleRevision: number;
}

export function approvedEmail(i: ApprovedEmailInput): Omit<OutboundEmail, "to"> {
  const title = approvedTitle(i.clientRef);
  const t = rows([
    ["Client", safeRef(i.clientRef)],
    ["Service date", formatServiceDate(i.startAt, i.timezone)],
    ["Confirmed minutes", i.confirmedMinutes === null ? "n/a" : String(i.confirmedMinutes)],
    ["Revision", String(i.bundleRevision)],
  ]);
  return {
    subject: title,
    text: `${title}.\n\n${t.text}\n\nThe session note, invoice and approval record are ready in the app.\n`,
    html: wrapHtml(title, t.html, `<p>The session note, invoice and approval record are ready in the app.</p>`),
  };
}

export function testEmail(origin: string): Omit<OutboundEmail, "to"> {
  const title = "Test notification from Vexo Field Assistant";
  return {
    subject: title,
    text: `${title}.\n\nEmail notifications work. When a visit is ready you will get its client ref, date, minutes, blocker count and a review link.\n\n${origin}\n`,
    html: wrapHtml(title, "", `<p>Email notifications work. When a visit is ready you will get its client ref, date, minutes, blocker count and a review link.</p>`),
  };
}
