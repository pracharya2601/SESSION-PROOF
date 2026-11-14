/**
 * D1 storage for paired devices (migrations/0008_devices.sql). Separate from the frozen
 * Repository interface. Rows carry key_hash, which never leaves this module: every read
 * returns a PairedDevice (no key, no hash).
 */
import { PairedDevice } from "../contracts/devices";
import { VISIT_APPOINTMENT_PREFIX } from "../contracts/band";

type Row = Record<string, unknown>;

/** last_seen_at is written at most this often per device. */
export const LAST_SEEN_INTERVAL_MS = 60_000;
export const MAX_ACTIVE_DEVICES = 10;

function rowToDevice(r: Row): PairedDevice {
  return PairedDevice.parse({
    id: r.id,
    providerId: r.provider_id,
    name: r.name,
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at ?? null,
    revokedAt: r.revoked_at ?? null,
  });
}

const COLUMNS = "id, provider_id, name, created_at, last_seen_at, revoked_at";

export interface DeviceStore {
  create(d: { id: string; providerId: string; name: string; keyHash: string; createdAt: string }): Promise<PairedDevice>;
  /** Newest first, revoked included. */
  list(providerId: string): Promise<PairedDevice[]>;
  countActive(providerId: string): Promise<number>;
  /** Any device (revoked included) with this key hash. */
  findByKeyHash(keyHash: string): Promise<PairedDevice | null>;
  /** Idempotent. null when the device is not the provider's. */
  revoke(providerId: string, id: string, at: string): Promise<PairedDevice | null>;
  /** Sets last_seen_at = now unless it was set within LAST_SEEN_INTERVAL_MS. True when written. */
  touch(id: string, now: Date): Promise<boolean>;
  /** Client refs with at least one non-canceled, non-band appointment (a service plan to copy). */
  appointmentClientRefs(providerId: string): Promise<string[]>;
}

export function createDeviceStore(db: D1Database): DeviceStore {
  const byId = async (id: string) => {
    const r = await db.prepare(`SELECT ${COLUMNS} FROM paired_devices WHERE id = ?`).bind(id).first<Row>();
    return r ? rowToDevice(r) : null;
  };
  return {
    async create(d) {
      await db
        .prepare(`INSERT INTO paired_devices (id, provider_id, name, key_hash, created_at) VALUES (?, ?, ?, ?, ?)`)
        .bind(d.id, d.providerId, d.name, d.keyHash, d.createdAt)
        .run();
      const out = await byId(d.id);
      if (!out) throw new Error("device insert failed");
      return out;
    },

    async list(providerId) {
      const { results } = await db
        .prepare(`SELECT ${COLUMNS} FROM paired_devices WHERE provider_id = ? ORDER BY created_at DESC, id DESC LIMIT 200`)
        .bind(providerId)
        .all<Row>();
      return results.map(rowToDevice);
    },

    async countActive(providerId) {
      const r = await db
        .prepare(`SELECT COUNT(*) AS n FROM paired_devices WHERE provider_id = ? AND revoked_at IS NULL`)
        .bind(providerId)
        .first<{ n: number }>();
      return Number(r?.n ?? 0);
    },

    async findByKeyHash(keyHash) {
      const r = await db.prepare(`SELECT ${COLUMNS} FROM paired_devices WHERE key_hash = ?`).bind(keyHash).first<Row>();
      return r ? rowToDevice(r) : null;
    },

    async revoke(providerId, id, at) {
      const d = await byId(id);
      if (!d || d.providerId !== providerId) return null;
      if (!d.revokedAt) {
        await db
          .prepare(`UPDATE paired_devices SET revoked_at = ? WHERE id = ? AND provider_id = ? AND revoked_at IS NULL`)
          .bind(at, id, providerId)
          .run();
      }
      return byId(id);
    },

    async touch(id, now) {
      const cutoff = new Date(now.getTime() - LAST_SEEN_INTERVAL_MS).toISOString();
      const r = await db
        .prepare(`UPDATE paired_devices SET last_seen_at = ? WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at <= ?)`)
        .bind(now.toISOString(), id, cutoff)
        .run();
      return (r.meta?.changes ?? 0) > 0;
    },

    async appointmentClientRefs(providerId) {
      const { results } = await db
        .prepare(
          `SELECT client_ref, MAX(start_ms) AS last_ms FROM appointments
           WHERE provider_id = ? AND canceled = 0 AND substr(id, 1, ?) <> ? GROUP BY client_ref ORDER BY last_ms DESC LIMIT 200`,
        )
        .bind(providerId, VISIT_APPOINTMENT_PREFIX.length, VISIT_APPOINTMENT_PREFIX)
        .all<Row>();
      return results.map((r) => String(r.client_ref));
    },
  };
}
