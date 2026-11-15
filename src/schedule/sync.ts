/**
 * Calendar → Appointments sync. For each calendar event in [from, to):
 *   - Drive context for the client → ServiceConfig (plan goals from the service plan doc,
 *     rules requiring the SDP invoice minimums, hourly rate from the authorization doc);
 *   - Appointment `appt_cal_<eventId>` (occurrenceId = eventId), cancelled → canceled=true;
 *   - client inserted from Drive if missing (insert-only: provider edits are never overwritten).
 * Idempotent: ids and config versions are deterministic, and every write is an upsert.
 * Versions are content-addressed (goal hash, rate cents), so a changed Drive document yields
 * a NEW config version instead of mutating one an existing draft may have frozen.
 */
import type { Appointment, CalendarEvent, CalendarSource, ClientInput, DriveClientContext, DriveSource, RequiredField, ServiceConfig } from "../contracts";
import type { Repository } from "../db/repository";
import { parseParticipantName } from "./drive-parse";
import { slugRef } from "./demo-calendar";
import { DemoDriveSource } from "./demo-drive";

/** SDP codes used by the demo (DDS "SDP Service Codes by Budget Category" [S1]). */
export const SDP_SERVICE_LABELS: Record<string, string> = {
  "CA-SDP-320": "Community Living Supports (Individual and Agency)",
  "CA-SDP-331": "Community Integration Supports",
  "CA-SDP-334": "Individual Training and Education",
  "CA-SDP-335": "Employment Supports",
};

/**
 * DDS minimums for an hourly SDP provider invoice (docs/research/self-determination-codes.md
 * §1.6 [S4]) mapped onto the rules engine's required fields: date of service → service_date;
 * description of the service/task → service_description (+ goal_addressed / progress_statement
 * against the plan); time spent → confirmed_duration; rate, SDP code and total come from the
 * ServiceConfig itself; provider + participant identity → provider_identity / client_reference.
 */
export const SDP_INVOICE_REQUIRED: readonly RequiredField[] = [
  "service_date",
  "provider_identity",
  "client_reference",
  "service_description",
  "goal_addressed",
  "progress_statement",
  "confirmed_duration",
];

const MAX_SYNC_DAYS = 62;
const MAX_ID = 128;

export interface SyncSkip {
  eventId: string;
  clientRef: string;
  reason: "no_drive_context" | "no_authorization" | "service_code_mismatch";
}

export interface SyncResult {
  events: number;
  appointmentsUpserted: number;
  canceled: number;
  configsUpserted: number;
  clientsInserted: number;
  skipped: SyncSkip[];
  /** Appointment ids written, in event order. */
  appointmentIds: string[];
}

export interface SyncOptions {
  /** Drive used for plan/rate context. Required for a non-demo calendar. */
  drive?: DriveSource;
  now?: Date;
}

/** FNV-1a 32-bit, hex. Deterministic content tag for config versions. */
export function shortHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

export function appointmentIdForEvent(eventId: string): string {
  const id = `appt_cal_${eventId}`;
  return id.length <= MAX_ID ? id : `appt_cal_h${shortHash(eventId)}_${slug(eventId).slice(0, 40)}`;
}

/** ServiceConfig derived from Drive context. Null without a parsed authorization. */
export function serviceConfigFromDrive(ctx: DriveClientContext): ServiceConfig | null {
  const auth = ctx.authorization;
  if (!auth) return null;
  const code = ctx.serviceCode;
  return {
    plan: {
      planVersion: `plan_drive_${slugRef(ctx.clientRef)}_${shortHash(JSON.stringify([code, ctx.goals]))}`,
      serviceCode: code,
      serviceDescription: SDP_SERVICE_LABELS[code] ? `${SDP_SERVICE_LABELS[code]} (SDP ${code.replace(/^CA-SDP-/, "")})` : code,
      goals: ctx.goals,
    },
    rules: {
      ruleVersion: `rules_drive_${slug(code)}_v1`,
      serviceCode: code,
      required: [...SDP_INVOICE_REQUIRED],
      allowProviderProgressAttestation: true,
    },
    rate: {
      rateVersion: `rate_drive_${slug(auth.number).slice(0, 60)}_${auth.hourlyRateCents}`,
      currency: "USD",
      hourlyRateCents: auth.hourlyRateCents,
      maxMinutes: 8 * 60,
    },
  };
}

/** Client record built from Drive documents (used insert-only). */
export function clientInputFromDrive(ctx: DriveClientContext, opts: { synthetic: boolean }): ClientInput {
  const plan = ctx.documents.find((d) => d.kind === "service_plan");
  let name = (plan && parseParticipantName(plan.text)) || ctx.clientRef;
  // Demo Drive participants are fictional (fixtures/schedule); names are kept as written.
  const auth = ctx.authorization;
  return {
    clientRef: ctx.clientRef,
    displayName: name,
    preferredName: null,
    hourlyRateCents: null, // the authorization rate lives in the ServiceConfig
    fundingSource: auth?.fundingSource ?? null,
    authorizationNumber: auth?.number.slice(0, 80) ?? null,
    fiscalIntermediary: null,
    authorizedHours: auth?.authorizedMinutesPerMonth != null ? Math.round((auth.authorizedMinutesPerMonth / 60) * 100) / 100 : null,
    caseManager: null,
    customFields: [{ label: "Service code", value: ctx.serviceCode }],
    templates: { session_note: null, invoice: null, approval_record: null },
    notes: opts.synthetic ? "Imported from the demo Drive folder (fictional participant)." : "Imported from Drive.",
    active: true,
  };
}

function appointmentFor(e: CalendarEvent, cfg: ServiceConfig): Appointment {
  return {
    id: appointmentIdForEvent(e.eventId),
    occurrenceId: e.eventId,
    providerId: e.providerId,
    clientRef: e.clientRef,
    startAt: e.startAt,
    endAt: e.endAt,
    timezone: e.timezone,
    serviceCode: e.serviceCode,
    planVersion: cfg.plan.planVersion,
    ruleVersion: cfg.rules.ruleVersion,
    rateVersion: cfg.rate.rateVersion,
    canceled: e.status === "cancelled",
  };
}

export async function syncCalendarToAppointments(
  repo: Repository,
  calendar: CalendarSource,
  providerId: string,
  from: Date,
  to: Date,
  opts: SyncOptions = {},
): Promise<SyncResult> {
  if (!(to.getTime() > from.getTime())) throw new RangeError("sync range is empty");
  if (to.getTime() - from.getTime() > MAX_SYNC_DAYS * 86_400_000) throw new RangeError(`sync range exceeds ${MAX_SYNC_DAYS} days`);
  let drive = opts.drive;
  if (!drive) {
    if (calendar.kind !== "demo") throw new Error("syncCalendarToAppointments: a DriveSource is required for a non-demo calendar");
    drive = new DemoDriveSource();
  }
  const now = opts.now ?? new Date();
  const events = (await calendar.listEvents(providerId, from, to)).filter((e) => e.providerId === providerId);

  const result: SyncResult = { events: events.length, appointmentsUpserted: 0, canceled: 0, configsUpserted: 0, clientsInserted: 0, skipped: [], appointmentIds: [] };
  const contexts = new Map<string, DriveClientContext | null>();
  const configs = new Map<string, ServiceConfig>();

  for (const e of events) {
    if (!contexts.has(e.clientRef)) contexts.set(e.clientRef, await drive.getClientContext(providerId, e.clientRef));
    const ctx = contexts.get(e.clientRef) ?? null;
    if (!ctx) {
      result.skipped.push({ eventId: e.eventId, clientRef: e.clientRef, reason: "no_drive_context" });
      continue;
    }
    if (ctx.serviceCode !== e.serviceCode) {
      result.skipped.push({ eventId: e.eventId, clientRef: e.clientRef, reason: "service_code_mismatch" });
      continue;
    }
    let cfg = configs.get(e.clientRef);
    if (!cfg) {
      const built = serviceConfigFromDrive(ctx);
      if (!built) {
        result.skipped.push({ eventId: e.eventId, clientRef: e.clientRef, reason: "no_authorization" });
        continue;
      }
      cfg = built;
      await repo.upsertServiceConfig(cfg.plan.serviceCode, cfg);
      configs.set(e.clientRef, cfg);
      result.configsUpserted++;
      const existing = await repo.getClient(providerId, e.clientRef);
      if (!existing) {
        await repo.upsertClient(providerId, clientInputFromDrive(ctx, { synthetic: drive.kind === "demo" }), now);
        result.clientsInserted++;
      }
    }
    const appt = appointmentFor(e, cfg);
    await repo.upsertAppointment(appt);
    result.appointmentsUpserted++;
    if (appt.canceled) result.canceled++;
    result.appointmentIds.push(appt.id);
  }
  return result;
}
