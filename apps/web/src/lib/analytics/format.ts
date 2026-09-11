/**
 * Formatting for the numbers `org_usage_summary` returns.
 *
 * Costs arrive as micro-units (25000 is 0.025) because a 15-second voice note
 * costs about 2,542 µUSD and cents would round it to zero — the storage layer
 * said so first (20260903000002) and the screen must not undo it. Six decimal
 * places, trailing zeros trimmed, and the currency code always visible: this
 * is a number an owner compares against an invoice, not a marketing figure, so
 * it is formatted deterministically rather than through `Intl` currency
 * styles whose rounding and symbol placement vary by locale and would make
 * the same micros render as different amounts in Spanish and English.
 */

/** `25000, 'USD'` → `'0.025 USD'`. `0, 'USD'` → `'0 USD'`. */
export function formatMicroCost(costMicros: number, currency: string): string {
  if (!Number.isFinite(costMicros)) return currency;
  const fixed = (costMicros / 1_000_000).toFixed(6);
  const trimmed = fixed.replace(/\.?0+$/, '');
  return `${trimmed} ${currency}`;
}

/** Quantities are whole numbers; grouped for reading, not for arithmetic. */
export function formatQuantity(quantity: number): string {
  return new Intl.NumberFormat('en-US').format(quantity);
}
