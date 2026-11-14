import { useEffect, useRef, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { api, ApiClientError } from "../../api";
import { Button, Dialog, Field, Input, Switch } from "../../design";
import { emptyInput, LIMITS, parseDollarsToCents, validateClientRef } from "./shared";

/** Creates a client with PUT /api/clients/:ref (refuses to overwrite an existing ref). */
export function NewClientDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (ref: string) => void }) {
  const [ref, setRef] = useState("");
  const [name, setName] = useState("");
  const [useDefault, setUseDefault] = useState(true);
  const [rate, setRate] = useState("");
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [serverErr, setServerErr] = useState<string | null>(null);
  const refInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setRef("");
      setName("");
      setUseDefault(true);
      setRate("");
      setTouched(false);
      setServerErr(null);
    }
  }, [open]);

  const refErr = validateClientRef(ref);
  const rateRes = useDefault ? null : parseDollarsToCents(rate);
  const rateErr = rateRes && "error" in rateRes ? rateRes.error : null;
  const nameErr = name.trim().length > LIMITS.displayName ? `At most ${LIMITS.displayName} characters.` : null;
  const invalid = !!(refErr || rateErr || nameErr);

  async function submit(e?: React.FormEvent) {
    e?.preventDefault();
    setTouched(true);
    if (invalid) return;
    setBusy(true);
    setServerErr(null);
    const clientRef = ref.trim();
    try {
      // Guard against silently overwriting an existing client record.
      try {
        await api.getClient(clientRef);
        setServerErr(`A client with ref “${clientRef}” already exists.`);
        setBusy(false);
        return;
      } catch (err) {
        if (!(err instanceof ApiClientError && err.status === 404)) throw err;
      }
      const input = emptyInput(clientRef);
      input.displayName = name.trim() || null;
      input.hourlyRateCents = rateRes && "cents" in rateRes ? rateRes.cents : null;
      await api.saveClient(input);
      onCreated(clientRef);
    } catch (err) {
      setServerErr(
        err instanceof ApiClientError
          ? err.status === 400 || err.status === 422
            ? err.message
            : `${err.message}${err.correlationId ? ` (ref ${err.correlationId})` : ""}`
          : "Something went wrong.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      dismissible={!busy}
      title="New client"
      description="Add a client so their rate, funding details and templates apply to new drafts."
      initialFocusRef={refInput}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void submit()}>
            Create client
          </Button>
        </>
      }
    >
      <form className="stack" onSubmit={(e) => void submit(e)} noValidate>
        <Field label="Client ref" required hint="Matches the client ref on calendar appointments. Letters, numbers, . _ -" error={touched ? refErr : null}>
          <Input
            ref={refInput}
            value={ref}
            onChange={(e) => setRef(e.target.value)}
            onBlur={() => setTouched(true)}
            maxLength={64}
            autoComplete="off"
            spellCheck={false}
            className="mono"
            placeholder="client-001"
          />
        </Field>
        <Field label="Name" hint="Optional — shown on your documents only." error={nameErr}>
          <Input value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
        </Field>
        <Switch checked={useDefault} onChange={setUseDefault} label="Use agency default rate" description="Turn off to set a per-client hourly rate." />
        {!useDefault && (
          <Field label="Hourly rate (USD)" error={touched || rate ? rateErr : null}>
            <Input value={rate} onChange={(e) => setRate(e.target.value)} inputMode="decimal" leading={<span aria-hidden="true">$</span>} placeholder="85.00" />
          </Field>
        )}
        <p className="cl-privacy small">
          <ShieldCheck size={14} aria-hidden="true" />
          <span>Names are never sent to AI — they're scrubbed like other personal details.</span>
        </p>
        {serverErr && (
          <div className="error-box small" role="alert">
            {serverErr}
          </div>
        )}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
