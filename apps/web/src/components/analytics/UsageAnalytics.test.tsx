// @vitest-environment jsdom
/**
 * @file UsageAnalytics.test.tsx
 * @description The usage & cost screen as an owner sees it.
 *
 * The route tests prove the aggregate that arrives is right. These prove the
 * screen does not undo it — and the thing it must not undo is specific: an
 * unknown cost is never rendered as a zero. A total of "0 USD" over a month of
 * unpriced calls is the exact lie the storage layer (20260903000002) and the
 * RPC (20260911000001) were both written to refuse, and it is the assertion
 * with the most money behind it in this file.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { UsageAnalytics } from './UsageAnalytics';
import { createTranslator } from '@/i18n';

const t = createTranslator('es');

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const ORG = 'aaaaaaaa-c057-0000-0000-0000000000a1';

function summary(overrides: Record<string, unknown> = {}) {
  return {
    organization_id: ORG,
    window: { from: '2026-08-12T00:00:00.000Z', to: '2026-09-11T00:00:00.000Z' },
    accounting_currency: 'USD',
    totals: {
      events: 3,
      priced_events: 2,
      unpriced_events: 1,
      unconverted_events: 0,
      accounting_cost_micros: 25000,
      quantities: { input_tokens: 1000, output_tokens: 500, audio_seconds: 120 },
      costs_by_currency: [{ currency: 'USD', cost_micros: 25000 }],
    },
    by_provider: [
      {
        provider: 'testprov',
        model: 'test-model',
        modality: 'text',
        events: 2,
        unpriced_events: 0,
        unconverted_events: 0,
        accounting_cost_micros: 25000,
        quantities: { input_tokens: 1000, output_tokens: 500 },
        costs: [{ currency: 'USD', cost_micros: 25000 }],
      },
      {
        provider: 'noprice',
        model: null,
        modality: 'audio',
        events: 1,
        unpriced_events: 1,
        unconverted_events: 0,
        accounting_cost_micros: 0,
        quantities: { audio_seconds: 120 },
        costs: [],
      },
    ],
    ...overrides,
  };
}

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const err = (status: number, code: string) => ({
  ok: false,
  status,
  json: async () => ({ error: { code, message: 'nope' } }),
});

const resp = (summaryOverrides: Record<string, unknown> = {}, range = '30d') =>
  ok({
    range,
    window: { from: '2026-08-12T00:00:00.000Z', to: '2026-09-11T00:00:00.000Z' },
    summary: summary(summaryOverrides),
  });

beforeEach(() => mockFetch.mockReset());
afterEach(cleanup);

const lastUrl = () => mockFetch.mock.calls[mockFetch.mock.calls.length - 1][0] as string;

describe('loading the report', () => {
  it('A1: asks for the default 30-day window', async () => {
    mockFetch.mockResolvedValueOnce(resp());
    render(<UsageAnalytics />);
    await screen.findByText(t('analytics.totalsTitle'));
    expect(lastUrl()).toBe('/api/v1/analytics/usage?range=30d');
  });

  it('A2: renders the recorded totals', async () => {
    mockFetch.mockResolvedValueOnce(resp());
    render(<UsageAnalytics />);

    expect(await screen.findByText(t('analytics.events'))).toBeTruthy();
    // Rendered in the native-currency row, the converted row and the provider
    // table alike — the point is that 25000 micros reads as 0.025, not 25000
    // and not 0.03.
    expect(screen.getAllByText('0.025 USD').length).toBeGreaterThan(0);
    expect(screen.getByText(t('analytics.quantities.audio_seconds'))).toBeTruthy();
    expect(screen.getByText('120')).toBeTruthy();
  });

  it('A3: switches the window from the period buttons', async () => {
    mockFetch.mockResolvedValue(resp());
    const user = userEvent.setup();
    render(<UsageAnalytics />);
    await screen.findByText(t('analytics.totalsTitle'));

    const seven = screen.getByRole('button', { name: t('analytics.range.7d') });
    await user.click(seven);

    await waitFor(() => expect(lastUrl()).toBe('/api/v1/analytics/usage?range=7d'));
    expect(seven.getAttribute('aria-pressed')).toBe('true');
    expect(
      screen.getByRole('button', { name: t('analytics.range.30d') }).getAttribute('aria-pressed')
    ).toBe('false');
  });
});

describe('the states a report has to survive', () => {
  it('E1: an empty window says so, and renders no table of nothing', async () => {
    mockFetch.mockResolvedValueOnce(
      resp({
        totals: {
          events: 0,
          priced_events: 0,
          unpriced_events: 0,
          unconverted_events: 0,
          accounting_cost_micros: 0,
          quantities: {},
          costs_by_currency: [],
        },
        by_provider: [],
      })
    );
    render(<UsageAnalytics />);

    expect(await screen.findByText(t('analytics.empty'))).toBeTruthy();
    expect(screen.queryByText(t('analytics.byProviderTitle'))).toBeNull();
  });

  it('F1: an API error is shown translated, with a retry that recovers', async () => {
    mockFetch.mockResolvedValueOnce(err(403, 'FORBIDDEN'));
    const user = userEvent.setup();
    render(<UsageAnalytics />);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(t('errors.FORBIDDEN'));

    mockFetch.mockResolvedValueOnce(resp());
    await user.click(screen.getByRole('button', { name: t('analytics.retry') }));

    expect(await screen.findByText(t('analytics.totalsTitle'))).toBeTruthy();
  });

  it('F2: a network failure says loading failed, not "no usage"', async () => {
    // "Could not fetch" and "nothing happened this month" are different facts;
    // rendering the second for the first tells an owner their spend is zero.
    mockFetch.mockRejectedValueOnce(new Error('network'));
    render(<UsageAnalytics />);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(t('analytics.loadFailed'));
    expect(screen.queryByText(t('analytics.empty'))).toBeNull();
  });
});

describe('unknown is never rendered as zero', () => {
  it('U1: unpriced calls get their sentence, with the count', async () => {
    mockFetch.mockResolvedValueOnce(resp());
    render(<UsageAnalytics />);
    await screen.findByText(t('analytics.totalsTitle'));

    expect(
      screen.getByText(t('analytics.unpricedNotice', { count: 1 }))
    ).toBeTruthy();
  });

  it('U2: no unpriced sentence when nothing is unpriced', async () => {
    mockFetch.mockResolvedValueOnce(
      resp({
        totals: {
          events: 2,
          priced_events: 2,
          unpriced_events: 0,
          unconverted_events: 0,
          accounting_cost_micros: 25000,
          quantities: {},
          costs_by_currency: [{ currency: 'USD', cost_micros: 25000 }],
        },
      })
    );
    render(<UsageAnalytics />);
    await screen.findByText(t('analytics.totalsTitle'));

    expect(screen.queryByText(t('analytics.unpricedNotice', { count: 0 }))).toBeNull();
    expect(screen.queryByText(/sin precio: su costo es desconocido/)).toBeNull();
  });

  it('U3: unconverted costs get their own sentence', async () => {
    mockFetch.mockResolvedValueOnce(
      resp({
        totals: {
          events: 3,
          priced_events: 3,
          unpriced_events: 0,
          unconverted_events: 2,
          accounting_cost_micros: 25000,
          quantities: {},
          costs_by_currency: [
            { currency: 'EUR', cost_micros: 20000 },
            { currency: 'USD', cost_micros: 25000 },
          ],
        },
      })
    );
    render(<UsageAnalytics />);
    await screen.findByText(t('analytics.totalsTitle'));

    expect(
      screen.getByText(t('analytics.unconvertedNotice', { count: 2 }))
    ).toBeTruthy();
    // The native totals are BOTH visible: summing EUR and USD into one number
    // would be a total that means nothing.
    expect(screen.getAllByText('0.02 EUR').length).toBeGreaterThan(0);
    expect(screen.getAllByText('0.025 USD').length).toBeGreaterThan(0);
  });

  it('U4: a month where NOTHING was priced says "cost unknown" — never "0 USD"', async () => {
    // The assertion with the most money behind it in this file.
    mockFetch.mockResolvedValueOnce(
      resp({
        totals: {
          events: 4,
          priced_events: 0,
          unpriced_events: 4,
          unconverted_events: 0,
          accounting_cost_micros: 0,
          quantities: { audio_seconds: 500 },
          costs_by_currency: [],
        },
        by_provider: [],
      })
    );
    render(<UsageAnalytics />);
    await screen.findByText(t('analytics.totalsTitle'));

    expect(screen.getByText(t('analytics.costUnknown'))).toBeTruthy();
    expect(screen.queryByText('0 USD')).toBeNull();
    expect(
      screen.getByText(t('analytics.unpricedNotice', { count: 4 }))
    ).toBeTruthy();
  });

  it('U5: the per-provider table shows unknown per row, not a column of zeros', async () => {
    mockFetch.mockResolvedValueOnce(resp());
    render(<UsageAnalytics />);
    await screen.findByText(t('analytics.byProviderTitle'));

    // The priced row carries its cost; the unpriced row carries "unknown"
    // plus its count, and the null model is named rather than blank.
    expect(screen.getByText('testprov')).toBeTruthy();
    expect(screen.getAllByText('0.025 USD').length).toBeGreaterThan(0);
    expect(screen.getByText(t('analytics.modelUnknown'))).toBeTruthy();
    expect(screen.getByText(t('analytics.costUnknown'))).toBeTruthy();
    expect(screen.getByText(t('analytics.unpricedShort', { count: 1 }))).toBeTruthy();
    expect(screen.getByText(t('analytics.modality.audio'))).toBeTruthy();
  });
});
