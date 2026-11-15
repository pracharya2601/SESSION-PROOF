import { describe, expect, it } from "vitest";
import type { ClientInput, ClientRecord } from "../contracts";
import type { Repository } from "../db/repository";
import { DEMO_PROVIDER_ID, demoAppointment } from "../../fixtures/scenario";
import { demoClientInput, seedDemoData } from "./seed";

function fakeRepo() {
  const clients = new Map<string, ClientRecord>();
  let upserts = 0;
  const repo = {
    upsertProvider: async () => {},
    upsertServiceConfig: async () => {},
    upsertAppointment: async () => {},
    getClient: async (p: string, ref: string) => clients.get(`${p}|${ref}`) ?? null,
    upsertClient: async (p: string, input: ClientInput, now: Date) => {
      upserts++;
      const rec: ClientRecord = { ...input, providerId: p, rateVersion: 1, createdAt: now.toISOString(), updatedAt: now.toISOString() };
      clients.set(`${p}|${input.clientRef}`, rec);
      return rec;
    },
  } as unknown as Repository;
  return { repo, clients, upserts: () => upserts };
}

describe("seedDemoData client", () => {
  it("seeds the synthetic C-104 client once and never overwrites edits", async () => {
    const f = fakeRepo();
    await seedDemoData(f.repo);
    const rec = f.clients.get(`${DEMO_PROVIDER_ID}|C-104`)!;
    expect(demoAppointment.clientRef).toBe("C-104");
    expect(rec).toMatchObject({ displayName: "Sam Rivera", preferredName: "Sam", hourlyRateCents: null, active: true });
    rec.displayName = "Edited by provider";
    await seedDemoData(f.repo);
    expect(f.upserts()).toBe(1);
    expect(f.clients.get(`${DEMO_PROVIDER_ID}|C-104`)!.displayName).toBe("Edited by provider");
    expect(demoClientInput.customFields).toEqual([{ label: "Program", value: "Independent living skills" }]);
  });
});
