import { z } from "zod";
import {
  EvidenceItem,
  EvidenceUnavailableError,
  systemClock,
  type Appointment,
  type Clock,
  type EvidenceResult,
  type EvidenceSource,
} from "../../contracts";
import { localDaysForWindow } from "./time";
import { evidenceWindow, itemInWindow } from "./window";

/** Minimal MCP client seam. The real client (separate MCP server) is injected. */
export interface VexoMcpClient {
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
}

/**
 * UNVERIFIED: the tool name, argument names and response field names below are
 * assumptions. They MUST be confirmed against the live Vexo MCP tool schema
 * (tools/list -> inputSchema) before live mode is relied upon. Response field
 * lists are tried in order; the first present field wins.
 */
export const VEXO_TOOL_CONFIG = {
  toolName: "get_transcripts",
  args: {
    date: "date", // local YYYY-MM-DD
    timezone: "timezone", // IANA tz
    from: "start_time", // ISO instant, inclusive
    to: "end_time", // ISO instant, inclusive
    pageSize: "limit",
    cursor: "cursor",
  },
  response: {
    items: ["segments", "items", "transcripts", "utterances", "results", "data"],
    nextCursor: ["next_cursor", "nextCursor", "cursor_next", "next"],
    unavailableSources: ["unavailable_sources", "unavailableSources"],
  },
  item: {
    id: ["id", "segment_id", "utterance_id", "segmentId", "utteranceId"],
    sourceId: ["transcript_id", "recording_id", "source_id", "transcriptId", "recordingId", "sourceId"],
    start: ["start_time", "startTime", "start", "started_at", "timestamp"],
    end: ["end_time", "endTime", "end", "ended_at"],
    speaker: ["speaker", "speaker_name", "speakerName", "speaker_label"],
    text: ["text", "content", "transcript", "excerpt"],
    url: ["url", "citation_url", "permalink"],
  },
  pageSize: 100,
  maxPagesPerDay: 10,
  maxItems: 500,
  maxRetries: 3,
  baseBackoffMs: 500,
  maxBackoffMs: 30_000,
} as const;

export interface LiveEvidenceOptions {
  clock?: Clock;
  sleep?: (ms: number) => Promise<void>;
  config?: Partial<Pick<typeof VEXO_TOOL_CONFIG, "pageSize" | "maxPagesPerDay" | "maxRetries" | "baseBackoffMs">>;
}

// ------------------------------------------------------------- normalization
const Rec = z.record(z.unknown());
/** MCP CallToolResult envelope (content blocks / structuredContent / isError). */
const McpEnvelope = z
  .object({
    isError: z.boolean().optional(),
    structuredContent: z.unknown().optional(),
    content: z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough()).optional(),
  })
  .passthrough();

function pick(obj: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const k of keys) if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  return undefined;
}

function str(v: unknown, max: number): string | null {
  if (typeof v === "number" && Number.isFinite(v)) v = String(v);
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length === 0 ? null : t.slice(0, max);
}

/** Accept only ISO-8601 instants with an explicit offset; never guess units or zones. */
function instant(v: unknown): string | null {
  if (typeof v !== "string") return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(v.trim())) return null;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function url(v: unknown): string | undefined {
  const s = str(v, 2000);
  if (!s) return undefined;
  try {
    const u = new URL(s);
    return u.protocol === "https:" || u.protocol === "http:" ? s : undefined;
  } catch {
    return undefined;
  }
}

interface ParsedPage {
  rawItems: unknown[];
  nextCursor: string | null;
  unavailableSources: string[];
}

function unwrap(raw: unknown): unknown {
  const env = McpEnvelope.safeParse(raw);
  if (!env.success || (env.data.content === undefined && env.data.structuredContent === undefined && env.data.isError === undefined)) {
    return raw;
  }
  if (env.data.isError) {
    const msg = env.data.content?.map((c) => c.text ?? "").join(" ").trim() || "tool reported an error";
    throw classifyToolMessage(msg);
  }
  if (env.data.structuredContent !== undefined) return env.data.structuredContent;
  const text = env.data.content?.find((c) => c.type === "text" && c.text)?.text;
  if (text === undefined) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new EvidenceUnavailableError("Vexo tool returned non-JSON text content", "tool", false);
  }
}

export function parsePage(raw: unknown): ParsedPage {
  const body = unwrap(raw);
  if (Array.isArray(body)) return { rawItems: body, nextCursor: null, unavailableSources: [] };
  const rec = Rec.safeParse(body);
  if (!rec.success) throw new EvidenceUnavailableError("Vexo tool returned an unrecognized response shape", "tool", false);
  const items = pick(rec.data, VEXO_TOOL_CONFIG.response.items);
  if (items !== undefined && !Array.isArray(items)) {
    throw new EvidenceUnavailableError("Vexo tool response items field is not an array", "tool", false);
  }
  const unavailable = pick(rec.data, VEXO_TOOL_CONFIG.response.unavailableSources);
  return {
    rawItems: (items as unknown[] | undefined) ?? [],
    nextCursor: str(pick(rec.data, VEXO_TOOL_CONFIG.response.nextCursor), 2000),
    unavailableSources: Array.isArray(unavailable)
      ? unavailable.map((u) => str(u, 128)).filter((u): u is string => u !== null)
      : [],
  };
}

/** Normalize one upstream item; returns null when it has no text. Missing metadata stays null. */
export function normalizeItem(raw: unknown, retrievedAt: string, fallbackIndex: string): EvidenceItem | null {
  const rec = Rec.safeParse(raw);
  if (!rec.success) return null;
  const f = VEXO_TOOL_CONFIG.item;
  const excerpt = str(pick(rec.data, f.text), 4000);
  if (!excerpt) return null;
  const sourceId = str(pick(rec.data, f.sourceId), 128);
  const upstreamId = str(pick(rec.data, f.id), 128);
  // Item id is required by the contract; when upstream gives none we derive a
  // local reference (it is NOT an upstream id — sourceId stays as supplied).
  const id = (upstreamId ?? `vexo_local_${fallbackIndex}`).slice(0, 128);
  const candidate = {
    id,
    sourceId,
    sourceMode: "live" as const,
    observedFrom: instant(pick(rec.data, f.start)),
    observedTo: instant(pick(rec.data, f.end)),
    speaker: str(pick(rec.data, f.speaker), 64),
    excerpt,
    retrievedAt,
    ...(url(pick(rec.data, f.url)) ? { citationUrl: url(pick(rec.data, f.url)) } : {}),
  };
  const parsed = EvidenceItem.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

// ------------------------------------------------------------- errors
class RateLimited extends Error {
  constructor(
    message: string,
    readonly retryAfterMs: number | null,
  ) {
    super(message);
  }
}

function classifyToolMessage(msg: string): Error {
  if (/rate.?limit|too many requests|\b429\b/i.test(msg)) return new RateLimited(msg, null);
  if (/unauthori[sz]ed|forbidden|\b40[13]\b|invalid.?token|expired.?token|\bauth(entication|orization)?\b/i.test(msg)) {
    return new EvidenceUnavailableError(`Vexo authorization failed: ${msg.slice(0, 200)}`, "auth", false);
  }
  return new EvidenceUnavailableError(`Vexo tool error: ${msg.slice(0, 200)}`, "tool", false);
}

function retryAfterFrom(err: Record<string, unknown>): number | null {
  const ms = err.retryAfterMs;
  if (typeof ms === "number" && ms >= 0) return ms;
  const s = err.retryAfter ?? err.retry_after;
  if (typeof s === "number" && s >= 0) return s * 1000;
  if (typeof s === "string" && /^\d+(\.\d+)?$/.test(s)) return Number(s) * 1000;
  return null;
}

/** Map a thrown client error into RateLimited or EvidenceUnavailableError. */
function classifyThrown(e: unknown): Error {
  if (e instanceof EvidenceUnavailableError || e instanceof RateLimited) return e;
  const rec = (typeof e === "object" && e !== null ? e : {}) as Record<string, unknown>;
  const status = Number(rec.status ?? rec.statusCode ?? rec.code);
  const msg = e instanceof Error ? e.message : String(e);
  if (status === 429 || /rate.?limit|too many requests/i.test(msg)) return new RateLimited(msg, retryAfterFrom(rec));
  if (status === 401 || status === 403 || /unauthori[sz]ed|forbidden|invalid.?token|expired.?token/i.test(msg)) {
    return new EvidenceUnavailableError(`Vexo authorization failed: ${msg.slice(0, 200)}`, "auth", false);
  }
  return new EvidenceUnavailableError(`Vexo transport error: ${msg.slice(0, 200)}`, "transport", true);
}

// ------------------------------------------------------------- source
export class LiveEvidenceSource implements EvidenceSource {
  readonly mode = "live" as const;
  private readonly clock: Clock;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly cfg: { pageSize: number; maxPagesPerDay: number; maxRetries: number; baseBackoffMs: number };

  constructor(
    private readonly client: VexoMcpClient,
    opts: LiveEvidenceOptions = {},
  ) {
    this.clock = opts.clock ?? systemClock;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.cfg = {
      pageSize: opts.config?.pageSize ?? VEXO_TOOL_CONFIG.pageSize,
      maxPagesPerDay: opts.config?.maxPagesPerDay ?? VEXO_TOOL_CONFIG.maxPagesPerDay,
      maxRetries: Math.min(opts.config?.maxRetries ?? VEXO_TOOL_CONFIG.maxRetries, 3),
      baseBackoffMs: opts.config?.baseBackoffMs ?? VEXO_TOOL_CONFIG.baseBackoffMs,
    };
  }

  private async callWithRetry(args: Record<string, unknown>): Promise<ParsedPage> {
    for (let attempt = 0; ; attempt++) {
      try {
        const raw = await this.client.callTool(VEXO_TOOL_CONFIG.toolName, args);
        return parsePage(raw);
      } catch (e) {
        const err = classifyThrown(e);
        if (!(err instanceof RateLimited)) throw err;
        if (attempt >= this.cfg.maxRetries) {
          throw new EvidenceUnavailableError("Vexo rate limit persisted after retries", "rate_limited", true);
        }
        const backoff = err.retryAfterMs ?? this.cfg.baseBackoffMs * 2 ** attempt;
        await this.sleep(Math.min(backoff, VEXO_TOOL_CONFIG.maxBackoffMs));
      }
    }
  }

  async retrieveEvidence(appointment: Appointment): Promise<EvidenceResult> {
    const retrievedAt = this.clock.now().toISOString();
    const w = evidenceWindow(appointment);
    const days = localDaysForWindow(w.fromMs, w.toMs, appointment.timezone);
    const a = VEXO_TOOL_CONFIG.args;
    const items: EvidenceItem[] = [];
    const seen = new Set<string>();
    const unavailable = new Set<string>();
    const warnings: string[] = [];
    let partial = false;
    let dropped = 0;
    let untimed = 0;

    for (const day of days) {
      let cursor: string | null = null;
      let pages = 0;
      do {
        if (pages >= this.cfg.maxPagesPerDay) {
          partial = true;
          warnings.push(`Page limit (${this.cfg.maxPagesPerDay}) reached for ${day.date}; evidence may be incomplete.`);
          break;
        }
        const args: Record<string, unknown> = {
          [a.date]: day.date,
          [a.timezone]: appointment.timezone,
          [a.from]: new Date(day.fromMs).toISOString(),
          [a.to]: new Date(day.toMs).toISOString(),
          [a.pageSize]: this.cfg.pageSize,
        };
        if (cursor) args[a.cursor] = cursor;
        const page = await this.callWithRetry(args);
        pages++;
        page.unavailableSources.forEach((s) => unavailable.add(s));
        page.rawItems.forEach((raw, idx) => {
          const item = normalizeItem(raw, retrievedAt, `${day.date}_${pages}_${idx}`);
          if (!item) {
            dropped++;
            return;
          }
          if (!item.observedFrom && !item.observedTo) {
            untimed++;
            return;
          }
          // Keep only the filtered window; discard the rest of the day's text immediately.
          if (!itemInWindow(item, w) || seen.has(item.id)) return;
          seen.add(item.id);
          items.push(item);
        });
        const next: string | null = page.nextCursor;
        if (next !== null && next === cursor) break; // defensive: non-advancing cursor
        cursor = next;
      } while (cursor);
    }

    if (items.length > VEXO_TOOL_CONFIG.maxItems) {
      items.length = VEXO_TOOL_CONFIG.maxItems;
      partial = true;
      warnings.push(`Evidence truncated to ${VEXO_TOOL_CONFIG.maxItems} items.`);
    }
    if (unavailable.size > 0) {
      partial = true;
      warnings.push(`${unavailable.size} upstream source(s) unavailable.`);
    }
    if (dropped > 0) warnings.push(`${dropped} upstream item(s) without usable text were dropped.`);
    if (untimed > 0) warnings.push(`${untimed} upstream item(s) without timestamps could not be placed in the window.`);
    items.sort((x, y) => (x.observedFrom ?? x.observedTo ?? "").localeCompare(y.observedFrom ?? y.observedTo ?? ""));

    return {
      items,
      completeness: partial ? "partial" : "complete",
      unavailableSourceIds: [...unavailable],
      warnings,
    };
  }
}
