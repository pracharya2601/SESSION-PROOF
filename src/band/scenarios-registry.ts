/**
 * Dev-only lookup for synthetic band scenarios (fixtures/band). Production code paths
 * never import the fixtures: src/index.ts registers a lookup only when
 * RUNTIME_MODE !== "deployed"; otherwise it stays null and scenarios do nothing.
 */
import type { SessionFacts } from "../contracts";
import type { ScenarioLine } from "../../fixtures/band/types";

export interface ScenarioEntry {
  script: ScenarioLine[];
  extraction: SessionFacts;
}

export type ScenarioLookup = (id: string) => ScenarioEntry | null;

let current: ScenarioLookup | null = null;

export function setScenarioLookup(lookup: ScenarioLookup | null): void {
  current = lookup;
}

export function getScenarioLookup(): ScenarioLookup | null {
  return current;
}

let pending: Promise<void> | null = null;

/**
 * Registers a lookup that has to be loaded first (src/index.ts dynamically imports the
 * fixtures). Idempotent: the first call wins. A loader that fails leaves the lookup null.
 */
export function loadScenarioLookup(loader: () => Promise<ScenarioLookup | null>): Promise<void> {
  pending ??= loader().then(
    (lookup) => {
      if (lookup) current = lookup;
    },
    () => undefined,
  );
  return pending;
}

/** Resolves once a pending loadScenarioLookup has settled (immediately when none). */
export function scenarioLookupReady(): Promise<void> {
  return pending ?? Promise.resolve();
}

// ------------------------------------------------------------------ day scripts (recordings, dev only)
/**
 * Synthetic "provider's day" scripts for client-less recordings (fixtures/schedule/day-scripts.ts),
 * played by the simulated transcriber when POST /api/device/recordings carries `scenario`.
 * Same lifecycle as the band lookup: src/index.ts registers it only when RUNTIME_MODE !== "deployed".
 */
export type DayScriptLookup = (id: string) => ScenarioLine[] | null;

let currentDay: DayScriptLookup | null = null;
let pendingDay: Promise<void> | null = null;

export function setDayScriptLookup(lookup: DayScriptLookup | null): void {
  currentDay = lookup;
}

export function getDayScriptLookup(): DayScriptLookup | null {
  return currentDay;
}

/** Idempotent: the first call wins. A loader that fails leaves the lookup null. */
export function loadDayScriptLookup(loader: () => Promise<DayScriptLookup | null>): Promise<void> {
  pendingDay ??= loader().then(
    (lookup) => {
      if (lookup) currentDay = lookup;
    },
    () => undefined,
  );
  return pendingDay;
}

/** Resolves once a pending loadDayScriptLookup has settled (immediately when none). */
export function dayScriptLookupReady(): Promise<void> {
  return pendingDay ?? Promise.resolve();
}
