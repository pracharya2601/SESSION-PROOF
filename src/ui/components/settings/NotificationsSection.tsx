/**
 * Settings → Notifications: the provider's own address for notification emails (opt-in, typed
 * twice), what to email about, and "Send test notification". In-app notifications (Today →
 * Approvals waiting) and the phone inbox always work; email needs the server to have a sender.
 */
import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, BellRing, CheckCircle2, Info, Send } from "lucide-react";
import type { NotificationSettingsView, TestNotificationResult } from "../../../notify/types";
import { isValidNotifyEmail } from "../../../notify/types";
import { api } from "../../api";
import { Badge, Button, Card, ErrorNotice, Field, Input, Skeleton, Switch, errorMessage, useToast } from "../../design";

const TEST_TEXT: Record<TestNotificationResult["email"]["status"], string> = {
  sent: "Test email sent. Check your inbox (and spam folder).",
  not_configured: "Email is not configured on the server, so only the in-app test notification was created.",
  no_address: "No notification email is saved, so only the in-app test notification was created.",
  disabled: "Email is turned off.",
  failed: "The email could not be sent.",
  already_sent: "Already sent.",
};

export function NotificationsSection({ onDirtyChange }: { onDirtyChange?: (dirty: boolean) => void }) {
  const toast = useToast();
  const [view, setView] = useState<NotificationSettingsView | null>(null);
  const [loadErr, setLoadErr] = useState<unknown>(null);
  const [email, setEmail] = useState("");
  const [confirm, setConfirm] = useState("");
  const [onReady, setOnReady] = useState(false);
  const [onApproved, setOnApproved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestNotificationResult | null>(null);

  const apply = useCallback((v: NotificationSettingsView) => {
    setView(v);
    setEmail(v.settings.email ?? "");
    setConfirm(v.settings.email ?? "");
    setOnReady(v.settings.emailOnReady);
    setOnApproved(v.settings.emailOnApproved);
  }, []);

  const load = useCallback(() => {
    setLoadErr(null);
    api.getNotificationSettings().then(apply).catch(setLoadErr);
  }, [apply]);
  useEffect(load, [load]);

  const trimmed = email.trim();
  const saved = view?.settings;
  const dirty =
    !!saved && (trimmed !== (saved.email ?? "") || onReady !== saved.emailOnReady || onApproved !== saved.emailOnApproved);
  useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange]);

  const emailError = trimmed && !isValidNotifyEmail(trimmed) ? "Enter a single address like name@example.com." : undefined;
  const confirmError =
    trimmed && !emailError && confirm.trim() !== trimmed ? "The two addresses don't match. Type it again." : undefined;
  const togglesNeedEmail = (onReady || onApproved) && !trimmed;
  const canSave = dirty && !emailError && !confirmError && !togglesNeedEmail && !saving;

  async function save() {
    if (!canSave) return;
    setSaving(true);
    try {
      const v = await api.saveNotificationSettings({ email: trimmed || null, emailOnReady: onReady, emailOnApproved: onApproved });
      apply(v);
      toast.success("Notification settings saved");
    } catch (e) {
      toast.error("Couldn't save", errorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  async function test() {
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult(await api.sendTestNotification());
    } catch (e) {
      toast.error("Test failed", errorMessage(e));
    } finally {
      setTesting(false);
    }
  }

  if (loadErr) return <ErrorNotice title="Couldn't load notification settings" error={loadErr} onRetry={load} />;
  if (!view) {
    return (
      <Card padding="lg" aria-busy="true">
        <Skeleton lines={6} />
      </Card>
    );
  }

  const configured = view.email.configured;

  return (
    <div className="u2-tab-stack">
      <Card padding="lg" className="u2-section">
        <div className="u2-section-head">
          <span className="u2-section-ico">
            <BellRing size={18} aria-hidden="true" />
          </span>
          <div>
            <h2 className="u2-h2">Notifications</h2>
            <p className="u2-muted">
              When a visit is processed you get a review link. It opens the full draft and the approval checklist; nothing is
              approved until you press Approve. In-app (Today → Approvals waiting) and your paired phone always get it. Email is
              optional.
            </p>
          </div>
        </div>

        <p className={configured ? "u2-muted" : "warn-box small"} role="status" style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {configured ? <CheckCircle2 size={15} aria-hidden="true" /> : <Info size={15} aria-hidden="true" />}
          {configured ? (
            <span>
              Email sending is set up on the server <Badge tone="success">{view.email.sender === "cloudflare" ? "Cloudflare Email" : "Resend"}</Badge>
            </span>
          ) : (
            <span>Email is not configured on the server. You can save an address now; emails start once the server has a sender.</span>
          )}
        </p>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
          style={{ display: "grid", gap: 14, maxWidth: 520 }}
        >
          <Field label="Your notification email" hint="Only you get these emails. Leave empty for no email." error={emailError}>
            <Input type="email" autoComplete="email" inputMode="email" maxLength={254} value={email} placeholder="name@example.com" onChange={(e) => setEmail(e.target.value)} />
          </Field>
          {trimmed && !emailError && (
            <Field label="Type it again" error={confirmError}>
              <Input type="email" autoComplete="off" maxLength={254} value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            </Field>
          )}
          <Switch
            checked={onReady}
            onChange={setOnReady}
            label="Email me when a visit is ready for review"
            description="Client ref, date, minutes, number of blockers and the review link. Never names or visit content."
          />
          <Switch checked={onApproved} onChange={setOnApproved} label="Email me when a visit is approved" description="A short confirmation once the files are final." />
          {togglesNeedEmail && (
            <p className="u2-inline-error" role="alert">
              <AlertTriangle size={15} aria-hidden="true" />
              <span>Add your email address to turn on email notifications.</span>
            </p>
          )}
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <Button type="submit" variant="primary" loading={saving} disabled={!canSave}>
              Save
            </Button>
            <Button type="button" variant="secondary" icon={<Send size={15} />} loading={testing} disabled={dirty} onClick={() => void test()}>
              Send test notification
            </Button>
          </div>
          {dirty && <p className="u2-muted small">Save first to test with the new settings.</p>}
        </form>

        {testResult && (
          <p
            className={testResult.email.status === "sent" ? "u2-muted" : "warn-box small"}
            role="status"
            style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 12 }}
          >
            {testResult.email.status === "sent" ? <CheckCircle2 size={15} aria-hidden="true" /> : <Info size={15} aria-hidden="true" />}
            <span>
              In-app test notification created. {TEST_TEXT[testResult.email.status]}
              {testResult.email.code ? ` (code ${testResult.email.code})` : ""}
            </span>
          </p>
        )}
      </Card>
    </div>
  );
}
