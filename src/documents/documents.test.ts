import { inflateSync } from "node:zlib";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { validDraftBundle, validReviewedBundle } from "../contracts/examples";
import type { FinalBundle, SessionBundle } from "../contracts/schemas";
import { FILE_KINDS, type FileKind } from "../contracts/v2";
import {
  DocumentTemplate as DocumentTemplateSchema,
  SECTION_KEYS,
  builtinTemplateId,
  type DocBlock,
  type DocModel,
  type DocModelInput,
  type DocumentTemplate,
} from "../contracts/v3";
import {
  BUILTIN_TEMPLATES,
  DRAFT_BANNER,
  DRAFT_WATERMARK,
  FIXTURE_BANNER,
  INVOICE_DRAFT_WATERMARK,
  NOTE_ATTESTATION_STATEMENT,
  SAMPLE_PROFILE,
  buildDocModel,
  docText,
  normalizeTemplate,
  renderDocModelPdf,
  sampleDocModelInput,
} from "./index";
import { DEMO_LOGO_DATA_URL } from "../calendar/seed-logo";

/** Inflate content streams and decode `<hex> Tj` strings (WinAnsi) to text. */
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
    for (const t of content.matchAll(/<([0-9A-Fa-f]*)>\s*Tj/g)) out.push(Buffer.from(t[1] ?? "", "hex").toString("latin1"));
    re.lastIndex = end + "endstream".length;
  }
  return out.join("\n").replace(/\u0097/g, "—").replace(/\u0096/g, "–").replace(/\u0095/g, "•");
}

const live = (b: SessionBundle): SessionBundle => ({ ...b, provenance: { ...b.provenance, evidenceMode: "live", extractionMode: "live" } });

function approvedInput(kind: FileKind, over: Partial<DocModelInput> = {}): DocModelInput {
  const base = sampleDocModelInput(BUILTIN_TEMPLATES[kind]);
  return { ...base, ...over };
}

function withSections(kind: FileKind, enabled: (key: string) => boolean, order?: string[]): DocumentTemplate {
  const keys = order ?? [...SECTION_KEYS[kind]];
  return { ...BUILTIN_TEMPLATES[kind], id: "tpl_test", builtin: false, sections: keys.map((key) => ({ key, enabled: enabled(key) })) };
}

const headingSections = (m: DocModel) => m.blocks.filter((b): b is Extract<DocBlock, { type: "heading" }> => b.type === "heading").map((b) => b.section);
const allText = (m: DocModel) => JSON.stringify(m);

/** Words that must never appear on the invoice or the session note (provenance lives on the approval record). */
const FORBIDDEN = /synthetic|demo|estimat|fixture|ev_0|\bAI\b/i;

/** Sections that print a heading for the sample input (bill_to carries its own labels; funding usage needs Drive data). */
const NO_HEADING_KEYS: Record<FileKind, string[]> = { invoice: ["bill_to", "funding_authorization"], session_note: [], approval_record: [] };
const headed = (kind: FileKind, keys: readonly string[]) => keys.filter((k) => !NO_HEADING_KEYS[kind].includes(k));

describe("templates", () => {
  it("builtins: one per kind, valid, every key once, invoice/note defaults are paperwork-shaped", () => {
    for (const kind of FILE_KINDS) {
      const t = BUILTIN_TEMPLATES[kind];
      expect(DocumentTemplateSchema.safeParse(t).success).toBe(true);
      expect(t.id).toBe(builtinTemplateId(kind));
      expect(t.builtin).toBe(true);
      expect(t.isDefault).toBe(false);
      expect(t.kind).toBe(kind);
      expect([...t.sections.map((x) => x.key)].sort()).toEqual([...SECTION_KEYS[kind]].sort());
      expect(t.text.invoicePrefix).toBe("INV");
      expect(t.text.representativeSignatureLabel).toBe("");
      expect(normalizeTemplate(kind, t)).toEqual(t);
    }
    const on = (kind: FileKind) => BUILTIN_TEMPLATES[kind].sections.filter((x) => x.enabled).map((x) => x.key);
    expect(on("invoice")).toEqual(["bill_to", "service_lines", "totals", "funding_authorization", "notes", "signatures"]);
    expect(on("session_note")).toEqual(["overview", "plan_coverage", "session_note", "progress", "participant_direction", "follow_ups", "time_summary", "signatures"]);
    expect(on("approval_record")).toEqual([...SECTION_KEYS.approval_record]);
    expect(BUILTIN_TEMPLATES.session_note.text.attestationStatement).toBe(NOTE_ATTESTATION_STATEMENT);
    expect(BUILTIN_TEMPLATES.invoice.text.attestationStatement).toMatch(/^I certify that the services listed/);
    expect(BUILTIN_TEMPLATES.invoice.text.attestationStatement).toContain("All services specified in this invoice have been provided to the participant.");
  });

  it("normalize drops unknown keys, de-dupes, keeps order, appends missing disabled", () => {
    const t = {
      ...BUILTIN_TEMPLATES.approval_record,
      sections: [
        { key: "provenance", enabled: true },
        { key: "bogus", enabled: true },
        { key: "provenance", enabled: false },
        { key: "bill_to", enabled: true },
        { key: "approval", enabled: true },
      ],
    };
    expect(normalizeTemplate("approval_record", t).sections).toEqual([
      { key: "provenance", enabled: true },
      { key: "approval", enabled: true },
      { key: "checks", enabled: false },
      { key: "attestations", enabled: false },
      { key: "amendments", enabled: false },
      { key: "signatures", enabled: false },
    ]);
  });
});

describe("buildDocModel", () => {
  for (const kind of FILE_KINDS) {
    it(`${kind}: each section toggles its blocks on/off`, () => {
      const all = withSections(kind, () => true);
      const full = buildDocModel(kind, approvedInput(kind, { template: all }));
      expect(headingSections(full).filter((k) => k !== "sources")).toEqual(headed(kind, SECTION_KEYS[kind]));
      for (const key of headed(kind, SECTION_KEYS[kind])) {
        const off = buildDocModel(kind, approvedInput(kind, { template: withSections(kind, (k) => k !== key) }));
        expect(headingSections(off)).not.toContain(key);
        expect(off.blocks.length).toBeLessThan(full.blocks.length);
        const only = buildDocModel(kind, approvedInput(kind, { template: withSections(kind, (k) => k === key) }));
        expect(headingSections(only).filter((k) => k !== "sources")).toEqual([key]);
      }
    });

    it(`${kind}: template order is respected`, () => {
      const reversed = [...SECTION_KEYS[kind]].reverse();
      const m = buildDocModel(kind, approvedInput(kind, { template: withSections(kind, () => true, reversed) }));
      expect(headingSections(m).filter((k) => k !== "sources")).toEqual(headed(kind, reversed));
    });
  }

  it("title override, filename, theme passthrough, templateId; default titles", () => {
    const t = { ...BUILTIN_TEMPLATES.invoice, id: "tpl_x", text: { ...BUILTIN_TEMPLATES.invoice.text, title: "Statement of services" } };
    const m = buildDocModel("invoice", approvedInput("invoice", { template: t }));
    expect(m.title).toBe("Statement of services");
    expect(m.templateId).toBe("tpl_x");
    expect(m.filename).toBe("C-104_2026-11-13_invoice_r3.pdf");
    expect(m.header.meta.find((x) => x.label === "Invoice #")?.value).toBe("HLS-1041");
    expect(buildDocModel("invoice", approvedInput("invoice")).title).toBe("INVOICE");
    expect(buildDocModel("session_note", approvedInput("session_note")).title).toBe("Session Note");
  });

  it("invoice: letterhead, bill-to FMS, participant + UCI, authorization, per-task lines, total, DDS certification", () => {
    const m = buildDocModel("invoice", approvedInput("invoice"));
    expect(m.letterhead?.name).toBe(SAMPLE_PROFILE.legalName);
    expect(m.letterhead?.incomplete).toBe(false);
    expect(m.letterhead?.lines.join("\n")).toContain("Vendor # PV0000");
    expect(m.letterhead?.meta.map((x) => x.label)).toEqual(["Invoice #", "Invoice date", "Service period", "Terms"]);
    const parties = m.blocks.find((b) => b.type === "parties");
    expect(parties?.type === "parties" && parties.parties.map((p) => p.label)).toEqual(["Bill to", "Participant", "Spending plan / authorization"]);
    const s = docText(m);
    for (const v of ["Example Fiscal Services, Inc.", "PO Box 0000", "Alex Morgan", "UCI # 0000000", "Authorization # SP-2026-000123", "Financial Management Services (bill payer)"]) expect(s).toContain(v);
    const table = m.blocks.find((b) => b.type === "table");
    expect(table?.type === "table" && table.columns.map((c) => c.label)).toEqual(["Date", "Code", "Service description", "Time in – out", "Min", "Rate", "Amount"]);
    if (table?.type !== "table") throw new Error("no table");
    expect(table.rowKinds?.[0]).toBe("item");
    expect(table.rows[0]!.slice(0, 6)).toEqual(["11/13/2026", "320", "Community Living Supports — independent living skills", "10:00 AM – 11:30 AM", "90", "$75.00/hr"]);
    const subs = table.rows.filter((_, i) => table.rowKinds?.[i] === "sub");
    expect(subs.length).toBeGreaterThan(1);
    const cents = subs.map((r) => Math.round(Number(r[6]!.replace(/[$,]/g, "")) * 100));
    expect(cents.reduce((a, b) => a + b, 0)).toBe(11250); // per-task amounts add up to the total
    expect(subs.map((r) => Number(r[4])).reduce((a, b) => a + b, 0)).toBe(90);
    expect(s).toContain("Total due (USD): $112.50");
    expect(s).toContain("All services specified in this invoice have been provided to the participant.");
    expect(s).toContain("/s/ Jamie Ortega — signed electronically Nov 13, 2026");
    expect(s).toContain("Remit to");
    expect(m.footer.revisionLabel).toBe("Invoice # HLS-1041");
  });

  it("invoice + note: no synthetic / demo / estimate / fixture / evidence-id / AI wording (draft or approved)", () => {
    for (const kind of ["invoice", "session_note"] as const) {
      for (const over of [{}, { final: null, approval: null }]) {
        const m = buildDocModel(kind, approvedInput(kind, over));
        expect(docText(m)).not.toMatch(FORBIDDEN);
        expect(m.banner).toBeNull();
        expect(m.blocks.some((b) => b.type === "callout" && b.tone === "fixture")).toBe(false);
      }
    }
    // Pending duration: still no "estimate" wording.
    const base = approvedInput("invoice");
    const pending = { ...base.bundle, billing: { ...base.bundle.billing, confirmedMinutes: null, amountCents: null, isEstimate: true, invoice: { ...base.bundle.billing.invoice!, totalCents: null, isEstimate: true, rounding: { ...base.bundle.billing.invoice!.rounding, billedMinutes: null }, lines: base.bundle.billing.invoice!.lines.map((l) => ({ ...l, billedMinutes: null, amountCents: null })) } } };
    const m = buildDocModel("invoice", { ...base, bundle: pending, final: null, approval: null });
    expect(docText(m)).toContain("Pending");
    expect(docText(m)).not.toMatch(FORBIDDEN);
  });

  it("DRAFT watermark only before approval", () => {
    const approved = buildDocModel("invoice", approvedInput("invoice"));
    expect(approved.watermark ?? null).toBeNull();
    const draft = buildDocModel("invoice", approvedInput("invoice", { final: null, approval: null }));
    expect(draft.watermark).toBe(INVOICE_DRAFT_WATERMARK);
    expect(INVOICE_DRAFT_WATERMARK).toBe("DRAFT — not for billing");
    expect(draft.footer.revisionLabel).toBe(INVOICE_DRAFT_WATERMARK);
    expect(docText(draft)).toContain("Assigned at approval");
    const sig = draft.blocks.find((b) => b.type === "signatures");
    expect(sig?.type === "signatures" && sig.lines[0]!.signed).toBeNull();
    expect(buildDocModel("session_note", approvedInput("session_note", { final: null, approval: null })).watermark).toBe(DRAFT_WATERMARK);
    expect(buildDocModel("session_note", approvedInput("session_note")).watermark ?? null).toBeNull();
  });

  it("missing business profile: clear placeholders on the invoice letterhead", () => {
    const m = buildDocModel("invoice", approvedInput("invoice", { profile: null }));
    expect(m.letterhead?.incomplete).toBe(true);
    expect(m.letterhead?.name).toBe("[Business name]");
    const s = docText(m);
    expect(s).toContain("Vendor # [not set]");
    expect(s).toContain("Complete Settings → Business profile (missing: business name, vendor #, address)");
  });

  it("provenance (fixture, AI provider, model, evidence mode) appears on the approval record only", () => {
    const base = approvedInput("approval_record");
    const bundle = { ...base.bundle, provenance: { ...base.bundle.provenance, aiProvider: "openai", model: "gpt-4.1" } };
    const input = { ...base, bundle, final: { ...base.final!, bundle } };
    const ap = buildDocModel("approval_record", input);
    const s = docText(ap);
    expect(ap.banner).toBe(FIXTURE_BANNER);
    expect(s).toContain("Evidence mode: FIXTURE (synthetic)");
    expect(s).toContain("AI provider: openai");
    expect(s).toContain("Model: gpt-4.1");
    expect(s).toContain("Invoice number: HLS-1041");
    for (const kind of ["invoice", "session_note"] as const) {
      const d = docText(buildDocModel(kind, { ...input, template: BUILTIN_TEMPLATES[kind] }));
      expect(d).not.toContain("openai");
      expect(d).not.toContain("gpt-4.1");
    }
  });

  it("approval record: checks, amendment history", () => {
    const base = approvedInput("approval_record");
    const none = docText(buildDocModel("approval_record", base));
    expect(none).toContain("No amendments — this is the original revision.");
    const m = buildDocModel("approval_record", {
      ...base,
      superseded: [{ sessionId: "s", bundleRevision: 2, approvalId: "a2", finalizedAt: "2026-11-13T19:00:00.000Z", supersededAt: "2026-11-13T19:30:00.000Z", supersededByRevision: 3, reason: "Visit ran 75 minutes", actorProviderId: "p", amountCents: 9375 }],
    });
    const s = docText(m);
    expect(s).toContain("r2 → r3");
    expect(s).toContain("Visit ran 75 minutes");
    expect(s).toContain("$93.75");
    expect(headingSections(m)).toContain("checks");
  });

  it("session note: progress-note sections, provider attestation phrasing, source markers + Sources appendix", () => {
    const m = buildDocModel("session_note", approvedInput("session_note"));
    expect(headingSections(m)).toEqual(["overview", "plan_coverage", "session_note", "progress", "participant_direction", "follow_ups", "time_summary", "signatures", "sources"]);
    const s = docText(m);
    expect(s).toContain("UCI #: 0000000");
    expect(s).toContain("Time in – out: 10:00 AM – 11:30 AM PST");
    expect(s).toContain("Location: Participant's home");
    expect(s).toContain("Service: SDP 320 — Community Living Supports");
    expect(s).toContain("Provider attestation");
    expect(s).not.toContain("Provider-confirmed (not evidence)");
    expect(s).not.toMatch(/ev_\d/);
    const lists = m.blocks.filter((b): b is Extract<DocBlock, { type: "list" }> => b.type === "list");
    const refs = lists.flatMap((l) => l.items.flatMap((i) => i.refs ?? []));
    expect(Math.max(...refs)).toBe(4);
    const pb = m.blocks.findIndex((b) => b.type === "pagebreak");
    expect(pb).toBeGreaterThan(0);
    expect(m.blocks[pb + 1]).toMatchObject({ type: "heading", text: "Sources" });
    expect(s).toContain("Sources: transcript excerpts on file.");
    expect(s).toContain("[1] Transcript excerpt, recorded 10:05 AM – 10:06 AM PST, on file.");
  });

  it("invoice rate comes from the frozen bundle, never the live client snapshot rate", () => {
    const base = approvedInput("invoice");
    const client = { ...base.client!, hourlyRateCents: 99900, effectiveHourlyRateCents: 99900 };
    const m = buildDocModel("invoice", { ...base, client });
    const s = allText(m);
    expect(s).toContain("$75.00");
    expect(s).toContain("$112.50");
    expect(s).not.toContain("$999.00");
  });

  it("authorization # prefers the client override, then Drive, then the client record", () => {
    const base = approvedInput("invoice");
    const withOverride = { ...base, client: { ...base.client!, authorizationOverride: "OVR-1" } };
    expect(docText(buildDocModel("invoice", withOverride))).toContain("Authorization # OVR-1");
    const inv = base.bundle.billing.invoice!;
    const drive = { ...inv, authorization: { number: "DRV-9", fundingSource: "RC", validFrom: "2026-07-01", validTo: "2027-06-30", serviceDateInRange: true, authorizedMinutesPerMonth: 2400, usedMinutesBeforeSession: 600, remainingMinutesAfterSession: 1710 } };
    const b2 = { ...base.bundle, billing: { ...base.bundle.billing, invoice: drive } };
    const s = docText(buildDocModel("invoice", { ...base, bundle: b2, final: { ...base.final!, bundle: b2 } }));
    expect(s).toContain("Authorization # DRV-9");
    expect(s).toContain("Authorization period 07/01/2026 – 06/30/2027");
    expect(s).toContain("Remaining after this invoice: 1710 min");
  });

  it("participant direction renders from attestations; absent → Not recorded", () => {
    const m = buildDocModel("session_note", approvedInput("session_note"));
    const s = allText(m);
    expect(s).toContain("Yes — the participant directed the activities");
    expect(s).toContain("Chose the library as the destination");
    const base = approvedInput("session_note");
    const noAtt = { ...base.bundle, attestations: base.bundle.attestations.filter((a) => !a.field.startsWith("participant")) };
    const m2 = buildDocModel("session_note", { ...base, bundle: noAtt, final: { ...base.final!, bundle: noAtt } });
    expect(allText(m2)).toContain("Not recorded");
    const no = { ...base.bundle, attestations: [{ ...base.bundle.attestations[0]!, id: "a_no", field: "participant_direction" as const, text: "no" }] };
    expect(allText(buildDocModel("session_note", { ...base, bundle: no, final: null, approval: null }))).toContain("No — the activities were not participant-directed");
    const ap = buildDocModel("approval_record", approvedInput("approval_record"));
    expect(allText(ap)).toContain("Participant direction");
  });

  it("does not quote raw transcript evidence", () => {
    for (const kind of FILE_KINDS) {
      const input = approvedInput(kind);
      const s = allText(buildDocModel(kind, input));
      for (const ev of input.bundle.evidence) expect(s).not.toContain(ev.excerpt);
    }
  });

  it("signatures: provider e-signature + participant/representative line, representative only when set, statement", () => {
    const m = buildDocModel("invoice", approvedInput("invoice"));
    const sig = m.blocks.find((b) => b.type === "signatures");
    expect(sig?.type === "signatures" && sig.lines.map((l) => l.label)).toEqual(["Provider signature", "Participant or authorized representative"]);
    expect(sig?.type === "signatures" && sig.lines[1]!.signed).toBeNull();
    const base = approvedInput("invoice");
    const t = { ...BUILTIN_TEMPLATES.invoice, text: { ...BUILTIN_TEMPLATES.invoice.text, representativeSignatureLabel: "Representative", attestationStatement: "Custom statement." } };
    const m2 = buildDocModel("invoice", { ...base, template: t, client: { ...base.client!, representativeName: "Pat Morgan" } });
    const sig2 = m2.blocks.find((b) => b.type === "signatures");
    expect(sig2?.type === "signatures" && sig2.lines.map((l) => l.label)).toEqual(["Provider signature", "Participant or authorized representative", "Representative"]);
    expect(sig2?.type === "signatures" && sig2.lines[1]!.name).toBe("Pat Morgan, authorized representative for Alex Morgan");
    expect(sig2?.type === "signatures" && sig2.statement).toBe("Custom statement.");
  });

  it("is deterministic and pure", () => {
    const input = approvedInput("approval_record");
    const snapshot = JSON.stringify(input);
    expect(buildDocModel("approval_record", input)).toEqual(buildDocModel("approval_record", input));
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it("draft bundle (no final) builds for every kind", () => {
    for (const kind of FILE_KINDS) {
      const m = buildDocModel(kind, { bundle: validDraftBundle, final: null, approval: null, providerIdentity: null, client: null, template: BUILTIN_TEMPLATES[kind] });
      expect(m.filename).toBe(`C-104_2026-11-13_${kind.replace(/_/g, "-")}_r2.pdf`);
      expect(m.watermark).toMatch(/^DRAFT/);
      if (kind === "approval_record") expect(m.banner).toContain(DRAFT_BANNER);
      else expect(m.banner).toBeNull();
    }
  });
});

describe("renderDocModelPdf", () => {
  const variants: { name: string; theme: Partial<DocumentTemplate["theme"]>; size: { width: number; height: number } }[] = [
    { name: "letter sans", theme: {}, size: { width: 612, height: 792 } },
    { name: "a4 serif", theme: { paper: "a4", fontFamily: "serif" }, size: { width: 595.28, height: 841.89 } },
    { name: "letter mono compact", theme: { fontFamily: "mono", density: "compact", accentColor: "#0F766E" }, size: { width: 612, height: 792 } },
    { name: "a4 sans compact", theme: { paper: "a4", density: "compact", headerNote: "Agency 42", footerNote: "Confidential — provider records" }, size: { width: 595.28, height: 841.89 } },
  ];
  for (const kind of FILE_KINDS) {
    for (const v of variants) {
      it(`${kind} / ${v.name} renders a valid PDF with expected text`, async () => {
        const t = { ...BUILTIN_TEMPLATES[kind], theme: { ...BUILTIN_TEMPLATES[kind].theme, ...v.theme } };
        const bytes = await renderDocModelPdf(buildDocModel(kind, approvedInput(kind, { template: t })));
        const doc = await PDFDocument.load(bytes, { updateMetadata: false });
        expect(doc.getPageCount()).toBeGreaterThanOrEqual(1);
        const size = doc.getPages()[0]!.getSize();
        expect(size.width).toBeCloseTo(v.size.width, 1);
        expect(size.height).toBeCloseTo(v.size.height, 1);
        const text = pdfText(bytes);
        expect(text).toMatch(/Page 1 of \d+/);
        expect(text).toContain("Signatures & attestation");
        if (v.theme.footerNote) expect(text).toContain(v.theme.footerNote);
        if (kind === "approval_record") {
          expect(doc.getTitle()).toContain("C-104");
          expect(text).toContain("VEXO FIELD ASSISTANT");
          expect(text).toContain(FIXTURE_BANNER);
          if (v.theme.headerNote) expect(text).toContain(v.theme.headerNote);
        } else {
          expect(text).toContain(SAMPLE_PROFILE.legalName!);
          expect(text).not.toMatch(FORBIDDEN);
          expect(text).not.toContain("DRAFT");
        }
        if (kind === "invoice") {
          expect(text).toContain("$112.50");
          expect(text).toContain("INVOICE");
          expect(text).toContain("HLS-1041");
        }
      });
    }
  }

  it("draft invoice PDF carries the DRAFT — not for billing watermark; approved does not", async () => {
    const draft = pdfText(await renderDocModelPdf(buildDocModel("invoice", approvedInput("invoice", { final: null, approval: null }))));
    expect(draft).toContain("DRAFT — NOT FOR BILLING");
    const approved = pdfText(await renderDocModelPdf(buildDocModel("invoice", approvedInput("invoice"))));
    expect(approved).not.toContain("DRAFT");
  });

  it("renders the business logo (PNG data URL) on the invoice", async () => {
    const base = approvedInput("invoice");
    const bytes = await renderDocModelPdf(buildDocModel("invoice", { ...base, profile: { ...SAMPLE_PROFILE, logoDataUrl: DEMO_LOGO_DATA_URL } }));
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(1);
    expect(Buffer.from(bytes).toString("latin1")).toMatch(/\/Subtype\s*\/Image/);
    const without = await renderDocModelPdf(buildDocModel("invoice", base));
    expect(Buffer.from(without).toString("latin1")).not.toMatch(/\/Subtype\s*\/Image/);
    // An unreadable logo is skipped, never fatal.
    const bad = await renderDocModelPdf(buildDocModel("invoice", { ...base, profile: { ...SAMPLE_PROFILE, logoDataUrl: "data:image/png;base64,AAAA" } }));
    expect((await PDFDocument.load(bad)).getPageCount()).toBeGreaterThanOrEqual(1);
  });

  it("session note PDF: source markers in text, Sources appendix on its own page", async () => {
    const bytes = await renderDocModelPdf(buildDocModel("session_note", approvedInput("session_note")));
    const text = pdfText(bytes);
    expect(text).toContain("[1][2]");
    expect(text).toContain("Sources");
    expect(text).not.toMatch(/ev_\d/);
    expect((await PDFDocument.load(bytes)).getPageCount()).toBeGreaterThanOrEqual(2);
  });

  it("is byte-for-byte deterministic", async () => {
    const m = buildDocModel("invoice", approvedInput("invoice"));
    const a = await renderDocModelPdf(m);
    const b = await renderDocModelPdf(m);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it("repeats table headers across page breaks", async () => {
    const base = approvedInput("approval_record");
    const atts = Array.from({ length: 80 }, (_, i) => ({ ...base.bundle.attestations[0]!, id: `att_${i}`, text: `Attestation ${i} `.repeat(6) }));
    const bundle = { ...base.bundle, attestations: atts };
    const m = buildDocModel("approval_record", { ...base, bundle, final: { ...base.final!, bundle }, template: withSections("approval_record", (k) => k === "attestations") });
    const bytes = await renderDocModelPdf(m);
    const n = (await PDFDocument.load(bytes)).getPageCount();
    expect(n).toBeGreaterThan(2);
    const text = pdfText(bytes);
    expect(text.split("\nATTESTATION\n").length - 1).toBe(n);
    for (let i = 1; i <= n; i++) expect(text).toContain(`Page ${i} of ${n}`);
  });

  it("treats HTML/script as plain text", async () => {
    const nasty = "<script>alert('x')</script><b>bold</b> “q” 😀";
    const t = { ...BUILTIN_TEMPLATES.invoice, theme: { ...BUILTIN_TEMPLATES.invoice.theme, footerNote: "<img src=x onerror=alert(1)>" }, text: { ...BUILTIN_TEMPLATES.invoice.text, invoiceNotes: nasty } };
    const m = buildDocModel("invoice", approvedInput("invoice", { template: t }));
    expect(allText(m)).toContain("<script>alert('x')</script>");
    const text = pdfText(await renderDocModelPdf(m));
    expect(text).toContain("<script>alert('x')</script><b>bold</b>");
    expect(text).toContain("<img src=x onerror=alert(1)>");
  });

  it("renders every block type incl. divider, parties, pagebreak and 2-column kv", async () => {
    const model: DocModel = {
      ...buildDocModel("session_note", approvedInput("session_note")),
      blocks: [
        { type: "heading", text: "All blocks", section: "overview" },
        { type: "paragraph", text: "Plain" },
        { type: "paragraph", text: "Notice text", tone: "notice" },
        { type: "list", items: [{ text: "Item", tag: "Custom tag", refs: [1] }] },
        { type: "kv", items: [{ label: "A", value: "1" }, { label: "B", value: "2" }, { label: "C", value: "3" }], columns: 2 },
        { type: "table", columns: [{ label: "X" }, { label: "Y", align: "right" }, { label: "Z" }], rows: [["x1", "y1", "z1"], ["", "", "sub1"]], rowKinds: ["item", "sub"] },
        { type: "parties", parties: [{ label: "Bill to", lines: ["P1"] }, { label: "Participant", lines: ["P2"] }] },
        { type: "totals", rows: [{ label: "Total", value: "$1.00", strong: true }] },
        { type: "callout", tone: "warning", text: "Single line callout" },
        { type: "divider" },
        { type: "pagebreak" },
        { type: "signatures", statement: null, lines: [{ label: "Witness", name: "W", signed: "/s/ W", date: "11/13/2026" }] },
      ],
    };
    const bytes = await renderDocModelPdf(model);
    const text = pdfText(bytes);
    for (const s of ["All blocks", "Notice text", "Custom tag", "x1", "y1", "sub1", "BILL TO", "P2", "$1.00", "Single line callout", "Witness", "/s/ W", "[1]"]) expect(text).toContain(s);
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(2);
  });
});

describe("sampleDocModelInput", () => {
  it("is fixture-marked (approval record only), approved, with a client snapshot + profile, and uses the given template", () => {
    const t = { ...BUILTIN_TEMPLATES.session_note, id: "tpl_mine" };
    const s = sampleDocModelInput(t);
    expect(s.template).toBe(t);
    expect(s.bundle.provenance.evidenceMode).toBe("fixture");
    expect(s.final?.bundle).toBe(s.bundle);
    expect(s.client?.clientRef).toBe(s.bundle.appointment.clientRef);
    expect(s.profile?.legalName).toBe(SAMPLE_PROFILE.legalName);
    expect(buildDocModel("session_note", s).banner).toBeNull();
    expect(buildDocModel("approval_record", { ...s, template: BUILTIN_TEMPLATES.approval_record }).banner).toBe(FIXTURE_BANNER);
    // Billing totals come from the reviewed example (math unchanged).
    expect(s.bundle.billing.amountCents).toBe(validReviewedBundle.billing.amountCents);
    expect(s.bundle.billing.invoice?.totalCents).toBe(validReviewedBundle.billing.amountCents);
  });
});
