/**
 * Business-profile gate (v5). Pure. The business profile (vendor #, address, …) lives outside the
 * frozen bundle, so this gate is applied when a bundle is READ for review and again at approval:
 * an incomplete profile adds one blocking documentation issue + checklist item and sets
 * canApprove = false. The stored bundle is never changed.
 */
import { missingProfileFields, type ProviderProfileInput } from "../../contracts/v3";
import type { ChecklistItem, DocumentationIssue, SessionBundle } from "../../contracts/schemas";

export const BUSINESS_PROFILE_ISSUE = "BUSINESS_PROFILE_INCOMPLETE";
export const BUSINESS_PROFILE_ITEM_ID = "invoice_business_profile";
export const BUSINESS_PROFILE_MESSAGE = "Complete your business profile (vendor #, address) before approving";

export function businessProfileIssue(missing: string[]): DocumentationIssue {
  return { code: BUSINESS_PROFILE_ISSUE, field: "business_profile", message: `${BUSINESS_PROFILE_MESSAGE} (missing: ${missing.join(", ")}).`, blocking: true };
}

/** Returns the bundle unchanged when the profile is complete; otherwise a copy with the blocker added. */
export function applyBusinessProfileGate(bundle: SessionBundle, profile: ProviderProfileInput | null | undefined): SessionBundle {
  const missing = missingProfileFields(profile);
  if (missing.length === 0) return bundle;
  const checks = bundle.checks;
  if (checks.issues.some((i) => i.code === BUSINESS_PROFILE_ISSUE)) return bundle;
  const item: ChecklistItem = {
    id: BUSINESS_PROFILE_ITEM_ID,
    group: "invoice_minimums",
    label: BUSINESS_PROFILE_MESSAGE,
    status: "fail",
    value: null,
    detail: `Missing: ${missing.join(", ")}. Add them in Settings → Business profile; they print on every invoice.`,
    source: "configuration",
    blocksApproval: true,
  };
  const checklist = checks.checklist
    ? {
        ...checks.checklist,
        items: [item, ...checks.checklist.items],
        summary: { ...checks.checklist.summary, fail: checks.checklist.summary.fail + 1 },
      }
    : undefined;
  return {
    ...bundle,
    checks: {
      ...checks,
      issues: [businessProfileIssue(missing), ...checks.issues],
      canApprove: false,
      ...(checklist ? { checklist } : {}),
    },
  };
}
