/**
 * Business profile service (v5): loading the provider's profile, the review-time approval gate,
 * and invoice-number assignment. Best-effort reads never fail a request: an unreadable profile
 * is treated as missing (which blocks approval — fail closed).
 */
import type { InvoiceNumberRecord, ProviderProfile, SessionBundle } from "../../contracts";
import type { Repository } from "../../db/repository";
import { applyBusinessProfileGate } from "../../domain/rules/profile-gate";
import { log } from "../../security/index";

export async function loadProviderProfile(repo: Repository, providerId: string): Promise<ProviderProfile | null> {
  try {
    return (await repo.getProviderProfile?.(providerId)) ?? null;
  } catch (err) {
    log("warn", "profile.read_failed", { providerId, error: err instanceof Error ? err.name : "unknown" });
    return null;
  }
}

/** Applies the business-profile gate to a bundle that is still under review (drafts only). */
export async function gateReviewBundle(repo: Repository, providerId: string, bundle: SessionBundle | null, reviewable: boolean): Promise<SessionBundle | null> {
  if (!bundle || !reviewable) return bundle;
  return applyBusinessProfileGate(bundle, await loadProviderProfile(repo, providerId));
}

/** Assigns (or returns) the revision's sequential invoice number. Never throws; null on failure. */
export async function assignInvoiceNumber(
  repo: Repository,
  providerId: string,
  sessionId: string,
  bundleRevision: number,
  now: Date,
): Promise<InvoiceNumberRecord | null> {
  try {
    return (await repo.ensureInvoiceNumber?.(providerId, sessionId, bundleRevision, now)) ?? null;
  } catch (err) {
    log("warn", "invoice_number.assign_failed", { sessionId, bundleRevision, error: err instanceof Error ? err.name : "unknown" });
    return null;
  }
}
