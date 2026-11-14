import { useCallback, useEffect, useState } from "react";
import QRCode from "qrcode";
import { AlertTriangle, Copy, Eye, EyeOff, Smartphone, Trash2 } from "lucide-react";
import type { PairDeviceResponse, PairedDevice } from "../../../contracts";
import { api } from "../../api";
import { Badge, Button, Card, Dialog, EmptyState, ErrorNotice, Field, Input, Skeleton, Spinner, errorMessage, useToast } from "../../design";
import { streamHostIsLoopback } from "../visit/handoff";
import { formatInstant } from "./shared";
import "./devices.css";

const NAME_MAX = 60;

/** The `server` origin inside a glasscam://pair link, or null. */
function linkServer(link: string): string | null {
  try {
    return new URL(link).searchParams.get("server");
  } catch {
    return null;
  }
}

/**
 * Settings → Devices: pair a phone (GlassCam) once with a long-lived key shown as a QR code,
 * list paired phones, and remove (revoke) one. Contract: src/contracts/devices.ts.
 */
export function DevicesSection() {
  const toast = useToast();
  const [devices, setDevices] = useState<PairedDevice[] | null>(null);
  const [loadErr, setLoadErr] = useState<unknown>(null);
  const [name, setName] = useState("");
  const [pairing, setPairing] = useState(false);
  const [pairErr, setPairErr] = useState<string | null>(null);
  const [paired, setPaired] = useState<PairDeviceResponse | null>(null);
  const [removing, setRemoving] = useState<PairedDevice | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);

  const load = useCallback(() => {
    setLoadErr(null);
    api.listDevices().then(setDevices).catch(setLoadErr);
  }, []);
  useEffect(load, [load]);

  const trimmed = name.trim();
  const nameInvalid = trimmed.length > NAME_MAX;

  async function pair() {
    if (!trimmed || nameInvalid) return;
    setPairing(true);
    setPairErr(null);
    try {
      const res = await api.pairDevice(trimmed);
      setPaired(res);
      setName("");
      load();
    } catch (e) {
      setPairErr(errorMessage(e) || "Could not pair the phone.");
    } finally {
      setPairing(false);
    }
  }

  async function remove() {
    if (!removing) return;
    setRemoveBusy(true);
    try {
      await api.revokeDevice(removing.id);
      toast.success("Phone removed", `${removing.name} can no longer start or stop visits.`);
      setRemoving(null);
      load();
    } catch (e) {
      toast.error("Couldn't remove the phone", errorMessage(e));
    } finally {
      setRemoveBusy(false);
    }
  }

  const active = devices?.filter((d) => !d.revokedAt) ?? [];
  const revoked = devices?.filter((d) => d.revokedAt) ?? [];

  return (
    <div className="u2-tab-stack">
      <Card padding="lg" className="u2-section">
        <div className="u2-section-head">
          <span className="u2-section-ico">
            <Smartphone size={18} aria-hidden="true" />
          </span>
          <div>
            <h2 className="u2-h2">Paired phones</h2>
            <p className="u2-muted">
              Pair your iPhone (GlassCam) once. It can then list your clients and start and stop band visits on its own, until
              you remove it here.
            </p>
          </div>
        </div>

        <form
          className="dv-pair"
          onSubmit={(e) => {
            e.preventDefault();
            void pair();
          }}
        >
          <Field label="Phone name" hint="So you can tell your phones apart, e.g. “Sam’s iPhone”." error={nameInvalid ? `At most ${NAME_MAX} characters.` : undefined}>
            <Input value={name} maxLength={NAME_MAX + 10} placeholder="Sam’s iPhone" onChange={(e) => setName(e.target.value)} />
          </Field>
          <Button type="submit" variant="primary" icon={<Smartphone size={16} />} loading={pairing} disabled={!trimmed || nameInvalid}>
            {pairing ? "Pairing…" : "Pair a phone"}
          </Button>
        </form>
        {pairErr && (
          <p className="u2-inline-error" role="alert">
            <AlertTriangle size={15} aria-hidden="true" />
            <span>{pairErr}</span>
          </p>
        )}

        {loadErr ? (
          <ErrorNotice title="Couldn't load paired phones" error={loadErr} onRetry={load} />
        ) : !devices ? (
          <Skeleton lines={3} />
        ) : devices.length === 0 ? (
          <EmptyState compact icon={<Smartphone size={18} />} title="No paired phones" description="Pair a phone to record visits from GlassCam without this page." />
        ) : (
          <ul className="dv-list" aria-label="Paired phones">
            {[...active, ...revoked].map((d) => (
              <li key={d.id} className={d.revokedAt ? "dv-row dv-row-revoked" : "dv-row"}>
                <div className="dv-row-main">
                  <span className="dv-row-name">{d.name}</span>
                  <span className="dv-row-meta">
                    <span>Paired {formatInstant(d.createdAt)}</span>
                    <span>Last seen {d.lastSeenAt ? formatInstant(d.lastSeenAt) : "never"}</span>
                    {d.revokedAt && <span>Removed {formatInstant(d.revokedAt)}</span>}
                  </span>
                </div>
                {d.revokedAt ? (
                  <Badge tone="neutral">Removed</Badge>
                ) : (
                  <>
                    <Badge tone="success" dot>
                      Active
                    </Badge>
                    <Button size="sm" variant="ghost" icon={<Trash2 size={15} />} onClick={() => setRemoving(d)}>
                      Remove
                    </Button>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <PairResultDialog result={paired} onClose={() => setPaired(null)} />

      <Dialog
        open={removing != null}
        onClose={() => !removeBusy && setRemoving(null)}
        dismissible={!removeBusy}
        size="sm"
        title={`Remove ${removing?.name ?? "this phone"}?`}
        description="Its key stops working at once: the phone can no longer list clients or start and stop visits. Visits it already recorded stay. To use it again, pair it again."
        footer={
          <>
            <Button variant="ghost" disabled={removeBusy} onClick={() => setRemoving(null)}>
              Keep it
            </Button>
            <Button variant="danger" icon={<Trash2 size={15} />} loading={removeBusy} onClick={() => void remove()}>
              Remove phone
            </Button>
          </>
        }
      />
    </div>
  );
}

function PairResultDialog({ result, onClose }: { result: PairDeviceResponse | null; onClose: () => void }) {
  const toast = useToast();
  const [qr, setQr] = useState<string | null>(null);
  const [qrFailed, setQrFailed] = useState(false);
  const [showLink, setShowLink] = useState(false);
  const link = result?.pairingLink ?? null;
  const server = link ? linkServer(link) : null;
  const loopback = server ? streamHostIsLoopback(server) : false;

  useEffect(() => {
    setQr(null);
    setQrFailed(false);
    setShowLink(false);
    if (!link) return;
    let cancelled = false;
    // Rendered locally; the link never leaves this page.
    QRCode.toDataURL(link, { errorCorrectionLevel: "M", margin: 1, width: 220 })
      .then((url) => !cancelled && setQr(url))
      .catch(() => !cancelled && setQrFailed(true));
    return () => {
      cancelled = true;
    };
  }, [link]);

  async function copy() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      toast.success("Link copied", "Open it on the iPhone to pair GlassCam.");
    } catch {
      toast.error("Couldn't copy", "Your browser blocked the clipboard. Use Show link and copy it by hand.");
    }
  }

  return (
    <Dialog
      open={result != null}
      onClose={onClose}
      size="md"
      title={`Pair ${result?.device.name ?? "phone"}`}
      description="Scan this code with the iPhone camera, or open the copied link on the phone."
      footer={
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      }
    >
      {result && link && (
        <div className="dv-result">
          <p className="u2-note u2-note-warn" role="note">
            <AlertTriangle size={15} aria-hidden="true" />
            <span>
              This code is shown <strong>once</strong>. It holds the phone’s key, which works until you remove the phone here.
              Anyone with it can start and stop visits for you, so don’t share it or paste it into chats, tickets or logs.
            </span>
          </p>
          {loopback && (
            <p className="u2-note u2-note-warn" role="alert">
              <AlertTriangle size={15} aria-hidden="true" />
              <span>
                The link points to {server}, which your phone can’t reach. Set PUBLIC_APP_ORIGIN (or PUBLIC_STREAM_ORIGIN) in
                .dev.vars to this Mac’s LAN address, e.g. http://192.168.1.20:8787, run wrangler dev with --ip 0.0.0.0, then
                remove this phone and pair it again.
              </span>
            </p>
          )}
          <div className="dv-result-main">
            <div className="dv-qr" aria-label="QR code for GlassCam pairing">
              {qr ? (
                <img src={qr} width={220} height={220} alt="QR code: pair this phone in GlassCam" />
              ) : qrFailed ? (
                <span className="u2-muted u2-small">QR code unavailable. Use Copy link.</span>
              ) : (
                <Spinner size={18} />
              )}
            </div>
            <ol className="dv-steps">
              <li>Open the iPhone camera and scan the code.</li>
              <li>GlassCam opens and saves the pairing for {server ?? "this server"}.</li>
              <li>Start visits from the phone. It appears under Paired phones once it connects.</li>
            </ol>
          </div>
          <div className="dv-actions">
            <Button size="sm" icon={<Copy size={15} />} onClick={() => void copy()}>
              Copy link
            </Button>
            <Button
              size="sm"
              variant="ghost"
              icon={showLink ? <EyeOff size={15} /> : <Eye size={15} />}
              aria-expanded={showLink}
              onClick={() => setShowLink((s) => !s)}
            >
              {showLink ? "Hide link" : "Show link"}
            </Button>
          </div>
          {showLink && <code className="mono dv-link">{link}</code>}
        </div>
      )}
    </Dialog>
  );
}
