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
// Recorded working workflow (reconstructed from the GPU-host command; verify byte-for-byte
// against /srv/ai/comfyui/test-wan-lightning.json once host access is approved).
const wanLightningReference = JSON.parse(readFileSync(path.join(FIXTURES_DIR, 'test-wan-lightning.json'), 'utf8')).prompt;

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

    it('submits lightning video prompt using the two-stage graph (4 steps, LoRAs)', async () => {
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
      const graph = body.prompt;
      // Both UNets with their matching Lightning LoRAs.
      expect(graph['1'].inputs.unet_name).toBe('wan2.2_t2v_high_noise_14B_fp16.safetensors');
      expect(graph['1L'].inputs.lora_name).toBe('wan2.2_t2v_lightx2v_4steps_lora_v1.1_high_noise.safetensors');
      expect(graph['2'].inputs.unet_name).toBe('wan2.2_t2v_low_noise_14B_fp16.safetensors');
      expect(graph['2L'].inputs.lora_name).toBe('wan2.2_t2v_lightx2v_4steps_lora_v1.1_low_noise.safetensors');
      // Two KSamplerAdvanced stages, 4 steps each.
      expect(graph['10'].class_type).toBe('KSamplerAdvanced');
      expect(graph['10'].inputs.steps).toBe(4);
      expect(graph['11'].class_type).toBe('KSamplerAdvanced');
      expect(graph['11'].inputs.steps).toBe(4);
      // Output chain ends in SaveVideo mp4/h264 with the org/job prefix.
      expect(graph['14'].inputs.filename_prefix).toBe('org-test-123/job-vid-789');
      expect(graph['14'].inputs.format).toBe('mp4');
    });

    it('builds a two-stage high/low-noise graph matching the recorded reference structure', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ prompt_id: 'prompt-video-uuid-2003' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      await adapter.submitPrompt({
        organizationId: 'org-test-123',
        jobId: 'job-vid-ref',
        domain: 'video',
        lane: 'lightning',
        prompt: 'A dramatic cinematic landscape with stormy sky',
        seed: 42,
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
      const graph = body.prompt;

      // Every reference node id exists with the same class_type.
      for (const nodeId of Object.keys(wanLightningReference)) {
        expect(graph[nodeId], `node ${nodeId} missing from built graph`).toBeDefined();
        expect(graph[nodeId].class_type).toBe(wanLightningReference[nodeId].class_type);
      }

      // High-noise stage: samples from the empty latent, returns leftover noise.
      const stage1 = graph['10'].inputs;
      expect(stage1.model).toEqual(['7', 0]); // high-noise branch (ModelSamplingSD3 on 1L)
      expect(stage1.latent_image).toEqual(['9', 0]);
      expect(stage1.add_noise).toBe('enable');
      expect(stage1.start_at_step).toBe(0);
      expect(stage1.end_at_step).toBe(2);
      expect(stage1.return_with_leftover_noise).toBe('enable');

      // Low-noise stage: continues from the high-noise stage latent, no new noise.
      const stage2 = graph['11'].inputs;
      expect(stage2.model).toEqual(['8', 0]); // low-noise branch (ModelSamplingSD3 on 2L)
      expect(stage2.latent_image).toEqual(['10', 0]);
      expect(stage2.add_noise).toBe('disable');
      expect(stage2.start_at_step).toBe(2);
      expect(stage2.return_with_leftover_noise).toBe('disable');

      // Decode -> CreateVideo -> SaveVideo chain.
      expect(graph['12'].inputs.samples).toEqual(['11', 0]);
      expect(graph['13'].class_type).toBe('CreateVideo');
      expect(graph['13'].inputs.images).toEqual(['12', 0]);
      expect(graph['13'].inputs.fps).toBe(16);
      expect(graph['14'].class_type).toBe('SaveVideo');
      expect(graph['14'].inputs.video).toEqual(['13', 0]);
      expect(graph['14'].inputs.format).toBe('mp4');
      expect(graph['14'].inputs.codec).toBe('h264');
    });

    it('rejects an unknown lane value with INVALID_REQUEST', async () => {
      await expect(
        adapter.submitPrompt({
          organizationId: 'org-1',
          jobId: 'job-1',
          domain: 'video',
          lane: 'default' as 'lightning',
          prompt: 'ocean waves',
        })
      ).rejects.toThrow(ProviderError);
    });

    it('submits quality video prompt using the two-stage graph with 20 steps and no LoRA', async () => {
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
      const graph = body.prompt;
      // No LoRA nodes on the quality lane; ModelSamplingSD3 sits directly on the UNets.
      expect(graph['1L']).toBeUndefined();
      expect(graph['2L']).toBeUndefined();
      expect(graph['7'].inputs.model).toEqual(['1', 0]);
      expect(graph['8'].inputs.model).toEqual(['2', 0]);
      // Two stages of 10 steps each: 0->10 high-noise, 10->end low-noise.
      expect(graph['10'].inputs.steps).toBe(20);
      expect(graph['10'].inputs.start_at_step).toBe(0);
      expect(graph['10'].inputs.end_at_step).toBe(10);
      expect(graph['11'].inputs.start_at_step).toBe(10);
      expect(graph['11'].inputs.latent_image).toEqual(['10', 0]);
      expect(graph['14'].class_type).toBe('SaveVideo');
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
