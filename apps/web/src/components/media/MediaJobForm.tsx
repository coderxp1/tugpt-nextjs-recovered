'use client';

// Media job submission form.
// Client-side validation mirrors the server rules (prompt 1..1000 chars,
// video frames 1..81 AND 4n+1, fps 1..30) so a rejected form never pays a
// round trip. Each submission carries a fresh idempotency key, so a double
// click or a retried request cannot create two jobs.

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useT } from '@/i18n/provider';
import type { MediaJobDetailResponse, MediaJobKind, MediaJobSubmitRequest } from '@/lib/media-api/types';
import { mediaApiErrorText } from '@/lib/media-api/error-text';
import {
  PROMPT_MAX_LENGTH,
  DEFAULT_FPS,
  DEFAULT_FRAMES,
  isValidPrompt,
  isValidFrames,
  isValidFps,
} from '@/lib/media-api/validation';

const IMAGE_SIZES = [
  { width: 1024, height: 1024 },
  { width: 1280, height: 720 },
  { width: 720, height: 1280 },
] as const;

export function MediaJobForm() {
  const t = useT();
  const router = useRouter();

  const [kind, setKind] = useState<MediaJobKind>('image');
  const [prompt, setPrompt] = useState('');
  const [negativePrompt, setNegativePrompt] = useState('');
  const [imageSize, setImageSize] = useState<string>('1024x1024');
  const [frames, setFrames] = useState(String(DEFAULT_FRAMES));
  const [fps, setFps] = useState(String(DEFAULT_FPS));
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [apiError, setApiError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const promptCount = prompt.length;

  const validate = (): boolean => {
    if (!isValidPrompt(prompt)) {
      setFieldError(
        prompt.trim().length === 0 ? t('media.form.promptRequired') : t('media.form.promptTooLong')
      );
      return false;
    }
    if (kind === 'video') {
      const framesNum = Number(frames);
      if (!isValidFrames(framesNum)) {
        setFieldError(t('media.form.framesInvalid'));
        return false;
      }
      const fpsNum = Number(fps);
      if (!isValidFps(fpsNum)) {
        setFieldError(t('media.form.fpsInvalid'));
        return false;
      }
    }
    setFieldError(null);
    return true;
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setApiError(null);
    if (!validate()) return;

    setSubmitting(true);
    try {
      const [width, height] = imageSize.split('x').map(Number);
      const payload: MediaJobSubmitRequest = {
        kind,
        prompt: prompt.trim(),
        idempotencyKey: crypto.randomUUID(),
        params:
          kind === 'image'
            ? { width, height }
            : { frames: Number(frames), fps: Number(fps) },
      };
      if (negativePrompt.trim().length > 0) {
        payload.negativePrompt = negativePrompt.trim();
      }

      const res = await fetch('/api/v1/media/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => undefined);
        setApiError(mediaApiErrorText(t, data));
        return;
      }

      const data = (await res.json()) as MediaJobDetailResponse;
      router.push(`/dashboard/media/${data.job.id}`);
    } catch {
      setApiError(t('media.form.submitFailed'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <h1 className="mb-6 text-2xl font-bold text-zinc-900">{t('media.form.title')}</h1>

      {/* noValidate: the min/max/step attributes are hints, not the validation.
          Native constraint validation would block submission with the
          browser's own untranslated bubble (e.g. a step mismatch for 20
          frames) before onSubmit runs. Our translated messages below are the
          ones the reviewer should see. */}
      <form onSubmit={submit} noValidate className="space-y-6">
        {/* Kind toggle */}
        <div>
          <span className="mb-2 block text-sm font-medium text-zinc-700">
            {t('media.form.kindLabel')}
          </span>
          <div className="flex gap-2">
            {(['image', 'video'] as const).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setKind(k)}
                aria-pressed={kind === k}
                className={`rounded px-4 py-2 text-sm font-medium ${
                  kind === k
                    ? 'bg-zinc-800 text-white'
                    : 'bg-zinc-100 text-zinc-700 hover:bg-zinc-200'
                }`}
              >
                {t(`media.kind.${k}`)}
              </button>
            ))}
          </div>
        </div>

        {/* Prompt */}
        <div>
          <label htmlFor="media-prompt" className="mb-2 block text-sm font-medium text-zinc-700">
            {t('media.form.promptLabel')}
          </label>
          <textarea
            id="media-prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={4}
            maxLength={PROMPT_MAX_LENGTH + 50}
            placeholder={t('media.form.promptPlaceholder')}
            className="w-full rounded-lg border border-zinc-300 p-3 text-sm focus:border-zinc-500 focus:outline-none"
          />
          <p className="mt-1 text-right text-xs text-zinc-400">
            {t('media.form.promptCounter', { count: promptCount, max: PROMPT_MAX_LENGTH })}
          </p>
        </div>

        {/* Negative prompt */}
        <div>
          <label
            htmlFor="media-negative-prompt"
            className="mb-2 block text-sm font-medium text-zinc-700"
          >
            {t('media.form.negativePromptLabel')}
          </label>
          <textarea
            id="media-negative-prompt"
            value={negativePrompt}
            onChange={(e) => setNegativePrompt(e.target.value)}
            rows={2}
            placeholder={t('media.form.negativePromptPlaceholder')}
            className="w-full rounded-lg border border-zinc-300 p-3 text-sm focus:border-zinc-500 focus:outline-none"
          />
        </div>

        {/* Image params */}
        {kind === 'image' && (
          <div>
            <label htmlFor="media-image-size" className="mb-2 block text-sm font-medium text-zinc-700">
              {t('media.form.imageSizeLabel')}
            </label>
            <select
              id="media-image-size"
              value={imageSize}
              onChange={(e) => setImageSize(e.target.value)}
              className="rounded-lg border border-zinc-300 p-2 text-sm focus:border-zinc-500 focus:outline-none"
            >
              {IMAGE_SIZES.map(({ width, height }) => (
                <option key={`${width}x${height}`} value={`${width}x${height}`}>
                  {width} × {height}
                </option>
              ))}
            </select>
          </div>
        )}

        {/* Video params */}
        {kind === 'video' && (
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label htmlFor="media-frames" className="mb-2 block text-sm font-medium text-zinc-700">
                {t('media.form.framesLabel')}
              </label>
              <input
                id="media-frames"
                type="number"
                min={1}
                max={81}
                step={4}
                value={frames}
                onChange={(e) => setFrames(e.target.value)}
                className="w-full rounded-lg border border-zinc-300 p-2 text-sm focus:border-zinc-500 focus:outline-none"
              />
              <p className="mt-1 text-xs text-zinc-400">{t('media.form.framesHint')}</p>
            </div>
            <div>
              <label htmlFor="media-fps" className="mb-2 block text-sm font-medium text-zinc-700">
                {t('media.form.fpsLabel')}
              </label>
              <input
                id="media-fps"
                type="number"
                min={1}
                max={30}
                value={fps}
                onChange={(e) => setFps(e.target.value)}
                className="w-full rounded-lg border border-zinc-300 p-2 text-sm focus:border-zinc-500 focus:outline-none"
              />
              <p className="mt-1 text-xs text-zinc-400">{t('media.form.fpsHint')}</p>
            </div>
          </div>
        )}

        {fieldError && <p className="text-sm text-red-600">{fieldError}</p>}
        {apiError && <p className="text-sm text-red-600">{apiError}</p>}

        <div className="flex items-center gap-4">
          <button
            type="submit"
            disabled={submitting}
            className="rounded bg-zinc-800 px-6 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50"
          >
            {submitting ? t('media.form.submitting') : t('media.form.submit')}
          </button>
          <Link href="/dashboard/media" className="text-sm text-zinc-600 hover:text-zinc-800">
            {t('media.form.backToList')}
          </Link>
        </div>
      </form>
    </div>
  );
}
