'use client';

// Media job detail: full prompt, status timeline, params, cancel, and — once
// completed — a private preview plus download link served through a signed
// URL. The job itself is polled every 5s while queued/processing
// (useMediaJob); the signed URL is refreshed 30s before its expiry so the
// preview never shows a dead link.

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useT } from '@/i18n/provider';
import { formatDateTime } from '@/i18n';
import { mediaApiErrorText } from '@/lib/media-api/error-text';
import type { MediaJobResultResponse } from '@/lib/media-api/types';
import { MediaStatusBadge } from './MediaStatusBadge';
import { useMediaJob } from './useMediaJob';

const URL_REFRESH_SAFETY_MARGIN_S = 30;

export function MediaJobDetail({ jobId }: { jobId: string }) {
  const t = useT();
  const { job, loading, error, networkFailed, retry } = useMediaJob(jobId);

  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [resultError, setResultError] = useState<string | null>(null);
  const [resultKey, setResultKey] = useState(0);

  const [reason, setReason] = useState('');
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);

  // Signed URL for the completed result, refreshed before expiry.
  useEffect(() => {
    if (job?.status !== 'completed') return;
    let cancelled = false;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;

    const fetchUrl = async () => {
      try {
        const res = await fetch(`/api/v1/media/jobs/${job.id}/result`);
        if (cancelled) return;
        if (!res.ok) {
          const data = await res.json().catch(() => undefined);
          setResultError(mediaApiErrorText(t, data));
          return;
        }
        const data = (await res.json()) as MediaJobResultResponse;
        if (cancelled) return;
        setResultUrl(data.url);
        setResultError(null);
        const refreshInMs = Math.max(
          0,
          (data.expiresIn - URL_REFRESH_SAFETY_MARGIN_S) * 1000
        );
        refreshTimer = setTimeout(fetchUrl, refreshInMs);
      } catch {
        if (!cancelled) setResultError(t('media.detail.resultFailed'));
      }
    };

    fetchUrl();

    return () => {
      cancelled = true;
      if (refreshTimer !== null) clearTimeout(refreshTimer);
    };
  }, [job?.status, job?.id, resultKey, t]);

  const cancelJob = async () => {
    if (!job) return;
    setCancelling(true);
    setCancelError(null);
    try {
      const res = await fetch(`/api/v1/media/jobs/${job.id}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reason.trim().length > 0 ? { reason: reason.trim() } : {}),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => undefined);
        setCancelError(mediaApiErrorText(t, data));
        return;
      }
      setReason('');
      retry(); // refetch the job: the cancel is now visible in its status
    } catch {
      setCancelError(t('media.detail.cancelFailed'));
    } finally {
      setCancelling(false);
    }
  };

  if (loading && !job) {
    return (
      <div className="flex items-center justify-center py-20">
        <p className="text-zinc-500">{t('media.detail.loading')}</p>
      </div>
    );
  }

  if (error || networkFailed) {
    return (
      <div className="flex flex-col items-center justify-center py-20">
        <p className="text-red-600">
          {networkFailed ? t('media.detail.loadFailed') : mediaApiErrorText(t, error)}
        </p>
        <button
          onClick={retry}
          className="mt-4 rounded bg-zinc-800 px-4 py-2 text-white hover:bg-zinc-700"
        >
          {t('common.retry')}
        </button>
      </div>
    );
  }

  if (!job) {
    return (
      <div className="flex flex-col items-center justify-center py-20">
        <p className="text-zinc-500">{t('media.detail.notFound')}</p>
        <Link href="/dashboard/media" className="mt-4 text-sm text-zinc-600 hover:text-zinc-800">
          {t('media.detail.backToList')}
        </Link>
      </div>
    );
  }

  const cancellable = job.status === 'queued' || job.status === 'processing';
  const paramEntries = Object.entries(job.params ?? {});

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <Link
        href="/dashboard/media"
        className="mb-6 inline-block text-sm text-zinc-600 hover:text-zinc-800"
      >
        {t('media.detail.backToList')}
      </Link>

      <div className="mb-4 flex items-center gap-3">
        <h1 className="text-2xl font-bold text-zinc-900">{t(`media.kind.${job.kind}`)}</h1>
        <MediaStatusBadge status={job.status} />
      </div>

      {/* Prompt */}
      <div className="mb-6 rounded-lg border border-zinc-200 bg-zinc-50 p-4">
        <p className="text-sm text-zinc-800">{job.prompt}</p>
      </div>

      {/* Timeline */}
      <dl className="mb-6 grid grid-cols-1 gap-2 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-zinc-400">{t('media.detail.created')}</dt>
          <dd className="text-zinc-800">{formatDateTime(job.createdAt, t.locale)}</dd>
        </div>
        {job.startedAt && (
          <div>
            <dt className="text-zinc-400">{t('media.detail.started')}</dt>
            <dd className="text-zinc-800">{formatDateTime(job.startedAt, t.locale)}</dd>
          </div>
        )}
        {job.finishedAt && (
          <div>
            <dt className="text-zinc-400">{t('media.detail.finished')}</dt>
            <dd className="text-zinc-800">{formatDateTime(job.finishedAt, t.locale)}</dd>
          </div>
        )}
      </dl>

      {/* Params + GPU */}
      {(paramEntries.length > 0 || job.gpuSeconds != null) && (
        <div className="mb-6 rounded-lg border border-zinc-200 p-4 text-sm">
          <h2 className="mb-2 font-medium text-zinc-700">{t('media.detail.paramsHeading')}</h2>
          <ul className="space-y-1 text-zinc-600">
            {paramEntries.map(([key, value]) => (
              <li key={key}>
                {key}: {String(value)}
              </li>
            ))}
            {job.gpuSeconds != null && (
              <li>{t('media.detail.gpuSeconds', { seconds: Math.round(job.gpuSeconds) })}</li>
            )}
          </ul>
        </div>
      )}

      {/* Failure info */}
      {job.errorCode && (
        <div className="mb-6 rounded-lg border border-red-200 bg-red-50 p-4 text-sm">
          <p className="font-medium text-red-800">{job.errorCode}</p>
          {job.errorReason && <p className="mt-1 text-red-700">{job.errorReason}</p>}
        </div>
      )}

      {/* Cancel */}
      {cancellable && (
        <div className="mb-6 rounded-lg border border-zinc-200 p-4">
          <h2 className="mb-2 text-sm font-medium text-zinc-700">{t('media.detail.cancelHeading')}</h2>
          <input
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={t('media.detail.cancelReasonPlaceholder')}
            aria-label={t('media.detail.cancelReasonLabel')}
            className="mb-3 w-full rounded-lg border border-zinc-300 p-2 text-sm focus:border-zinc-500 focus:outline-none"
          />
          {cancelError && <p className="mb-2 text-sm text-red-600">{cancelError}</p>}
          <button
            onClick={cancelJob}
            disabled={cancelling}
            className="rounded bg-red-700 px-4 py-2 text-sm font-medium text-white hover:bg-red-600 disabled:opacity-50"
          >
            {cancelling ? t('media.detail.cancelling') : t('common.cancel')}
          </button>
        </div>
      )}

      {/* Result preview */}
      {job.status === 'completed' && (
        <div className="mb-6">
          <h2 className="mb-3 text-lg font-medium text-zinc-900">{t('media.detail.resultHeading')}</h2>
          {resultError && (
            <div className="flex flex-col items-start gap-2">
              <p className="text-sm text-red-600">{resultError}</p>
              <button
                onClick={() => setResultKey((k) => k + 1)}
                className="rounded bg-zinc-800 px-4 py-2 text-sm text-white hover:bg-zinc-700"
              >
                {t('common.retry')}
              </button>
            </div>
          )}
          {!resultError && !resultUrl && (
            <p className="text-sm text-zinc-500">{t('media.detail.resultLoading')}</p>
          )}
          {resultUrl && (
            <div>
              {job.kind === 'image' ? (
                // next/image is wrong for a short-lived signed URL to private storage:
                // it would route the signed URL through the optimizer and need a
                // remotePatterns entry for a host that changes per deploy.
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={resultUrl}
                  alt={job.prompt}
                  className="max-h-[480px] rounded-lg border border-zinc-200"
                  onError={() => {
                    setResultUrl(null);
                    setResultError(t('media.detail.resultFailed'));
                  }}
                />
              ) : (
                <video
                  src={resultUrl}
                  controls
                  preload="metadata"
                  className="max-h-[480px] w-full rounded-lg border border-zinc-200"
                  onError={() => {
                    setResultUrl(null);
                    setResultError(t('media.detail.resultFailed'));
                  }}
                />
              )}
              <a
                href={resultUrl}
                download
                className="mt-3 inline-block rounded bg-zinc-800 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700"
              >
                {t('media.detail.download')}
              </a>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
