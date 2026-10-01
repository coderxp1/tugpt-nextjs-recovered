/**
 * Mock ComfyUI server for the media E2E test.
 *
 * Implements just enough of the ComfyUI API for MediaWorker:
 * - GET  /object_info        → required nodes + model allowlists
 * - POST /prompt             → accepts a prompt, returns a prompt_id
 * - GET  /history/<promptId> → completed with a fake image output
 * - GET  /queue              → empty (nothing pending/running)
 * - GET  /view               → fake PNG bytes
 *
 * The mock records every prompt it receives so the test can assert
 * the worker submitted exactly once (no double-submit on redelivery).
 */
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';

// 1x1 transparent PNG.
const FAKE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

const REQUIRED_NODES = [
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

const MODEL_ALLOWLISTS: Record<string, Record<string, string[]>> = {
  CheckpointLoaderSimple: { ckpt_name: ['flux1-schnell-fp8.safetensors'] },
  UNETLoader: {
    unet_name: [
      'wan2.2_t2v_high_noise_14B_fp16.safetensors',
      'wan2.2_t2v_low_noise_14B_fp16.safetensors',
    ],
  },
  CLIPLoader: { clip_name: ['umt5_xxl_fp16.safetensors'] },
  VAELoader: { vae_name: ['wan_2.1_vae.safetensors'] },
  LoraLoaderModelOnly: {
    lora_name: [
      'wan2.2_t2v_lightx2v_4steps_lora_v1.1_high_noise.safetensors',
      'wan2.2_t2v_lightx2v_4steps_lora_v1.1_low_noise.safetensors',
    ],
  },
};

export interface MockComfyUI {
  readonly url: string;
  readonly receivedPrompts: Array<{ promptId: string; body: unknown }>;
  close(): Promise<void>;
}

export async function startMockComfyUI(): Promise<MockComfyUI> {
  const receivedPrompts: Array<{ promptId: string; body: unknown }> = [];
  let promptCounter = 0;

  const sendJson = (res: ServerResponse, status: number, body: unknown) => {
    const payload = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(payload);
  };

  const readBody = (req: IncomingMessage): Promise<unknown> =>
    new Promise((resolve) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          resolve({});
        }
      });
    });

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    const path = url.pathname;

    if (req.method === 'GET' && path === '/object_info') {
      const info: Record<string, unknown> = {};
      for (const node of REQUIRED_NODES) {
        const allowlists = MODEL_ALLOWLISTS[node] || {};
        const required: Record<string, [string[]]> = {};
        for (const [param, options] of Object.entries(allowlists)) {
          required[param] = [options];
        }
        info[node] = { input: { required } };
      }
      sendJson(res, 200, info);
      return;
    }

    if (req.method === 'POST' && path === '/prompt') {
      const body = await readBody(req);
      promptCounter += 1;
      const promptId = `mock-prompt-${promptCounter}`;
      receivedPrompts.push({ promptId, body });
      sendJson(res, 200, { prompt_id: promptId });
      return;
    }

    if (req.method === 'GET' && path.startsWith('/history/')) {
      const promptId = path.slice('/history/'.length);
      const found = receivedPrompts.some((p) => p.promptId === promptId);
      if (!found) {
        sendJson(res, 200, {});
        return;
      }
      sendJson(res, 200, {
        [promptId]: {
          status: { status_str: 'success', completed: true, messages: [] },
          outputs: {
            '10': {
              images: [{ filename: 'mock-output.png', subfolder: '', type: 'output' }],
            },
          },
        },
      });
      return;
    }

    if (req.method === 'GET' && path === '/queue') {
      sendJson(res, 200, { queue_running: [], queue_pending: [] });
      return;
    }

    if (req.method === 'GET' && path === '/view') {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(FAKE_PNG);
      return;
    }

    if (req.method === 'GET' && path === '/system_stats') {
      sendJson(res, 200, { system: { os: 'mock' } });
      return;
    }

    sendJson(res, 404, { error: 'mock-comfyui: not implemented' });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    receivedPrompts,
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}
