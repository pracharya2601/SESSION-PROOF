/**
 * FROZEN interface for synthetic band-visit scenarios (dummy data that exercises the
 * whole band pipeline: simulated transcript → evidence → fixture extraction → checks →
 * billing → review → approval). Everything here is SYNTHETIC: fictional people, no PII.
 *
 * Owners: scenarios + seed (fixtures/band/scenarios.ts, seed.ts) · scripted transcriber and
 * scenario extractor (src/band/) · runner/observation (tests + scripts). Do not rename.
 */
import type { ClientInput, Plan, RateRule, RuleSet, SessionFacts, SessionStatus } from "../../src/contracts";

/** One transcript line. `atSec` = seconds from the start of the band audio. */
export interface ScenarioLine {
  atSec: number;
  durationSec: number;
  /** As a transcriber would label it ("Speaker 0"), or a role for simulated scripts. null = unknown. */
  speaker: string | null;
  text: string;
}

/** A real code the scenario is coded with (from docs/research/self-determination-codes.md). */
export interface ScenarioServiceCode {
  /** e.g. "CA-SDP" (Self-Determination Program, DDS table 2019-02-14) or "CA-RC". */
  system: string;
  code: string;
  label: string;
  /** e.g. "hour", "day" — informational until the billing model supports units. */
  unit: string;
  sourceNote: string;
}

export interface BandScenario {
  /** kebab-case id, also used as StartVisitRequest.scenario. */
  id: string;
  title: string;
  /** What this scenario is meant to exercise in the pipeline. */
  purpose: string;
  serviceCode: ScenarioServiceCode;
  /** Synthetic client (clientRef unique per scenario, e.g. "SD-320-A"). */
  client: ClientInput;
  /** Plan/rules/rate for this scenario's service. plan.serviceCode is the app's service key (e.g. "CA-SDP-320"). */
  plan: Plan;
  rules: RuleSet;
  rate: RateRule;
  /** Packet-level audio behaviour the runner should simulate. */
  audio: {
    /** Total seconds of audio to stream (50 packets/s). */
    seconds: number;
    /** Seq ranges [from, to) to drop, simulating Bluetooth loss. */
    dropPackets?: [number, number][];
    /** Band reconnects at these audio seconds (seq restarts at 0, a new "start" is sent). */
    reconnectAtSec?: number[];
  };
  /** Transcript the simulated transcriber emits (in order). Evidence ids are ev_001.. by position. */
  script: ScenarioLine[];
  /** Fixture extraction output for this scenario; citations must reference ev_00N of the script. */
  extraction: SessionFacts;
  /** Provider review the runner applies before approving (omit = expect it to stay blocked). */
  review?: { confirmedMinutes?: number; progressConfirmation?: string; participantDirected?: boolean; participantChoices?: string };
  expect: {
    /** Status right after processing. */
    afterProcessing: SessionStatus;
    /** Blocking check codes expected at revision 1 (sorted). */
    blockingAtR1: string[];
    /** Billed cents after the review (null = not approvable / no amount). */
    amountCentsAfterReview: number | null;
    /** Status after review + approve (if review given). */
    final: SessionStatus;
    /** Substrings expected among provenance.evidenceWarnings. */
    warningsInclude?: string[];
    evidenceCompleteness: "complete" | "partial" | "unknown";
  };
}
