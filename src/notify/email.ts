/**
 * Outbound email for notifications: two senders behind one interface, both OFF unless configured.
 *
 *  - Resend HTTP API: RESEND_API_KEY (secret) + NOTIFY_FROM (an address on a domain verified in Resend).
 *  - Cloudflare Email Workers `send_email` binding: NOTIFY_EMAIL (binding) + NOTIFY_FROM. Works only
 *    when Email Routing is enabled on NOTIFY_FROM's domain, and only to destination addresses that
 *    are verified in Email Routing (or the binding's allowed destinations).
 *
 * When both are configured Resend is used, unless NOTIFY_EMAIL_PROVIDER says "cloudflare".
 * Failures return a reason code; nothing here logs an address, subject or body.
 */
import type { Env } from "../env";
import type { EmailSenderKind } from "./types";

export interface OutboundEmail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export type SendResult = { ok: true; messageId: string | null } | { ok: false; code: string };

export interface EmailSender {
  kind: EmailSenderKind;
  send(m: OutboundEmail): Promise<SendResult>;
}

/** The send_email binding surface we use (structured builder form). */
export interface SendEmailBinding {
  send(message: { from: string; to: string; subject: string; text?: string; html?: string }): Promise<unknown>;
}

export type EmailEnv = Pick<Env, "RESEND_API_KEY" | "NOTIFY_FROM" | "NOTIFY_EMAIL" | "NOTIFY_EMAIL_PROVIDER">;

export const RESEND_ENDPOINT = "https://api.resend.com/emails";

function fromAddress(env: EmailEnv): string | null {
  const f = env.NOTIFY_FROM?.trim();
  // "Name <a@b.c>" or "a@b.c"; no line breaks.
  return f && !/[\r\n]/.test(f) && /@/.test(f) ? f : null;
}

export function resendSender(apiKey: string, from: string, fetchImpl: typeof fetch = fetch): EmailSender {
  return {
    kind: "resend",
    async send(m) {
      let res: Response;
      try {
        res = await fetchImpl(RESEND_ENDPOINT, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ from, to: [m.to], subject: m.subject, text: m.text, html: m.html }),
        });
      } catch {
        return { ok: false, code: "resend_network" };
      }
      if (!res.ok) return { ok: false, code: `resend_http_${res.status}` };
      let id: string | null = null;
      try {
        const body = (await res.json()) as { id?: unknown };
        id = typeof body.id === "string" ? body.id.slice(0, 128) : null;
      } catch {
        id = null;
      }
      return { ok: true, messageId: id };
    },
  };
}

export function cloudflareSender(binding: SendEmailBinding, from: string): EmailSender {
  return {
    kind: "cloudflare",
    async send(m) {
      try {
        const r = (await binding.send({ from, to: m.to, subject: m.subject, text: m.text, html: m.html })) as { messageId?: unknown } | undefined;
        return { ok: true, messageId: typeof r?.messageId === "string" ? r.messageId.slice(0, 128) : null };
      } catch (err) {
        return { ok: false, code: `cf_send_failed${err instanceof Error && err.name !== "Error" ? `_${err.name}`.slice(0, 40) : ""}` };
      }
    },
  };
}

/** The configured sender, or null (email off). */
export function createEmailSender(env: EmailEnv, opts: { fetch?: typeof fetch } = {}): EmailSender | null {
  const from = fromAddress(env);
  if (!from) return null;
  const resendKey = env.RESEND_API_KEY?.trim();
  const binding = env.NOTIFY_EMAIL as SendEmailBinding | undefined;
  const hasBinding = !!binding && typeof binding.send === "function";
  const prefer = env.NOTIFY_EMAIL_PROVIDER;
  if (prefer === "cloudflare" && hasBinding) return cloudflareSender(binding!, from);
  if (resendKey) return resendSender(resendKey, from, opts.fetch ?? fetch);
  if (hasBinding) return cloudflareSender(binding!, from);
  return null;
}
