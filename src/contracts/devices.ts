/**
 * Paired devices (FROZEN): a phone (GlassCam) is paired ONCE with a long-lived device key
 * and can then list the provider's clients and start/stop band visits itself, until the
 * provider revokes it in Settings → Devices.
 *
 * Pairing link (QR): glasscam://pair?server=<https/http origin>&key=<device key>&name=<label>
 * Device key format: "vfad_" + 43 base64url chars (32 random bytes). Shown ONCE at creation;
 * the server stores only SHA-256(key). Auth header: `Authorization: Bearer <device key>`.
 *
 * Device API (no cookie, no Origin needed; all scoped to the device's provider):
 *   GET  /api/device/me                      → DeviceMe
 *   GET  /api/device/clients                 → DeviceClient[] (active clients)
 *   POST /api/device/visits   DeviceStartVisitRequest → StartVisitResponse (contracts/band.ts)
 *   POST /api/device/visits/:id/stop         → StopVisitResponse
 *   GET  /api/device/visits/:id              → VisitDetail
 * Web (cookie) management:
 *   GET    /api/devices                      → PairedDevice[]
 *   POST   /api/devices        PairDeviceRequest → PairDeviceResponse (key + pairing link, once)
 *   DELETE /api/devices/:id                  → { revoked: true }   (key stops working at once)
 */
import { z } from "zod";
import { BandTransport } from "./band";

const Id = z.string().min(1).max(128);
const Instant = z.string().datetime({ offset: true });

export const DEVICE_KEY_PREFIX = "vfad_";

export const PairedDevice = z.object({
  id: Id,
  providerId: Id,
  name: z.string().min(1).max(60),
  createdAt: Instant,
  lastSeenAt: Instant.nullable(),
  revokedAt: Instant.nullable(),
});
export type PairedDevice = z.infer<typeof PairedDevice>;

export const PairDeviceRequest = z.object({ name: z.string().trim().min(1).max(60) }).strict();
export type PairDeviceRequest = z.infer<typeof PairDeviceRequest>;

export const PairDeviceResponse = z.object({
  device: PairedDevice,
  /** Shown once. Never stored in plain text on the server. */
  key: z.string(),
  /** glasscam://pair?server=…&key=…&name=… */
  pairingLink: z.string(),
});
export type PairDeviceResponse = z.infer<typeof PairDeviceResponse>;

export const DeviceMe = z.object({
  device: PairedDevice,
  provider: z.object({ id: Id, identity: z.string() }),
  /** Transcribers this server can run for device visits: the server's choice (deepgram/simulated) if any, then "device" (always accepted). */
  transcribers: z.array(z.enum(["deepgram", "device", "simulated"])),
});
export type DeviceMe = z.infer<typeof DeviceMe>;

export const DeviceClient = z.object({
  clientRef: Id,
  /** Shown on the provider's own phone only. Never sent to AI. */
  displayName: z.string().nullable(),
  preferredName: z.string().nullable(),
});
export type DeviceClient = z.infer<typeof DeviceClient>;

export const DeviceStartVisitRequest = z
  .object({
    clientRef: z.string().trim().min(1).max(64),
    bandNumber: z.number().int().min(1).max(999).nullable(),
    transport: BandTransport,
    timezone: z.string().min(1).max(64).optional(),
    /**
     * Default "server": the phone only records and streams audio; the Worker transcribes
     * (Deepgram, or simulated in local dev). "device" = on-phone transcription (optional path).
     */
    transcriber: z.enum(["device", "server"]).default("server"),
  })
  .strict();
export type DeviceStartVisitRequest = z.infer<typeof DeviceStartVisitRequest>;
