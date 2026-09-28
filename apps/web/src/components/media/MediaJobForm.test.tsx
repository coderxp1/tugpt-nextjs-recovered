// @vitest-environment jsdom
/**
 * @file MediaJobForm.test.tsx
 * @description The form never pays a round trip for a rejection the browser
 * can see: empty/oversized prompts, non-4n+1 frame counts, and out-of-range
 * fps are all refused client-side with a translated message. A valid submit
 * posts the contract payload and lands on the job's detail page.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MediaJobForm } from './MediaJobForm';
import { createTranslator } from '@/i18n';

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}));

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const t = createTranslator('es');

const jsonOk = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const jsonErr = (status: number, code: string, message: string) => ({
  ok: false,
  status,
  json: async () => ({ error: { code, message } }),
});

beforeEach(() => {
  mockFetch.mockReset();
  mockPush.mockReset();
  cleanup();
});

async function fillPrompt(user: ReturnType<typeof userEvent.setup>, text: string) {
  await user.type(screen.getByLabelText(t('media.form.promptLabel')), text);
}

describe('MediaJobForm', () => {
  it('refuses an empty prompt without calling the API', async () => {
    const user = userEvent.setup();
    render(<MediaJobForm />);

    await user.click(screen.getByRole('button', { name: t('media.form.submit') }));

    expect(screen.getByText(t('media.form.promptRequired'))).toBeTruthy();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('refuses a video frame count that is not 4n+1', async () => {
    const user = userEvent.setup();
    render(<MediaJobForm />);

    await user.click(screen.getByRole('button', { name: t('media.kind.video') }));
    await fillPrompt(user, 'Un atardecer sobre el lago');
    const frames = screen.getByLabelText(t('media.form.framesLabel'));
    await user.clear(frames);
    await user.type(frames, '20');
    await user.click(screen.getByRole('button', { name: t('media.form.submit') }));

    expect(screen.getByText(t('media.form.framesInvalid'))).toBeTruthy();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('refuses a frame count above 81', async () => {
    const user = userEvent.setup();
    render(<MediaJobForm />);

    await user.click(screen.getByRole('button', { name: t('media.kind.video') }));
    await fillPrompt(user, 'Un atardecer sobre el lago');
    const frames = screen.getByLabelText(t('media.form.framesLabel'));
    await user.clear(frames);
    await user.type(frames, '85');
    await user.click(screen.getByRole('button', { name: t('media.form.submit') }));

    expect(screen.getByText(t('media.form.framesInvalid'))).toBeTruthy();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('refuses an fps outside 1..30', async () => {
    const user = userEvent.setup();
    render(<MediaJobForm />);

    await user.click(screen.getByRole('button', { name: t('media.kind.video') }));
    await fillPrompt(user, 'Un atardecer sobre el lago');
    const fps = screen.getByLabelText(t('media.form.fpsLabel'));
    await user.clear(fps);
    await user.type(fps, '31');
    await user.click(screen.getByRole('button', { name: t('media.form.submit') }));

    expect(screen.getByText(t('media.form.fpsInvalid'))).toBeTruthy();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('submits a valid video job and redirects to its detail page', async () => {
    const user = userEvent.setup();
    mockFetch.mockResolvedValue(
      jsonOk({ job: { id: 'job-9', kind: 'video', status: 'queued' } })
    );
    render(<MediaJobForm />);

    await user.click(screen.getByRole('button', { name: t('media.kind.video') }));
    await fillPrompt(user, 'Un atardecer sobre el lago');
    const frames = screen.getByLabelText(t('media.form.framesLabel'));
    await user.clear(frames);
    await user.type(frames, '81');
    await user.click(screen.getByRole('button', { name: t('media.form.submit') }));

    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/v1/media/jobs');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body.kind).toBe('video');
    expect(body.prompt).toBe('Un atardecer sobre el lago');
    expect(body.params).toEqual({ frames: 81, fps: 16 });
    expect(typeof body.idempotencyKey).toBe('string');
    expect(body.idempotencyKey.length).toBeGreaterThan(0);

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/dashboard/media/job-9'));
  });

  it('shows the translated message when another job is already running', async () => {
    const user = userEvent.setup();
    mockFetch.mockResolvedValue(
      jsonErr(409, 'MEDIA_CONCURRENCY_EXCEEDED', 'one active job per org')
    );
    render(<MediaJobForm />);

    await fillPrompt(user, 'Una foto de producto');
    await user.click(screen.getByRole('button', { name: t('media.form.submit') }));

    await waitFor(() =>
      expect(screen.getByText(t('errors.MEDIA_CONCURRENCY_EXCEEDED'))).toBeTruthy()
    );
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('shows the quota message when the organization is over its limit', async () => {
    const user = userEvent.setup();
    mockFetch.mockResolvedValue(jsonErr(429, 'MEDIA_QUOTA_EXCEEDED', 'quota exceeded'));
    render(<MediaJobForm />);

    await fillPrompt(user, 'Una foto de producto');
    await user.click(screen.getByRole('button', { name: t('media.form.submit') }));

    await waitFor(() =>
      expect(screen.getByText(t('errors.MEDIA_QUOTA_EXCEEDED'))).toBeTruthy()
    );
  });
});
