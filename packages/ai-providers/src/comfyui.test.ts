/**
 * @file comfyui.test.ts
 * @description Unit tests for ComfyUIAdapter using recorded fixtures.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ComfyUIAdapter } from './comfyui';
import { ProviderError } from './errors';

const FIXTURES_DIR = path.resolve(__dirname, '../../..', 'apps/worker/tests/fixtures/comfyui');

const objectInfoFixture = JSON.parse(readFileSync(path.join(FIXTURES_DIR, 'object_info.json'), 'utf8'));
const historyImageFixture = JSON.parse(readFileSync(path.join(FIXTURES_DIR, 'history-image-complete.json'), 'utf8'));
const historyVideoFixture = JSON.parse(readFileSync(path.join(FIXTURES_DIR, 'history-video-complete.json'), 'utf8'));
const historyInterruptedFixture = JSON.parse(readFileSync(path.join(FIXTURES_DIR, 'history-interrupted.json'), 'utf8'));

describe('ComfyUIAdapter', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let adapter: ComfyUIAdapter;

  beforeEach(() => {
    fetchMock = vi.fn();
    adapter = new ComfyUIAdapter({
      baseUrl: 'http://comfyui:8188',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
  });

  describe('validateObjectInfo', () => {
    it('succeeds when all required nodes are present', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify(objectInfoFixture), { status: 200, headers: { 'Content-Type': 'application/json' } })
      );

      const isValid = await adapter.validateObjectInfo();
      expect(isValid).toBe(true);
      expect(fetchMock).toHaveBeenCalledWith('http://comfyui:8188/object_info', expect.anything());
    });

    it('throws ProviderError when a required node is missing', async () => {
      const incompleteInfo = { ...objectInfoFixture };
      delete (incompleteInfo as Record<string, unknown>).CheckpointLoaderSimple;

      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify(incompleteInfo), { status: 200, headers: { 'Content-Type': 'application/json' } })
      );

      await expect(adapter.validateObjectInfo()).rejects.toThrow(ProviderError);
    });

    it('throws ProviderError when a required template model is missing from object_info allowlist', async () => {
      const modifiedInfo = JSON.parse(JSON.stringify(objectInfoFixture));
      modifiedInfo.CheckpointLoaderSimple.input.required.ckpt_name[0] = ['other-model.safetensors'];

      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify(modifiedInfo), { status: 200, headers: { 'Content-Type': 'application/json' } })
      );

      try {
        await adapter.validateObjectInfo();
        expect.fail('Should have thrown ProviderError for missing model');
      } catch (err) {
        expect(err).toBeInstanceOf(ProviderError);
        expect((err as ProviderError).category).toBe('INVALID_CONFIGURATION');
        expect((err as ProviderError).providerDetail).toContain("flux1-schnell-fp8.safetensors' missing");
      }
    });

    it('throws ProviderError on HTTP failure', async () => {
      fetchMock.mockResolvedValueOnce(new Response('Service Unavailable', { status: 503 }));
      await expect(adapter.validateObjectInfo()).rejects.toThrow(ProviderError);
    });
  });


  describe('submitPrompt', () => {
    it('validates prompt length bounds (>1000 chars throws 400)', async () => {
      const longPrompt = 'a'.repeat(1001);
      try {
        await adapter.submitPrompt({
          organizationId: 'org-1',
          jobId: 'job-1',
          domain: 'image',
          prompt: longPrompt,
        });
        expect.fail('Should have thrown ProviderError');
      } catch (err) {
        expect(err).toBeInstanceOf(ProviderError);
        expect((err as ProviderError).category).toBe('INVALID_REQUEST');
        expect((err as ProviderError).providerDetail).toContain('Prompt length exceeds 1000 characters');
      }
    });

    it('validates video resolution allowlist (invalid resolution throws 400)', async () => {
      try {
        await adapter.submitPrompt({
          organizationId: 'org-1',
          jobId: 'job-1',
          domain: 'video',
          prompt: 'ocean waves',
          width: 1920,
          height: 1080,
        });
        expect.fail('Should have thrown ProviderError');
      } catch (err) {
        expect(err).toBeInstanceOf(ProviderError);
        expect((err as ProviderError).category).toBe('INVALID_REQUEST');
        expect((err as ProviderError).providerDetail).toContain('Video resolution 1920x1080 not in allowlist');
      }
    });

    it('validates video 4n+1 frame rule (non-4n+1 frames like 80 throws 400)', async () => {
      await expect(
        adapter.submitPrompt({
          organizationId: 'org-1',
          jobId: 'job-1',
          domain: 'video',
          prompt: 'ocean waves',
          width: 1280,
          height: 720,
          frames: 80,
        })
      ).rejects.toThrow(ProviderError);

      await expect(
        adapter.submitPrompt({
          organizationId: 'org-1',
          jobId: 'job-1',
          domain: 'video',
          prompt: 'ocean waves',
          width: 1280,
          height: 720,
          frames: 4,
        })
      ).rejects.toThrow(ProviderError);
    });

    it('validates video fps bounds (fps > 30 or < 1 throws 400)', async () => {
      await expect(
        adapter.submitPrompt({
          organizationId: 'org-1',
          jobId: 'job-1',
          domain: 'video',
          prompt: 'ocean waves',
          width: 1280,
          height: 720,
          fps: 35,
        })
      ).rejects.toThrow(ProviderError);

      await expect(
        adapter.submitPrompt({
          organizationId: 'org-1',
          jobId: 'job-1',
          domain: 'video',
          prompt: 'ocean waves',
          width: 1280,
          height: 720,
          fps: 0,
        })
      ).rejects.toThrow(ProviderError);
    });


    it('submits image prompt successfully and builds graph with org_id/job_id subfolder prefix', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ prompt_id: 'prompt-image-uuid-1001' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      const res = await adapter.submitPrompt({
        organizationId: 'org-test-123',
        jobId: 'job-img-456',
        domain: 'image',
        prompt: 'A futuristic city at dusk',
        seed: 42,
      });

      expect(res.promptId).toBe('prompt-image-uuid-1001');
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('http://comfyui:8188/prompt');

      const body = JSON.parse(init.body as string);
      expect(body.prompt['9'].inputs.filename_prefix).toBe('org-test-123/job-img-456');
      expect(body.prompt['4'].inputs.ckpt_name).toBe('flux1-schnell-fp8.safetensors');
    });

    it('submits default video prompt successfully using Lightning LoRA and 4 steps', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ prompt_id: 'prompt-video-uuid-2002' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      const res = await adapter.submitPrompt({
        organizationId: 'org-test-123',
        jobId: 'job-vid-789',
        domain: 'video',
        lane: 'lightning',
        prompt: 'A dramatic cinematic landscape with stormy sky',
        seed: 12345,
      });

      expect(res.promptId).toBe('prompt-video-uuid-2002');

      const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
      expect(body.prompt['9'].inputs.filename_prefix).toBe('org-test-123/job-vid-789');
      expect(body.prompt['7'].inputs.steps).toBe(4);
      expect(body.prompt['2'].inputs.lora_name).toContain('wan2.2_t2v_lightx2v_4steps_lora');
    });

    it('submits quality video prompt successfully using 20 steps and no LoRA', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ prompt_id: 'prompt-video-uuid-2002' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      const res = await adapter.submitPrompt({
        organizationId: 'org-test-123',
        jobId: 'job-vid-789',
        domain: 'video',
        lane: 'quality',
        prompt: 'A dramatic cinematic landscape with stormy sky',
      });

      expect(res.promptId).toBe('prompt-video-uuid-2002');

      const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
      expect(body.prompt['6'].inputs.steps).toBe(20);
      expect(body.prompt['2'].class_type).toBe('CLIPLoader'); // No LoraLoaderModelOnly in quality lane
    });
  });

  describe('pollHistory', () => {
    it('parses completed image history fixture correctly', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify(historyImageFixture), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      const result = await adapter.pollHistory('prompt-image-uuid-1001', undefined, 1000);
      expect(result.status).toBe('completed');
      expect(result.output).toEqual({
        filename: 'job-img-1001_00001_.png',
        subfolder: '11111111-7c11-0000-0000-000000000001',
        type: 'output',
      });
    });

    it('parses completed video history fixture correctly', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify(historyVideoFixture), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      const result = await adapter.pollHistory('prompt-video-uuid-2002', undefined, 1000);
      expect(result.status).toBe('completed');
      expect(result.output).toEqual({
        filename: 'job-vid-2002_00001_.mp4',
        subfolder: '11111111-7c11-0000-0000-000000000001',
        type: 'output',
      });
    });

    it('parses interrupted history fixture as status cancelled (reading execution_interrupted message)', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify(historyInterruptedFixture), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      const result = await adapter.pollHistory('prompt-interrupted-uuid-3003', undefined, 1000);
      expect(result.status).toBe('cancelled');
      expect(result.errorCode).toBe('MEDIA_INTERRUPTED');
    });

    it('parses status_str: "error" without execution_interrupted as status failed with MEDIA_EXECUTION_ERROR', async () => {
      const errorFixture = {
        'prompt-err-uuid-4004': {
          status: {
            status_str: 'error',
            completed: false,
            messages: [
              ['execution_start', { prompt_id: 'prompt-err-uuid-4004' }],
              ['execution_error', { node_id: '6', node_type: 'WanSampler', exception_message: 'CUDA OOM' }],
            ],
          },
        },
      };

      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify(errorFixture), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      const result = await adapter.pollHistory('prompt-err-uuid-4004', undefined, 1000);
      expect(result.status).toBe('failed');
      expect(result.errorCode).toBe('MEDIA_EXECUTION_ERROR');
    });

    it('returns status failed with MEDIA_HISTORY_LOST when prompt_id is missing from history and queue', async () => {
      // 1. Return empty history map
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } })
      );
      // 2. Return empty queue
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ queue_running: [], queue_pending: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      const result = await adapter.pollHistory('missing-prompt-uuid-5005', undefined, 1000);
      expect(result.status).toBe('failed');
      expect(result.errorCode).toBe('MEDIA_HISTORY_LOST');
    });

  });


  describe('fetchOutputBytes', () => {
    it('fetches output bytes via /view API', async () => {
      const dummyBuffer = Buffer.from('fake-image-bytes');
      fetchMock.mockResolvedValueOnce(new Response(dummyBuffer, { status: 200 }));

      const bytes = await adapter.fetchOutputBytes({
        filename: 'test_render.png',
        subfolder: 'org1/job1',
        type: 'output',
      });

      expect(bytes).toEqual(dummyBuffer);
      expect(fetchMock).toHaveBeenCalledWith(
        'http://comfyui:8188/view?filename=test_render.png&subfolder=org1%2Fjob1&type=output',
        expect.anything()
      );
    });
  });
});
