import { describe, expect, it } from "vitest";
import { exportJson, renderExportHtml } from "./index";
import { makeBundle, NOW, SESSION } from "../services/approval/testkit";
import type { ApprovalRecord, FinalBundle } from "../contracts";

const bundle = makeBundle({ bundleRevision: 3 });
const final: FinalBundle = { sessionId: SESSION, bundleRevision: 3, approvalId: "approval-x", finalizedAt: NOW.toISOString(), bundle };
const approval: ApprovalRecord = {
  id: "approval-x",
  sessionId: SESSION,
  bundleRevision: 3,
  approverProviderId: "prov-<b>",
  approvedAt: NOW.toISOString(),
  idempotencyKey: "key-1234",
  requestFingerprint: "f",
  finalizationStatus: "finalized",
};

describe("export", () => {
  it("renders all sections, escapes every dynamic string", () => {
    const html = renderExportHtml(final, approval);
    expect(html).not.toMatch(/<script>/);
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("prov-&lt;b&gt;");
    for (const s of ["Session note", "Plan coverage", "Time summary", "Billing", "Approval record", "Provenance", "FIXTURE / SYNTHETIC"]) {
      expect(html).toContain(s);
    }
  });

  it("omits fixture banner for live provenance", () => {
    const live = { ...final, bundle: { ...bundle, provenance: { ...bundle.provenance, evidenceMode: "live" as const, extractionMode: "live" as const } } };
    expect(renderExportHtml(live)).not.toContain("FIXTURE / SYNTHETIC");
  });

  it("exportJson wraps the final record", () => {
    const j = exportJson(final, approval);
    expect(j.finalized).toBe(final);
    expect(j.modes).toBe(bundle.provenance);
    expect(j.approval).toBe(approval);
  });
});
