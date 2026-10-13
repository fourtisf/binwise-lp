"""Kovra intro soundtrack: an original cue, synthesised from scratch (no samples, no third-party music).

Timed to intro.html: the mark assembles (0-2 s, one soft blip per bin), locks up with the name (2.6 s),
the beat comes in with "It finds the pools that pay" (7.45 s), an arpeggio joins the chart (11.95 s),
a short lift into the end card (21.45 s), then the last chord rings out.

    python3 music.py music.wav
"""

import sys
import wave

import numpy as np

SR = 48000
DUR = 26.0
N = int(SR * DUR)
rng = np.random.default_rng(7)

BPM = 120
BEAT = 60 / BPM
G0 = 3.95  # the beat grid starts with the headline


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


# ---------------------------------------------------------------- arrangement
pads, bass, drums, keys, fx, blips = bus(), bus(), bus(), bus(), bus(), bus()
kicks = []

# Intro: a low drone that opens up, one blip per bin as the mark assembles, a lift into the lockup.
drone = pad_chord(['D2', 'A2', 'D3'], 3.6, bright=700)
place(pads, 0.0, drone, gain=0.9)
for i in range(28):
    a = i / 28 * 2 * np.pi - np.pi / 2
    place(blips, 0.35 + i * 0.042, blip(2300 * 2 ** (i / 28 * 0.9)), pan=0.85 * np.cos(a), gain=0.55 if 3 <= i <= 12 else 0.32)
place(fx, 0.9, riser(1.7, 200, 5200), gain=0.32)
place(fx, 2.6, impact(), gain=0.55)
for f, d in [(hz(m('A5')), 0.0), (hz(m('D6')), 0.05), (hz(m('E6')), 0.1)]:
    place(keys, 2.6 + d, bell(f, 2.2), gain=0.5)

# Chords, one per bar from the headline on; the end card lands on F major.
BAR = 4 * BEAT
CHORDS = [
    ['D3', 'F3', 'A3', 'C4', 'E4'],   # Dm9
    ['Bb2', 'D3', 'F3', 'A3', 'C4'],  # Bbmaj9
    ['F3', 'A3', 'C4', 'E4', 'G4'],   # Fmaj9
    ['C3', 'G3', 'C4', 'D4', 'E4'],   # Cadd9
    ['D3', 'F3', 'A3', 'C4', 'E4'],   # Dm9
    ['Bb2', 'D3', 'F3', 'A3', 'C4'],  # Bbmaj9
    ['G2', 'Bb3', 'D4', 'F4', 'A4'],  # Gm9
    ['A2', 'D4', 'E4', 'G4'],         # A7sus4, the lift
]
ROOTS = ['D2', 'Bb1', 'F2', 'C2', 'D2', 'Bb1', 'G1', 'A1']
END = G0 + 35 * BEAT  # 21.45 s, the end card
for b, ch in enumerate(CHORDS):
    t0 = G0 + b * BAR
    dur = min(BAR, END - t0)
    if dur <= 0:
        break
    place(pads, t0, pad_chord(ch, dur), gain=1.0)
place(pads, END, pad_chord(['F2', 'C3', 'A3', 'E4', 'G4', 'C5'], 26 - END - 0.6, bright=2200), gain=1.15)

# Drums and bass: in with the pools (7.45 s), fuller with the chart (11.95 s), out for the lift.
beat_t = lambda k: G0 + k * BEAT
for k in range(7, 35):
    t = beat_t(k)
    if k < 29 or k % 2 == 1 and k < 33:
        place(drums, t, kick(), gain=0.85)
        kicks.append(t)
    if 3 <= k < 33:
        place(drums, t + BEAT / 2, hat(0.03, False), pan=0.25, gain=0.55)
    if 15 <= k < 31:
        for s in (0.25, 0.75):
            place(drums, t + BEAT * s, hat(0.014), pan=-0.3, gain=0.3)
for k in range(7, 33):
    t = beat_t(k)
    bar = int((t - G0) // BAR)
    root = hz(m(ROOTS[min(bar, len(ROOTS) - 1)]))
    for s in (0, 0.5):
        place(bass, t + BEAT * s, sub(root, BEAT * 0.45), gain=0.6 if s else 0.75)
# final low note under the end card
place(bass, END, sub(hz(m('F1')), 3.2), gain=0.8)

# Arpeggio over the chart: chord tones up high, 16ths, ping-pong.
for k in range(15, 33):
    t = beat_t(k)
    bar = int((t - G0) // BAR)
    tones = [hz(m(x)) * 2 for x in CHORDS[min(bar, len(CHORDS) - 1)][1:]]
    for s in range(4):
        f = tones[(k * 4 + s) % len(tones)]
        place(keys, t + s * BEAT / 4, pluck(f), pan=0.45 if s % 2 else -0.45, gain=0.22 + 0.06 * (s == 0))

# Air between scenes, a lift into the end card, and the hit when it lands.
for cut in (3.95, 7.45, 11.75, 18.2):
    place(fx, cut - 0.55, whoosh(1.1), pan=0.0, gain=0.45)
place(fx, END - 2.0, riser(2.0, 250, 9000), gain=0.42)
place(fx, END, impact(), gain=0.7)
for f, d in [(hz(m('C6')), 0.0), (hz(m('F6')), 0.06), (hz(m('A6')), 0.12)]:
    place(keys, END + d, bell(f, 2.8), gain=0.42)

# ---------------------------------------------------------------- mix
# The kick pushes the pads and bass down for a moment: the pulse you feel more than hear.
duck = np.ones(N)
tt = np.arange(N) / SR
for k in kicks:
    i0 = int(k * SR)
    seg = tt[i0:] - k
    duck[i0:] = np.minimum(duck[i0:], 1 - 0.45 * np.exp(-seg / 0.11))
pads *= duck[:, None]
bass *= duck[:, None] ** 1.5

dry = pads * 0.5 + bass * 0.55 + drums * 0.6 + keys * 0.5 + fx * 0.5 + blips * 0.5
wet = reverb(pads * 0.3 + keys * 0.55 + blips * 0.6 + fx * 0.35 + drums * 0.06)
mix = dry + wet * 0.55

# Clean the very low end, fade in and out, gentle soft clip, then level to -1 dBFS peak.
mix -= np.mean(mix, axis=0)
fade = np.ones(N)
fade[: int(0.04 * SR)] = np.linspace(0, 1, int(0.04 * SR))
fo0 = int(24.6 * SR)
fade[fo0:] = np.linspace(1, 0, N - fo0) ** 1.5
mix *= fade[:, None]
mix /= np.max(np.abs(mix)) + 1e-9
mix = np.tanh(mix * 1.3) / np.tanh(1.3)
mix *= 10 ** (-1 / 20) / (np.max(np.abs(mix)) + 1e-9)

out = sys.argv[1] if len(sys.argv) > 1 else 'music.wav'
with wave.open(out, 'wb') as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes((np.clip(mix, -1, 1) * 32767).astype('<i2').tobytes())


def rms_db(a, b):
    seg = mix[int(a * SR):int(b * SR)]
    return 20 * np.log10(np.sqrt(np.mean(seg ** 2)) + 1e-12)


print('wrote', out, ' rms dB by section:', ', '.join(f'{a}-{b}s {rms_db(a, b):.1f}' for a, b in [(0, 4), (4, 7.45), (7.45, 12), (12, 18.2), (18.2, 21.45), (21.45, 26)]))
