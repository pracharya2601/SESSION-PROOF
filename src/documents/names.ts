/** Deterministic file names + display invoice numbers (no PII beyond clientRef). */
import type { FileKind } from "../contracts/v2";
import type { SessionBundle } from "../contracts/schemas";
import { fnv1a, ymdInTz } from "../artifacts/format";

const kebab = (kind: FileKind) => kind.replace(/_/g, "-");

export function sanitizeFileName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, "-").replace(/\.{2,}/g, ".").replace(/^[.-]+/, "").slice(0, 200);
}

/** `<clientRef>_<YYYY-MM-DD in appointment tz>_<kind>_r<rev>.pdf` */
export function fileNameForBundle(kind: FileKind, bundle: SessionBundle, revision = bundle.bundleRevision): string {
  const a = bundle.appointment;
  const date = ymdInTz(a.startAt, a.timezone);
  return sanitizeFileName(`${a.clientRef}_${date}_${kebab(kind)}_r${revision}.pdf`);
}

/** `<prefix>-<hash(sessionId)>-R<rev>`; empty prefix → `<hash>-R<rev>`. */
export function invoiceNumberFor(sessionId: string, revision: number, prefix = "INV"): string {
  const p = prefix.replace(/[^A-Za-z0-9-]/g, "");
  return `${p ? `${p}-` : ""}${fnv1a(sessionId)}-R${revision}`;
}
