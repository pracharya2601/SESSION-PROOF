import { describe, expect, it } from "vitest";
import {
  CloudApiError,
  CloudInputError,
  escapeDriveQuery,
  mailAdapterFor,
  storageAdapterFor,
  type CloudAdapterOptions,
} from "./index";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Uint8Array | string | undefined;
}
type Reply = { status?: number; json?: unknown; headers?: Record<string, string> };
type Route = (c: Call) => Reply;

function fakeFetch(route: Route) {
  const calls: Call[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const c: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: { ...(init?.headers as Record<string, string>) },
      body: init?.body as Uint8Array | string | undefined,
    };
    calls.push(c);
    const r = route(c);
    return new Response(r.json === undefined ? null : JSON.stringify(r.json), {
      status: r.status ?? 200,
      headers: { "content-type": "application/json", ...(r.headers ?? {}) },
    });
  }) as typeof fetch;
  return { f, calls };
}
const sleeps: number[] = [];
const opts = (o: Partial<CloudAdapterOptions> = {}): CloudAdapterOptions => ({
  sleep: async (ms) => void sleeps.push(ms),
  boundary: () => "BOUNDARY",
  now: () => new Date("2026-11-13T18:00:00Z"),
  messageId: () => "<id-1@field-assist.invalid>",
  ...o,
});
const TOKEN = "ya29.secret-token";
const dec = new TextDecoder();
const bodyText = (c: Call) => (typeof c.body === "string" ? c.body : dec.decode(c.body));
const qOf = (url: string) => new URL(url).searchParams.get("q");
const pdf = (n = 300) => Uint8Array.from({ length: n }, (_, i) => (i * 37 + 11) % 256);

function b64urlDecode(s: string): string {
  const b = s.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(b, "base64").toString("utf8");
}

describe("escapeDriveQuery", () => {
  it("escapes backslash then quote", () => {
    expect(escapeDriveQuery(`a\\b'c`)).toBe(`a\\\\b\\'c`);
  });
});

describe("Google Drive", () => {
  it("folder walk creates only missing segments", async () => {
    const { f, calls } = fakeFetch((c) => {
      if (c.method === "GET") {
        const q = qOf(c.url)!;
        if (q.startsWith("name='Vexo'")) return { json: { files: [{ id: "F1", webViewLink: "https://d/F1" }] } };
        return { json: { files: [] } };
      }
      const name = JSON.parse(bodyText(c)).name;
      return { json: { id: `new-${name}`, webViewLink: `https://d/new-${name}` } };
    });
    const a = storageAdapterFor("google", TOKEN, f, opts());
    const r = await a.ensureFolder("/Vexo/O'Brien/ 2026-11-13 /");
    expect(r).toEqual({ folderId: "new-2026-11-13", webUrl: "https://d/new-2026-11-13" });
    expect(calls.map((c) => c.method)).toEqual(["GET", "GET", "POST", "GET", "POST"]);
    expect(calls[0]!.url).toBe(
      "https://www.googleapis.com/drive/v3/files?" +
        new URLSearchParams({
          q: "name='Vexo' and mimeType='application/vnd.google-apps.folder' and 'root' in parents and trashed=false",
          fields: "files(id,webViewLink)",
        }),
    );
    expect(qOf(calls[1]!.url)).toBe(
      "name='O\\'Brien' and mimeType='application/vnd.google-apps.folder' and 'F1' in parents and trashed=false",
    );
    expect(calls[2]!.url).toBe("https://www.googleapis.com/drive/v3/files?fields=id,webViewLink");
    expect(JSON.parse(bodyText(calls[2]!))).toEqual({
      name: "O'Brien",
      mimeType: "application/vnd.google-apps.folder",
      parents: ["F1"],
    });
    expect(qOf(calls[3]!.url)).toContain("'new-O'Brien' in parents".replace("O'", "O\\'"));
    for (const c of calls) expect(c.headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("uploads new files as multipart/related", async () => {
    const bytes = pdf();
    const { f, calls } = fakeFetch((c) =>
      c.method === "GET" ? { json: { files: [] } } : { json: { id: "FILE1", webViewLink: "https://d/FILE1" } },
    );
    const r = await storageAdapterFor("google", TOKEN, f, opts()).uploadFile("FOLD", "note.pdf", bytes, "application/pdf");
    expect(r).toEqual({ fileId: "FILE1", webUrl: "https://d/FILE1" });
    expect(qOf(calls[0]!.url)).toBe(
      "name='note.pdf' and 'FOLD' in parents and mimeType!='application/vnd.google-apps.folder' and trashed=false",
    );
    const up = calls[1]!;
    expect(up.method).toBe("POST");
    expect(up.url).toBe("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink");
    expect(up.headers["Content-Type"]).toBe("multipart/related; boundary=BOUNDARY");
    const body = up.body as Uint8Array;
    const head =
      `--BOUNDARY\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
      `{"name":"note.pdf","parents":["FOLD"],"mimeType":"application/pdf"}\r\n` +
      `--BOUNDARY\r\nContent-Type: application/pdf\r\n\r\n`;
    const tail = `\r\n--BOUNDARY--\r\n`;
    expect(dec.decode(body.subarray(0, head.length))).toBe(head);
    expect(Array.from(body.subarray(head.length, head.length + bytes.length))).toEqual(Array.from(bytes));
    expect(dec.decode(body.subarray(head.length + bytes.length))).toBe(tail);
  });

  it("updates an existing same-name file via PATCH upload", async () => {
    const { f, calls } = fakeFetch((c) =>
      c.method === "GET" ? { json: { files: [{ id: "OLD" }] } } : { json: { id: "OLD", webViewLink: "https://d/OLD" } },
    );
    const r = await storageAdapterFor("google", TOKEN, f, opts()).uploadFile("FOLD", "note.pdf", pdf(10), "application/pdf");
    expect(r.fileId).toBe("OLD");
    expect(calls[1]!.method).toBe("PATCH");
    expect(calls[1]!.url).toBe("https://www.googleapis.com/upload/drive/v3/files/OLD?uploadType=multipart&fields=id,webViewLink");
    expect(dec.decode(calls[1]!.body as Uint8Array)).toContain(`{"name":"note.pdf","mimeType":"application/pdf"}`);
  });

  it("rejects control characters in names", async () => {
    const { f, calls } = fakeFetch(() => ({ json: {} }));
    const a = storageAdapterFor("google", TOKEN, f, opts());
    await expect(a.uploadFile("F", "a\r\nb.pdf", pdf(1), "application/pdf")).rejects.toBeInstanceOf(CloudInputError);
    await expect(a.ensureFolder("A/b\nc")).rejects.toBeInstanceOf(CloudInputError);
    expect(calls).toHaveLength(0);
  });
});

const draft = (over: Record<string, unknown> = {}) => ({
  to: ["billing@example.com", "b@example.org"],
  cc: ["cc@example.com"],
  subject: "Session documentation — C-104 — 2026-11-13",
  bodyText: "Hello,\nAttached. Café ✓",
  attachments: [
    { filename: "C-104_note.pdf", contentType: "application/pdf", bytes: pdf(500) },
    { filename: "C-104_invoice.pdf", contentType: "application/pdf", bytes: pdf(77) },
  ],
  ...over,
});

/** Tiny MIME parser for assertions. */
function parseMime(mime: string) {
  const [rawHead, ...rest] = mime.split("\r\n\r\n");
  const unfolded = rawHead!.replace(/\r\n /g, " ");
  const headers = Object.fromEntries(
    unfolded.split("\r\n").map((l) => [l.slice(0, l.indexOf(":")).toLowerCase(), l.slice(l.indexOf(":") + 2)]),
  );
  const boundary = /boundary="([^"]+)"/.exec(headers["content-type"]!)![1]!;
  const body = rest.join("\r\n\r\n");
  const parts = body
    .split(`--${boundary}`)
    .slice(1, -1)
    .map((p) => {
      const t = p.replace(/^\r\n/, "").replace(/\r\n$/, "");
      const i = t.indexOf("\r\n\r\n");
      const h = Object.fromEntries(
        t
          .slice(0, i)
          .replace(/\r\n /g, " ")
          .split("\r\n")
          .map((l) => [l.slice(0, l.indexOf(":")).toLowerCase(), l.slice(l.indexOf(":") + 2)]),
      );
      return { headers: h, body: t.slice(i + 4) };
    });
  return { headers, parts, body, boundary };
}
function decodeWords(v: string): string {
  return v
    .split(" ")
    .map((w) => {
      const m = /^=\?UTF-8\?B\?([^?]*)\?=$/.exec(w);
      return m ? Buffer.from(m[1]!, "base64") : Buffer.from(w);
    })
    .reduce((acc, b) => Buffer.concat([acc, b]), Buffer.alloc(0))
    .toString("utf8");
}

describe("Gmail draft", () => {
  it("POSTs a base64url raw MIME with attachments and encoded subject", async () => {
    const d = draft();
    const { f, calls } = fakeFetch(() => ({ json: { id: "r-1", message: { id: "m-1" } } }));
    const r = await mailAdapterFor("google", TOKEN, f, opts()).createDraft(d);
    expect(r).toEqual({ draftId: "r-1", webUrl: "https://mail.google.com/mail/u/0/#drafts?compose=m-1" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toBe("https://gmail.googleapis.com/gmail/v1/users/me/drafts");
    const raw = JSON.parse(bodyText(calls[0]!)).message.raw as string;
    expect(raw).toMatch(/^[A-Za-z0-9_-]+$/);
    const mime = b64urlDecode(raw);
    expect(mime).toMatch(/^[\x20-\x7e\r\n]*$/); // 7-bit
    for (const line of mime.split("\r\n")) expect(line.length).toBeLessThanOrEqual(76);
    expect(mime.replace(/\r\n/g, "")).not.toContain("\n");

    const m = parseMime(mime);
    expect(m.headers["mime-version"]).toBe("1.0");
    expect(m.headers["to"]).toBe("billing@example.com, b@example.org");
    expect(m.headers["cc"]).toBe("cc@example.com");
    expect(m.headers["date"]).toBe("Fri, 13 Nov 2026 18:00:00 +0000");
    expect(m.headers["message-id"]).toBe("<id-1@field-assist.invalid>");
    expect(m.headers["subject"]).toMatch(/^=\?UTF-8\?B\?/);
    expect(decodeWords(m.headers["subject"]!)).toBe(d.subject);
    expect(m.headers["content-type"]).toMatch(/^multipart\/mixed; boundary="/);
    expect(mime.endsWith(`--${m.boundary}--\r\n`)).toBe(true);

    expect(m.parts).toHaveLength(3);
    expect(m.parts[0]!.headers["content-type"]).toBe(`text/plain; charset="UTF-8"`);
    expect(Buffer.from(m.parts[0]!.body.replace(/\r\n/g, ""), "base64").toString("utf8")).toBe(
      "Hello,\r\nAttached. Café ✓",
    );
    d.attachments.forEach((a, i) => {
      const p = m.parts[i + 1]!;
      expect(p.headers["content-type"]).toBe(`application/pdf; name="${a.filename}"`);
      expect(p.headers["content-disposition"]).toBe(`attachment; filename="${a.filename}"`);
      expect(p.headers["content-transfer-encoding"]).toBe("base64");
      for (const l of p.body.split("\r\n")) expect(l.length).toBeLessThanOrEqual(76);
      expect(Array.from(Buffer.from(p.body.replace(/\r\n/g, ""), "base64"))).toEqual(Array.from(a.bytes));
    });
  });

  it("splits long non-ASCII subjects into ≤75-char encoded words", async () => {
    const subject = "Sitzungsdokumentation für Müller — ".repeat(4);
    const { f, calls } = fakeFetch(() => ({ json: { id: "r", message: { id: "m" } } }));
    await mailAdapterFor("google", TOKEN, f, opts()).createDraft(draft({ subject, cc: [] }));
    const m = parseMime(b64urlDecode(JSON.parse(bodyText(calls[0]!)).message.raw));
    expect(m.headers["cc"]).toBeUndefined();
    const words = m.headers["subject"]!.split(" ");
    expect(words.length).toBeGreaterThan(1);
    for (const w of words) expect(w.length).toBeLessThanOrEqual(75);
    expect(decodeWords(m.headers["subject"]!)).toBe(subject);
  });

  it.each([
    ["subject CRLF", { subject: "Hi\r\nBcc: evil@x.com" }],
    ["subject LF", { subject: "Hi\nX" }],
    ["recipient CRLF", { to: ["a@example.com\r\nBcc: evil@x.com"] }],
    ["bad email", { to: ["not-an-email"] }],
    ["cc comma smuggling", { cc: ["a@example.com, evil@x.com"] }],
    ["no recipients", { to: [] }],
    ["filename CRLF", { attachments: [{ filename: "a.pdf\r\nX-Evil: 1", contentType: "application/pdf", bytes: pdf(1) }] }],
    ["content-type injection", { attachments: [{ filename: "a.pdf", contentType: "application/pdf\r\nX: 1", bytes: pdf(1) }] }],
  ])("rejects header injection: %s", async (_n, over) => {
    for (const p of ["google", "microsoft"] as const) {
      const { f, calls } = fakeFetch(() => ({ json: {} }));
      await expect(mailAdapterFor(p, TOKEN, f, opts()).createDraft(draft(over))).rejects.toBeInstanceOf(CloudInputError);
      expect(calls).toHaveLength(0);
    }
  });
});

describe("OneDrive", () => {
  const G = "https://graph.microsoft.com/v1.0";

  it("returns the folder directly when the full path exists", async () => {
    const { f, calls } = fakeFetch(() => ({ json: { id: "X", webUrl: "https://od/X" } }));
    expect(await storageAdapterFor("microsoft", TOKEN, f, opts()).ensureFolder("Vexo Field/C 104")).toEqual({
      folderId: "X",
      webUrl: "https://od/X",
    });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([`GET ${G}/me/drive/root:/Vexo%20Field/C%20104`]);
  });

  it("creates only missing segments and resolves a 409 race by re-GET", async () => {
    let racedB = false;
    const { f, calls } = fakeFetch((c) => {
      if (c.method === "GET") {
        if (c.url === `${G}/me/drive/root:/A`) return { json: { id: "IA", webUrl: "https://od/A" } };
        if (c.url === `${G}/me/drive/root:/A/B` && racedB) return { json: { id: "IB", webUrl: "https://od/B" } };
        return { status: 404, json: { error: { code: "itemNotFound", message: "nope" } } };
      }
      const name = JSON.parse(bodyText(c)).name;
      if (name === "B") {
        racedB = true;
        return { status: 409, json: { error: { code: "nameAlreadyExists" } } };
      }
      return { status: 201, json: { id: `I${name}`, webUrl: `https://od/${name}` } };
    });
    const r = await storageAdapterFor("microsoft", TOKEN, f, opts()).ensureFolder("A/B/C");
    expect(r).toEqual({ folderId: "IC", webUrl: "https://od/C" });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET ${G}/me/drive/root:/A/B/C`,
      `GET ${G}/me/drive/root:/A`,
      `GET ${G}/me/drive/root:/A/B`,
      `POST ${G}/me/drive/items/IA/children`,
      `GET ${G}/me/drive/root:/A/B`,
      `POST ${G}/me/drive/items/IB/children`,
    ]);
    expect(JSON.parse(bodyText(calls[3]!))).toEqual({
      name: "B",
      folder: {},
      "@microsoft.graph.conflictBehavior": "fail",
    });
  });

  it("creates top-level folder under root/children", async () => {
    const { f, calls } = fakeFetch((c) =>
      c.method === "GET" ? { status: 404, json: {} } : { status: 201, json: { id: "N", webUrl: null } },
    );
    await storageAdapterFor("microsoft", TOKEN, f, opts()).ensureFolder("New");
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET ${G}/me/drive/root:/New`,
      `GET ${G}/me/drive/root:/New`,
      `POST ${G}/me/drive/root/children`,
    ]);
  });

  it("uploads small files with a replace PUT", async () => {
    const bytes = pdf(1000);
    const { f, calls } = fakeFetch(() => ({ status: 201, json: { id: "FID", webUrl: "https://od/f" } }));
    const r = await storageAdapterFor("microsoft", TOKEN, f, opts()).uploadFile("FOLD!1", "C-104 note.pdf", bytes, "application/pdf");
    expect(r).toEqual({ fileId: "FID", webUrl: "https://od/f" });
    expect(calls[0]!.method).toBe("PUT");
    expect(calls[0]!.url).toBe(
      `${G}/me/drive/items/FOLD!1:/C-104%20note.pdf:/content?@microsoft.graph.conflictBehavior=replace`,
    );
    expect(calls[0]!.headers["Content-Type"]).toBe("application/pdf");
    expect(calls[0]!.body).toBe(bytes);
  });

  it("uses an upload session above 4 MB without sending the token to uploadUrl", async () => {
    const size = 4 * 1024 * 1024 + 5;
    const bytes = new Uint8Array(size);
    const { f, calls } = fakeFetch((c) => {
      if (c.url.endsWith("createUploadSession")) return { json: { uploadUrl: "https://up.example/sess" } };
      const range = c.headers["Content-Range"]!;
      return range.endsWith(`-${size - 1}/${size}`) ? { status: 201, json: { id: "BIG", webUrl: "https://od/big" } } : { status: 202, json: {} };
    });
    const r = await storageAdapterFor("microsoft", TOKEN, f, opts()).uploadFile("F", "big.pdf", bytes, "application/pdf");
    expect(r.fileId).toBe("BIG");
    expect(calls[0]!.url).toBe(`${G}/me/drive/items/F:/big.pdf:/createUploadSession`);
    expect(calls.slice(1).map((c) => c.headers["Content-Range"])).toEqual([
      `bytes 0-3932159/${size}`,
      `bytes 3932160-${size - 1}/${size}`,
    ]);
    for (const c of calls.slice(1)) expect(c.headers.Authorization).toBeUndefined();
  });

  it("rejects names OneDrive disallows", async () => {
    const { f } = fakeFetch(() => ({ json: {} }));
    const a = storageAdapterFor("microsoft", TOKEN, f, opts());
    await expect(a.uploadFile("F", "a:b.pdf", pdf(1), "application/pdf")).rejects.toBeInstanceOf(CloudInputError);
    await expect(a.ensureFolder("A/b|c")).rejects.toBeInstanceOf(CloudInputError);
  });
});

describe("Outlook draft", () => {
  it("POSTs /me/messages with recipients and base64 attachments, never /send", async () => {
    const d = draft();
    const { f, calls } = fakeFetch(() => ({ status: 201, json: { id: "MSG", webLink: "https://outlook.office365.com/owa/?ItemID=MSG" } }));
    const r = await mailAdapterFor("microsoft", TOKEN, f, opts()).createDraft(d);
    expect(r).toEqual({ draftId: "MSG", webUrl: "https://outlook.office365.com/owa/?ItemID=MSG" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toBe("https://graph.microsoft.com/v1.0/me/messages");
    expect(calls[0]!.url).not.toContain("send");
    const body = JSON.parse(bodyText(calls[0]!));
    expect(body.subject).toBe(d.subject);
    expect(body.body).toEqual({ contentType: "Text", content: d.bodyText });
    expect(body.toRecipients).toEqual([
      { emailAddress: { address: "billing@example.com" } },
      { emailAddress: { address: "b@example.org" } },
    ]);
    expect(body.ccRecipients).toEqual([{ emailAddress: { address: "cc@example.com" } }]);
    expect(body.attachments).toHaveLength(2);
    body.attachments.forEach((a: Record<string, string>, i: number) => {
      expect(a["@odata.type"]).toBe("#microsoft.graph.fileAttachment");
      expect(a.name).toBe(d.attachments[i]!.filename);
      expect(a.contentType).toBe("application/pdf");
      expect(Array.from(Buffer.from(a.contentBytes!, "base64"))).toEqual(Array.from(d.attachments[i]!.bytes));
    });
  });

  it("rejects attachments over the inline limit with a quota error", async () => {
    const { f, calls } = fakeFetch(() => ({ json: {} }));
    const big = { filename: "a.pdf", contentType: "application/pdf", bytes: new Uint8Array(3 * 1024 * 1024) };
    await expect(mailAdapterFor("microsoft", TOKEN, f, opts()).createDraft(draft({ attachments: [big] }))).rejects.toMatchObject({
      code: "quota",
    });
    expect(calls).toHaveLength(0);
  });
});

describe("error mapping + retry", () => {
  const run = async (replies: Reply[], provider: "google" | "microsoft" = "google") => {
    sleeps.length = 0;
    let i = 0;
    const { f, calls } = fakeFetch(() => replies[Math.min(i++, replies.length - 1)]!);
    const p = storageAdapterFor(provider, TOKEN, f, opts()).ensureFolder("A");
    return { p, calls };
  };

  it.each<[string, Reply, string, boolean]>([
    ["401", { status: 401, json: { error: { message: "Invalid Credentials" } } }, "auth", false],
    ["403 forbidden", { status: 403, json: { error: { errors: [{ reason: "insufficientPermissions" }] } } }, "auth", false],
    ["404", { status: 404, json: {} }, "not_found", false],
    ["403 storage quota", { status: 403, json: { error: { errors: [{ reason: "storageQuotaExceeded" }] } } }, "quota", false],
    ["400", { status: 400, json: { error: { message: "bad" } } }, "provider", false],
  ])("maps %s without retry", async (_n, reply, code, retryable) => {
    const { p, calls } = await run([reply]);
    const err = (await p.catch((e) => e)) as CloudApiError;
    expect(err).toBeInstanceOf(CloudApiError);
    expect(err.code).toBe(code);
    expect(err.retryable).toBe(retryable);
    expect(err.message).not.toContain(TOKEN);
    expect(calls).toHaveLength(1);
  });

  it.each<[string, Reply, string]>([
    ["429", { status: 429, json: {} }, "rate_limited"],
    ["403 rateLimitExceeded", { status: 403, json: { error: { errors: [{ reason: "rateLimitExceeded" }] } } }, "rate_limited"],
    ["403 userRateLimitExceeded", { status: 403, json: { error: { errors: [{ reason: "userRateLimitExceeded" }] } } }, "rate_limited"],
    ["503", { status: 503, json: {} }, "provider"],
  ])("retries %s at most twice then throws", async (_n, reply, code) => {
    const { p, calls } = await run([reply]);
    await expect(p).rejects.toMatchObject({ code, retryable: true });
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([500, 1000]);
  });

  it("honours Retry-After (capped) and succeeds after a transient failure", async () => {
    const { p, calls } = await run([
      { status: 429, json: {}, headers: { "retry-after": "3" } },
      { status: 502, json: {} },
      { json: { files: [{ id: "OK", webViewLink: null }] } },
    ]);
    await expect(p).resolves.toEqual({ folderId: "OK", webUrl: null });
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([3000, 1000]);
  });

  it("maps Graph 507 to quota and network failures to retryable provider errors", async () => {
    const { p } = await run([{ status: 507, json: {} }], "microsoft");
    await expect(p).rejects.toMatchObject({ code: "quota", retryable: false });

    sleeps.length = 0;
    let n = 0;
    const f = (async () => {
      n++;
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    await expect(storageAdapterFor("google", TOKEN, f, opts()).ensureFolder("A")).rejects.toMatchObject({
      status: 0,
      code: "provider",
      retryable: true,
    });
    expect(n).toBe(3);
  });
});
