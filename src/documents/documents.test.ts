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
  FIXTURE_BANNER,
  buildDocModel,
  normalizeTemplate,
  renderDocModelPdf,
  sampleDocModelInput,
} from "./index";

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

describe("templates", () => {
  it("builtins: one per kind, valid, all sections enabled in SECTION_KEYS order", () => {
    for (const kind of FILE_KINDS) {
      const t = BUILTIN_TEMPLATES[kind];
      expect(DocumentTemplateSchema.safeParse(t).success).toBe(true);
      expect(t.id).toBe(builtinTemplateId(kind));
      expect(t.builtin).toBe(true);
      expect(t.isDefault).toBe(false);
      expect(t.kind).toBe(kind);
      expect(t.sections).toEqual(SECTION_KEYS[kind].map((key) => ({ key, enabled: true })));
      expect(t.text.invoicePrefix).toBe("INV");
      expect(t.text.representativeSignatureLabel).toBe("");
      expect(normalizeTemplate(kind, t)).toEqual(t);
    }
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
      { key: "attestations", enabled: false },
      { key: "signatures", enabled: false },
    ]);
  });
});

describe("buildDocModel", () => {
  for (const kind of FILE_KINDS) {
    it(`${kind}: each section toggles its blocks on/off`, () => {
      const full = buildDocModel(kind, approvedInput(kind));
      expect(headingSections(full)).toEqual([...SECTION_KEYS[kind]]);
      for (const key of SECTION_KEYS[kind]) {
        const off = buildDocModel(kind, approvedInput(kind, { template: withSections(kind, (k) => k !== key) }));
        expect(headingSections(off)).not.toContain(key);
        expect(headingSections(off)).toHaveLength(SECTION_KEYS[kind].length - 1);
        expect(off.blocks.length).toBeLessThan(full.blocks.length);
        const only = buildDocModel(kind, approvedInput(kind, { template: withSections(kind, (k) => k === key) }));
        expect(headingSections(only)).toEqual([key]);
      }
    });

    it(`${kind}: template order is respected`, () => {
      const reversed = [...SECTION_KEYS[kind]].reverse();
      const m = buildDocModel(kind, approvedInput(kind, { template: withSections(kind, () => true, reversed) }));
      expect(headingSections(m)).toEqual(reversed);
    });
  }

  it("title override, filename, theme passthrough, templateId", () => {
    const t = { ...BUILTIN_TEMPLATES.invoice, id: "tpl_x", text: { ...BUILTIN_TEMPLATES.invoice.text, title: "Statement of services", invoicePrefix: "ACME" } };
    const m = buildDocModel("invoice", approvedInput("invoice", { template: t }));
    expect(m.title).toBe("Statement of services");
    expect(m.templateId).toBe("tpl_x");
    expect(m.filename).toBe("C-104_2026-11-13_invoice_r3.pdf");
    expect(m.header.meta.find((x) => x.label === "Invoice #")?.value).toMatch(/^ACME-[0-9A-F]{8}-R3$/);
    expect(buildDocModel("invoice", approvedInput("invoice")).title).toBe("Invoice");
  });

  it("banners: fixture, draft, both, none", () => {
    const fixtureApproved = buildDocModel("session_note", approvedInput("session_note"));
    expect(fixtureApproved.banner).toBe(FIXTURE_BANNER);
    const draft = buildDocModel("session_note", approvedInput("session_note", { final: null, approval: null }));
    expect(draft.banner).toBe(`${FIXTURE_BANNER} · ${DRAFT_BANNER}`);
    expect(draft.footer.revisionLabel).toContain("not approved");
    const base = approvedInput("session_note");
    const liveBundle = live(base.bundle);
    const liveDraft = buildDocModel("session_note", { ...base, bundle: liveBundle, final: null, approval: null });
    expect(liveDraft.banner).toBe(DRAFT_BANNER);
    expect(liveDraft.blocks.some((b) => b.type === "callout" && b.tone === "draft")).toBe(true);
    const liveFinal: FinalBundle = { ...base.final!, bundle: liveBundle };
    const approved = buildDocModel("session_note", { ...base, bundle: liveBundle, final: liveFinal });
    expect(approved.banner).toBeNull();
    expect(approved.blocks.some((b) => b.type === "callout" && (b.tone === "draft" || b.tone === "fixture"))).toBe(false);
  });

  it("invoice shows client snapshot fields; absent snapshot degrades gracefully", () => {
    const m = buildDocModel("invoice", approvedInput("invoice"));
    const s = allText(m);
    for (const v of ["Sample Participant", "Sam", "Sample self-direction waiver", "AUTH-SAMPLE-0001", "Sample Fiscal Services", "40 h", "Sample Case Manager", "Community living skills (sample)"]) {
      expect(s).toContain(v);
    }
    const none = buildDocModel("invoice", approvedInput("invoice", { client: null }));
    const n = allText(none);
    expect(n).toContain("No funding details on file");
    expect(n).toContain("No custom fields on file");
    expect(n).toContain("Client reference only");
    expect(n).not.toContain("Sample Participant");
    expect(headingSections(none)).toEqual([...SECTION_KEYS.invoice]);
  });

  it("funding block only lists rows that have values", () => {
    const base = approvedInput("invoice");
    const client = { ...base.client!, fundingSource: "Waiver X", authorizationNumber: null, fiscalIntermediary: "  ", authorizedHours: null, caseManager: null };
    const m = buildDocModel("invoice", { ...base, client, template: withSections("invoice", (k) => k === "funding_authorization") });
    const kv = m.blocks.find((b) => b.type === "kv");
    expect(kv && kv.type === "kv" ? kv.items : []).toEqual([{ label: "Funding source", value: "Waiver X" }]);
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

  it("participant direction renders from attestations; absent → Not recorded", () => {
    for (const kind of ["session_note", "invoice"] as const) {
      const m = buildDocModel(kind, approvedInput(kind));
      const s = allText(m);
      expect(s).toContain("Yes — the participant directed the activities");
      expect(s).toContain("Chose the library as the destination");
    }
    const base = approvedInput("session_note");
    const noAtt = { ...base.bundle, attestations: base.bundle.attestations.filter((a) => !a.field.startsWith("participant")) };
    const m = buildDocModel("session_note", { ...base, bundle: noAtt, final: { ...base.final!, bundle: noAtt } });
    expect(allText(m)).toContain("Not recorded");
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

  it("signatures: labels, representative only when set, statement", () => {
    const m = buildDocModel("invoice", approvedInput("invoice"));
    const sig = m.blocks.find((b) => b.type === "signatures");
    expect(sig?.type === "signatures" && sig.lines.map((l) => l.label)).toEqual(["Participant", "Provider"]);
    const t = { ...BUILTIN_TEMPLATES.invoice, text: { ...BUILTIN_TEMPLATES.invoice.text, representativeSignatureLabel: "Representative", attestationStatement: "Custom statement." } };
    const m2 = buildDocModel("invoice", approvedInput("invoice", { template: t }));
    const sig2 = m2.blocks.find((b) => b.type === "signatures");
    expect(sig2?.type === "signatures" && sig2.lines.map((l) => l.label)).toEqual(["Participant", "Provider", "Representative"]);
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
      expect(m.banner).toContain(DRAFT_BANNER);
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
        expect(doc.getTitle()).toContain("C-104");
        const text = pdfText(bytes);
        expect(text).toContain("VEXO FIELD ASSISTANT");
        expect(text).toContain(FIXTURE_BANNER);
        expect(text).toMatch(/Page 1 of \d+/);
        expect(text).toContain("Signatures & attestation");
        if (v.theme.headerNote) expect(text).toContain(v.theme.headerNote);
        if (v.theme.footerNote) expect(text).toContain(v.theme.footerNote);
        if (kind === "invoice") expect(text).toContain("$112.50");
      });
    }
  }

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
    const t = { ...BUILTIN_TEMPLATES.invoice, theme: { ...BUILTIN_TEMPLATES.invoice.theme, headerNote: "<img src=x onerror=alert(1)>" }, text: { ...BUILTIN_TEMPLATES.invoice.text, invoiceNotes: nasty } };
    const m = buildDocModel("invoice", approvedInput("invoice", { template: t }));
    expect(allText(m)).toContain("<script>alert('x')</script>");
    const text = pdfText(await renderDocModelPdf(m));
    expect(text).toContain("<script>alert('x')</script><b>bold</b>");
    expect(text).toContain("<img src=x onerror=alert(1)>");
  });

  it("renders every block type incl. divider and 2-column kv", async () => {
    const model: DocModel = {
      ...buildDocModel("session_note", approvedInput("session_note")),
      blocks: [
        { type: "heading", text: "All blocks", section: "overview" },
        { type: "paragraph", text: "Plain" },
        { type: "paragraph", text: "Notice text", tone: "notice" },
        { type: "list", items: [{ text: "Item", tag: "Custom tag" }] },
        { type: "kv", items: [{ label: "A", value: "1" }, { label: "B", value: "2" }, { label: "C", value: "3" }], columns: 2 },
        { type: "table", columns: [{ label: "X" }, { label: "Y", align: "right" }], rows: [["x1", "y1"]] },
        { type: "totals", rows: [{ label: "Total", value: "$1.00", strong: true }] },
        { type: "callout", tone: "warning", text: "Single line callout" },
        { type: "divider" },
        { type: "signatures", statement: null, lines: [{ label: "Witness", name: "W" }] },
      ],
    };
    const text = pdfText(await renderDocModelPdf(model));
    for (const s of ["All blocks", "Notice text", "Custom tag", "x1", "y1", "$1.00", "Single line callout", "Witness"]) expect(text).toContain(s);
  });
});

describe("sampleDocModelInput", () => {
  it("is fixture-marked, approved, with a client snapshot, and uses the given template", () => {
    const t = { ...BUILTIN_TEMPLATES.session_note, id: "tpl_mine" };
    const s = sampleDocModelInput(t);
    expect(s.template).toBe(t);
    expect(s.bundle.provenance.evidenceMode).toBe("fixture");
    expect(s.final?.bundle).toBe(s.bundle);
    expect(s.client?.clientRef).toBe(s.bundle.appointment.clientRef);
    expect(buildDocModel("session_note", s).banner).toBe(FIXTURE_BANNER);
    // Uses existing reviewed example as a base.
    expect(s.bundle.billing).toEqual(validReviewedBundle.billing);
  });
});
