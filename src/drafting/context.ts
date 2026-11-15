/**
 * Drafting inputs: transcript evidence (already matched to the session window) + the client's
 * Drive context (goals, authorization, previous notes). Drive documents are CONTEXT: goals and the
 * authorization configure the session; previous notes may inform wording but are never evidence
 * and can never be cited. Pure helpers, plus one loader that calls injected resolvers.
 */
import {
  DriveClientContext,
  SessionContextSnapshot,
  type Appointment,
  type ExtractionContext,
  type Plan,
  type ServiceConfig,
} from "../contracts";

/** ExtractionContext plus the optional Drive context (live prompt + demo drafter read it). */
export type DraftingExtractionContext = ExtractionContext & { driveContext?: DriveClientContext | null };

/** What the calendar event / recording know about the visit (EVV + consent + usage). All optional. */
export interface VisitContext {
  location?: string | null;
  workerId?: string | null;
  consent?: { recordedAt: string; method: string; confirmedBy?: string | null } | null;
  recordingSpan?: { from: string; to: string } | null;
  minutesUsedThisMonth?: number | null;
  /** From the recording side's conversation-type check (src/recordings/visit-context.ts). */
  conversationType?: "client_session" | "colleague_meeting" | "guardian_or_family" | "phone_call" | "personal" | "unclear" | null;
  conversationConfidence?: number | null;
  conversationLabel?: string | null;
  conversationNeedsConfirmation?: boolean | null;
  conversationDecision?: "client_session" | "dismissed" | null;
}

export interface DraftingResolvers {
  resolveDriveContext?: (appointment: Appointment) => Promise<DriveClientContext | null>;
  resolveVisitContext?: (appointment: Appointment) => Promise<VisitContext | null>;
}

export interface LoadedDraftingContext {
  drive: DriveClientContext | null;
  visit: VisitContext | null;
  warnings: string[];
}

/** Calls the resolvers; failures never fail the draft (they become warnings, ids/codes only). */
export async function loadDraftingContext(appointment: Appointment, r: DraftingResolvers): Promise<LoadedDraftingContext> {
  const warnings: string[] = [];
  let drive: DriveClientContext | null = null;
  if (r.resolveDriveContext) {
    try {
      const raw = await r.resolveDriveContext(appointment);
      if (raw) {
        const parsed = DriveClientContext.safeParse(raw);
        if (parsed.success && parsed.data.clientRef === appointment.clientRef) drive = parsed.data;
        else warnings.push("Drive context ignored: it did not validate or names a different client.");
      }
    } catch {
      warnings.push("Drive context unavailable: drafted without the client's Drive documents.");
    }
  }
  let visit: VisitContext | null = null;
  if (r.resolveVisitContext) {
    try {
      visit = await r.resolveVisitContext(appointment);
    } catch {
      warnings.push("Visit context (location / consent / recording span) unavailable.");
    }
  }
  return { drive, visit, warnings };
}

/** Drive goals (parsed from the service plan doc) replace the configured goals when present. */
export function planForSession(plan: Plan, drive: DriveClientContext | null): Plan {
  if (!drive || drive.goals.length === 0) return plan;
  return { ...plan, goals: drive.goals.slice(0, 20).map((g) => ({ goalId: g.goalId, objective: g.objective })) };
}

/** "CA-SDP-320" / "320" / "SDP 320" → "320"; anything else → null. */
export function sdpCodeOf(serviceCode: string | null | undefined): string | null {
  if (!serviceCode) return null;
  const m = /(?:^|[^0-9])(3\d{2})$/.exec(serviceCode.trim()) ?? /^(3\d{2})$/.exec(serviceCode.trim());
  return m ? m[1]! : null;
}

function usedAs(kind: DriveClientContext["documents"][number]["kind"]): "goals" | "authorization" | "context_only" {
  return kind === "service_plan" ? "goals" : kind === "authorization" ? "authorization" : "context_only";
}

/**
 * Freezes the Drive/visit context into the service config: plan goals from Drive, rate from the
 * Drive authorization (it outranks a client or service-config rate), and a context snapshot.
 * Document text is never copied into the snapshot.
 */
export function applyDraftingContext(
  config: ServiceConfig,
  appointment: Appointment,
  loaded: LoadedDraftingContext,
): ServiceConfig {
  const { drive, visit } = loaded;
  const warnings = [...loaded.warnings];
  const plan = planForSession(config.plan, drive);
  let rate = config.rate;
  let rateSource: SessionContextSnapshot["rateSource"] = config.rate.rateVersion.startsWith("client:") ? "client" : "service_config";
  const auth = drive?.authorization ?? null;
  if (auth && auth.hourlyRateCents > 0) {
    rate = { ...config.rate, hourlyRateCents: auth.hourlyRateCents, rateVersion: `auth:${auth.number}`.slice(0, 128) };
    rateSource = "drive_authorization";
  } else if (drive && !auth) {
    warnings.push("No authorization document in Drive: rate comes from the service configuration.");
  }
  if (drive && drive.serviceCode !== appointment.serviceCode && sdpCodeOf(drive.serviceCode) !== sdpCodeOf(appointment.serviceCode)) {
    warnings.push(`Service code differs: calendar ${appointment.serviceCode}, Drive ${drive.serviceCode}. Drive was used.`);
  }
  const consent = visit?.consent
    ? { recordedAt: visit.consent.recordedAt, method: visit.consent.method, confirmedBy: visit.consent.confirmedBy ?? null }
    : null;
  const snapshot = SessionContextSnapshot.parse({
    drive: drive
      ? {
          clientRef: drive.clientRef,
          folder: drive.folder,
          serviceCode: drive.serviceCode,
          authorization: auth,
          goalIds: drive.goals.map((g) => g.goalId).slice(0, 20),
          documents: drive.documents.map((d) => ({ id: d.id, name: d.name, kind: d.kind, modifiedAt: d.modifiedAt, usedAs: usedAs(d.kind) })),
        }
      : null,
    location: visit?.location?.trim() ? visit.location.trim().slice(0, 200) : null,
    workerId: visit?.workerId?.trim() ? visit.workerId.trim() : appointment.providerId,
    consent,
    recordingSpan: visit?.recordingSpan ?? null,
    minutesUsedThisMonth:
      typeof visit?.minutesUsedThisMonth === "number" && Number.isInteger(visit.minutesUsedThisMonth) && visit.minutesUsedThisMonth >= 0
        ? visit.minutesUsedThisMonth
        : null,
    rateSource,
    serviceCodeSource: drive ? "drive" : "calendar",
    warnings: warnings.slice(0, 20),
    conversation: visit?.conversationType
      ? {
          type: visit.conversationType,
          label: (visit.conversationLabel ?? visit.conversationType).slice(0, 60),
          confidence: Math.max(0, Math.min(1, visit.conversationConfidence ?? 0)),
          needsConfirmation: visit.conversationNeedsConfirmation === true,
          decision: visit.conversationDecision ?? null,
        }
      : null,
  });
  return { ...config, plan, rate, context: snapshot };
}

/** Previous notes / assessments: context the live prompt may read (never cite). */
export function contextDocuments(drive: DriveClientContext | null | undefined, limit = 3): DriveClientContext["documents"] {
  if (!drive) return [];
  return drive.documents
    .filter((d) => d.kind === "previous_note" || d.kind === "assessment")
    .sort((a, b) => (a.modifiedAt < b.modifiedAt ? 1 : -1))
    .slice(0, limit);
}
