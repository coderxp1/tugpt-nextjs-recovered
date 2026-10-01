'use client';

/**
 * Polls one media job until it reaches a terminal state.
 *
 * Generation takes minutes, and the repo has no polling precedent — inboxes
 * use event-driven refetch — so this hook is deliberately small and explicit:
 * fetch immediately, then every 5 seconds while the status is `queued` or
 * `processing`, and stop the interval the moment a terminal status arrives.
 * The interval is always cleared on unmount.
 */

import { useEffect, useState } from 'react';
import { TERMINAL_STATUSES } from '@/lib/media-api/types';
import type { MediaJob, MediaJobDetailResponse, ApiError } from '@/lib/media-api/types';

const POLL_INTERVAL_MS = 5000;

export interface UseMediaJobResult {
  job: MediaJob | null;
  loading: boolean;
  /** The raw API error, so the caller can translate it with its dictionary. */
  error: ApiError | null;
  networkFailed: boolean;
  retry: () => void;
}

export function useMediaJob(jobId: string): UseMediaJobResult {
  const [job, setJob] = useState<MediaJob | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);
  const [networkFailed, setNetworkFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let interval: ReturnType<typeof setInterval> | null = null;

    const load = async () => {
      try {
        const res = await fetch(`/api/v1/media/jobs/${jobId}`);
        if (cancelled) return;

        if (!res.ok) {
          let data: ApiError | null = null;
          try {
            data = (await res.json()) as ApiError;
          } catch {
            data = null;
          }
          setError(data);
          setNetworkFailed(false);
          setLoading(false);
          return;
        }

        const data = (await res.json()) as MediaJobDetailResponse;
        if (cancelled) return;
        setJob(data.job);
        setError(null);
        setNetworkFailed(false);

        // Terminal on arrival: no further polls, and the running interval
        // (if any) is stopped now rather than after one wasted tick.
        if (TERMINAL_STATUSES.has(data.job.status) && interval !== null) {
          clearInterval(interval);
          interval = null;
        }
      } catch {
        if (cancelled) return;
        setNetworkFailed(true);
        setError(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    load();
    interval = setInterval(load, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      if (interval !== null) clearInterval(interval);
    };
  }, [jobId, reloadKey]);

  // The spinner is raised by the handler, not by the effect — same reasoning
  // as DraftInbox's retry: the click is where "this is going to take a
  // moment" is actually known.
  const retry = () => {
    setLoading(true);
    setReloadKey((k) => k + 1);
  };

  return { job, loading, error, networkFailed, retry };
}
