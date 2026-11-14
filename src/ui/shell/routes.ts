export type Route =
  | { name: "today" }
  | { name: "session"; id: string }
  | { name: "files" }
  | { name: "connections" }
  | { name: "settings" }
  // v3
  | { name: "clients" }
  | { name: "client"; ref: string }
  | { name: "templates" }
  | { name: "template"; id: string }
  | { name: "runs" }
  | { name: "run"; runId: string };

export type NavKey = "today" | "runs" | "files" | "clients" | "templates" | "connections" | "settings";

const DETAIL: { re: RegExp; make: (v: string) => Route }[] = [
  { re: /^\/sessions\/([^/]+)$/, make: (id) => ({ name: "session", id }) },
  { re: /^\/clients\/([^/]+)$/, make: (ref) => ({ name: "client", ref }) },
  { re: /^\/templates\/([^/]+)$/, make: (id) => ({ name: "template", id }) },
  { re: /^\/runs\/([^/]+)$/, make: (runId) => ({ name: "run", runId }) },
];

const SIMPLE: Record<string, Route> = {
  "/files": { name: "files" },
  "/connections": { name: "connections" },
  "/settings": { name: "settings" },
  "/clients": { name: "clients" },
  "/templates": { name: "templates" },
  "/runs": { name: "runs" },
};

/** Parses `#/path?query`. Query strings (e.g. `#/connections?connected=google`) are ignored here; pages read them. */
export function parseHash(hash: string): Route {
  const path = (hash.replace(/^#/, "").split("?")[0] ?? "").replace(/\/+$/, "") || "/";
  for (const d of DETAIL) {
    const m = d.re.exec(path);
    if (m && m[1]) {
      try {
        return d.make(decodeURIComponent(m[1]));
      } catch {
        return { name: "today" };
      }
    }
  }
  return SIMPLE[path] ?? { name: "today" };
}

export function routeKey(r: Route): string {
  switch (r.name) {
    case "session":
      return `session:${r.id}`;
    case "client":
      return `client:${r.ref}`;
    case "template":
      return `template:${r.id}`;
    case "run":
      return `run:${r.runId}`;
    default:
      return r.name;
  }
}

export function navKeyOf(r: Route): NavKey {
  switch (r.name) {
    case "session":
      return "today";
    case "client":
      return "clients";
    case "template":
      return "templates";
    case "run":
      return "runs";
    default:
      return r.name;
  }
}

export const ROUTE_TITLES: Record<Route["name"], string> = {
  today: "Today",
  session: "Session review",
  files: "Files",
  connections: "Connections",
  settings: "Settings",
  clients: "Clients",
  client: "Client",
  templates: "Templates",
  template: "Template designer",
  runs: "Runs",
  run: "Run detail",
};

/** Hash links for detail routes (values are URL-encoded). */
export const hrefs = {
  client: (ref: string) => `#/clients/${encodeURIComponent(ref)}`,
  template: (id: string) => `#/templates/${encodeURIComponent(id)}`,
  run: (runId: string) => `#/runs/${encodeURIComponent(runId)}`,
  session: (id: string) => `#/sessions/${encodeURIComponent(id)}`,
};
