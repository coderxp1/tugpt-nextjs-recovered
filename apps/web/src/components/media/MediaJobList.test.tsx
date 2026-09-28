// @vitest-environment jsdom
/**
 * @file MediaJobList.test.tsx
 * @description The list shows each job's prompt, kind, and status, filters by
 * status, and degrades honestly: an empty inbox invites the first job, a
 * failed load offers a retry that actually re-runs the effect.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MediaJobList } from './MediaJobList';
import { createTranslator } from '@/i18n';
import type { MediaJob } from '@/lib/media-api/types';

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const t = createTranslator('es');

const job = (overrides: Partial<MediaJob> = {}): MediaJob => ({
  id: 'job-1',
  kind: 'video',
  status: 'queued',
  prompt: 'Un atardecer sobre el lago',
  params: { frames: 81, fps: 16 },
  promptId: null,
  attempts: 1,
  idempotencyKey: null,
  errorCode: null,
  errorReason: null,
  cancelReason: null,
  resultPath: null,
  gpuSeconds: null,
  createdAt: '2026-09-28T10:00:00Z',
  updatedAt: '2026-09-28T10:00:00Z',
  startedAt: null,
  finishedAt: null,
  ...overrides,
});

const jsonOk = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const jsonErr = (status: number, code: string, message: string) => ({
  ok: false,
  status,
  json: async () => ({ error: { code, message } }),
});

beforeEach(() => {
  mockFetch.mockReset();
  cleanup();
});

describe('MediaJobList', () => {
  it('renders each job with its prompt, kind, and translated status', async () => {
    mockFetch.mockResolvedValue(
      jsonOk({
        jobs: [
          job({ id: 'job-1', kind: 'video', status: 'queued' }),
          job({ id: 'job-2', kind: 'image', status: 'completed', prompt: 'Foto de producto' }),
        ],
        total: 2,
      })
    );
    render(<MediaJobList />);

    await waitFor(() => expect(screen.getByText('Un atardecer sobre el lago')).toBeTruthy());
    expect(screen.getByText('Foto de producto')).toBeTruthy();
    expect(screen.getByText(t('media.kind.video'))).toBeTruthy();
    expect(screen.getByText(t('media.kind.image'))).toBeTruthy();

    // The status label also names a filter button, so scope the assertion to
    // the job's own row rather than the whole document.
    const link = screen.getByText('Un atardecer sobre el lago').closest('a');
    expect(link?.getAttribute('href')).toBe('/dashboard/media/job-1');
    expect(link?.textContent).toContain(t('media.status.queued'));

    const completedLink = screen.getByText('Foto de producto').closest('a');
    expect(completedLink?.textContent).toContain(t('media.status.completed'));
  });

  it('filters by status when a filter button is pressed', async () => {
    mockFetch.mockResolvedValue(jsonOk({ jobs: [], total: 0 }));
    const user = userEvent.setup();
    render(<MediaJobList />);

    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole('button', { name: t('media.filter.completed') }));

    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
    const [url] = mockFetch.mock.calls[1] as [string, RequestInit];
    expect(url).toContain('status=completed');
  });

  it('shows the empty state when there are no jobs', async () => {
    mockFetch.mockResolvedValue(jsonOk({ jobs: [], total: 0 }));
    render(<MediaJobList />);

    await waitFor(() => expect(screen.getByText(t('media.list.empty'))).toBeTruthy());
    // The header and the empty state each offer the "new job" action.
    const newJobLinks = screen.getAllByRole('link', { name: t('media.list.newJob') });
    expect(newJobLinks).toHaveLength(2);
    for (const link of newJobLinks) {
      expect(link.getAttribute('href')).toBe('/dashboard/media/new');
    }
  });

  it('shows the error state and retries on click', async () => {
    mockFetch
      .mockResolvedValueOnce(jsonErr(500, 'INTERNAL_ERROR', 'boom'))
      .mockResolvedValueOnce(jsonOk({ jobs: [], total: 0 }));
    const user = userEvent.setup();
    render(<MediaJobList />);

    await waitFor(() =>
      expect(screen.getByText(t('errors.INTERNAL_ERROR'))).toBeTruthy()
    );
    await user.click(screen.getByRole('button', { name: t('common.retry') }));

    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByText(t('media.list.empty'))).toBeTruthy());
  });

  it('shows the feature-unavailable state on 503', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });
    render(<MediaJobList />);

    await waitFor(() =>
      expect(screen.getByText(t('errors.FEATURE_UNAVAILABLE'))).toBeTruthy()
    );
  });
});
