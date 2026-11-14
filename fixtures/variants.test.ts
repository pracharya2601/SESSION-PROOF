import { describe, expect, it } from "vitest";
import { Appointment, EvidenceResult, EvidenceUnavailableError, ServiceConfig, SessionFacts } from "../src/contracts";
import type { Repository } from "../src/db/repository";
import { seedDemoData } from "../src/calendar";
import * as S from "./scenario";
import { INJECTION_TEXT, VARIANT_NAMES, getVariant } from "./variants";

function laTime(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).format(new Date(iso));
}

describe("scenario", () => {
  it("validates against contracts and is 10:00–11:00 LA", () => {
    expect(() => Appointment.parse(S.demoAppointment)).not.toThrow();
    expect(() => ServiceConfig.parse(S.demoConfig)).not.toThrow();
    expect(() => SessionFacts.parse(S.demoFacts)).not.toThrow();
    expect(laTime(S.demoAppointment.startAt)).toBe("11/13/2026, 10:00");
    expect(laTime(S.demoAppointment.endAt)).toBe("11/13/2026, 11:00");
    expect(new Date(S.FIXTURE_CLOCK_NOW) >= new Date(S.demoAppointment.endAt)).toBe(true);
  });
});

describe("variants", () => {
  it.each(VARIANT_NAMES)("%s validates and has unique ids", (name) => {
    const v = getVariant(name);
    if (v.evidence instanceof Error) {
      expect(name).toBe("upstream-error");
      expect(v.evidence).toBeInstanceOf(EvidenceUnavailableError);
    } else {
      const ev = EvidenceResult.parse(v.evidence);
      const ids = ev.items.map((i) => i.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const i of ev.items) expect(i.sourceMode).toBe("fixture");
    }
    for (const a of v.extraAppointments) Appointment.parse(a);
    const apptIds = [S.demoAppointment, ...v.extraAppointments].flatMap((a) => [a.id, a.occurrenceId]);
    expect(new Set(apptIds).size).toBe(apptIds.length);
    if (name !== "malformed-extraction") {
      const facts = SessionFacts.parse(v.extractionRaw);
      const claimIds = [...facts.activities, ...facts.observations, ...facts.progress, ...facts.followUps, ...facts.goals.flatMap((g) => g.claims)].map((c) => c.id);
      expect(new Set(claimIds).size).toBe(claimIds.length);
    }
  });

  it("returns fresh copies", () => {
    const a = getVariant("normal");
    (a.evidence as EvidenceResult).items.pop();
    expect((getVariant("normal").evidence as EvidenceResult).items).toHaveLength(5);
  });

  it("variant-specific shapes", () => {
    expect((getVariant("no-evidence").evidence as EvidenceResult).items).toEqual([]);
    const partial = getVariant("partial-evidence").evidence as EvidenceResult;
    expect(partial.completeness).toBe("partial");
    expect(partial.unavailableSourceIds.length).toBeGreaterThan(0);
    expect(partial.warnings.length).toBeGreaterThan(0);

    const amb = getVariant("ambiguous").extraAppointments[0]!;
    expect(amb.providerId).toBe(S.DEMO_PROVIDER_ID);
    expect(amb.startAt < S.demoAppointment.endAt && amb.endAt > S.demoAppointment.startAt).toBe(true);

    expect(JSON.stringify(getVariant("bad-citation").extractionRaw)).toContain("ev_999");
    expect(getVariant("malformed-extraction").extractionRaw).toBe("{ not json");
    expect(() => JSON.parse("{ not json")).toThrow();

    const inj = getVariant("instruction-in-transcript");
    expect((inj.evidence as EvidenceResult).items.some((i) => i.excerpt === INJECTION_TEXT)).toBe(true);
    expect(inj.extractionRaw).toEqual(S.demoFacts);

    const mid = getVariant("midnight");
    const m = mid.extraAppointments[0]!;
    expect(laTime(m.startAt)).toBe("11/13/2026, 23:30");
    expect(laTime(m.endAt)).toBe("11/14/2026, 00:30");
    const days = (mid.evidence as EvidenceResult).items.map((i) => laTime(i.observedFrom!).slice(0, 10));
    expect(new Set(days)).toEqual(new Set(["11/13/2026", "11/14/2026"]));
    for (const i of (mid.evidence as EvidenceResult).items) {
      expect(i.observedFrom! >= m.startAt && i.observedTo! <= m.endAt).toBe(true);
    }
    const midIds = new Set((mid.evidence as EvidenceResult).items.map((i) => i.id));
    const cited = JSON.stringify(mid.extractionRaw).match(/ev_[a-z0-9_]+/g) ?? [];
    expect(cited.length).toBeGreaterThan(0);
    for (const c of cited) expect(midIds.has(c)).toBe(true);
  });

  it("unknown name throws", () => {
    expect(() => getVariant("nope")).toThrow();
  });
});

function fakeRepo() {
  const providers = new Map<string, string>();
  const configs = new Map<string, ServiceConfig>();
  const appts = new Map<string, Appointment>();
  const clients = new Map<string, unknown>();
  const repo = {
    async upsertProvider(id: string, identity: string) { providers.set(id, identity); },
    async upsertServiceConfig(code: string, c: ServiceConfig) { configs.set(code, c); },
    async upsertAppointment(a: Appointment) { appts.set(a.id, a); },
    // v3: seed also creates the synthetic client record once.
    async getClient(pid: string, ref: string) { return clients.get(`${pid}:${ref}`) ?? null; },
    async upsertClient(pid: string, input: { clientRef: string }) {
      clients.set(`${pid}:${input.clientRef}`, input);
      return input;
    },
  } as unknown as Repository;
  return { repo, providers, configs, appts };
}

describe("seedDemoData", () => {
  it("is idempotent", async () => {
    const f = fakeRepo();
    await seedDemoData(f.repo);
    await seedDemoData(f.repo);
    expect([...f.providers]).toEqual([
      [S.DEMO_PROVIDER_ID, S.DEMO_PROVIDER_IDENTITY],
      [S.OTHER_PROVIDER_ID, S.OTHER_PROVIDER_IDENTITY],
    ]);
    expect(f.configs.size).toBe(1);
    expect([...f.appts.keys()]).toEqual([S.demoAppointment.id]);
  });

  it("adds variant appointments", async () => {
    const f = fakeRepo();
    await seedDemoData(f.repo, { variant: "ambiguous" });
    await seedDemoData(f.repo, { variant: "ambiguous" });
    expect([...f.appts.keys()].sort()).toEqual(["appointment_demo_001", "appointment_demo_002"]);
  });

  it("rejects unknown variant", async () => {
    await expect(seedDemoData(fakeRepo().repo, { variant: "nope" })).rejects.toThrow();
  });
});
