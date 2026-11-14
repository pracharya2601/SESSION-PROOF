export type Route =
  | { name: "today" }
  | { name: "session"; id: string }
  | { name: "files" }
  | { name: "connections" }
  | { name: "settings" };

export type NavKey = "today" | "files" | "connections" | "settings";

/** Parses `#/path?query`. Query strings (e.g. `#/connections?connected=google`) are ignored here; pages read them. */
export function parseHash(hash: string): Route {
  const path = (hash.replace(/^#/, "").split("?")[0] ?? "").replace(/\/+$/, "") || "/";
  const m = /^\/sessions\/([^/]+)$/.exec(path);
  if (m && m[1]) {
    try {
      return { name: "session", id: decodeURIComponent(m[1]) };
    } catch {
      return { name: "today" };
    }
  }
  if (path === "/files") return { name: "files" };
  if (path === "/connections") return { name: "connections" };
  if (path === "/settings") return { name: "settings" };
  return { name: "today" };
}

export function routeKey(r: Route): string {
  return r.name === "session" ? `session:${r.id}` : r.name;
}

export function navKeyOf(r: Route): NavKey {
  return r.name === "session" ? "today" : r.name;
}

export const ROUTE_TITLES: Record<Route["name"], string> = {
  today: "Today",
  session: "Session review",
  files: "Files",
  connections: "Connections",
  settings: "Settings",
};
