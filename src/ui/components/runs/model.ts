/**
 * Run-history view model (W8). Types only from contracts — the stage list is
 * copied locally so zod is not bundled into the UI.
 */
import { useEffect, useRef, useState } from "react";
import type { RunDetail, RunEvent, RunStage, RunSummary } from "../../../contracts";

export type RunStatus = RunSummary["status"];
export type EventStatus = RunEvent["status"];

export const STAGE_LABELS: Record<RunStage, string> = {
  discovered: "Discovered",
  queued: "Queued",
  workflow_started: "Workflow",
  load: "Load",
  evidence: "Evidence",
  match: "Match",
  privacy: "Privacy",
  extraction: "AI extraction",
  assemble: "Assemble",
  draft_saved: "Draft",
  review_saved: "Review",
  approval_wait: "Awaiting approval",
  approved: "Approved",
  finalize: "Finalize",
  client_snapshot: "Client snapshot",
  files: "Files",
  delivery_drive: "Drive",
  delivery_email: "Email",
  completed: "Completed",
  failed: "Failed",
  amended: "Amended",
};

export function stageLabel(stage: string): string {
  return (STAGE_LABELS as Record<string, string>)[stage] ?? stage.replace(/_/g, " ");
}

export interface PipelineNode {
  key: string;
  label: string;
  stages: RunStage[];
}

export const PROCESSING_PIPELINE: PipelineNode[] = [
  { key: "discovered", label: "Discovered", stages: ["discovered"] },
  { key: "queued", label: "Queued", stages: ["queued"] },
  { key: "workflow", label: "Workflow", stages: ["workflow_started", "load"] },
  { key: "evidence", label: "Evidence", stages: ["evidence"] },
  { key: "match", label: "Match", stages: ["match"] },
  { key: "privacy", label: "Privacy", stages: ["privacy"] },
  { key: "extraction", label: "AI extraction", stages: ["extraction"] },
  { key: "assemble", label: "Assemble", stages: ["assemble"] },
  { key: "draft", label: "Draft", stages: ["draft_saved"] },
  { key: "review", label: "Review", stages: ["review_saved"] },
  { key: "approval", label: "Approval", stages: ["approval_wait", "approved"] },
  { key: "client_snapshot", label: "Client snapshot", stages: ["client_snapshot"] },
  { key: "finalize", label: "Finalize", stages: ["finalize"] },
  { key: "files", label: "Files", stages: ["files"] },
  { key: "delivery", label: "Drive / Email", stages: ["delivery_drive", "delivery_email"] },
  { key: "completed", label: "Completed", stages: ["completed"] },
];

export const DELIVERY_PIPELINE: PipelineNode[] = [
  { key: "files", label: "Files", stages: ["files"] },
  { key: "delivery", label: "Drive / Email", stages: ["delivery_drive", "delivery_email"] },
  { key: "completed", label: "Completed", stages: ["completed"] },
];

export type NodeState = "pending" | "done" | "passed" | "active" | "waiting" | "failed" | "skipped";

export interface NodeView extends PipelineNode {
  state: NodeState;
  /** Failure reason / last label for the node. */
  note: string | null;
  at: string | null;
}

function nodeIndexOf(nodes: PipelineNode[], stage: string): number {
  return nodes.findIndex((n) => (n.stages as string[]).includes(stage));
}

/** Derive the per-node state from a run's events (ordered or not). */
export function pipelineView(detail: Pick<RunDetail, "summary" | "events">): NodeView[] {
  const { summary } = detail;
  const nodes = summary.runKind === "delivery" ? DELIVERY_PIPELINE : PROCESSING_PIPELINE;
  const events = sortEvents(detail.events);
  const last = new Map<number, RunEvent>();
  let furthest = -1;
  let failedEvent: RunEvent | null = null;
  for (const e of events) {
    if (e.stage === "failed") {
      failedEvent = e;
      continue;
    }
    const i = nodeIndexOf(nodes, e.stage);
    if (i < 0) continue;
    last.set(i, e);
    if (i > furthest) furthest = i;
    if (e.status === "failed") failedEvent = e;
  }
  if (furthest < 0) furthest = nodeIndexOf(nodes, summary.currentStage);

  const views: NodeView[] = nodes.map((n, i) => {
    const e = last.get(i);
    let state: NodeState = "pending";
    if (e) {
      if (e.status === "failed") state = "failed";
      else if (e.status === "waiting") state = summary.status === "waiting" ? "waiting" : "done";
      else if (e.status === "started") state = summary.status === "running" && i === furthest ? "active" : "done";
      else if (e.status === "skipped") state = "skipped";
      else state = "done";
    } else if (i < furthest) state = "passed";
    return { ...n, state, note: e ? e.detail ?? e.label : null, at: e?.at ?? null };
  });

  if (summary.status === "failed" && !views.some((v) => v.state === "failed")) {
    const idx = Math.max(0, furthest >= 0 && views[furthest]?.state !== "done" ? furthest : Math.min(furthest + 1, views.length - 1));
    patch(views, idx, { state: "failed", note: failedEvent?.detail ?? failedEvent?.label ?? "Run failed", at: failedEvent?.at ?? null });
  } else if (summary.status === "failed" && failedEvent) {
    const idx = views.findIndex((v) => v.state === "failed");
    if (idx >= 0 && failedEvent.detail) patch(views, idx, { note: failedEvent.detail });
  }
  if (summary.status === "running" && !views.some((v) => v.state === "active")) {
    const next = views.findIndex((v, i) => i > furthest && v.state === "pending");
    if (next >= 0) patch(views, next, { state: "active" });
  }
  if (summary.status === "waiting" && !views.some((v) => v.state === "waiting")) {
    const i = nodeIndexOf(nodes, summary.currentStage);
    if (i >= 0) patch(views, i, { state: "waiting" });
  }
  if (summary.status === "succeeded") {
    const ci = views.findIndex((v) => v.key === "completed");
    if (views[ci]?.state === "pending") patch(views, ci, { state: "done" });
  }
  return views;
}

function patch(views: NodeView[], i: number, p: Partial<NodeView>): void {
  const v = views[i];
  if (v) views[i] = { ...v, ...p };
}

export function sortEvents(events: RunEvent[]): RunEvent[] {
  return [...events].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

export function isActive(s: { status: RunStatus }): boolean {
  return s.status === "running" || s.status === "waiting";
}

export const RUN_STATUS_LABELS: Record<RunStatus, string> = {
  running: "Running",
  waiting: "Waiting",
  succeeded: "Succeeded",
  failed: "Failed",
};

export function kindLabel(k: RunSummary["runKind"]): string {
  return k === "delivery" ? "Delivery" : "Processing";
}

// ------------------------------------------------------------------ time
export function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${String(m % 60).padStart(2, "0")}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function relativeTime(iso: string, now: number): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const d = Math.max(0, now - t);
  const s = Math.floor(d / 1000);
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function clockTime(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  return new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function absoluteTime(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  return new Date(t).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium" });
}

/** Elapsed ms for a run (ticking while active). */
export function runElapsed(s: RunSummary, now: number): number | null {
  if (s.durationMs !== null && !isActive(s)) return s.durationMs;
  const start = Date.parse(s.startedAt);
  if (!Number.isFinite(start)) return s.durationMs;
  const end = s.endedAt ? Date.parse(s.endedAt) : now;
  return Math.max(0, end - start);
}

/** Current time, re-rendering every `ms` while `enabled`. */
export function useNow(enabled: boolean, ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(id);
  }, [enabled, ms]);
  return now;
}

/**
 * Calls `fn` every `intervalMs` while `active`, paused while the tab is hidden,
 * bounded to `maxTicks` consecutive polls (reset when `active` toggles).
 */
export function usePoll(fn: () => Promise<unknown> | void, active: boolean, intervalMs = 3000, maxTicks = 200): void {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => {
    if (!active) return;
    let ticks = 0;
    let timer: number | undefined;
    let stopped = false;
    let inFlight = false;
    const schedule = () => {
      if (stopped || ticks >= maxTicks) return;
      timer = window.setTimeout(tick, intervalMs);
    };
    const tick = async () => {
      timer = undefined;
      if (stopped) return;
      if (document.visibilityState === "hidden") return; // resumes on visibilitychange
      if (inFlight) return schedule();
      ticks++;
      inFlight = true;
      try {
        await fnRef.current();
      } catch {
        /* transient — keep polling */
      } finally {
        inFlight = false;
      }
      schedule();
    };
    const onVis = () => {
      if (document.visibilityState === "visible" && timer === undefined && !inFlight && !stopped) void tick();
    };
    document.addEventListener("visibilitychange", onVis);
    schedule();
    return () => {
      stopped = true;
      if (timer !== undefined) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [active, intervalMs, maxTicks]);
}

export function runHref(runId: string): string {
  return `#/runs/${encodeURIComponent(runId)}`;
}

export function sessionHref(sessionId: string): string {
  return `#/sessions/${encodeURIComponent(sessionId)}`;
}

/** "privacyFindings" / "privacy_findings" → "Privacy findings". */
export function humanizeKey(k: string): string {
  const s = k
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_.-]+/g, " ")
    .trim()
    .toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}
