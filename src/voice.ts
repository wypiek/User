// User's "voice": he speaks by playing the old sound effects one after another,
// in random order, at 1.2x speed. Each sound reveals the next few words.

export const VOICE_FILES = ['press', 'ball', 'ouch', 'splat', 'pinball', 'glass'] as const;
export type SoundName = (typeof VOICE_FILES)[number];
const RATE = 1.2;

interface SpeakToken { stopped: boolean; current: AudioBufferSourceNode | null }

export class Voice {
  readonly ctx = new AudioContext();
  private master = this.ctx.createGain();
  private voiceGain = this.ctx.createGain();
  private ambGain = this.ctx.createGain();
  private buffers = new Map<SoundName, AudioBuffer>();
  private speaking: SpeakToken | null = null;
  private ambienceStarted = false;

  constructor(private base: string) {
    this.master.connect(this.ctx.destination);
    this.voiceGain.connect(this.master);
    this.ambGain.connect(this.master);
  }

  async load(): Promise<void> {
    await Promise.all(
      VOICE_FILES.map(async (name) => {
        const res = await fetch(`${this.base}${name}.mp3`);
        this.buffers.set(name, await this.ctx.decodeAudioData(await res.arrayBuffer()));
      }),
    );
  }

  setVolumes(voice: number, ambience: number): void {
    this.voiceGain.gain.value = voice;
    this.ambGain.gain.value = ambience;
  }

  resume(): void {
    if (this.ctx.state !== 'running') void this.ctx.resume();
  }

  /** Play one sound (default 1.2x). `done` resolves when it ends or is stopped. */
  play(name: SoundName, { rate = RATE, gain = 1 } = {}): { src: AudioBufferSourceNode; done: Promise<void> } {
    this.resume();
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffers.get(name) ?? null;
    src.playbackRate.value = rate;
    const g = this.ctx.createGain();
    g.gain.value = gain;
    src.connect(g).connect(this.voiceGain);
    const done = new Promise<void>((r) => { src.onended = () => r(); });
    src.start();
    return { src, done };
  }

  /**
   * Speak `text`: random sounds, back to back. onChunk(textSoFar) is called each time a
   * sound starts, so the caption appears in step with the "voice".
   */
  async speak(text: string, opts: { onChunk?: (soFar: string, last: boolean) => void; onSyllable?: () => void } = {}): Promise<void> {
    this.stop();
    const words = text.split(/\s+/).filter(Boolean);
    if (!words.length) return;
    // long replies get more words per sound so he doesn't talk forever
    const per = Math.max(2, Math.min(8, Math.ceil(words.length / 26)));
    const token: SpeakToken = { stopped: false, current: null };
    this.speaking = token;
    let last: SoundName | null = null;
    for (let i = 0; i < words.length; i += per) {
      if (token.stopped) return;
      let name: SoundName;
      do name = VOICE_FILES[Math.floor(Math.random() * VOICE_FILES.length)];
      while (name === last);
      last = name;
      const h = this.play(name);
      token.current = h.src;
      opts.onChunk?.(words.slice(0, i + per).join(' '), i + per >= words.length);
      opts.onSyllable?.();
      await h.done;
    }
    if (this.speaking === token) this.speaking = null;
  }

  stop(): void {
    if (!this.speaking) return;
    this.speaking.stopped = true;
    try { this.speaking.current?.stop(); } catch { /* already stopped */ }
    this.speaking = null;
  }

  /** Low night wind + hum, generated (no extra files). */
  startAmbience(): void {
    if (this.ambienceStarted) return;
    this.ambienceStarted = true;
    const ctx = this.ctx;
    const len = ctx.sampleRate * 4;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) { // brown noise
      last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
      d[i] = last * 3.5;
    }
    const noise = ctx.createBufferSource();
    noise.buffer = buf;
    noise.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 420;
    const windGain = ctx.createGain();
    windGain.gain.value = 0.55;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.07;
    const lfoAmt = ctx.createGain();
    lfoAmt.gain.value = 0.35;
    lfo.connect(lfoAmt).connect(windGain.gain);
    noise.connect(lp).connect(windGain).connect(this.ambGain);
    const hum = ctx.createOscillator();
    hum.frequency.value = 55;
    const humGain = ctx.createGain();
    humGain.gain.value = 0.035;
    hum.connect(humGain).connect(this.ambGain);
    noise.start();
    lfo.start();
    hum.start();
  }
}
