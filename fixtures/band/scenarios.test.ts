/**
 * SYNTHETIC band scenarios: shape, citation and expectation checks, plus seed
 * idempotency against Miniflare D1. Expectations are re-derived here from the pure
 * domain (validateExtraction → assembleBundle) so a scenario cannot drift from what
 * the pipeline would compute.
 */
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ClientInput,
  Plan,
  RateRule,
  RuleSet,
  SessionFacts,
  type Appointment,
  type EvidenceItem,
  type FactClaim,
  type ProviderAttestation,
} from "../../src/contracts";
import { validateExtraction } from "../../src/ai/index";
import { assembleBundle } from "../../src/domain";
import { roundHalfUpCents } from "../../src/domain/billing";
import { evidenceIdFor } from "../../src/band/evidence";
import { createRepository } from "../../src/db/d1";
import { createVisitStore } from "../../src/band/store";
import { DEMO_PROVIDER_ID } from "../scenario";
import { BAND_SCENARIOS, bandTemplateAppointment, getBandScenario, seedBandScenarios } from "./index";
import type { BandScenario } from "./types";

const PACKETS_PER_SEC = 50;
const VISIT_START = Date.parse("2026-11-14T18:00:00.000Z");

function claimsOf(f: SessionFacts): FactClaim[] {
  return [...f.activities, ...f.observations, ...f.progress, ...f.followUps, ...f.goals.flatMap((g) => g.claims)];
}

/** Evidence exactly as BandEvidenceSource would build it from the scripted segments. */
function evidenceFor(s: BandScenario): EvidenceItem[] {
  return [...s.script]
    .sort((a, b) => a.atSec - b.atSec)
    .map((l, i) => ({
      id: evidenceIdFor(i + 1),
      sourceId: `band_visit:test_${s.id}`,
      sourceMode: "fixture",
      observedFrom: new Date(VISIT_START + l.atSec * 1000).toISOString(),
      observedTo: new Date(VISIT_START + (l.atSec + l.durationSec) * 1000).toISOString(),
      speaker: l.speaker,
      excerpt: l.text,
      retrievedAt: new Date(VISIT_START + s.audio.seconds * 1000).toISOString(),
    }));
}

function visitAppointment(s: BandScenario): Appointment {
  return {
    ...bandTemplateAppointment(s),
    id: `appt_visit_test_${s.id}`,
    occurrenceId: `occ_visit_test_${s.id}`,
    startAt: new Date(VISIT_START).toISOString(),
    endAt: new Date(VISIT_START + s.audio.seconds * 1000).toISOString(),
  };
}

function lostPackets(s: BandScenario): number {
  return (s.audio.dropPackets ?? []).reduce((n, [a, b]) => n + (b - a), 0);
}

/** Same warnings/completeness rules as src/band/evidence.ts for a stopped simulated visit. */
function evidenceWarnings(s: BandScenario): { completeness: "complete" | "partial"; warnings: string[] } {
  const total = s.audio.seconds * PACKETS_PER_SEC;
  const lost = lostPackets(s);
  const warnings = ["Simulated transcript (synthetic, dev only): not a real recording."];
  if (lost > 0) {
    const pct = Math.round((lost / total) * 1000) / 10;
    warnings.push(`${lost} audio packet(s) (${pct}%) were lost on the Bluetooth link.`);
  }
  return { completeness: lost === 0 ? "complete" : "partial", warnings };
}

function draft(s: BandScenario, attestations: ProviderAttestation[], bundleRevision: number) {
  const appointment = visitAppointment(s);
  const evidence = evidenceFor(s);
  const facts = validateExtraction(s.extraction, { appointment, plan: s.plan, evidence });
  const ev = evidenceWarnings(s);
  return assembleBundle({
    sessionId: `sess_test_${s.id}`,
    bundleRevision,
    processingRevision: 1,
    appointment,
    config: { plan: s.plan, rules: s.rules, rate: s.rate },
    evidence,
    evidenceWindow: evidence.length ? { from: evidence[0]!.observedFrom!, to: evidence[evidence.length - 1]!.observedTo! } : null,
    facts,
    attestations,
    provenance: {
      evidenceMode: "fixture",
      extractionMode: "fixture",
      runtimeMode: "local",
      schemaVersion: "1",
      promptVersion: "fixture",
      model: null,
      evidenceCompleteness: ev.completeness,
      evidenceWarnings: ev.warnings,
    },
    createdAt: new Date(VISIT_START + s.audio.seconds * 1000).toISOString(),
  });
}

function reviewAttestations(s: BandScenario): ProviderAttestation[] {
  const r = s.review;
  if (!r) return [];
  const mk = (field: ProviderAttestation["field"], text: string): ProviderAttestation => ({
    id: `att-test-${s.id}-${field}`,
    field,
    text,
    actorProviderId: DEMO_PROVIDER_ID,
    attestedAt: new Date(VISIT_START + 3_600_000).toISOString(),
    bundleRevision: 2,
  });
  const out: ProviderAttestation[] = [];
  if (r.progressConfirmation !== undefined) out.push(mk("progress", r.progressConfirmation));
  if (r.confirmedMinutes !== undefined) out.push(mk("duration", String(r.confirmedMinutes)));
  if (r.participantDirected !== undefined) out.push(mk("participant_direction", r.participantDirected ? "yes" : "no"));
  if (r.participantChoices !== undefined) out.push(mk("participant_choices", r.participantChoices));
  return out;
}

describe("band scenarios (synthetic)", () => {
  it("has 6-8 scenarios with unique ids, clientRefs and config versions", () => {
    expect(BAND_SCENARIOS.length).toBeGreaterThanOrEqual(6);
    expect(BAND_SCENARIOS.length).toBeLessThanOrEqual(8);
    const uniq = (xs: string[]) => expect(new Set(xs).size).toBe(xs.length);
    uniq(BAND_SCENARIOS.map((s) => s.id));
    uniq(BAND_SCENARIOS.map((s) => s.client.clientRef));
    uniq(BAND_SCENARIOS.map((s) => s.plan.planVersion));
    uniq(BAND_SCENARIOS.map((s) => s.rules.ruleVersion));
    uniq(BAND_SCENARIOS.map((s) => s.rate.rateVersion));
    for (const s of BAND_SCENARIOS) {
      expect(s.id).toMatch(/^[a-z0-9-]{1,64}$/); // StartVisitRequest.scenario
      expect(getBandScenario(s.id)).toBe(s);
    }
    expect(getBandScenario("nope")).toBeNull();
  });

  for (const s of BAND_SCENARIOS) {
    describe(s.id, () => {
      it("parses against the frozen zod contracts and uses a verified SDP code", () => {
        Plan.parse(s.plan);
        RuleSet.parse(s.rules);
        RateRule.parse(s.rate);
        SessionFacts.parse(s.extraction);
        ClientInput.parse(s.client);
        expect(s.plan.serviceCode).toBe(`${s.serviceCode.system}-${s.serviceCode.code}`);
        expect(s.rules.serviceCode).toBe(s.plan.serviceCode);
        expect(["320", "331", "334", "335"]).toContain(s.serviceCode.code);
        expect(s.serviceCode.sourceNote).toContain("2019-02-14");
        expect(s.client.hourlyRateCents).toBeNull();
        expect(s.client.displayName).not.toMatch(/synthetic/i); // fictional, realistic name
      });

      it("has ordered script lines inside the audio", () => {
        let prev = -1;
        for (const l of s.script) {
          expect(l.atSec).toBeGreaterThan(prev);
          expect(l.durationSec).toBeGreaterThan(0);
          expect(l.atSec + l.durationSec).toBeLessThanOrEqual(s.audio.seconds);
          prev = l.atSec;
        }
        const total = s.audio.seconds * PACKETS_PER_SEC;
        for (const [a, b] of s.audio.dropPackets ?? []) {
          // Inside the stream and < 3000 packets, so capture.ts counts the gap as loss.
          expect(a).toBeGreaterThan(0);
          expect(b).toBeGreaterThan(a);
          expect(b).toBeLessThan(total);
          expect(b - a).toBeLessThan(3000);
        }
        for (const r of s.audio.reconnectAtSec ?? []) {
          expect(r).toBeGreaterThan(0);
          expect(r).toBeLessThan(s.audio.seconds);
        }
      });

      it("cites only existing evidence ids and plan goals; claim ids unique", () => {
        const known = new Set(s.script.map((_, i) => evidenceIdFor(i + 1)));
        const claims = claimsOf(s.extraction);
        expect(new Set(claims.map((c) => c.id)).size).toBe(claims.length);
        for (const c of claims) {
          expect(c.support).not.toBe("provider_confirmed");
          for (const id of c.evidenceIds) expect(known.has(id), `${c.id} → ${id}`).toBe(true);
        }
        const goals = new Set(s.plan.goals.map((g) => g.goalId));
        for (const g of s.extraction.goals) expect(goals.has(g.goalId)).toBe(true);
        // validateExtraction (the gate every extractor goes through) must accept it.
        if (s.script.length > 0) {
          expect(() => validateExtraction(s.extraction, { appointment: visitAppointment(s), plan: s.plan, evidence: evidenceFor(s) })).not.toThrow();
        }
      });

      it("expectations match what the domain computes", () => {
        const ev = evidenceWarnings(s);
        expect(ev.completeness).toBe(s.expect.evidenceCompleteness);
        if (s.script.length === 0) {
          expect(s.expect.afterProcessing).toBe("NO_EVIDENCE");
          expect(s.expect.final).toBe("NO_EVIDENCE");
          expect(s.expect.blockingAtR1).toEqual([]);
          expect(s.expect.amountCentsAfterReview).toBeNull();
          return;
        }
        expect(s.expect.afterProcessing).toBe("NEEDS_REVIEW");
        for (const w of s.expect.warningsInclude ?? []) expect(ev.warnings.some((x) => x.includes(w)), w).toBe(true);

        const r1 = draft(s, [], 1);
        const blocking = r1.checks.issues.filter((i) => i.blocking).map((i) => i.code).sort();
        expect(blocking).toEqual(s.expect.blockingAtR1);
        expect([...s.expect.blockingAtR1].sort()).toEqual(s.expect.blockingAtR1);
        expect(r1.billing.amountCents).toBeNull();
        expect(r1.checks.issues.some((i) => i.code === "PARTIAL_EVIDENCE")).toBe(ev.completeness !== "complete");

        if (!s.review) {
          expect(s.expect.amountCentsAfterReview).toBeNull();
          return;
        }
        const r2 = draft(s, reviewAttestations(s), 2);
        expect(r2.checks.canApprove).toBe(true);
        expect(r2.billing.amountCents).toBe(s.expect.amountCentsAfterReview);
        expect(s.expect.amountCentsAfterReview).toBe(roundHalfUpCents(s.rate.hourlyRateCents, s.review.confirmedMinutes!));
        expect(s.expect.final).toBe("COMPLETED");
      });
    });
  }

  it("covers the required behaviours", () => {
    const ids = BAND_SCENARIOS.map((s) => s.id);
    for (const id of ["sdp-320-normal", "sdp-334-training", "sdp-331-community", "lossy-bluetooth", "reconnect-mid-visit", "participant-directed", "pii-in-transcript", "empty-recording"]) {
      expect(ids).toContain(id);
    }
    const pd = getBandScenario("participant-directed")!;
    expect(pd.review?.participantDirected).toBe(true);
    expect(pd.review?.participantChoices).toBeTruthy();
    expect(getBandScenario("reconnect-mid-visit")!.audio.reconnectAtSec?.length).toBeGreaterThan(0);
    const pii = getBandScenario("pii-in-transcript")!;
    expect(pii.script.some((l) => l.text.includes("555-0100"))).toBe(true);
    expect(pii.script.some((l) => l.text.includes("@example.invalid"))).toBe(true);
    // The fake values never leak into the extraction.
    expect(JSON.stringify(pii.extraction)).not.toMatch(/555|example\.invalid/);
  });
});

// ------------------------------------------------------------------ seed (Miniflare D1)
function splitSql(sql: string): string[] {
  const noComments = sql
    .split("\n")
    .map((l) => l.replace(/--.*$/, ""))
    .join("\n");
  const out: string[] = [];
  let buf = "";
  let depth = 0;
  for (const part of noComments.split(/(;)/)) {
    if (part === ";") {
      buf += ";";
      if (depth === 0) {
        if (buf.trim() !== ";") out.push(buf.trim());
        buf = "";
      }
      continue;
    }
    depth += (part.match(/\bBEGIN\b/gi) ?? []).length;
    depth -= (part.match(/\bEND\b/gi) ?? []).length;
    if (depth < 0) depth = 0;
    buf += part;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

describe("seedBandScenarios (Miniflare D1)", () => {
  let mf: Miniflare;
  let db: D1Database;

  beforeAll(async () => {
    mf = new Miniflare({ modules: true, script: "export default {}", d1Databases: ["DB"] });
    db = (await mf.getD1Database("DB")) as unknown as D1Database;
    const migDir = resolve(__dirname, "../../migrations");
    for (const f of readdirSync(migDir).filter((n) => n.endsWith(".sql")).sort()) {
      for (const stmt of splitSql(readFileSync(resolve(migDir, f), "utf8"))) await db.prepare(stmt).run();
    }
  });
  afterAll(async () => {
    await mf?.dispose();
  });

  it("is idempotent and links each client to its scenario config", async () => {
    const repo = createRepository(db);
    const now = new Date("2026-11-14T12:00:00.000Z");
    await seedBandScenarios(repo, { now });
    const count = async (sql: string) => Number((await db.prepare(sql).first<{ n: number }>())!.n);
    const snap = async () => ({
      configs: await count("SELECT COUNT(*) AS n FROM service_configs"),
      appts: await count("SELECT COUNT(*) AS n FROM appointments"),
      clients: await count("SELECT COUNT(*) AS n FROM clients"),
    });
    const first = await snap();
    expect(first.appts).toBe(BAND_SCENARIOS.length);
    expect(first.configs).toBe(BAND_SCENARIOS.length);
    expect(first.clients).toBe(BAND_SCENARIOS.length);

    // A provider edit to a client survives re-seeding (insert-only).
    const edited = BAND_SCENARIOS[0]!.client;
    await repo.upsertClient(DEMO_PROVIDER_ID, { ...edited, notes: "edited by provider" }, now);
    await seedBandScenarios(repo, { now });
    await seedBandScenarios(repo);
    expect(await snap()).toEqual(first);
    expect((await repo.getClient(DEMO_PROVIDER_ID, edited.clientRef))!.notes).toBe("edited by provider");

    const store = createVisitStore(db);
    for (const s of BAND_SCENARIOS) {
      const latest = await store.latestAppointmentForClient(DEMO_PROVIDER_ID, s.client.clientRef);
      expect(latest).toEqual(bandTemplateAppointment(s));
      const cfg = await repo.getServiceConfig(s.plan.planVersion, s.rules.ruleVersion, s.rate.rateVersion);
      expect(cfg).toEqual({ plan: s.plan, rules: s.rules, rate: s.rate });
    }
  });
});
