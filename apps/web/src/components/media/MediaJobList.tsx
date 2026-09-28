'use client';

// Media job inbox: list with status filter, pagination, and all UI states.
// Follows the DraftInbox shape (filter buttons, reloadKey retry, cards that
// link to the detail page) so a reviewer meets one consistent dashboard.

import { useState, useEffect } from 'react';
import Link from 'next/link';
import type { MediaJob, MediaJobListResponse, MediaStatusFilter } from '@/lib/media-api/types';
import { mediaApiErrorText } from '@/lib/media-api/error-text';
import { formatDateTime } from '@/i18n';
import { useT } from '@/i18n/provider';
import { MediaStatusBadge } from './MediaStatusBadge';

const STATUS_FILTERS: MediaStatusFilter[] = [
  'all',
  'queued',
  'processing',
  'completed',
  'cancelled',
  'dead_lettered',
];

const PAGE_LIMIT = 20;

export function MediaJobList() {
  const t = useT();
  const [jobs, setJobs] = useState<MediaJob[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState<MediaStatusFilter>('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [featureUnavailable, setFeatureUnavailable] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const params = new URLSearchParams({
          status: statusFilter,
          page: String(page),
          limit: String(PAGE_LIMIT),
        });
        const res = await fetch(`/api/v1/media/jobs?${params}`, {
          headers: { 'Content-Type': 'application/json' },
        });

        if (cancelled) return;

        if (res.status === 503) {
          setFeatureUnavailable(true);
          setJobs([]);
          setLoading(false);
          return;
        }

        if (!res.ok) {
          const data = await res.json();
          if (cancelled) return;
          setError(mediaApiErrorText(t, data));
          setJobs([]);
          setLoading(false);
          return;
        }

        const data = (await res.json()) as MediaJobListResponse;
        if (cancelled) return;
        setJobs(data.jobs || []);
        setTotal(data.total || 0);
        setError(null);
        setFeatureUnavailable(false);
      } catch {
        if (!cancelled) {
          setError(t('media.list.loadFailed'));
          setJobs([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    load();

    return () => {
      cancelled = true;
    };
  }, [statusFilter, page, reloadKey, t]);

  const retry = () => {
    setLoading(true);
    setReloadKey((k) => k + 1);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <p className="text-zinc-500">{t('media.list.loading')}</p>
      </div>
    );
  }

  if (featureUnavailable) {
    return (
      <div className="flex flex-col items-center justify-center py-20">
        <p className="text-lg font-medium text-zinc-700">{t('errors.FEATURE_UNAVAILABLE')}</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-20">
        <p className="text-red-600">{error}</p>
        <button
          onClick={retry}
          className="mt-4 rounded bg-zinc-800 px-4 py-2 text-white hover:bg-zinc-700"
        >
          {t('common.retry')}
        </button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-zinc-900">{t('media.list.title')}</h1>
        <Link
          href="/dashboard/media/new"
          className="rounded bg-zinc-800 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700"
        >
          {t('media.list.newJob')}
        </Link>
      </div>

      {/* Status filter */}
      <div className="mb-4 flex flex-wrap gap-2">
        {STATUS_FILTERS.map((s) => (
          <button
            key={s}
            onClick={() => {
              setStatusFilter(s);
              setPage(1);
            }}
            className={`rounded px-3 py-1 text-sm font-medium ${
              statusFilter === s
                ? 'bg-zinc-800 text-white'
                : 'bg-zinc-100 text-zinc-700 hover:bg-zinc-200'
            }`}
          >
            {t(`media.filter.${s}`)}
          </button>
        ))}
      </div>

      {/* Empty state */}
      {jobs.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20">
          <p className="text-zinc-500">{t('media.list.empty')}</p>
          <Link
            href="/dashboard/media/new"
            className="mt-4 rounded bg-zinc-800 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700"
          >
            {t('media.list.newJob')}
          </Link>
        </div>
      ) : (
        <>
          {/* Job list */}
          <div className="space-y-3">
            {jobs.map((job) => (
              <Link
                key={job.id}
                href={`/dashboard/media/${job.id}`}
                className="block rounded-lg border border-zinc-200 p-4 transition hover:border-zinc-300 hover:shadow-sm"
              >
                <div className="flex items-center justify-between gap-3">
                  <p className="flex-1 truncate text-sm text-zinc-800">{job.prompt}</p>
                  <span className="shrink-0 rounded bg-zinc-100 px-2 py-1 text-xs font-medium text-zinc-600">
                    {t(`media.kind.${job.kind}`)}
                  </span>
                  <MediaStatusBadge status={job.status} />
                </div>
                <div className="mt-2 flex items-center gap-3 text-xs text-zinc-400">
                  <span>{formatDateTime(job.createdAt, t.locale)}</span>
                  {job.gpuSeconds != null && (
                    <span>{t('media.list.gpuSeconds', { seconds: Math.round(job.gpuSeconds) })}</span>
                  )}
                </div>
              </Link>
            ))}
          </div>

          {/* Pagination */}
          {total > PAGE_LIMIT && (
            <div className="mt-6 flex items-center justify-center gap-4">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page === 1}
                className="rounded px-3 py-1 text-sm disabled:opacity-50"
              >
                {t('common.previous')}
              </button>
              <span className="text-sm text-zinc-500">
                {t('media.list.pagination', {
                  page,
                  pages: Math.ceil(total / PAGE_LIMIT),
                })}
              </span>
              <button
                onClick={() => setPage((p) => p + 1)}
                disabled={page * PAGE_LIMIT >= total}
                className="rounded px-3 py-1 text-sm disabled:opacity-50"
              >
                {t('common.next')}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
