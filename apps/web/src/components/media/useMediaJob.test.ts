// @vitest-environment jsdom
/**
 * @file useMediaJob.test.ts
 * @description The polling contract: fetch now, then every 5s while the job
 * is queued/processing, and stop the moment a terminal status arrives.
 * Unmounting clears the interval — a leaked interval is a request every 5s
 * against a page nobody is looking at.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useMediaJob } from './useMediaJob';
import type { MediaJob } from '@/lib/media-api/types';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const jobPayload = (status: MediaJob['status']): MediaJob => ({
  id: 'job-1',
  kind: 'video',
  status,
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
});

const jsonOk = (job: MediaJob) => ({
  ok: true,
  status: 200,
  json: async () => ({ job }),
});

beforeEach(() => {
  mockFetch.mockReset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useMediaJob', () => {
  it('polls every 5s while the job is queued', async () => {
    mockFetch.mockResolvedValue(jsonOk(jobPayload('queued')));
    renderHook(() => useMediaJob('job-1'));

    await act(async () => {
      await Promise.resolve();
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(5000);
      await Promise.resolve();
    });
    expect(mockFetch).toHaveBeenCalledTimes(2);

    await act(async () => {
      vi.advanceTimersByTime(5000);
      await Promise.resolve();
    });
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('keeps polling while processing and stops on completed', async () => {
    mockFetch
      .mockResolvedValueOnce(jsonOk(jobPayload('processing')))
      .mockResolvedValueOnce(jsonOk(jobPayload('processing')))
      .mockResolvedValue(jsonOk(jobPayload('completed')));

    const { result } = renderHook(() => useMediaJob('job-1'));

    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.job?.status).toBe('processing');
    expect(mockFetch).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(5000);
      await Promise.resolve();
    });
    expect(mockFetch).toHaveBeenCalledTimes(2);

    // Third poll returns completed: the interval is cleared, so the 15s
    // after it produce no further requests.
    await act(async () => {
      vi.advanceTimersByTime(5000);
      await Promise.resolve();
    });
    expect(result.current.job?.status).toBe('completed');
    expect(mockFetch).toHaveBeenCalledTimes(3);

    await act(async () => {
      vi.advanceTimersByTime(15000);
      await Promise.resolve();
    });
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('does not poll at all when the first load is already terminal', async () => {
    mockFetch.mockResolvedValue(jsonOk(jobPayload('cancelled')));
    renderHook(() => useMediaJob('job-1'));

    await act(async () => {
      await Promise.resolve();
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(30000);
      await Promise.resolve();
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('clears the interval on unmount', async () => {
    mockFetch.mockResolvedValue(jsonOk(jobPayload('queued')));
    const { unmount } = renderHook(() => useMediaJob('job-1'));

    await act(async () => {
      await Promise.resolve();
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);

    unmount();

    await act(async () => {
      vi.advanceTimersByTime(30000);
      await Promise.resolve();
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('exposes retry to re-run the load', async () => {
    mockFetch.mockRejectedValueOnce(new Error('network down'));
    mockFetch.mockResolvedValue(jsonOk(jobPayload('queued')));
    const { result } = renderHook(() => useMediaJob('job-1'));

    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.networkFailed).toBe(true);

    await act(async () => {
      result.current.retry();
      await Promise.resolve();
    });
    expect(result.current.networkFailed).toBe(false);
    expect(result.current.job?.status).toBe('queued');
  });
});
