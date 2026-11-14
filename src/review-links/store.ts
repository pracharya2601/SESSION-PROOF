/**
 * D1 storage for review links (migrations/0009_review_links.sql). Separate from the frozen
 * Repository. token_hash never leaves this module except for the integrity check in
 * ensureReviewLink (`hashMatches`).
 */
export interface ReviewLinkRecord {
  id: string;
  providerId: string;
  sessionId: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  closedAt: string | null;
  usedAt: string | null;
  lastOpenedAt: string | null;
}

type Row = Record<string, unknown>;
const COLUMNS = "id, provider_id, session_id, created_at, expires_at, revoked_at, closed_at, used_at, last_opened_at";
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

function toRecord(r: Row): ReviewLinkRecord {
  return {
    id: String(r.id),
    providerId: String(r.provider_id),
    sessionId: String(r.session_id),
    createdAt: String(r.created_at),
    expiresAt: String(r.expires_at),
    revokedAt: str(r.revoked_at),
    closedAt: str(r.closed_at),
    usedAt: str(r.used_at),
    lastOpenedAt: str(r.last_opened_at),
  };
}

export interface ReviewLinkStore {
  create(l: { id: string; providerId: string; sessionId: string; tokenHash: string; createdAt: string; expiresAt: string }): Promise<void>;
  findByHash(tokenHash: string): Promise<ReviewLinkRecord | null>;
  /** Newest link of the session that is not revoked, closed or expired at `nowIso`, with its hash. */
  latestOpen(providerId: string, sessionId: string, nowIso: string): Promise<{ link: ReviewLinkRecord; tokenHash: string } | null>;
  /** Newest first, at most 50. */
  listForSession(providerId: string, sessionId: string): Promise<ReviewLinkRecord[]>;
  /** Idempotent; null when the link is not the provider's. */
  revoke(providerId: string, id: string, at: string): Promise<ReviewLinkRecord | null>;
  /** Closes every open link of the session (session completed). Returns how many changed. */
  closeForSession(sessionId: string, at: string): Promise<number>;
  markUsed(id: string, at: string): Promise<void>;
  touchOpened(id: string, at: string): Promise<void>;
}

export function createReviewLinkStore(db: D1Database): ReviewLinkStore {
  const byId = async (id: string) => {
    const r = await db.prepare(`SELECT ${COLUMNS} FROM review_links WHERE id = ?`).bind(id).first<Row>();
    return r ? toRecord(r) : null;
  };
  return {
    async create(l) {
      await db
        .prepare(
          `INSERT INTO review_links (id, provider_id, session_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind(l.id, l.providerId, l.sessionId, l.tokenHash, l.createdAt, l.expiresAt)
        .run();
    },

    async findByHash(tokenHash) {
      const r = await db.prepare(`SELECT ${COLUMNS} FROM review_links WHERE token_hash = ?`).bind(tokenHash).first<Row>();
      return r ? toRecord(r) : null;
    },

    async latestOpen(providerId, sessionId, nowIso) {
      const r = await db
        .prepare(
          `SELECT ${COLUMNS}, token_hash FROM review_links
           WHERE provider_id = ? AND session_id = ? AND revoked_at IS NULL AND closed_at IS NULL AND expires_at > ?
           ORDER BY created_at DESC, id DESC LIMIT 1`,
        )
        .bind(providerId, sessionId, nowIso)
        .first<Row>();
      return r ? { link: toRecord(r), tokenHash: String(r.token_hash) } : null;
    },

    async listForSession(providerId, sessionId) {
      const { results } = await db
        .prepare(`SELECT ${COLUMNS} FROM review_links WHERE provider_id = ? AND session_id = ? ORDER BY created_at DESC, id DESC LIMIT 50`)
        .bind(providerId, sessionId)
        .all<Row>();
      return results.map(toRecord);
    },

    async revoke(providerId, id, at) {
      const l = await byId(id);
      if (!l || l.providerId !== providerId) return null;
      if (!l.revokedAt) {
        await db.prepare(`UPDATE review_links SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`).bind(at, id).run();
      }
      return byId(id);
    },

    async closeForSession(sessionId, at) {
      const r = await db
        .prepare(`UPDATE review_links SET closed_at = ? WHERE session_id = ? AND closed_at IS NULL AND revoked_at IS NULL`)
        .bind(at, sessionId)
        .run();
      return r.meta?.changes ?? 0;
    },

    async markUsed(id, at) {
      await db.prepare(`UPDATE review_links SET used_at = COALESCE(used_at, ?) WHERE id = ?`).bind(at, id).run();
    },

    async touchOpened(id, at) {
      await db.prepare(`UPDATE review_links SET last_opened_at = ? WHERE id = ?`).bind(at, id).run();
    },
  };
}
