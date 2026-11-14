import { useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { Bluetooth, Check, Flashlight, Hand, Unplug, Usb, Watch, WandSparkles } from "lucide-react";
import { Badge, Button, Card, Field, Input, cx, springy } from "../../design";
import type { BandView, ConnectMethod } from "./useVisitRecorder";
import { parseBandNumber } from "./protocol";

const NUMBER_KEY = "vexo.visit.bandNumber";
const METHOD_KEY = "vexo.visit.method";

function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeStored(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* private mode etc. */
  }
}

export const hasBluetooth = () => typeof navigator !== "undefined" && "bluetooth" in navigator;
export const hasSerial = () => typeof navigator !== "undefined" && "serial" in navigator;

interface MethodOption {
  value: ConnectMethod;
  label: string;
  icon: typeof Bluetooth;
  available: boolean;
  desc: string;
}

function methodOptions(): MethodOption[] {
  const ble = hasBluetooth();
  const serial = hasSerial();
  return [
    {
      value: "ble",
      label: "Bluetooth",
      icon: Bluetooth,
      available: ble,
      desc: ble
        ? "Wireless, from this browser."
        : "Not in this browser. Use Chrome or Edge on a laptop or Android. On iPhone, record with the GlassCam bridge app.",
    },
    {
      value: "serial",
      label: "USB cable",
      icon: Usb,
      available: serial,
      desc: serial ? "Plug the band in; pick “Vexo Open band”." : "Needs Chrome or Edge on a laptop (Web Serial).",
    },
    { value: "sim", label: "Pretend band", icon: WandSparkles, available: true, desc: "No hardware: plays a sample reading." },
  ];
}

const PHASE_BADGE: Record<BandView["phase"], { tone: "neutral" | "info" | "success" | "warning"; label: string }> = {
  idle: { tone: "neutral", label: "Not connected" },
  connecting: { tone: "info", label: "Connecting…" },
  connected: { tone: "success", label: "Connected" },
  reconnecting: { tone: "warning", label: "Reconnecting…" },
};

export function BandPanel({
  band,
  micOn,
  locked,
  onConnect,
  onDisconnect,
  onFlash,
}: {
  band: BandView;
  /** Microphone is on: the LED is locked solid blue, so Flash light is unavailable. */
  micOn: boolean;
  /** Recording in progress: the band can't be changed. */
  locked: boolean;
  onConnect: (number: number | null, method: ConnectMethod) => void;
  onDisconnect: () => void;
  onFlash: () => Promise<void>;
}) {
  const reduce = useReducedMotion();
  const options = methodOptions();
  const [numberText, setNumberText] = useState(() => readStored(NUMBER_KEY) ?? "");
  const [method, setMethod] = useState<ConnectMethod>(() => {
    const stored = readStored(METHOD_KEY) as ConnectMethod | null;
    const ok = options.find((o) => o.value === stored && o.available);
    return ok?.value ?? options.find((o) => o.available)?.value ?? "sim";
  });
  const [flashing, setFlashing] = useState(false);

  const number = parseBandNumber(numberText);
  const numberError = numberText.trim() !== "" && number === null ? "Band numbers are 1 to 999." : undefined;
  const chosen = options.find((o) => o.value === method);
  const canConnect = band.phase === "idle" && !numberError && !!chosen?.available;
  const connected = band.phase === "connected" || band.phase === "reconnecting";
  const badge = PHASE_BADGE[band.phase];

  function connect() {
    // Called synchronously from the click: the Bluetooth/USB chooser needs the user gesture.
    if (!canConnect) return;
    if (number !== null) writeStored(NUMBER_KEY, String(number));
    writeStored(METHOD_KEY, method);
    onConnect(number, method);
  }

  async function flash() {
    setFlashing(true);
    try {
      await onFlash();
    } finally {
      setFlashing(false);
    }
  }

  return (
    <Card padding="lg" as="section" className="u2-section" aria-labelledby="rv-band-h">
      <div className="u2-section-head">
        <span className="u2-section-ico">
          <Watch size={18} aria-hidden="true" />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="row-between">
            <h2 className="u2-h2" id="rv-band-h">
              Band
            </h2>
            <Badge tone={badge.tone} dot>
              {badge.label}
            </Badge>
          </div>
          <p className="u2-muted">The Vexo Open band is the microphone. Its number is printed on the band and its bag.</p>
        </div>
      </div>

      {!connected && (
        <>
          <Field
            label="Band number"
            hint={method === "sim" ? "Optional for the pretend band." : "Leave empty to choose from every band nearby."}
            error={numberError}
          >
            <Input
              className="rv-number"
              inputMode="numeric"
              autoComplete="off"
              placeholder="e.g. 42"
              maxLength={3}
              value={numberText}
              disabled={band.phase === "connecting"}
              onChange={(e) => setNumberText(e.target.value.replace(/[^\d]/g, ""))}
            />
          </Field>

          <fieldset className="u2-choice" disabled={band.phase === "connecting"}>
            <legend className="ds-field-label">Connect with</legend>
            <div className="u2-choice-grid">
              {options.map((o) => {
                const on = o.value === method;
                const Icon = o.icon;
                return (
                  <label
                    key={o.value}
                    className={cx("u2-choice-card", on && "u2-choice-on", !o.available && "rv-choice-off")}
                    title={o.available ? undefined : o.desc}
                  >
                    <input
                      type="radio"
                      className="sr-only"
                      name="rv-method"
                      value={o.value}
                      checked={on}
                      disabled={!o.available}
                      onChange={() => setMethod(o.value)}
                    />
                    <span className="rv-choice-ico" aria-hidden="true">
                      <Icon size={17} />
                    </span>
                    <span className="u2-choice-text">
                      <span className="u2-choice-name">{o.label}</span>
                      <span className="rv-choice-desc">{o.desc}</span>
                    </span>
                    {on && (
                      <>
                        <motion.span className="u2-choice-ring" layoutId="rv-method-ring" transition={reduce ? { duration: 0 } : springy} />
                        <span className="u2-choice-check" aria-hidden="true">
                          <Check size={12} />
                        </span>
                      </>
                    )}
                  </label>
                );
              })}
            </div>
          </fieldset>

          {method === "ble" && (
            <p className="rv-hint">
              <Hand size={15} aria-hidden="true" />
              <span>
                <strong>Double-tap the band</strong> (its light blinks blue), then press Connect and pick it from the list. If it
                isn’t listed, close any other tab or app connected to it.
              </span>
            </p>
          )}

          {band.error && (
            <p className="u2-inline-error" role="alert">
              {band.error}
            </p>
          )}

          <div className="rv-actions">
            <Button
              variant="primary"
              icon={<Bluetooth size={16} />}
              loading={band.phase === "connecting"}
              disabled={!canConnect}
              onClick={connect}
            >
              {band.phase === "connecting" ? "Connecting…" : "Connect"}
            </Button>
          </div>
        </>
      )}

      {connected && (
        <>
          <dl className="rv-band-facts">
            <div>
              <dt>Band</dt>
              <dd>{band.name ?? "—"}</dd>
            </div>
            <div>
              <dt>Link</dt>
              <dd>
                {band.method === "ble" ? "Bluetooth" : band.method === "serial" ? "USB cable" : "Pretend band"}
                {band.phase === "reconnecting" ? " · reconnecting" : ""}
              </dd>
            </div>
            <div>
              <dt>Firmware</dt>
              <dd>{band.firmware ?? "—"}</dd>
            </div>
            <div>
              <dt>Battery</dt>
              <dd>{band.battery ? `${band.battery.percent}%${band.battery.charging ? " · charging" : ""}` : "—"}</dd>
            </div>
          </dl>
          {band.silent && (
            <p className="u2-note u2-note-warn">The sample voice could not be loaded, so the pretend band streams silence.</p>
          )}
          <div className="rv-actions">
            <Button
              size="sm"
              icon={<Flashlight size={15} />}
              loading={flashing}
              disabled={micOn || band.phase !== "connected"}
              onClick={() => void flash()}
              title={micOn ? "The light is locked solid blue while the microphone is on." : undefined}
            >
              Flash light
            </Button>
            <Button size="sm" variant="ghost" icon={<Unplug size={15} />} disabled={locked} onClick={onDisconnect}>
              Disconnect
            </Button>
          </div>
          {micOn && <p className="rv-why">The light is solid blue while the microphone is on; it can’t flash until you stop.</p>}
        </>
      )}
    </Card>
  );
}
