/**
 * Phone handoff (GlassCam on iPhone): the deep link that hands a started visit's stream URL
 * to the native bridge. Pure helpers, tested in handoff.test.ts. Protocol: docs/band-bridge.md.
 */

/**
 * `glasscam://band-visit?stream=<encoded streamUrl>&band=<n>&client=<clientRef>`.
 * Carries the client ref only (never a name). `band` is omitted when no number was given.
 * The link contains the stream token: it is a secret until the token expires.
 */
export function glasscamLink(args: { streamUrl: string; bandNumber: number | null; clientRef: string }): string {
  const parts = [`stream=${encodeURIComponent(args.streamUrl)}`];
  if (args.bandNumber !== null) parts.push(`band=${encodeURIComponent(String(args.bandNumber))}`);
  parts.push(`client=${encodeURIComponent(args.clientRef)}`);
  return `glasscam://band-visit?${parts.join("&")}`;
}

/** True when a phone could not reach the stream URL's host (localhost / loopback). */
export function streamHostIsLoopback(streamUrl: string): boolean {
  let host: string;
  try {
    host = new URL(streamUrl).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    return false;
  }
  return host === "localhost" || host.endsWith(".localhost") || host === "::1" || /^127\.\d+\.\d+\.\d+$/.test(host);
}

/** The visit has been stopped and handed to processing (by the phone or from here). */
export function handoffFinished(visit: { status: string; sessionId: string | null }): string | null {
  return visit.status === "stopped" && visit.sessionId ? visit.sessionId : null;
}
