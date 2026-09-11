/**
 * The window an analytics request asks for.
 *
 * Presets, not free-form dates, and that is a decision rather than a
 * limitation: the RPC behind this refuses windows longer than 366 days
 * (P3J04) and unordered ones (P3J03), and a closed set of presets means the
 * route can never hand it either. The day a custom-date picker is approved is
 * the day this file grows a parser — and the validation below is where its
 * tests will land.
 *
 * `to` is the instant of the request, `from` is `days` before it. The RPC
 * treats the window as [from, to): an event exactly at `to` belongs to the
 * next window, not this one, and an event counted in two adjacent reports
 * would be a total nobody could reconcile.
 */

export const USAGE_RANGES = ['7d', '30d', '90d'] as const;

export type UsageRange = (typeof USAGE_RANGES)[number];

const RANGE_DAYS: Record<UsageRange, number> = {
  '7d': 7,
  '30d': 30,
  '90d': 90,
};

export const DEFAULT_USAGE_RANGE: UsageRange = '30d';

export interface UsageWindow {
  range: UsageRange;
  /** Inclusive. ISO string, as the RPC receives it. */
  from: string;
  /** Exclusive. ISO string, as the RPC receives it. */
  to: string;
}

/**
 * Resolve `?range=` against a caller-supplied "now".
 *
 * Returns null for a value that is not one of the presets. A missing value is
 * not an error — it is the default — but a *wrong* value is: silently
 * answering a 30-day question that was asked as 7 days is answering a
 * different question than the one asked, which is the cursor rule from the
 * inbox route applied to time.
 *
 * `now` is a parameter so tests are arithmetic, not sleeps.
 */
export function resolveUsageWindow(raw: string | null, now: Date): UsageWindow | null {
  if (raw === null) raw = DEFAULT_USAGE_RANGE;
  if (!USAGE_RANGES.includes(raw as UsageRange)) return null;

  const range = raw as UsageRange;
  const to = now.getTime();
  const from = to - RANGE_DAYS[range] * 24 * 60 * 60 * 1000;

  return {
    range,
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
  };
}
