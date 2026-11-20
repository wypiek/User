// Local, offline-after-first-download speech recognition (Whisper via transformers.js).
// The microphone is captured natively by Rust (cpal) and handed over as 16 kHz PCM;
// Whisper itself runs in a Web Worker (stt.worker.ts) so it never blocks rendering.

type Progress = (p: { status: string; file?: string; progress?: number }) => void;
type Reply = { id: number; ok: boolean; text?: string; error?: string };

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, (r: Reply) => void>();
let onProgress: Progress | undefined;
let loaded: Promise<void> | null = null;
let loadedModel = '';

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./stt.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (e: MessageEvent) => {
    const d = e.data;
    if (d.type === 'progress') return onProgress?.({ status: 'progress', file: d.file, progress: d.progress });
    pending.get(d.id)?.(d as Reply);
    pending.delete(d.id);
  };
  worker.onerror = (e) => {
    for (const resolve of pending.values()) resolve({ id: 0, ok: false, error: e.message || 'speech worker crashed' });
    pending.clear();
    worker?.terminate();
    worker = null;
    loaded = null;
  };
  return worker;
}

function call(msg: Record<string, unknown>, transfer: Transferable[] = []): Promise<Reply> {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    getWorker().postMessage({ ...msg, id }, transfer);
  });
}

export function loadSTT(model = 'onnx-community/whisper-base.en', progress?: Progress): Promise<void> {
  if (progress) onProgress = progress;
  if (loaded && loadedModel === model) return loaded;
  loadedModel = model;
  loaded = call({ type: 'load', model }).then((r) => {
    if (!r.ok) { loaded = null; throw new Error(r.error); }
  });
  return loaded;
}

/** @param pcm mono 16 kHz samples */
export async function transcribe(pcm: Float32Array, model = loadedModel || 'onnx-community/whisper-base.en'): Promise<string> {
  if (pcm.length < 16000 * 0.25) return '';
  const r = await call({ type: 'transcribe', model, pcm }, [pcm.buffer]);
  if (!r.ok) throw new Error(r.error);
  return cleanTranscript(r.text ?? '');
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
