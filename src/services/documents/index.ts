/**
 * v3 document service (W4): template resolution + DocModelInput loading.
 *
 * - Template precedence: explicit override → client's template for the kind →
 *   provider default → builtin. Ids that are missing, belong to another
 *   provider, or are for another kind fall through to the next level (ending
 *   at the builtin).
 * - Client data: a COMPLETED session always uses the frozen client snapshot
 *   (never the live client record). Drafts use the live client converted to a
 *   preview snapshot with the bundle's frozen rate.
 */
import {
  builtinTemplateId,
  type ClientRecord,
  type ClientSnapshot,
  type DocModelInput,
  type DocumentTemplate,
  type FileKind,
  type SessionRecord,
} from "../../contracts";
import type { Repository } from "../../db/repository";
import type { ApiDeps } from "../../api/deps";
import { BUILTIN_TEMPLATES } from "../../documents/index";
import { ServiceError } from "../approval/index";
import { assignInvoiceNumber, loadProviderProfile } from "../profile/index";

export type DocumentDeps = Pick<ApiDeps, "repo" | "clock">;

function isClientRecord(client: ClientRecord | ClientSnapshot | null): client is ClientRecord {
  return client !== null && "templates" in client && typeof (client as ClientRecord).templates === "object";
}

/** Returns the template for `id` if it is a builtin of `kind` or one of the provider's templates of `kind`. */
export async function findTemplate(
  repo: Repository,
  providerId: string,
  kind: FileKind,
  id: string | null | undefined,
): Promise<DocumentTemplate | null> {
  if (!id) return null;
  if (id === builtinTemplateId(kind)) return BUILTIN_TEMPLATES[kind];
  if (id.startsWith("builtin:")) return null;
  const t = await repo.getTemplate(providerId, id);
  return t && t.kind === kind ? t : null;
}

export async function resolveTemplate(
  repo: Repository,
  providerId: string,
  kind: FileKind,
  client: ClientRecord | ClientSnapshot | null,
  overrideId?: string | null,
): Promise<DocumentTemplate> {
  const candidates: (() => Promise<string | null | undefined>)[] = [
    async () => overrideId,
    async () => (isClientRecord(client) ? client.templates?.[kind] : null),
    () => repo.getDefaultTemplateId(providerId, kind),
  ];
  for (const next of candidates) {
    const t = await findTemplate(repo, providerId, kind, await next());
    if (t) return t;
  }
  return BUILTIN_TEMPLATES[kind];
}

/** Live client → snapshot shape for draft previews (rate = the bundle's frozen rate). */
export function previewSnapshot(client: ClientRecord, effectiveHourlyRateCents: number, now: Date): ClientSnapshot {
  const { notes: _notes, templates: _templates, ...rest } = client;
  return { ...rest, effectiveHourlyRateCents, capturedAt: now.toISOString() };
}

/** Builds the DocModelInput for an already-scoped session. */
export async function loadDocModelInputForSession(
  deps: DocumentDeps,
  session: SessionRecord,
  kind: FileKind,
  templateId?: string | null,
): Promise<DocModelInput> {
  const repo = deps.repo;
  const storedFinal = await repo.getFinalBundle(session.id);
  const completed = session.status === "COMPLETED" && storedFinal !== null;
  const final = completed ? storedFinal : null;
  const bundle = final?.bundle ?? (await repo.getCurrentBundle(session.id));
  if (!bundle) throw new ServiceError(409, "NO_BUNDLE", "This session has no document draft yet", true);

  const approvalRaw = await repo.getApprovalForSession(session.id);
  const approval = approvalRaw && approvalRaw.bundleRevision === bundle.bundleRevision ? approvalRaw : null;
  const providerIdentity = await repo.getProviderIdentity(session.providerId);
  const liveClient = await repo.getClient(session.providerId, bundle.appointment.clientRef);

  let client: ClientSnapshot | null;
  if (final) {
    client = (await repo.getClientSnapshot(session.id, final.bundleRevision)) ?? null;
  } else {
    client = liveClient ? previewSnapshot(liveClient, bundle.config.rate.hourlyRateCents, deps.clock.now()) : null;
  }
  // Template choice is display-only, so it follows the live client record.
  const template = await resolveTemplate(repo, session.providerId, kind, liveClient, templateId);

  // v5: invoice number + business profile. A final uses the profile frozen with its number
  // (assigned now if an older final has none); a draft uses the live profile and has no number.
  let invoiceNumber: string | null = null;
  let profile = null;
  if (final) {
    const rec =
      (await safe(() => repo.getInvoiceNumber(final.sessionId, final.bundleRevision))) ??
      (await assignInvoiceNumber(repo, session.providerId, final.sessionId, final.bundleRevision, deps.clock.now()));
    invoiceNumber = rec?.invoiceNumber ?? null;
    profile = rec?.profile ?? null;
  }
  if (!profile) profile = await loadProviderProfile(repo, session.providerId);
  const superseded = kind === "approval_record" ? ((await safe(() => repo.listSupersededRevisions(session.id))) ?? []) : [];
  return { bundle, final, approval, providerIdentity, client, template, profile, invoiceNumber, superseded };
}

async function safe<T>(fn: () => Promise<T> | undefined): Promise<T | null> {
  try {
    return (await fn()) ?? null;
  } catch {
    return null;
  }
}

export async function loadDocModelInput(
  deps: DocumentDeps,
  providerId: string,
  sessionId: string,
  kind: FileKind,
  templateId?: string | null,
): Promise<DocModelInput> {
  const session = await deps.repo.getSessionForProvider(providerId, sessionId);
  if (!session) throw new ServiceError(404, "NOT_FOUND", "Session not found", false);
  return loadDocModelInputForSession(deps, session, kind, templateId);
}
