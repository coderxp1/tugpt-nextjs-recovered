// @vitest-environment jsdom
/**
 * @file MediaJobDetail.test.tsx
 * @description The detail page shows the full prompt, the timeline, and the
 * failure info; offers cancel only while the job is queued/processing; and
 * once completed, loads the signed result URL into a private preview with a
 * download link.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MediaJobDetail } from './MediaJobDetail';
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
  kind: 'image',
  status: 'queued',
  prompt: 'Foto de producto sobre fondo blanco',
  params: { width: 1024, height: 1024 },
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

const jobOk = (j: MediaJob) => ({
  ok: true,
  status: 200,
  json: async () => ({ job: j }),
});

beforeEach(() => {
  mockFetch.mockReset();
  cleanup();
});

describe('MediaJobDetail', () => {
  it('renders the prompt, status badge, and timeline', async () => {
    mockFetch.mockResolvedValue(
      jobOk(
        job({
          status: 'processing',
          startedAt: '2026-09-28T10:01:00Z',
        })
      )
    );
    render(<MediaJobDetail jobId="job-1" />);

    await waitFor(() =>
      expect(screen.getByText('Foto de producto sobre fondo blanco')).toBeTruthy()
    );
    expect(screen.getByText(t('media.status.processing'))).toBeTruthy();
    expect(screen.getByText(t('media.detail.created'))).toBeTruthy();
    expect(screen.getByText(t('media.detail.started'))).toBeTruthy();
    expect(screen.getByText(t('media.kind.image'))).toBeTruthy();
  });

  it('offers cancel with an optional reason while queued, then refetches', async () => {
    const user = userEvent.setup();
    mockFetch
      .mockResolvedValueOnce(jobOk(job({ status: 'queued' })))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ job: job({ status: 'cancelled' }) }),
      })
      .mockResolvedValue(jobOk(job({ status: 'cancelled' })));
    render(<MediaJobDetail jobId="job-1" />);

    await waitFor(() =>
      expect(screen.getByLabelText(t('media.detail.cancelReasonLabel'))).toBeTruthy()
    );
    await user.type(
      screen.getByLabelText(t('media.detail.cancelReasonLabel')),
      'Ya no lo necesito'
    );
    await user.click(screen.getByRole('button', { name: t('common.cancel') }));

    await waitFor(() => {
      const calls = mockFetch.mock.calls as Array<[string, RequestInit?]>;
      const cancelCall = calls.find(([url]) => url.endsWith('/cancel'));
      expect(cancelCall).toBeTruthy();
      const [, init] = cancelCall as [string, RequestInit];
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body as string)).toEqual({ reason: 'Ya no lo necesito' });
    });
    await waitFor(() => expect(screen.getByText(t('media.status.cancelled'))).toBeTruthy());
  });

  it('hides the cancel control once the job is completed', async () => {
    mockFetch
      .mockResolvedValueOnce(jobOk(job({ status: 'completed' })))
      .mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ url: 'https://storage.example/signed', expiresIn: 300 }),
      });
    render(<MediaJobDetail jobId="job-1" />);

    await waitFor(() => expect(screen.getByText(t('media.status.completed'))).toBeTruthy());
    expect(screen.queryByLabelText(t('media.detail.cancelReasonLabel'))).toBeNull();
  });

  it('loads the signed URL into a preview with a download link when completed', async () => {
    mockFetch
      .mockResolvedValueOnce(jobOk(job({ status: 'completed', kind: 'image' })))
      .mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ url: 'https://storage.example/signed.png', expiresIn: 300 }),
      });
    render(<MediaJobDetail jobId="job-1" />);

    await waitFor(() => {
      const img = screen.getByAltText('Foto de producto sobre fondo blanco');
      expect(img.getAttribute('src')).toBe('https://storage.example/signed.png');
    });
    const download = screen.getByRole('link', { name: t('media.detail.download') });
    expect(download.getAttribute('href')).toBe('https://storage.example/signed.png');

    const calls = mockFetch.mock.calls as Array<[string, RequestInit?]>;
    const [resultUrl] = calls.find(([url]) => url.endsWith('/result')) as [string];
    expect(resultUrl).toBe('/api/v1/media/jobs/job-1/result');
  });

  it('renders a video element with controls for video results', async () => {
    mockFetch
      .mockResolvedValueOnce(jobOk(job({ status: 'completed', kind: 'video' })))
      .mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ url: 'https://storage.example/signed.mp4', expiresIn: 300 }),
      });
    const { container } = render(<MediaJobDetail jobId="job-1" />);

    await waitFor(() => {
      const video = container.querySelector('video');
      expect(video?.getAttribute('src')).toBe('https://storage.example/signed.mp4');
      expect(video?.hasAttribute('controls')).toBe(true);
    });
  });

  it('shows the failure code and message when the job died', async () => {
    mockFetch.mockResolvedValue(
      jobOk(
        job({
          status: 'dead_lettered',
          errorCode: 'COMFYUI_ERROR',
          errorReason: 'The queue rejected the prompt',
        })
      )
    );
    render(<MediaJobDetail jobId="job-1" />);

    await waitFor(() => expect(screen.getByText('COMFYUI_ERROR')).toBeTruthy());
    expect(screen.getByText('The queue rejected the prompt')).toBeTruthy();
    expect(screen.getByText(t('media.status.dead_lettered'))).toBeTruthy();
  });
});
