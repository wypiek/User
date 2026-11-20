// User's "voice": he speaks by playing the old sound effects one after another,
// in random order, at 1.2x speed. Each sound reveals the next few words.

const VOICE_FILES = ['press', 'ball', 'ouch', 'splat', 'pinball', 'glass'];
const RATE = 1.2;

export class Voice {
  constructor(base) {
    this.base = base;
    this.ctx = new AudioContext();
    this.master = this.ctx.createGain();
    this.master.connect(this.ctx.destination);
    this.voiceGain = this.ctx.createGain();
    this.voiceGain.connect(this.master);
    this.ambGain = this.ctx.createGain();
    this.ambGain.connect(this.master);
    this.buffers = {};
    this.speaking = null;
  }

  async load() {
    await Promise.all(VOICE_FILES.map(async (name) => {
      const res = await fetch(`${this.base}${name}.mp3`);
      this.buffers[name] = await this.ctx.decodeAudioData(await res.arrayBuffer());
    }));
  }

  setVolumes(voice, ambience) {
    this.voiceGain.gain.value = voice;
    this.ambGain.gain.value = ambience;
  }

  resume() { if (this.ctx.state !== 'running') this.ctx.resume(); }

  /** Play one buffer at 1.2x. Resolves when it ends (or is stopped). */
  play(name, { rate = RATE, gain = 1 } = {}) {
    this.resume();
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffers[name];
    src.playbackRate.value = rate;
    const g = this.ctx.createGain();
    g.gain.value = gain;
    src.connect(g).connect(this.voiceGain);
    src.start();
    return { src, done: new Promise((r) => { src.onended = r; }) };
  }

  /**
   * Speak `text`: random sounds, back to back. onChunk(textSoFar) is called each time a
   * sound starts, so the caption appears in step with the "voice".
   */
  async speak(text, { onChunk, onSyllable } = {}) {
    this.stop();
    const words = text.split(/\s+/).filter(Boolean);
    if (!words.length) return;
    // long replies get more words per sound so he doesn't talk forever
    const per = Math.max(2, Math.min(8, Math.ceil(words.length / 26)));
    const token = (this.speaking = { stopped: false, current: null });
    let last = '';
    for (let i = 0; i < words.length; i += per) {
      if (token.stopped) return;
      let name;
      do { name = VOICE_FILES[(Math.random() * VOICE_FILES.length) | 0]; } while (name === last && VOICE_FILES.length > 1);
      last = name;
      const h = this.play(name);
      token.current = h.src;
      onChunk?.(words.slice(0, i + per).join(' '), i + per >= words.length);
      onSyllable?.();
      await h.done;
    }
    if (this.speaking === token) this.speaking = null;
  }

  stop() {
    if (this.speaking) {
      this.speaking.stopped = true;
      try { this.speaking.current?.stop(); } catch { /* already stopped */ }
      this.speaking = null;
    }
  }

  /** Low night wind + hum, generated (no extra files). */
  startAmbience() {
    if (this.ambience) return;
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
    noise.buffer = buf; noise.loop = true;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 420;
    const windGain = ctx.createGain(); windGain.gain.value = 0.55;
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.07;
    const lfoAmt = ctx.createGain(); lfoAmt.gain.value = 0.35;
    lfo.connect(lfoAmt).connect(windGain.gain);
    noise.connect(lp).connect(windGain).connect(this.ambGain);
    const hum = ctx.createOscillator(); hum.type = 'sine'; hum.frequency.value = 55;
    const humGain = ctx.createGain(); humGain.gain.value = 0.035;
    hum.connect(humGain).connect(this.ambGain);
    noise.start(); lfo.start(); hum.start();
    this.ambience = { noise, lfo, hum };
  }
}
