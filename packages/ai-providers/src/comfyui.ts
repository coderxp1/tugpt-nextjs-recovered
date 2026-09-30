/**
 * @file comfyui.ts
 * @description Dedicated ComfyUI provider adapter for TuGPT media generation.
 *
 * Implements local open-weights image (FLUX.1 schnell) and video (WAN 2.2 14B two-stage
 * high-/low-noise pipeline) generation over ComfyUI's REST API.
 *
 * GOVERNANCE AND INVARIANTS (ADR-019 & Review 07/08):
 * 1. Loopback / Internal Network only: Connects to ComfyUI over internal network (default http://comfyui:8188).
 * 2. Parameter Allowlist & Typed Payloads: Callers submit typed requests, never raw workflow graphs.
 * 3. Parameter bounds: Fixed resolutions (1280x720, 720x1280, 832x480 for video; 1024x1024 for image);
 *    prompt <= 1000 chars; steps fixed per lane (4 for lightning / schnell, 20 for quality WAN).
 * 4. Output retrieval: Fetches output via GET /view?filename=... using metadata returned by /history.
 * 5. Interrupt/Cancel Mapping: Distinguishes execution_interrupted (CANCELLED) from execution_error (FAILED).
 */

import { ProviderError } from './errors.js';

export type MediaDomain = 'image' | 'video';
export type MediaLane = 'lightning' | 'quality';

export interface MediaGenerationRequest {
  readonly organizationId: string;
  readonly jobId: string;
  readonly domain: MediaDomain;
  readonly lane?: MediaLane;
  readonly prompt: string;
  readonly negativePrompt?: string;
  readonly width?: number;
  readonly height?: number;
  readonly frames?: number;
  readonly fps?: number;
  readonly seed?: number;
}

export interface MediaOutputInfo {
  readonly filename: string;
  readonly subfolder: string;
  readonly type: string;
}

export interface MediaGenerationResult {
  readonly promptId: string;
  readonly status: 'completed' | 'cancelled' | 'failed' | 'timed_out';
  readonly output?: MediaOutputInfo;
  readonly latencyMs: number;
  readonly errorCode?: string;
  readonly errorDetail?: string;
}

export interface ComfyUIAdapterConfig {
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
}

export class ComfyUIAdapter {
  readonly providerName = 'comfyui';
  private readonly baseUrl: string;
  private readonly customFetch: typeof fetch;

  constructor(config?: ComfyUIAdapterConfig) {
    this.baseUrl = (config?.baseUrl || process.env.COMFYUI_BASE_URL || 'http://comfyui:8188').replace(/\/+$/, '');
    this.customFetch = config?.fetchImpl || globalThis.fetch;
  }

  /**
   * Validate that ComfyUI server is online, required loader nodes are available,
   * and required template models/LoRAs are present in node option allowlists.
   */
  async validateObjectInfo(signal?: AbortSignal): Promise<boolean> {
    try {
      const res = await this.customFetch(`${this.baseUrl}/object_info`, { signal });
      if (!res.ok) {
        throw ProviderError.fromHttpStatus(this.providerName, res.status, 'object_info check failed');
      }
      const data = (await res.json()) as Record<string, { input?: { required?: Record<string, [string[]]> } }>;
      const requiredNodes = [
        'UNETLoader',
        'CheckpointLoaderSimple',
        'CLIPLoader',
        'CLIPTextEncode',
        'VAELoader',
        'VAEDecode',
        'LoraLoaderModelOnly',
        'ModelSamplingSD3',
        'EmptyHunyuanLatentVideo',
        'KSamplerAdvanced',
        'CreateVideo',
        'SaveVideo',
      ];
      for (const node of requiredNodes) {
        if (!data[node]) {
          throw new ProviderError(
            this.providerName,
            'INVALID_CONFIGURATION',
            undefined,
            `Required node ${node} missing from ComfyUI object_info`
          );
        }
      }

      // Check model allowlist options in object_info schemas
      const requiredModelChecks: Array<{ node: string; param: string; expectedModel: string }> = [
        { node: 'CheckpointLoaderSimple', param: 'ckpt_name', expectedModel: 'flux1-schnell-fp8.safetensors' },
        { node: 'UNETLoader', param: 'unet_name', expectedModel: 'wan2.2_t2v_high_noise_14B_fp16.safetensors' },
        { node: 'UNETLoader', param: 'unet_name', expectedModel: 'wan2.2_t2v_low_noise_14B_fp16.safetensors' },
        { node: 'CLIPLoader', param: 'clip_name', expectedModel: 'umt5_xxl_fp16.safetensors' },
        { node: 'VAELoader', param: 'vae_name', expectedModel: 'wan_2.1_vae.safetensors' },
        { node: 'LoraLoaderModelOnly', param: 'lora_name', expectedModel: 'wan2.2_t2v_lightx2v_4steps_lora_v1.1_high_noise.safetensors' },
        { node: 'LoraLoaderModelOnly', param: 'lora_name', expectedModel: 'wan2.2_t2v_lightx2v_4steps_lora_v1.1_low_noise.safetensors' },
      ];

      for (const check of requiredModelChecks) {
        const nodeInfo = data[check.node];
        const inputReq = nodeInfo?.input?.required?.[check.param];
        const optionsList: string[] = Array.isArray(inputReq?.[0]) ? inputReq[0] : [];

        if (!optionsList.includes(check.expectedModel)) {
          throw new ProviderError(
            this.providerName,
            'INVALID_CONFIGURATION',
            undefined,
            `Required model/LoRA '${check.expectedModel}' missing from node ${check.node}.${check.param} options list`
          );
        }
      }

      return true;
    } catch (err: unknown) {
      if (err instanceof ProviderError) throw err;
      throw new ProviderError(
        this.providerName,
        'NETWORK_FAILURE',
        undefined,
        (err as Error).message
      );
    }
  }

  /**
   * Query ComfyUI /queue endpoint to check if promptId is running or pending.
   */
  async checkQueue(promptId: string, signal?: AbortSignal): Promise<{ isPending: boolean; isRunning: boolean }> {
    try {
      const res = await this.customFetch(`${this.baseUrl}/queue`, { signal });
      if (!res.ok) return { isPending: false, isRunning: false };
      const data = (await res.json()) as { queue_running?: Array<[number, string, ...unknown[]]>; queue_pending?: Array<[number, string, ...unknown[]]> };
      const running = data.queue_running || [];
      const pending = data.queue_pending || [];

      const isRunning = running.some((item) => item[1] === promptId);
      const isPending = pending.some((item) => item[1] === promptId);
      return { isPending, isRunning };
    } catch {
      return { isPending: false, isRunning: false };
    }
  }

  /**
   * One-shot history check for worker restart recovery.
   *
   * Unlike pollHistory, this does not wait: it fetches /history/<promptId>
   * once and reports what ComfyUI knows right now. The worker uses it to
   * reconcile interrupted jobs before polling for new work — completed
   * results are collected, still-queued prompts are adopted, and only
   * genuinely lost prompts are failed visibly (never silently resubmitted).
   */
  async peekHistory(
    promptId: string,
    signal?: AbortSignal
  ): Promise<
    | { readonly found: false }
    | { readonly found: true; readonly status: 'completed' | 'pending' | 'error'; readonly output?: MediaOutputInfo; readonly errorDetail?: string }
  > {
    const res = await this.customFetch(`${this.baseUrl}/history/${promptId}`, { signal });
    if (!res.ok) return { found: false };
    const historyMap = (await res.json()) as Record<string, unknown>;
    const item = historyMap[promptId] as Record<string, unknown> | undefined;
    if (!item) return { found: false };

    const statusObj = item.status as { status_str?: string; completed?: boolean; messages?: Array<[string, unknown]> } | undefined;
    const statusStr = statusObj?.status_str;

    if (statusStr === 'success' || statusObj?.completed === true) {
      const outputs = item.outputs as Record<string, { images?: MediaOutputInfo[]; gifs?: MediaOutputInfo[] }> | undefined;
      let outputInfo: MediaOutputInfo | undefined;
      if (outputs) {
        for (const nodeKey of Object.keys(outputs)) {
          const nodeOut = outputs[nodeKey];
          const files = nodeOut.images || nodeOut.gifs;
          if (files && files.length > 0) {
            outputInfo = files[0];
            break;
          }
        }
      }
      return { found: true, status: 'completed', output: outputInfo };
    }

    if (statusStr === 'error') {
      const messages = statusObj?.messages || [];
      const detail = messages
        .map(([, msg]) => JSON.stringify(msg))
        .join('; ')
        .slice(0, 512);
      return { found: true, status: 'error', errorDetail: detail || 'ComfyUI execution error' };
    }

    // Present but neither success nor error: still finalizing.
    return { found: true, status: 'pending' };
  }


  /**
   * Build workflow graph JSON for the requested domain & lane.
   */
  buildWorkflowGraph(req: MediaGenerationRequest): Record<string, unknown> {
    const lane = req.lane || 'lightning';
    const seed = req.seed ?? Math.floor(Math.random() * 1000000);
    const subfolderPrefix = `${req.organizationId}/${req.jobId}`;

    if (req.domain === 'image') {
      // FLUX.1 schnell fp8 image generation
      return {
        '3': {
          inputs: {
            seed,
            steps: 4,
            cfg: 1.0,
            sampler_name: 'euler',
            scheduler: 'simple',
            denoise: 1.0,
            model: ['4', 0],
            positive: ['6', 0],
            negative: ['7', 0],
            latent_image: ['5', 0],
          },
          class_type: 'KSampler',
        },
        '4': {
          inputs: {
            ckpt_name: 'flux1-schnell-fp8.safetensors',
          },
          class_type: 'CheckpointLoaderSimple',
        },
        '5': {
          inputs: {
            width: req.width || 1024,
            height: req.height || 1024,
            batch_size: 1,
          },
          class_type: 'EmptyLatentImage',
        },
        '6': {
          inputs: {
            text: req.prompt,
            clip: ['4', 1],
          },
          class_type: 'CLIPTextEncode',
        },
        '7': {
          inputs: {
            text: '', // FLUX schnell ignores negative prompt
            clip: ['4', 1],
          },
          class_type: 'CLIPTextEncode',
        },
        '8': {
          inputs: {
            samples: ['3', 0],
            vae: ['4', 2],
          },
          class_type: 'VAEDecode',
        },
        '9': {
          inputs: {
            filename_prefix: subfolderPrefix,
            images: ['8', 0],
          },
          class_type: 'SaveImage',
        },
      };
    }

    if (lane !== 'lightning' && lane !== 'quality') {
      throw new ProviderError(
        this.providerName,
        'INVALID_REQUEST',
        400,
        `Unknown media lane '${req.lane}': expected 'lightning' or 'quality'`
      );
    }

    // Video domain: WAN 2.2 — two-stage high-noise -> low-noise pipeline.
    // Reference: apps/worker/tests/fixtures/comfyui/test-wan-lightning.json
    // (recorded working workflow). Stage 1 (KSamplerAdvanced '10') denoises with
    // the high-noise UNet for the first half of the steps and returns the latent
    // with leftover noise; stage 2 ('11') continues from that latent with the
    // low-noise UNet without adding noise. VAE decode -> CreateVideo ->
    // SaveVideo (mp4/h264) completes the graph.
    const useLora = lane === 'lightning'; // Lightning 4-step LoRAs; quality lane uses bare UNets
    const steps = useLora ? 4 : 20;
    const cfg = useLora ? 1.0 : 3.5;
    const shift = useLora ? 5.0 : 8.0;
    const stageSplit = Math.floor(steps / 2);
    const highModelRef = useLora ? '1L' : '1';
    const lowModelRef = useLora ? '2L' : '2';

    return {
      '1': {
        inputs: {
          unet_name: 'wan2.2_t2v_high_noise_14B_fp16.safetensors',
          weight_dtype: 'default',
        },
        class_type: 'UNETLoader',
      },
      ...(useLora
        ? {
            '1L': {
              inputs: {
                model: ['1', 0],
                lora_name: 'wan2.2_t2v_lightx2v_4steps_lora_v1.1_high_noise.safetensors',
                strength_model: 1.0,
              },
              class_type: 'LoraLoaderModelOnly',
            },
          }
        : {}),
      '2': {
        inputs: {
          unet_name: 'wan2.2_t2v_low_noise_14B_fp16.safetensors',
          weight_dtype: 'default',
        },
        class_type: 'UNETLoader',
      },
      ...(useLora
        ? {
            '2L': {
              inputs: {
                model: ['2', 0],
                lora_name: 'wan2.2_t2v_lightx2v_4steps_lora_v1.1_low_noise.safetensors',
                strength_model: 1.0,
              },
              class_type: 'LoraLoaderModelOnly',
            },
          }
        : {}),
      '3': {
        inputs: {
          clip_name: 'umt5_xxl_fp16.safetensors',
          type: 'wan',
          device: 'default',
        },
        class_type: 'CLIPLoader',
      },
      '4': {
        inputs: {
          vae_name: 'wan_2.1_vae.safetensors',
        },
        class_type: 'VAELoader',
      },
      '5': {
        inputs: {
          text: req.prompt,
          clip: ['3', 0],
        },
        class_type: 'CLIPTextEncode',
      },
      '6': {
        inputs: {
          text: req.negativePrompt || 'blurry, distorted, low quality, static, watermark',
          clip: ['3', 0],
        },
        class_type: 'CLIPTextEncode',
      },
      '7': {
        inputs: {
          model: [highModelRef, 0],
          shift,
        },
        class_type: 'ModelSamplingSD3',
      },
      '8': {
        inputs: {
          model: [lowModelRef, 0],
          shift,
        },
        class_type: 'ModelSamplingSD3',
      },
      '9': {
        inputs: {
          width: req.width || 1280,
          height: req.height || 720,
          length: req.frames || 81,
          batch_size: 1,
        },
        class_type: 'EmptyHunyuanLatentVideo',
      },
      '10': {
        inputs: {
          model: ['7', 0],
          add_noise: 'enable',
          noise_seed: seed,
          steps,
          cfg,
          sampler_name: 'euler',
          scheduler: 'simple',
          positive: ['5', 0],
          negative: ['6', 0],
          latent_image: ['9', 0],
          start_at_step: 0,
          end_at_step: stageSplit,
          return_with_leftover_noise: 'enable',
        },
        class_type: 'KSamplerAdvanced',
      },
      '11': {
        inputs: {
          model: ['8', 0],
          add_noise: 'disable',
          noise_seed: 0,
          steps,
          cfg,
          sampler_name: 'euler',
          scheduler: 'simple',
          positive: ['5', 0],
          negative: ['6', 0],
          latent_image: ['10', 0],
          start_at_step: stageSplit,
          end_at_step: 10000,
          return_with_leftover_noise: 'disable',
        },
        class_type: 'KSamplerAdvanced',
      },
      '12': {
        inputs: {
          samples: ['11', 0],
          vae: ['4', 0],
        },
        class_type: 'VAEDecode',
      },
      '13': {
        inputs: {
          images: ['12', 0],
          fps: req.fps || 16,
        },
        class_type: 'CreateVideo',
      },
      '14': {
        inputs: {
          video: ['13', 0],
          filename_prefix: subfolderPrefix,
          format: 'mp4',
          codec: 'h264',
        },
        class_type: 'SaveVideo',
      },
    };
  }

  /**
   * Submit prompt to ComfyUI.
   */
  async submitPrompt(req: MediaGenerationRequest, signal?: AbortSignal): Promise<{ promptId: string }> {
    // Parameter validation
    if (!req.prompt || req.prompt.trim().length === 0) {
      throw new ProviderError(this.providerName, 'INVALID_REQUEST', 400, 'Prompt text is required');
    }

    if (req.prompt.length > 1000) {
      throw new ProviderError(this.providerName, 'INVALID_REQUEST', 400, 'Prompt length exceeds 1000 characters');
    }

    if (req.domain === 'image') {
      const allowedRes = ['1024x1024'];
      const resStr = `${req.width || 1024}x${req.height || 1024}`;
      if (!allowedRes.includes(resStr)) {
        throw new ProviderError(
          this.providerName,
          'INVALID_REQUEST',
          400,
          `Image resolution ${resStr} not in allowlist (${allowedRes.join(', ')})`
        );
      }
    }

    if (req.domain === 'video') {
      const allowedRes = ['1280x720', '720x1280', '832x480'];
      const resStr = `${req.width || 1280}x${req.height || 720}`;
      if (!allowedRes.includes(resStr)) {
        throw new ProviderError(
          this.providerName,
          'INVALID_REQUEST',
          400,
          `Video resolution ${resStr} not in allowlist (${allowedRes.join(', ')})`
        );
      }
      const frames = req.frames ?? 81;
      if (frames < 1 || frames > 81 || (frames - 1) % 4 !== 0) {
        throw new ProviderError(
          this.providerName,
          'INVALID_REQUEST',
          400,
          'Video frames must follow 4n+1 rule between 1 and 81 (e.g. 1, 5, 9, ..., 81)'
        );
      }
      const fps = req.fps ?? 16;
      if (fps < 1 || fps > 30) {
        throw new ProviderError(this.providerName, 'INVALID_REQUEST', 400, 'Video fps must be between 1 and 30');
      }
    }

    const workflow = this.buildWorkflowGraph(req);

    try {
      const response = await this.customFetch(`${this.baseUrl}/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: workflow }),
        signal,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw ProviderError.fromHttpStatus(this.providerName, response.status, text);
      }

      const data = (await response.json()) as { prompt_id?: string };
      if (!data.prompt_id) {
        throw new ProviderError(
          this.providerName,
          'MALFORMED_PROVIDER_RESPONSE',
          undefined,
          'Missing prompt_id in ComfyUI /prompt response'
        );
      }

      return { promptId: data.prompt_id };
    } catch (err: unknown) {
      if (err instanceof ProviderError) throw err;
      throw new ProviderError(
        this.providerName,
        'NETWORK_FAILURE',
        undefined,
        (err as Error).message
      );
    }
  }

  /**
   * Poll `/history/<prompt_id>` for job completion status.
   */
  async pollHistory(
    promptId: string,
    signal?: AbortSignal,
    maxWaitMs: number = 600000
  ): Promise<MediaGenerationResult> {
    const startTime = Date.now();
    let pollIntervalMs = 5000;

    while (!signal?.aborted && Date.now() - startTime < maxWaitMs) {
      try {
        const res = await this.customFetch(`${this.baseUrl}/history/${promptId}`, { signal });
        if (res.ok) {
          const historyMap = (await res.json()) as Record<string, unknown>;
          const item = historyMap[promptId] as Record<string, unknown> | undefined;

          if (item) {
            const statusObj = item.status as { status_str?: string; completed?: boolean; messages?: Array<[string, unknown]> } | undefined;
            const statusStr = statusObj?.status_str;
            const messages = statusObj?.messages || [];

            if (statusStr === 'success' || statusObj?.completed === true) {
              // Extract output information
              const outputs = item.outputs as Record<string, { images?: MediaOutputInfo[]; gifs?: MediaOutputInfo[] }> | undefined;
              let outputInfo: MediaOutputInfo | undefined;

              if (outputs) {
                for (const nodeKey of Object.keys(outputs)) {
                  const nodeOut = outputs[nodeKey];
                  const files = nodeOut.images || nodeOut.gifs;
                  if (files && files.length > 0) {
                    outputInfo = files[0];
                    break;
                  }
                }
              }

              return {
                promptId,
                status: 'completed',
                output: outputInfo,
                latencyMs: Date.now() - startTime,
              };
            }

            if (statusStr === 'error') {
              // Inspect messages array: execution_interrupted maps to cancelled, execution_error maps to failed
              const isInterrupted = messages.some(([msgType]) => msgType === 'execution_interrupted');
              return {
                promptId,
                status: isInterrupted ? 'cancelled' : 'failed',
                latencyMs: Date.now() - startTime,
                errorCode: isInterrupted ? 'MEDIA_INTERRUPTED' : 'MEDIA_EXECUTION_ERROR',
                errorDetail: isInterrupted ? 'Job interrupted during execution' : 'ComfyUI execution error',
              };
            }
          } else {
            // Prompt ID not in history map. Verify whether it is still pending or running in queue.
            const qState = await this.checkQueue(promptId, signal);
            if (!qState.isPending && !qState.isRunning) {
              return {
                promptId,
                status: 'failed',
                latencyMs: Date.now() - startTime,
                errorCode: 'MEDIA_HISTORY_LOST',
                errorDetail: 'ComfyUI prompt history lost (server restarted or queue cleared)',
              };
            }
          }
        }

      } catch {
        if (signal?.aborted) break;
      }

      // Check if elapsed time passed 60s -> increase interval to 10s
      if (Date.now() - startTime > 60000) {
        pollIntervalMs = 10000;
      }

      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    if (signal?.aborted) {
      return {
        promptId,
        status: 'cancelled',
        latencyMs: Date.now() - startTime,
        errorCode: 'MEDIA_ABORTED',
      };
    }

    return {
      promptId,
      status: 'timed_out',
      latencyMs: Date.now() - startTime,
      errorCode: 'MEDIA_TIMEOUT',
      errorDetail: `Polling timed out after ${maxWaitMs}ms`,
    };
  }

  /**
   * Safe interrupt: only issue global POST /interrupt if target prompt is actively running on ComfyUI.
   * If target prompt is pending in queue, remove it via POST /queue without global interrupt.
   */
  async interrupt(promptId: string, signal?: AbortSignal): Promise<void> {
    try {
      const qState = await this.checkQueue(promptId, signal);

      if (qState.isRunning) {
        // Only POST /interrupt when target prompt is confirmed actively running
        await this.customFetch(`${this.baseUrl}/interrupt`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal,
        });
      } else if (qState.isPending) {
        // Delete from queue if pending (completely targeted, zero global side-effects)
        await this.customFetch(`${this.baseUrl}/queue`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ delete: [promptId] }),
          signal,
        });
      }
    } catch {
      // Swallowed: best-effort safe interrupt
    }
  }

  /**
   * Fetch output file bytes from ComfyUI /view API.
   */
  async fetchOutputBytes(output: MediaOutputInfo, signal?: AbortSignal): Promise<Buffer> {
    const params = new URLSearchParams({
      filename: output.filename,
      subfolder: output.subfolder,
      type: output.type || 'output',
    });

    const url = `${this.baseUrl}/view?${params.toString()}`;
    const res = await this.customFetch(url, { signal });

    if (!res.ok) {
      throw ProviderError.fromHttpStatus(this.providerName, res.status, `Failed to fetch output file ${output.filename}`);
    }

    const arrayBuffer = await res.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }
}
