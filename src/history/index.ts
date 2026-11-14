/**
 * Run history recorder (W5). Turns stage transitions into RunEvents with
 * deterministic ids (retried steps INSERT OR IGNORE, never duplicate).
 *
 * Recording is best-effort: it NEVER throws and never fails the caller.
 * Events carry stages, statuses, counts, provider/model ids and reason codes
 * only — never transcript text, names, emails or tokens.
 */
import { RunEvent, type Clock, type RunRecorder } from "../contracts";
import type { Repository } from "../db/repository";
import { log } from "../security/index";

type RecordInput = Parameters<RunRecorder["record"]>[0];

const LABEL_MAX = 200;
const DETAIL_MAX = 500;
const META_STRING_MAX = 200;
const ID_MAX = 300;

function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

export function runEventId(runId: string, stage: string, status: string, idSuffix?: string): string {
  return clip(`${runId}:${stage}:${status}${idSuffix ? `:${idSuffix}` : ""}`, ID_MAX);
}

function cleanMeta(meta: RecordInput["meta"] | undefined): RunEvent["meta"] {
  const out: RunEvent["meta"] = {};
  for (const [k, v] of Object.entries(meta ?? {})) {
    if (typeof v === "string") out[k] = clip(v, META_STRING_MAX);
    else if (typeof v === "number") {
      if (Number.isFinite(v)) out[k] = v;
    } else if (typeof v === "boolean" || v === null) out[k] = v;
  }
  return out;
}

/** Builds a validated RunEvent (truncating label/detail). Throws on invalid input. */
export function buildRunEvent(input: RecordInput, now: Date): RunEvent {
  const { idSuffix, at, ...rest } = input;
  return RunEvent.parse({
    ...rest,
    id: runEventId(rest.runId, rest.stage, rest.status, idSuffix),
    label: clip(rest.label ?? "", LABEL_MAX),
    detail: rest.detail == null ? null : clip(rest.detail, DETAIL_MAX),
    meta: cleanMeta(rest.meta),
    at: at ?? now.toISOString(),
  });
}

export function createRunRecorder(repo: Pick<Repository, "appendRunEvent">, clock: Clock): RunRecorder {
  return {
    async record(input) {
      try {
        const event = buildRunEvent(input, clock.now());
        await repo.appendRunEvent(event);
      } catch (err) {
        // Ids + error class only (no message: it could echo input).
        log("warn", "history.record_failed", {
          runId: typeof input?.runId === "string" ? clip(input.runId, 200) : null,
          stage: typeof input?.stage === "string" ? input.stage : null,
          status: typeof input?.status === "string" ? input.status : null,
          error: err instanceof Error ? err.name : typeof err,
        });
      }
    },
  };
}

export const noopRecorder: RunRecorder = {
  async record() {
    /* no-op */
  },
};

/** Calls recorder.record without ever throwing (for callers given an arbitrary recorder). */
export async function safeRecord(recorder: RunRecorder | undefined, input: RecordInput): Promise<void> {
  if (!recorder) return;
  try {
    await recorder.record(input);
  } catch {
    /* recording never fails the caller */
  }
}
