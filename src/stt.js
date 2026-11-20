// Local, offline-after-first-download speech recognition (Whisper via transformers.js).
// Works the same no matter which AI backend powers User, and needs no API key.
import { pipeline, env } from '@huggingface/transformers';

env.allowLocalModels = false;
env.useBrowserCache = true;
env.backends.onnx.wasm.wasmPaths = new URL('../node_modules/onnxruntime-web/dist/', import.meta.url).href;
env.backends.onnx.wasm.proxy = true; // run inference off the render thread

let transcriberPromise = null;
let currentModel = null;

export function loadSTT(model = 'onnx-community/whisper-base.en', onProgress) {
  if (transcriberPromise && currentModel === model) return transcriberPromise;
  currentModel = model;
  const make = () => pipeline('automatic-speech-recognition', model, {
    dtype: 'q8',
    device: 'wasm',
    progress_callback: onProgress,
  });
  transcriberPromise = make()
    .catch((err) => {
      // If the off-thread proxy worker can't start, fall back to running in-page.
      if (!env.backends.onnx.wasm.proxy) throw err;
      console.warn('ASR proxy worker failed, retrying in-page', err);
      env.backends.onnx.wasm.proxy = false;
      return make();
    })
    .catch((err) => {
      transcriberPromise = null;
      throw err;
    });
  return transcriberPromise;
}

/** @param {Float32Array} pcm mono 16 kHz samples */
export async function transcribe(pcm, model) {
  const asr = await loadSTT(model);
  if (!pcm.length || pcm.length < 16000 * 0.25) return '';
  const out = await asr(pcm, { chunk_length_s: 30, stride_length_s: 5 });
  return cleanTranscript(out.text || '');
}

function cleanTranscript(t) {
  t = t.replace(/\[(BLANK_AUDIO|MUSIC|NOISE|SILENCE)[^\]]*\]/gi, '')
       .replace(/\((?:[^)]*(?:music|noise|silence|static|breathing)[^)]*)\)/gi, '')
       .trim();
  // Whisper hallucinates these on near-silent input.
  if (/^(you|thank you\.?|thanks for watching!?|\.+)$/i.test(t)) return '';
  return t;
}

/** Push-to-talk microphone recorder. start() on key down, stop() on key up -> Float32Array @16 kHz. */
export class MicRecorder {
  constructor() { this.stream = null; this.rec = null; this.chunks = []; }
  async ensureStream() {
    if (this.stream && this.stream.active) return this.stream;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    return this.stream;
  }
  async start() {
    const stream = await this.ensureStream();
    this.chunks = [];
    this.rec = new MediaRecorder(stream);
    this.rec.ondataavailable = (e) => { if (e.data.size) this.chunks.push(e.data); };
    this.rec.start(100);
    this.startedAt = performance.now();
  }
  get recording() { return !!this.rec && this.rec.state === 'recording'; }
  cancel() { if (this.recording) { this.rec.onstop = null; this.rec.stop(); } this.rec = null; this.chunks = []; }
  async stop() {
    if (!this.recording) return new Float32Array(0);
    const rec = this.rec;
    await new Promise((res) => { rec.onstop = res; rec.stop(); });
    this.rec = null;
    const blob = new Blob(this.chunks, { type: rec.mimeType });
    return decodeTo16k(await blob.arrayBuffer());
  }
}

export async function decodeTo16k(arrayBuffer) {
  const ctx = new AudioContext({ sampleRate: 16000 });
  try {
    const buf = await ctx.decodeAudioData(arrayBuffer);
    if (buf.numberOfChannels === 1) return buf.getChannelData(0).slice();
    const a = buf.getChannelData(0), b = buf.getChannelData(1), out = new Float32Array(a.length);
    for (let i = 0; i < a.length; i++) out[i] = (a[i] + b[i]) / 2;
    return out;
  } finally { ctx.close(); }
}
