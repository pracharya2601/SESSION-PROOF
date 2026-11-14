/**
 * v3 clients (W3): per-client rate application, frozen snapshots, and the
 * client's known PII terms for the scrubber. Pure functions — no I/O.
 */
import { clientRateVersion, type ClientRecord, type ClientSnapshot, type RateRule } from "../contracts";

/**
 * The rate frozen into a draft bundle. An ACTIVE client with its own
 * hourlyRateCents overrides the agency default; rateVersion then identifies the
 * client's rate version so later rate changes never alter approved invoices.
 */
export function effectiveRate(rate: RateRule, client: ClientRecord | null): RateRule {
  if (client && client.active && client.hourlyRateCents != null) {
    return {
      ...rate,
      hourlyRateCents: client.hourlyRateCents,
      rateVersion: clientRateVersion(client.clientRef, client.rateVersion),
    };
  }
  return rate;
}

/**
 * Snapshot frozen at finalization. `rate` must be the bundle's FROZEN rate
 * (bundle.config.rate), not the client's live rate.
 */
export function snapshotClient(client: ClientRecord, rate: RateRule, now: Date): ClientSnapshot {
  const { notes: _notes, templates: _templates, ...rest } = client;
  return {
    ...rest,
    customFields: client.customFields.map((f) => ({ ...f })),
    effectiveHourlyRateCents: rate.hourlyRateCents,
    capturedAt: now.toISOString(),
  };
}

const MIN_PART_LEN = 3;

/**
 * displayName / preferredName (full) plus their individual name parts of at
 * least 3 characters (parenthetical qualifiers excluded), as NAME terms for the PII scrubber. Case-insensitive dedupe.
 */
export function clientKnownTerms(client: ClientRecord | null): { value: string; type: "NAME" }[] {
  if (!client) return [];
  const out: { value: string; type: "NAME" }[] = [];
  const seen = new Set<string>();
  const add = (v: string) => {
    const t = v.trim();
    if (!t) return;
    const k = t.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ value: t, type: "NAME" });
  };
  for (const name of [client.displayName, client.preferredName]) {
    if (!name || !name.trim()) continue;
    add(name);
    // Parenthetical qualifiers like "(synthetic)" are not name parts.
    for (const part of name.replace(/\([^)]*\)/g, " ").split(/[^\p{L}\p{M}'’-]+/u)) {
      const p = part.replace(/^['’-]+|['’-]+$/g, "");
      if (p.length >= MIN_PART_LEN) add(p);
    }
  }
  return out;
}
