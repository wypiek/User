#!/usr/bin/env python3
"""Synthesizes User's extra voice sounds: short, lo-fi sound effects in the spirit of
2006-era Roblox games (boings, swooshes, slingshot twangs, button clicks, bloops...).

Everything here is generated from scratch (oscillators, noise and simple filters); no
sounds are copied from anywhere. Output: public/assets/sounds/<name>.mp3 (needs ffmpeg).

    python3 scripts/make-sounds.py
"""
import os
import subprocess
import tempfile
import wave

import numpy as np

SR = 22050  # old-game sample rate
OUT = os.path.join(os.path.dirname(__file__), '..', 'public', 'assets', 'sounds')
rng = np.random.default_rng(2006)


def t_(dur):
    return np.arange(int(SR * dur)) / SR


def env(n, attack=0.005, release=0.03):
    """Linear fade in/out (in seconds) so nothing clicks."""
    e = np.ones(n)
    a, r = int(SR * attack), int(SR * release)
    if a: e[:a] = np.linspace(0, 1, a)
    if r: e[-r:] = np.minimum(e[-r:], np.linspace(1, 0, r))
    return e


def phase(freq):
    """Oscillator phase for a (possibly time-varying) frequency array."""
    return 2 * np.pi * np.cumsum(freq) / SR


def square(freq, duty=0.5):
    return np.where((phase(freq) / (2 * np.pi)) % 1 < duty, 1.0, -1.0)


def tri(freq):
    p = (phase(freq) / (2 * np.pi)) % 1
    return 4 * np.abs(p - 0.5) - 1


def saw(freq):
    return 2 * ((phase(freq) / (2 * np.pi)) % 1) - 1


def onepole_lp(x, cutoff):
    """One-pole low-pass; cutoff can be a number or an array (sweeps)."""
    c = np.broadcast_to(np.asarray(cutoff, dtype=float), x.shape)
    a = 1 - np.exp(-2 * np.pi * c / SR)
    y = np.empty_like(x)
    acc = 0.0
    for i in range(len(x)):
        acc += a[i] * (x[i] - acc)
        y[i] = acc
    return y


def resonator(x, f, bw):
    """Two-pole resonant band-pass (a formant / bell mode)."""
    r = np.exp(-np.pi * bw / SR)
    th = 2 * np.pi * f / SR
    a1, a2 = -2 * r * np.cos(th), r * r
    y = np.zeros_like(x)
    y1 = y2 = 0.0
    for i in range(len(x)):
        y0 = x[i] - a1 * y1 - a2 * y2
        y[i] = y0
        y2, y1 = y1, y0
    return y * (1 - r)


def karplus(freq, dur, bend=0.0):
    """Plucked string (slingshot / rubber band twang)."""
    n = int(SR * dur)
    period = int(SR / freq)
    buf = rng.uniform(-1, 1, period)
    out = np.empty(n)
    for i in range(n):
        out[i] = buf[i % period]
        buf[i % period] = 0.5 * (buf[i % period] + buf[(i + 1) % period]) * 0.996
    if bend:  # drop pitch a little by resampling
        idx = np.cumsum(1 + bend * (np.arange(n) / n))
        idx = idx[idx < n - 1]
        out = np.interp(idx, np.arange(n), out)
    return out


def lofi(x, bits=10):
    """Crunch it like an old game: soft clip, then quantize."""
    x = np.tanh(x * 1.3)
    q = 2 ** (bits - 1)
    return np.round(x * q) / q


def finish(x, attack=0.003, release=0.04):
    x = x * env(len(x), attack, release)
    peak = np.max(np.abs(x)) or 1
    return lofi(x / peak * 0.85)


# ---------------------------------------------------------------- the sounds
def boing():
    t = t_(0.55)
    f = 210 * (1 + 0.45 * np.exp(-5 * t) * np.sin(2 * np.pi * 13 * t)) * (1 + 0.6 * np.exp(-14 * t))
    return finish(np.sin(phase(f)) * np.exp(-4.5 * t) + 0.2 * tri(f * 2) * np.exp(-7 * t))


def swoosh():
    t = t_(0.32)
    sweep = 300 + 3200 * np.sin(np.pi * t / t[-1]) ** 2
    noise = rng.uniform(-1, 1, len(t))
    x = onepole_lp(noise, sweep) - onepole_lp(noise, sweep * 0.35)
    return finish(x * np.sin(np.pi * t / t[-1]) ** 1.5, release=0.06)


def twang():
    return finish(karplus(98, 0.6, bend=-0.08) * np.exp(-3 * t_(0.6))[: len(karplus(98, 0.6, bend=-0.08))])


def click():
    t = t_(0.13)
    x = np.zeros(len(t))
    for start, f, amp in ((0.0, 2400, 1.0), (0.07, 1700, 0.6)):  # press ... release
        i = int(start * SR)
        n = int(0.025 * SR)
        tt = np.arange(n) / SR
        x[i:i + n] += amp * (square(np.full(n, f)) * 0.5 + rng.uniform(-1, 1, n) * 0.5) * np.exp(-180 * tt)
    return finish(x, attack=0.0005, release=0.01)


def bloop():
    t = t_(0.2)
    f = 900 * np.exp(-9 * t) + 180
    return finish(np.sin(phase(f)) * np.exp(-11 * t), attack=0.001)


def ding():
    t = t_(0.9)
    x = sum(a * np.sin(2 * np.pi * f * t) * np.exp(-d * t) for f, a, d in ((988, 1, 4), (2723, 0.45, 7), (5130, 0.2, 11), (494, 0.3, 3)))
    return finish(x, attack=0.001, release=0.1)


def zap():
    t = t_(0.26)
    f = 1900 * np.exp(-11 * t) + 120
    return finish(square(f, 0.3) * (1 - t / t[-1]) ** 1.2)


def pop():
    t = t_(0.09)
    burst = onepole_lp(rng.uniform(-1, 1, len(t)), 2500) * np.exp(-60 * t)
    return finish(burst + 0.6 * np.sin(phase(420 * np.exp(-25 * t) + 120)) * np.exp(-35 * t), attack=0.0005)


def thud():
    t = t_(0.28)
    body = np.sin(phase(130 * np.exp(-9 * t) + 48)) * np.exp(-10 * t)
    hit = onepole_lp(rng.uniform(-1, 1, len(t)), 900) * np.exp(-70 * t)
    return finish(body + 0.5 * hit, attack=0.0005)


def squeak():
    t = t_(0.17)
    f = 820 * (1 + t / t[-1]) * (1 + 0.04 * np.sin(2 * np.pi * 38 * t))
    return finish(np.sin(phase(f)) * np.sin(np.pi * t / t[-1]))


def bonk():
    t = t_(0.16)
    x = tri(np.full(len(t), 330)) * np.exp(-28 * t) + 0.5 * np.sin(2 * np.pi * 495 * t) * np.exp(-40 * t)
    return finish(x, attack=0.0005)


def rocket():
    t = t_(0.6)
    noise = rng.uniform(-1, 1, len(t))
    roar = onepole_lp(noise, 300 + 2500 * (t / t[-1]))
    rumble = square(55 + 30 * t / t[-1]) * 0.25
    return finish((roar + rumble) * np.minimum(1, t * 10) * np.exp(-1.6 * t), release=0.12)


def chime():
    t = t_(0.22)
    half = len(t) // 2
    f = np.where(np.arange(len(t)) < half, 1047, 1568)
    return finish(square(f, 0.25) * np.exp(-6 * (t % (t[-1] / 2))), release=0.05)


def vowel(f1, f2, pitch_from, pitch_to, dur=0.32):
    """A buzzy little syllable: a falling sawtooth through two formant resonators."""
    t = t_(dur)
    pitch = np.linspace(pitch_from, pitch_to, len(t)) * (1 + 0.02 * np.sin(2 * np.pi * 6 * t))
    src = saw(pitch)
    x = resonator(src, f1, 90) * 1.0 + resonator(src, f2, 130) * 0.7
    return finish(x * np.sin(np.pi * t / t[-1]) ** 0.6)


SOUNDS = {
    'boing': boing, 'swoosh': swoosh, 'twang': twang, 'click': click, 'bloop': bloop,
    'ding': ding, 'zap': zap, 'pop': pop, 'thud': thud, 'squeak': squeak, 'bonk': bonk,
    'rocket': rocket, 'chime': chime,
    'oh': lambda: vowel(480, 820, 190, 140),
    'eh': lambda: vowel(560, 1750, 210, 170, 0.26),
    'uh': lambda: vowel(640, 1150, 170, 110, 0.36),
}


def write_mp3(name, x):
    pcm = (np.clip(x, -1, 1) * 32767).astype(np.int16)
    with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as tmp:
        path = tmp.name
    with wave.open(path, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())
    out = os.path.join(OUT, f'{name}.mp3')
    subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-i', path, '-c:a', 'libmp3lame', '-b:a', '64k', out], check=True)
    os.remove(path)
    return out


if __name__ == '__main__':
    os.makedirs(OUT, exist_ok=True)
    for name, make in SOUNDS.items():
        x = make()
        print(f'{name:7s} {len(x) / SR:.2f}s -> {write_mp3(name, x)}')
