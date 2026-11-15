import type { DocumentLine } from "../../../contracts";

/** Format an instant in the given IANA timezone. Display only. */
export function formatInstant(iso: string | null | undefined, timeZone: string, withDate = true): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  try {
    return new Intl.DateTimeFormat(undefined, {
      timeZone,
      ...(withDate ? { year: "numeric", month: "short", day: "numeric" } : {}),
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    }).format(d);
  } catch {
    return d.toISOString();
  }
}

/** Formats server-provided integer cents. Never used to compute amounts. */
export function formatCents(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

export function originLabel(origin: DocumentLine["origin"]): { label: string; cls: string } {
  switch (origin) {
    case "provider_attestation":
      return { label: "Provider-confirmed (not evidence)", cls: "rv-tag-provider" };
    case "extracted":
      return { label: "From evidence", cls: "rv-tag-evidence" };
    case "system_notice":
      return { label: "System notice", cls: "rv-tag-system" };
    default:
      return { label: "Configuration", cls: "rv-tag-config" };
  }
}

export function coverageLabel(status: "addressed" | "partially_addressed" | "unknown"): string {
  return status === "addressed" ? "Addressed" : status === "partially_addressed" ? "Partially addressed" : "Unknown";
}
