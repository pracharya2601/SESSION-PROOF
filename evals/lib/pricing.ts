/**
 * APPROXIMATE list prices in USD per million tokens, used only for the pre-run cost
 * estimate and the report. Verify against the provider's pricing page; override with
 * --price-in / --price-out. Unknown models fall back to a conservative default.
 */
export const PRICES_PER_MTOK: Record<string, { in: number; out: number }> = {
  "gpt-4.1": { in: 2, out: 8 },
  "gpt-4.1-mini": { in: 0.4, out: 1.6 },
  "gpt-4o": { in: 2.5, out: 10 },
  "gpt-5": { in: 1.25, out: 10 },
  "gpt-5-mini": { in: 0.25, out: 2 },
  "gpt-5.1": { in: 1.25, out: 10 },
  "gpt-5.2": { in: 1.75, out: 14 },
  "claude-sonnet-5-5": { in: 3, out: 15 },
  "claude-haiku-5-5": { in: 1, out: 5 },
  "claude-opus-5-5": { in: 5, out: 25 },
  "gemini-2.5-pro": { in: 1.25, out: 10 },
  "gemini-2.5-flash": { in: 0.3, out: 2.5 },
  "mistral-large-latest": { in: 2, out: 6 },
  "mistral-medium-latest": { in: 0.4, out: 2 },
  "mistral-small-latest": { in: 0.1, out: 0.3 },
};
const FALLBACK = { in: 5, out: 25 };

export function priceFor(model: string, override?: { in?: number; out?: number }): { in: number; out: number; known: boolean } {
  const p = PRICES_PER_MTOK[model];
  return { in: override?.in ?? p?.in ?? FALLBACK.in, out: override?.out ?? p?.out ?? FALLBACK.out, known: !!p };
}

export function costUsd(inTok: number, outTok: number, price: { in: number; out: number }): number {
  return (inTok * price.in + outTok * price.out) / 1_000_000;
}
