/**
 * Q2 — recording fake `fetch` for every outbound v2 call:
 *   Google OAuth/userinfo/Drive/Gmail, Microsoft OAuth/Graph (OneDrive/Outlook),
 *   Anthropic / OpenAI / Gemini / Mistral.
 * Stateful enough to model a Drive folder walk (lookups miss → create → reuse).
 * Every request (url, method, headers, decoded body) is recorded for assertions.
 */

export interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  /** Body decoded as UTF-8 (lossless for JSON / MIME / multipart heads). */
  body: string;
  bytes: Uint8Array;
}

export type AiResponder = (vendor: "anthropic" | "openai" | "gemini" | "mistral", req: Recorded) => unknown;

/** Any URL that would SEND mail. Must never be hit. */
export const SEND_PATTERNS: RegExp[] = [
  /gmail\.googleapis\.com\/.*\/send\b/i,
  /googleapis\.com\/upload\/gmail\/.*\/send\b/i,
  /graph\.microsoft\.com\/.*\/sendMail\b/i,
  /graph\.microsoft\.com\/.*\/messages\/[^/]+\/send\b/i,
  /graph\.microsoft\.com\/.*\/send\b/i,
];

export const ACCESS_TOKENS = {
  google: "ya29.FAKE-GOOGLE-ACCESS-TOKEN-zz9",
  googleRefresh: "1//FAKE-GOOGLE-REFRESH-TOKEN-zz9",
  microsoft: "EwBFAKE-MS-ACCESS-TOKEN-zz9",
  microsoftRefresh: "M.FAKE-MS-REFRESH-TOKEN-zz9",
} as const;

function b64urlDecode(s: string): string {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(b64, "base64").toString("utf8");
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export class FakeCloud {
  requests: Recorded[] = [];
  unhandled: Recorded[] = [];
  /** Vendor responder for AI calls; set per test. */
  ai: AiResponder | null = null;
  /** Error injection: url regex → status (one-shot). */
  failOnce: { re: RegExp; status: number }[] = [];

  // Google Drive state
  gFolders: { id: string; name: string; parent: string }[] = [];
  gFiles: { id: string; name: string; parent: string; bytes: Uint8Array; method: string }[] = [];
  gDrafts: { id: string; raw: string; mime: string }[] = [];
  // OneDrive state (path → item)
  msItems = new Map<string, { id: string; name: string; webUrl: string; folder: boolean; bytes?: Uint8Array }>();
  msItemPath = new Map<string, string>();
  msDrafts: { id: string; body: any }[] = [];
  private seq = 0;

  fetch: typeof fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input as any, init);
    const bytes = new Uint8Array(await req.arrayBuffer());
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => (headers[k] = v));
    const rec: Recorded = { url: req.url, method: req.method, headers, body: new TextDecoder().decode(bytes), bytes };
    this.requests.push(rec);
    const inj = this.failOnce.findIndex((f) => f.re.test(rec.url));
    if (inj >= 0) {
      const [f] = this.failOnce.splice(inj, 1);
      return json({ error: { code: f!.status, message: "injected failure" } }, f!.status);
    }
    const res = await this.route(rec);
    if (!res) {
      this.unhandled.push(rec);
      return json({ error: { message: `FakeCloud: unhandled ${rec.method} ${rec.url}` } }, 501);
    }
    return res;
  };

  /** Requests whose URL matches any send endpoint (must be empty). */
  sendCalls(): Recorded[] {
    return this.requests.filter((r) => SEND_PATTERNS.some((re) => re.test(r.url)));
  }
  to(re: RegExp): Recorded[] {
    return this.requests.filter((r) => re.test(r.url));
  }
  reset(): void {
    this.requests = [];
    this.unhandled = [];
  }

  private id(prefix: string): string {
    return `${prefix}${++this.seq}`;
  }

  private async route(r: Recorded): Promise<Response | null> {
    const u = new URL(r.url);
    const host = u.host;

    // ---------------------------------------------------------------- OAuth
    if (host === "oauth2.googleapis.com" && u.pathname === "/token") {
      return json({
        access_token: ACCESS_TOKENS.google,
        refresh_token: ACCESS_TOKENS.googleRefresh,
        expires_in: 3599,
        scope: "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/gmail.compose",
        token_type: "Bearer",
      });
    }
    if (host === "oauth2.googleapis.com" && u.pathname === "/revoke") return new Response("", { status: 200 });
    if (host === "openidconnect.googleapis.com" || (host === "www.googleapis.com" && u.pathname.includes("userinfo"))) {
      return json({ sub: "1", email: "provider.google@example.invalid", email_verified: true });
    }
    if (host === "login.microsoftonline.com" && u.pathname.endsWith("/oauth2/v2.0/token")) {
      return json({
        access_token: ACCESS_TOKENS.microsoft,
        refresh_token: ACCESS_TOKENS.microsoftRefresh,
        expires_in: 3600,
        scope: "openid email offline_access User.Read Files.ReadWrite Mail.ReadWrite",
        token_type: "Bearer",
      });
    }

    // ---------------------------------------------------------------- Google Drive
    if (host === "www.googleapis.com" && u.pathname === "/drive/v3/files" && r.method === "GET") {
      const q = u.searchParams.get("q") ?? "";
      const name = /name='((?:\\'|[^'])*)'/.exec(q)?.[1]?.replace(/\\'/g, "'").replace(/\\\\/g, "\\");
      const parent = /'((?:\\'|[^'])*)' in parents/.exec(q)?.[1];
      const isFolder = q.includes("mimeType='application/vnd.google-apps.folder'");
      const pool = isFolder ? this.gFolders : this.gFiles;
      const hit = pool.filter((f) => f.name === name && f.parent === parent);
      return json({ files: hit.map((f) => ({ id: f.id, webViewLink: `https://drive.google.com/drive/folders/${f.id}` })) });
    }
    if (host === "www.googleapis.com" && u.pathname === "/drive/v3/files" && r.method === "POST") {
      const b = JSON.parse(r.body);
      const f = { id: this.id("gfolder_"), name: b.name, parent: b.parents?.[0] ?? "root" };
      this.gFolders.push(f);
      return json({ id: f.id, webViewLink: `https://drive.google.com/drive/folders/${f.id}` });
    }
    if (host === "www.googleapis.com" && u.pathname.startsWith("/upload/drive/v3/files")) {
      const meta = /\r\n\r\n(\{.*?\})\r\n/s.exec(r.body)?.[1];
      const m = meta ? JSON.parse(meta) : {};
      const existingId = u.pathname.split("/")[5];
      const id = existingId ?? this.id("gfile_");
      const parent = m.parents?.[0] ?? this.gFiles.find((x) => x.id === existingId)?.parent ?? "?";
      this.gFiles.push({ id, name: m.name, parent, bytes: r.bytes, method: r.method });
      return json({ id, webViewLink: `https://drive.google.com/file/d/${id}/view` });
    }

    // ---------------------------------------------------------------- Gmail
    if (host === "gmail.googleapis.com" && /\/gmail\/v1\/users\/me\/drafts$/.test(u.pathname) && r.method === "POST") {
      const raw = JSON.parse(r.body)?.message?.raw as string;
      const d = { id: this.id("r-draft"), raw, mime: b64urlDecode(raw ?? "") };
      this.gDrafts.push(d);
      return json({ id: d.id, message: { id: `msg${d.id}`, threadId: "t1", labelIds: ["DRAFT"] } });
    }

    // ---------------------------------------------------------------- Microsoft Graph
    if (host === "graph.microsoft.com") {
      const p = decodeURIComponent(u.pathname.replace(/^\/v1\.0/, ""));
      if (p === "/me") return json({ mail: "provider.ms@example.invalid", userPrincipalName: "provider.ms@example.invalid" });
      if (p === "/me/drive/root" && r.method === "GET") return json({ id: "msroot", webUrl: "https://onedrive.live.com/root" });
      let m = /^\/me\/drive\/root:\/(.+)$/.exec(p);
      if (m && r.method === "GET") {
        const it = this.msItems.get(m[1]!.replace(/:$/, ""));
        return it ? json({ id: it.id, name: it.name, webUrl: it.webUrl, folder: {} }) : json({ error: { code: "itemNotFound" } }, 404);
      }
      m = /^\/me\/drive\/(?:root|items\/([^/:]+))\/children$/.exec(p);
      if (m && r.method === "POST") {
        const b = JSON.parse(r.body);
        const parentPath = m[1] ? this.msItemPath.get(m[1]) ?? "?" : "";
        const path = parentPath ? `${parentPath}/${b.name}` : b.name;
        if (this.msItems.has(path)) return json({ error: { code: "nameAlreadyExists" } }, 409);
        const it = { id: this.id("msfolder_"), name: b.name, webUrl: `https://onedrive.live.com/?id=${encodeURIComponent(path)}`, folder: true };
        this.msItems.set(path, it);
        this.msItemPath.set(it.id, path);
        return json({ id: it.id, name: it.name, webUrl: it.webUrl, folder: {} }, 201);
      }
      m = /^\/me\/drive\/items\/([^/:]+):\/(.+):\/content$/.exec(p);
      if (m && r.method === "PUT") {
        const path = `${this.msItemPath.get(m[1]!) ?? "?"}/${m[2]}`;
        const it = { id: this.id("msfile_"), name: m[2]!, webUrl: `https://onedrive.live.com/?file=${encodeURIComponent(path)}`, folder: false, bytes: r.bytes };
        this.msItems.set(path, it);
        return json({ id: it.id, name: it.name, webUrl: it.webUrl, file: {} }, 201);
      }
      if (p === "/me/messages" && r.method === "POST") {
        const b = JSON.parse(r.body);
        const d = { id: this.id("AAMk-draft-"), body: b };
        this.msDrafts.push(d);
        return json({ id: d.id, isDraft: true, webLink: `https://outlook.office365.com/owa/?ItemID=${d.id}&exvsurl=1&viewmodel=ReadMessageItem` }, 201);
      }
      return null;
    }

    // ---------------------------------------------------------------- AI vendors
    const vendor =
      host === "api.anthropic.com"
        ? "anthropic"
        : host === "api.openai.com"
          ? "openai"
          : host === "generativelanguage.googleapis.com"
            ? "gemini"
            : host === "api.mistral.ai"
              ? "mistral"
              : null;
    if (vendor) {
      if (!this.ai) return json({ error: { message: "no AI responder" } }, 500);
      const out = this.ai(vendor, r);
      return json(wrapAi(vendor, out));
    }
    return null;
  }
}

/** Wraps a structured output in each vendor's tool/JSON response envelope. */
export function wrapAi(vendor: "anthropic" | "openai" | "gemini" | "mistral", out: unknown): unknown {
  const args = JSON.stringify(out);
  switch (vendor) {
    case "anthropic":
      return {
        id: "msg_fake",
        type: "message",
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_1", name: "record_session_facts", input: out }],
        stop_reason: "tool_use",
      };
    case "openai":
    case "mistral":
      return {
        id: "chatcmpl-fake",
        choices: [
          {
            index: 0,
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{ id: "call_1", type: "function", function: { name: "record_session_facts", arguments: args } }],
            },
          },
        ],
      };
    case "gemini":
      return { candidates: [{ content: { role: "model", parts: [{ text: args }] }, finishReason: "STOP" }] };
  }
}
