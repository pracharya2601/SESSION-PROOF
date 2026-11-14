/** Deterministic identity rules (handoff §10.2). */

/** Workflow identity = session identity + processing revision. */
export function workflowInstanceId(sessionId: string, processingRevision: number): string {
  return `wf-${sessionId}-r${processingRevision}`;
}

/** Delivery identity = operation type + target identity/revision. */
export function deliveryKey(
  operation: "process_session" | "approval_notification",
  sessionId: string,
  revision: number,
): string {
  return `${operation}:${sessionId}:${revision}`;
}

/** Approval identity = session identity + approved bundle revision. */
export function approvalId(sessionId: string, bundleRevision: number): string {
  return `approval-${sessionId}-r${bundleRevision}`;
}

export async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Session identity = provider + immutable appointment occurrence. */
export async function sessionIdFor(providerId: string, occurrenceId: string): Promise<string> {
  return `sess_${(await sha256Hex(`${providerId}\u0000${occurrenceId}`)).slice(0, 24)}`;
}
