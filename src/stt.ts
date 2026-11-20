// Local, offline-after-first-download speech recognition (Whisper via transformers.js).
// The microphone itself is captured natively by Rust (cpal) and handed over as 16 kHz PCM.
// Works the same no matter which AI backend powers User, and needs no API key.
import { pipeline, env } from '@huggingface/transformers';

type Transcriber = (audio: Float32Array, opts?: Record<string, unknown>) => Promise<{ text?: string } | { text?: string }[]>;
type Progress = (p: { status: string; file?: string; progress?: number }) => void;

env.allowLocalModels = false;
env.useBrowserCache = true;
const wasm = env.backends.onnx.wasm!;
wasm.proxy = true; // run inference off the render thread

let transcriberPromise: Promise<Transcriber> | null = null;
let currentModel: string | null = null;

export function loadSTT(model = 'onnx-community/whisper-base.en', onProgress?: Progress): Promise<Transcriber> {
  if (transcriberPromise && currentModel === model) return transcriberPromise;
  currentModel = model;
  const make = async () =>
    (await pipeline('automatic-speech-recognition', model, {
      dtype: 'q8',
      device: 'wasm',
      progress_callback: onProgress as never,
    })) as unknown as Transcriber;
  transcriberPromise = make()
    .catch((err) => {
      // If the off-thread proxy worker can't start in this webview, run in-page instead.
      if (!wasm.proxy) throw err;
      console.warn('ASR proxy worker failed, retrying in-page', err);
      wasm.proxy = false;
      return make();
    })
    .catch((err) => {
      transcriberPromise = null;
      throw err;
    });
  return transcriberPromise;
}

/** @param pcm mono 16 kHz samples */
export async function transcribe(pcm: Float32Array, model?: string): Promise<string> {
  const asr = await loadSTT(model);
  if (pcm.length < 16000 * 0.25) return '';
  const out = await asr(pcm, { chunk_length_s: 30, stride_length_s: 5 });
  const text = Array.isArray(out) ? out.map((o) => o.text ?? '').join(' ') : out.text ?? '';
  return cleanTranscript(text);
}

function cleanTranscript(t: string): string {
  t = t
    .replace(/\[(BLANK_AUDIO|MUSIC|NOISE|SILENCE)[^\]]*\]/gi, '')
    .replace(/\((?:[^)]*(?:music|noise|silence|static|breathing)[^)]*)\)/gi, '')
    .trim();
  // Whisper hallucinates these on near-silent input.
  if (/^(you|thank you\.?|thanks for watching!?|\.+)$/i.test(t)) return '';
  return t;
}
