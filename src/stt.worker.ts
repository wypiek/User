// Whisper runs entirely in this worker, so downloading / compiling / inferring
// can never freeze the 3D scene on the main thread.
import { pipeline, env } from '@huggingface/transformers';

type Transcriber = (audio: Float32Array, opts?: Record<string, unknown>) => Promise<{ text?: string } | { text?: string }[]>;

env.allowLocalModels = false;
env.useBrowserCache = true;
env.backends.onnx.wasm!.proxy = false; // we already are the background thread

let asr: Promise<Transcriber> | null = null;
let current = '';

function load(model: string): Promise<Transcriber> {
  if (asr && current === model) return asr;
  current = model;
  asr = (pipeline('automatic-speech-recognition', model, {
    dtype: 'q8',
    device: 'wasm',
    progress_callback: (p: { status: string; file?: string; progress?: number }) => {
      if (p.status === 'progress') postMessage({ type: 'progress', file: p.file, progress: p.progress });
    },
  }) as unknown as Promise<Transcriber>).catch((e) => {
    asr = null;
    throw e;
  });
  return asr;
}

self.onmessage = async (e: MessageEvent) => {
  const { id, type, model, pcm } = e.data as { id: number; type: 'load' | 'transcribe'; model: string; pcm?: Float32Array };
  try {
    const run = await load(model);
    if (type === 'load') return postMessage({ id, ok: true });
    const out = await run(pcm!, { chunk_length_s: 30, stride_length_s: 5 });
    const text = Array.isArray(out) ? out.map((o) => o.text ?? '').join(' ') : out.text ?? '';
    postMessage({ id, ok: true, text });
  } catch (err) {
    postMessage({ id, ok: false, error: String((err as Error)?.message ?? err) });
  }
};
