"""Kovra's sound kit: every sound synthesised from scratch (no samples), shared by the video soundtracks.

    import synth
    synth.init(seconds)   # the length of the buses, before anything else
"""

import numpy as np

SR = 48000
N = 0
rng = np.random.default_rng(7)


def init(seconds):
    """Sets the length of every bus (and of the reverb tail) to `seconds`."""
    global N
    N = int(SR * seconds)


def hz(midi):
    return 440.0 * 2 ** ((midi - 69) / 12)


NOTE = {'C': 0, 'Db': 1, 'D': 2, 'Eb': 3, 'E': 4, 'F': 5, 'Gb': 6, 'G': 7, 'Ab': 8, 'A': 9, 'Bb': 10, 'B': 11}


def m(name):
    """'D3' -> midi number."""
    return 12 * (int(name[-1]) + 1) + NOTE[name[:-1]]


def bus():
    return np.zeros((N, 2))


def place(buf, t0, sig, pan=0.0, gain=1.0):
    """Mix a mono or stereo signal into buf at t0 seconds; pan -1 (left) .. 1 (right)."""
    i0 = int(round(t0 * SR))
    if sig.ndim == 1:
        lg, rg = np.cos((pan + 1) * np.pi / 4), np.sin((pan + 1) * np.pi / 4)
        sig = np.stack([sig * lg, sig * rg], axis=1) * np.sqrt(2)
    i1 = min(N, i0 + len(sig))
    if i1 > max(0, i0):
        s0 = max(0, -i0)
        buf[max(0, i0):i1] += sig[s0:s0 + i1 - max(0, i0)] * gain


def adsr(n, a, d, s, r, hold):
    """Envelope of n samples: attack a, decay d to sustain s, hold until `hold` s, release r (seconds)."""
    t = np.arange(n) / SR
    env = np.where(t < a, t / max(a, 1e-6), 1.0)
    env = np.where((t >= a) & (t < a + d), 1 - (1 - s) * (t - a) / max(d, 1e-6), env)
    env = np.where(t >= a + d, s, env)
    rel = t >= hold
    env = np.where(rel, s * np.exp(-(t - hold) / max(r, 1e-6) * 3), env)
    return env


def onepole_lp(x, cutoff):
    """One-pole low-pass; cutoff may be a per-sample array (Hz)."""
    c = np.broadcast_to(np.asarray(cutoff, dtype=float), x.shape)
    a = 1 - np.exp(-2 * np.pi * c / SR)
    y = np.empty_like(x)
    acc = 0.0
    for i in range(len(x)):
        acc += a[i] * (x[i] - acc)
        y[i] = acc
    return y


# ---------------------------------------------------------------- sounds
def pad_voice(freq, dur, detune_cents, bright=1700.0):
    """Warm band-limited saw (additive), slow attack, long release."""
    n = int((dur + 2.2) * SR)
    t = np.arange(n) / SR
    f = freq * 2 ** (detune_cents / 1200)
    out = np.zeros(n)
    k = 1
    while f * k < 5200:
        amp = (1 / k) * np.exp(-(f * k) / bright)
        out += amp * np.sin(2 * np.pi * f * k * t + rng.uniform(0, 2 * np.pi))
        k += 1
    # slow shimmer so long chords breathe
    out *= 1 + 0.06 * np.sin(2 * np.pi * 0.35 * t + rng.uniform(0, 6))
    return out * adsr(n, 0.9, 0.6, 0.85, 1.6, dur)


def pad_chord(notes, dur, bright=1700.0):
    left = sum(pad_voice(hz(m(x)), dur, -6, bright) for x in notes)
    right = sum(pad_voice(hz(m(x)), dur, +6, bright) for x in notes)
    sig = np.stack([left, right], axis=1)
    return sig / (len(notes) * 1.6)


def sub(freq, dur):
    n = int((dur + 0.08) * SR)
    t = np.arange(n) / SR
    s = np.sin(2 * np.pi * freq * t) + 0.25 * np.sin(4 * np.pi * freq * t)
    s = np.tanh(1.6 * s) / np.tanh(1.6)
    env = np.minimum(1, t / 0.006) * np.exp(-t / (dur * 0.9)) * np.minimum(1, (n / SR - t) / 0.03)
    return s * env


def kick():
    n = int(0.5 * SR)
    t = np.arange(n) / SR
    f = 46 + 110 * np.exp(-t / 0.028)
    ph = 2 * np.pi * np.cumsum(f) / SR
    body = np.sin(ph) * np.exp(-t / 0.26)
    click = rng.standard_normal(n) * np.exp(-t / 0.0025) * 0.25
    return np.tanh(1.8 * (body + click)) * 0.9


def hat(dec=0.022, bright=True):
    n = int(0.12 * SR)
    t = np.arange(n) / SR
    x = rng.standard_normal(n)
    x = np.diff(x, prepend=0)
    if bright:
        x = np.diff(x, prepend=0) * 0.5
    return x * np.exp(-t / dec) * 0.22


def pluck(freq, dec=0.22):
    n = int(0.9 * SR)
    t = np.arange(n) / SR
    s = np.sin(2 * np.pi * freq * t) + 0.35 * np.sin(4 * np.pi * freq * t) * np.exp(-t / 0.05) + 0.12 * np.sin(6 * np.pi * freq * t) * np.exp(-t / 0.03)
    return s * np.minimum(1, t / 0.003) * np.exp(-t / dec) * 0.5


def blip(freq):
    n = int(0.09 * SR)
    t = np.arange(n) / SR
    return np.sin(2 * np.pi * freq * t) * np.minimum(1, t / 0.0015) * np.exp(-t / 0.018) * 0.45


def bell(freq, dec=2.4):
    n = int((dec * 2.5) * SR)
    t = np.arange(n) / SR
    s = sum(a * np.sin(2 * np.pi * freq * r * t) * np.exp(-t / (dec / r ** 0.6)) for r, a in [(1, 1), (2.0, .4), (2.76, .3), (5.4, .12)])
    return s * np.minimum(1, t / 0.004) * 0.35


def riser(dur, f0=300, f1=7000):
    """Noise swelling up, its tone sweeping from f0 to f1."""
    n = int(dur * SR)
    t = np.arange(n) / SR
    x = rng.standard_normal(n)
    cut = f0 * (f1 / f0) ** (t / dur)
    y = onepole_lp(x, cut)
    y = y - onepole_lp(y, cut * 0.25)
    env = (t / dur) ** 2.2
    return y * env * 0.9


def whoosh(dur=1.1):
    """Air moving past: noise swelling then falling, tone up then down."""
    n = int(dur * SR)
    t = np.arange(n) / SR
    x = rng.standard_normal(n)
    shape = np.sin(np.pi * t / dur) ** 2
    cut = 400 + 5200 * shape
    y = onepole_lp(x, cut)
    y = y - onepole_lp(y, 250)
    return y * shape * 0.75


def impact():
    n = int(2.6 * SR)
    t = np.arange(n) / SR
    f = 34 + 70 * np.exp(-t / 0.06)
    boom = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / 0.9)
    noise = onepole_lp(rng.standard_normal(n), 2200) * np.exp(-t / 0.12) * 0.6
    return np.tanh(1.4 * (boom + noise)) * 0.95


def reverb(x, seconds=2.8, decay=0.75, damp=4200):
    """Convolution with a synthetic stereo hall (decaying, darkening noise)."""
    n = int(seconds * SR)
    t = np.arange(n) / SR
    out = np.zeros((len(x) + n - 1, 2))
    size = 1 << int(np.ceil(np.log2(len(x) + n)))
    for ch in range(2):
        ir = rng.standard_normal(n) * np.exp(-t / decay * 3)
        spec = np.fft.rfft(ir)
        freqs = np.fft.rfftfreq(n, 1 / SR)
        ir = np.fft.irfft(spec / (1 + (freqs / damp) ** 2), n)
        ir[: int(0.012 * SR)] *= np.linspace(0, 1, int(0.012 * SR))  # a little pre-delay feel
        ir /= np.sqrt(np.sum(ir ** 2))
        out[:, ch] = np.fft.irfft(np.fft.rfft(x[:, ch], size) * np.fft.rfft(ir, size), size)[: len(x) + n - 1]
    return out[:N]

