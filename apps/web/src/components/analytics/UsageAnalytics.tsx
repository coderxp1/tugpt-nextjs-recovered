'use client';

/**
 * @file UsageAnalytics.tsx
 * @description Analytics v1: what the organization's AI is costing it.
 *
 * THE SCREEN'S ONE JOB IS TO NOT LIE
 *
 * Every number here comes from `org_usage_summary` (20260911000001), which was
 * written around two refusals: an unpriced call is never valued at zero, and a
 * cost that could not be converted to the accounting currency is never summed
 * as if it had been. This component is where those refusals become sentences —
 * `analytics.unpricedNotice` and `analytics.unconvertedNotice` — because a
 * total with no caveat next to it reads as complete, and the spend nobody has
 * priced yet is exactly the spend worth looking at.
 *
 * It is also why there is no chart. A chart of one currency total across two
 * currencies, or of a month where half the calls were unpriced, would be the
 * same lie with better posture. v1 is a table an owner can reconcile against
 * an invoice; a visualization is a later conversation with real data in front
 * of it.
 *
 * READ-ONLY. Nothing here sends, enables or changes anything — no WhatsApp,
 * no provider calls, no flags.
 */

import { useCallback, useEffect, useState } from 'react';
import type { UsageSummary } from '@tugpt/database';
import { useT } from '@/i18n/provider';
import { formatDateTime } from '@/i18n';
import { apiErrorText } from '@/lib/draft-api/error-text';
import {
  DEFAULT_USAGE_RANGE,
  USAGE_RANGES,
  type UsageRange,
} from '@/lib/analytics/window';
import { formatMicroCost, formatQuantity } from '@/lib/analytics/format';

interface UsageResponse {
  range: UsageRange;
  window: { from: string; to: string };
  summary: UsageSummary;
}

export function UsageAnalytics() {
  const t = useT();
  const [range, setRange] = useState<UsageRange>(DEFAULT_USAGE_RANGE);
  const [data, setData] = useState<UsageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/v1/analytics/usage?range=${range}`);
        const body = await res.json();
        if (cancelled) return;

        if (!res.ok) {
          setError(apiErrorText(t, body));
          setData(null);
        } else {
          setData(body as UsageResponse);
          setError(null);
        }
      } catch {
        if (!cancelled) {
          setError(t('analytics.loadFailed'));
          setData(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [range, attempt, t]);

  const retry = useCallback(() => setAttempt((a) => a + 1), []);

  const summary = data?.summary ?? null;
  const totals = summary?.totals ?? null;
  const isEmpty = totals !== null && totals.events === 0;

  return (
    <main>
      <h1>{t('analytics.title')}</h1>

      <div role="group" aria-label={t('analytics.rangeLabel')}>
        {USAGE_RANGES.map((r) => (
          <button
            key={r}
            type="button"
            aria-pressed={r === range}
            onClick={() => setRange(r)}
          >
            {t(`analytics.range.${r}`)}
          </button>
        ))}
      </div>

      {loading && <p>{t('analytics.loading')}</p>}

      {error !== null && !loading && (
        <div role="alert">
          <p>{error}</p>
          <button type="button" onClick={retry}>
            {t('analytics.retry')}
          </button>
        </div>
      )}

      {summary !== null && totals !== null && !loading && error === null && (
        <>
          <p>
            {t('analytics.window', {
              from: formatDateTime(summary.window.from, t.locale),
              to: formatDateTime(summary.window.to, t.locale),
            })}
          </p>

          {isEmpty ? (
            <p>{t('analytics.empty')}</p>
          ) : (
            <>
              <section aria-labelledby="analytics-totals">
                <h2 id="analytics-totals">{t('analytics.totalsTitle')}</h2>
                <dl>
                  <dt>{t('analytics.events')}</dt>
                  <dd>{formatQuantity(totals.events)}</dd>

                  <dt>{t('analytics.pricedEvents')}</dt>
                  <dd>{formatQuantity(totals.priced_events)}</dd>

                  <dt>{t('analytics.unpricedEvents')}</dt>
                  <dd>{formatQuantity(totals.unpriced_events)}</dd>

                  {totals.costs_by_currency.map((c) => (
                    <CostRow
                      key={c.currency}
                      label={t('analytics.nativeCost', { currency: c.currency })}
                      costMicros={c.cost_micros}
                      currency={c.currency}
                    />
                  ))}

                  {/* The converted total is only a total when something was
                      priced. With every call unpriced it would render
                      "0 USD" — a fabricated zero, and the exact lie the
                      storage layer was built to refuse — so the screen says
                      "unknown" instead. */}
                  {totals.priced_events > 0 ? (
                    <CostRow
                      label={t('analytics.accountingCost', {
                        currency: summary.accounting_currency,
                      })}
                      costMicros={totals.accounting_cost_micros}
                      currency={summary.accounting_currency}
                    />
                  ) : (
                    <div>
                      <dt>
                        {t('analytics.accountingCost', {
                          currency: summary.accounting_currency,
                        })}
                      </dt>
                      <dd>{t('analytics.costUnknown')}</dd>
                    </div>
                  )}

                  {Object.entries(totals.quantities).map(([dimension, qty]) => (
                    <div key={dimension}>
                      <dt>
                        {t.maybe(`analytics.quantities.${dimension}`, dimension)}
                      </dt>
                      <dd>{formatQuantity(qty)}</dd>
                    </div>
                  ))}
                </dl>

                {/* The two sentences that keep the totals honest. Each is a
                    count of things the totals above deliberately do not
                    include, and neither is rendered when the count is zero —
                    a notice about nothing is noise that trains the reader to
                    skip the one that matters. */}
                {totals.unpriced_events > 0 && (
                  <p role="status">
                    {t('analytics.unpricedNotice', { count: totals.unpriced_events })}
                  </p>
                )}
                {totals.unconverted_events > 0 && (
                  <p role="status">
                    {t('analytics.unconvertedNotice', {
                      count: totals.unconverted_events,
                    })}
                  </p>
                )}
              </section>

              <section aria-labelledby="analytics-by-provider">
                <h2 id="analytics-by-provider">{t('analytics.byProviderTitle')}</h2>
                <table>
                  <thead>
                    <tr>
                      <th scope="col">{t('analytics.provider')}</th>
                      <th scope="col">{t('analytics.model')}</th>
                      <th scope="col">{t('analytics.modality')}</th>
                      <th scope="col">{t('analytics.column.events')}</th>
                      <th scope="col">{t('analytics.column.cost')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.by_provider.map((group) => (
                      <tr
                        key={`${group.provider}|${group.model ?? ''}|${group.modality}`}
                      >
                        <td>{group.provider}</td>
                        <td>{group.model ?? t('analytics.modelUnknown')}</td>
                        <td>{t(`analytics.modality.${group.modality}`)}</td>
                        <td>{formatQuantity(group.events)}</td>
                        <td>
                          {group.costs.length > 0
                            ? group.costs
                                .map((c) => formatMicroCost(c.cost_micros, c.currency))
                                .join(', ')
                            : t('analytics.costUnknown')}
                          {group.unpriced_events > 0 && (
                            <>
                              {' '}
                              <span>
                                {t('analytics.unpricedShort', {
                                  count: group.unpriced_events,
                                })}
                              </span>
                            </>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            </>
          )}
        </>
      )}
    </main>
  );
}

function CostRow({
  label,
  costMicros,
  currency,
}: {
  label: string;
  costMicros: number;
  currency: string;
}) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{formatMicroCost(costMicros, currency)}</dd>
    </div>
  );
}
