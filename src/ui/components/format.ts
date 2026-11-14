export function formatCents(cents: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

/** Formats an instant range in the appointment's own IANA timezone. */
export function formatTimeRange(startIso: string, endIso: string, timeZone: string): string {
  try {
    const date = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", month: "short", day: "numeric" });
    const time = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" });
    const tzName =
      new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short" })
        .formatToParts(new Date(startIso))
        .find((p) => p.type === "timeZoneName")?.value ?? timeZone;
    const s = new Date(startIso);
    const e = new Date(endIso);
    return `${date.format(s)}, ${time.format(s)}–${time.format(e)} ${tzName}`;
  } catch {
    return `${startIso} – ${endIso} (${timeZone})`;
  }
}
