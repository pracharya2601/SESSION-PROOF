import { inflateSync } from "node:zlib";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { validReviewedBundle } from "../contracts/examples";
import type { ApprovalRecord, FinalBundle } from "../contracts/schemas";
import { FILE_KINDS, SessionFile } from "../contracts/v2";
import { FIXTURE_BANNER, fileNameFor, invoiceNumber, renderFilePdf, sessionFiles, toWinAnsi, type ArtifactInput } from "./index";

const final: FinalBundle = {
  sessionId: validReviewedBundle.sessionId,
  bundleRevision: validReviewedBundle.bundleRevision,
  approvalId: "approval_demo_001",
  finalizedAt: "2026-11-13T19:50:00.000Z",
  bundle: validReviewedBundle,
};
const approval: ApprovalRecord = {
  id: "approval_demo_001",
  sessionId: final.sessionId,
  bundleRevision: 3,
  approverProviderId: "provider_demo_001",
  approvedAt: "2026-11-13T19:49:00.000Z",
  idempotencyKey: "demo-session-approval-request-001",
  requestFingerprint: "sha256:" + "ab12".repeat(16),
  finalizationStatus: "finalized",
};
const input: ArtifactInput = { final, approval, providerIdentity: "Dana Provider" };

const liveFinal = (f: FinalBundle): FinalBundle => ({
  ...f,
  bundle: { ...f.bundle, provenance: { ...f.bundle.provenance, evidenceMode: "live", extractionMode: "live", model: "claude-sonnet-5-5", aiProvider: "anthropic", privacy: { scrubbed: true, findings: { NAME: 2, EMAIL: 1 } } } },
});

/** Inflate every content stream and decode `<hex> Tj` strings (WinAnsi) to text. */
function pdfText(bytes: Uint8Array): string {
  const buf = Buffer.from(bytes);
  const raw = buf.toString("latin1");
  const out: string[] = [];
  const re = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    const start = m.index + m[0].length;
    const end = raw.indexOf("endstream", start);
    if (end < 0) break;
    let content: string;
    try {
      content = inflateSync(buf.subarray(start, end)).toString("latin1");
    } catch {
      content = raw.slice(start, end);
    }
    for (const t of content.matchAll(/<([0-9A-Fa-f]*)>\s*Tj/g)) {
      out.push(Buffer.from(t[1] ?? "", "hex").toString("latin1"));
    }
    for (const t of content.matchAll(/\(((?:\\.|[^\\)])*)\)\s*Tj/g)) out.push(t[1] ?? "");
    re.lastIndex = end + "endstream".length;
  }
  // latin1 decode maps CP1252 0x97 (em dash) to U+0097; normalize for assertions.
  return out.join("\n").replace(/\u0097/g, "—").replace(/\u0096/g, "–").replace(/\u0095/g, "•");
}

describe("renderFilePdf", () => {
  for (const kind of FILE_KINDS) {
    it(`renders a valid ${kind} PDF`, async () => {
      const bytes = await renderFilePdf(kind, input);
      expect(Buffer.from(bytes.subarray(0, 5)).toString("latin1")).toBe("%PDF-");
      const doc = await PDFDocument.load(bytes, { updateMetadata: false });
      expect(doc.getPageCount()).toBeGreaterThanOrEqual(1);
      expect(doc.getTitle()).toContain("C-104");
      expect(doc.getAuthor()).toBe("Vexo Field Assistant");
      const [page] = doc.getPages();
      expect(page?.getSize()).toEqual({ width: 612, height: 792 });
      const text = pdfText(bytes);
      expect(text).toContain("VEXO FIELD ASSISTANT");
      expect(text).toMatch(/Page 1 of \d+/);
      expect(text).toContain(FIXTURE_BANNER);
    });
  }

  it("is deterministic for the same input", async () => {
    const a = await renderFilePdf("invoice", input);
    const b = await renderFilePdf("invoice", input);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it("session note content: provider confirmed, coverage statuses, follow-ups, checks, time", async () => {
    const text = pdfText(await renderFilePdf("session_note", input));
    expect(text).toContain("Provider confirmed");
    expect(text).toContain("Addressed");
    expect(text).toContain("Partially addressed");
    expect(text).toContain("Unknown — no supporting evidence");
    expect(text).toContain("Recorded only — not sent");
    expect(text).toContain("Documentation checks — not a compliance determination");
    expect(text).toContain("Evidence window (informational)");
    expect(text).toContain("10:00 AM – 11:00 AM PST");
    expect(text).toContain("90 min (1 h 30 min) — provider confirmed");
  });

  it("invoice content: number, amount, draft notice, no tax", async () => {
    const text = pdfText(await renderFilePdf("invoice", input));
    expect(text).toContain(invoiceNumber(final));
    expect(invoiceNumber(final)).toMatch(/^INV-[0-9A-F]{8}-R3$/);
    expect(text).toContain("$112.50");
    expect(text).toContain("$75.00");
    expect(text).toContain("Draft invoice — no payment requested or submitted");
    expect(text).toContain("rate_demo_v1");
    expect(text).toContain("None applied.");
  });

  it("approval record content incl. identity, fingerprint, attestations, provenance", async () => {
    const text = pdfText(await renderFilePdf("approval_record", { ...input, final: liveFinal(final) }));
    expect(text).toContain("Dana Provider");
    expect(text).toContain("demo-session-approval-request-001");
    expect(text).toContain("2026-11-13 19:49:00 UTC");
    expect(text).toContain("11:49 AM PST");
    expect(text).toContain("anthropic");
    expect(text).toContain("NAME: 2, EMAIL: 1");
    expect(text).toContain("90 minutes confirmed");
    expect(text).not.toContain(FIXTURE_BANNER);
  });

  it("omits identity row when providerIdentity is null", async () => {
    const text = pdfText(await renderFilePdf("approval_record", { ...input, providerIdentity: null }));
    expect(text).not.toContain("Approver identity");
    expect(text).toContain("provider_demo_001");
  });

  it("paginates long content with footers on every page", async () => {
    const longText = "Long observation sentence for pagination testing. ".repeat(38).trim();
    const lines = Array.from({ length: 60 }, (_, i) => ({ text: `${i + 1}. ${longText}`.slice(0, 2000), claimIds: [], evidenceIds: [], attestationIds: [], origin: "extracted" as const }));
    const big: FinalBundle = {
      ...final,
      bundle: {
        ...final.bundle,
        documents: {
          ...final.bundle.documents,
          sections: final.bundle.documents.sections.map((s) => (s.key === "session_note" ? { ...s, lines } : s)),
        },
      },
    };
    const bytes = await renderFilePdf("session_note", { ...input, final: big });
    const doc = await PDFDocument.load(bytes);
    const n = doc.getPageCount();
    expect(n).toBeGreaterThan(3);
    const text = pdfText(bytes);
    for (let i = 1; i <= n; i++) expect(text).toContain(`Page ${i} of ${n}`);
    expect(text.split(FIXTURE_BANNER).length - 1).toBeGreaterThanOrEqual(n);
  });

  it("treats <script> and unicode as plain text without throwing", async () => {
    const nasty = "<script>alert('x')</script> “quoted” … 😀 中文 → café Ω";
    const f: FinalBundle = {
      ...final,
      bundle: {
        ...final.bundle,
        config: { ...final.bundle.config, plan: { ...final.bundle.config.plan, serviceDescription: nasty } },
        documents: {
          ...final.bundle.documents,
          sections: final.bundle.documents.sections.map((s) =>
            s.key === "follow_ups" ? { ...s, lines: [{ text: nasty, claimIds: [], evidenceIds: [], attestationIds: [], origin: "extracted" as const }] } : s,
          ),
        },
      },
    };
    for (const kind of FILE_KINDS) {
      const text = pdfText(await renderFilePdf(kind, { ...input, final: f, providerIdentity: "Zoë 李 “Dana”" }));
      if (kind !== "approval_record") expect(text).toContain("<script>alert('x')</script>");
    }
  });
});

describe("toWinAnsi", () => {
  it("maps smart quotes, ellipsis, emoji, CJK; keeps dashes and ×", () => {
    expect(toWinAnsi("“Hi” ‘there’…")).toBe("\"Hi\" 'there'...");
    expect(toWinAnsi("a — b – c × d • e")).toBe("a — b – c × d • e");
    expect(toWinAnsi("😀 中 → ok")).toBe("? ? -> ok");
    expect(toWinAnsi("café Zoë ñ")).toBe("café Zoë ñ");
    expect(toWinAnsi("Łódź")).toBe("Lódz");
    expect(toWinAnsi("a\u0000b\tc\nd")).toBe("a b    c d");
    expect(toWinAnsi(null)).toBe("");
  });
});

describe("fileNameFor / sessionFiles", () => {
  it("is deterministic and uses the appointment timezone date", () => {
    expect(fileNameFor("session_note", final)).toBe("C-104_2026-11-13_session-note_r3.pdf");
    expect(fileNameFor("approval_record", final)).toBe("C-104_2026-11-13_approval-record_r3.pdf");
    // 2026-11-14T05:00Z is still Nov 13 in Los Angeles.
    const late: FinalBundle = { ...final, bundle: { ...final.bundle, appointment: { ...final.bundle.appointment, startAt: "2026-11-14T05:00:00.000Z" } } };
    expect(fileNameFor("invoice", late)).toBe("C-104_2026-11-13_invoice_r3.pdf");
  });

  it("sanitizes unsafe characters", () => {
    const bad: FinalBundle = { ...final, bundle: { ...final.bundle, appointment: { ...final.bundle.appointment, clientRef: "../C 1/04\"<x>é" } } };
    const name = fileNameFor("invoice", bad);
    expect(name).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(name).not.toContain("..");
    expect(name.endsWith("_invoice_r3.pdf")).toBe(true);
  });

  it("lists all three files with encoded download urls", () => {
    const files = sessionFiles("sess/1 a", final);
    expect(files.map((f) => f.kind)).toEqual(["session_note", "invoice", "approval_record"]);
    for (const f of files) {
      expect(SessionFile.safeParse(f).success).toBe(true);
      expect(f.downloadUrl).toBe(`/api/sessions/sess%2F1%20a/files/${f.kind}`);
    }
    expect(files[1]?.label).toBe("Invoice");
  });
});
