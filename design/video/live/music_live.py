"""Soundtrack for the live-site video, fitted to its cuts: an original cue synthesised from scratch (synth.py),
so there is nothing to license and X won't mute it.

    python3 music_live.py cues.json music.wav

cues.json (written by compose.mjs): {"total": seconds, "cuts": [scene starts...], "outro": seconds}.
The intro card gets a drone and the mark's blips, the beat starts with the first shot of the site, a whoosh
marks every cut, and a lift lands on the end card.
"""

import json
import os
import sys
import wave

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
import synth  # noqa: E402

cues = json.load(open(sys.argv[1]))
TOTAL, CUTS, OUTRO = cues['total'], cues['cuts'], cues['outro']
synth.init(TOTAL)
from synth import SR, bell, blip, bus, hat, hz, impact, kick, m, pad_chord, place, pluck, reverb, riser, sub, whoosh  # noqa: E402

N = synth.N
BEAT = 60 / 120
BAR = 4 * BEAT
G0 = CUTS[0]  # the beat starts with the first shot of the site

pads, bass, drums, keys, fx, blips = bus(), bus(), bus(), bus(), bus(), bus()
kicks = []

# Intro card: a low drone opening up, one blip per bin of the mark, a lift into the first shot.
place(pads, 0.0, pad_chord(['D2', 'A2', 'D3'], G0 + 0.4, bright=700), gain=0.9)
for i in range(28):
    a = i / 28 * 2 * np.pi - np.pi / 2
    place(blips, 0.15 + i * 0.03, blip(2300 * 2 ** (i / 28 * 0.9)), pan=0.85 * np.cos(a), gain=0.5 if 3 <= i <= 12 else 0.3)
for f, d in [(hz(m('A5')), 0.0), (hz(m('D6')), 0.05), (hz(m('E6')), 0.1)]:
    place(keys, 1.05 + d, bell(f, 2.0), gain=0.45)
place(fx, max(0.0, G0 - 1.4), riser(1.4, 250, 6000), gain=0.3)
place(fx, G0, impact(), gain=0.5)

# One chord per bar from the first shot until the end card.
CHORDS = [
    ['D3', 'F3', 'A3', 'C4', 'E4'],   # Dm9
    ['Bb2', 'D3', 'F3', 'A3', 'C4'],  # Bbmaj9
    ['F3', 'A3', 'C4', 'E4', 'G4'],   # Fmaj9
    ['C3', 'G3', 'C4', 'D4', 'E4'],   # Cadd9
]
ROOTS = ['D2', 'Bb1', 'F2', 'C2']
bar = 0
while G0 + bar * BAR < OUTRO - 0.05:
    t0 = G0 + bar * BAR
    place(pads, t0, pad_chord(CHORDS[bar % 4], min(BAR, OUTRO - t0)), gain=1.0)
    bar += 1

# Drums, bass and an arpeggio: in with the first shot, fuller from the second, out for the lift.
arp_from = CUTS[1] if len(CUTS) > 1 else G0
k = 0
while G0 + k * BEAT < OUTRO - 2 * BEAT:
    t = G0 + k * BEAT
    lift = t >= OUTRO - 2.0
    if not lift or k % 2 == 1:
        place(drums, t, kick(), gain=0.85)
        kicks.append(t)
    if not lift:
        place(drums, t + BEAT / 2, hat(0.03, False), pan=0.25, gain=0.55)
    b = int((t - G0) // BAR)
    root = hz(m(ROOTS[b % 4]))
    for s in (0, 0.5):
        place(bass, t + BEAT * s, sub(root, BEAT * 0.45), gain=0.6 if s else 0.75)
    if arp_from <= t and not lift:
        for s in (0.25, 0.75):
            place(drums, t + BEAT * s, hat(0.014), pan=-0.3, gain=0.28)
        tones = [hz(m(x)) * 2 for x in CHORDS[b % 4][1:]]
        for s in range(4):
            place(keys, t + s * BEAT / 4, pluck(tones[(k * 4 + s) % len(tones)]), pan=0.45 if s % 2 else -0.45, gain=0.2 + 0.05 * (s == 0))
    k += 1

# Air on every cut, a lift into the end card, the hit when it lands, and the last chord ringing out.
for c in CUTS[1:]:
    place(fx, c - 0.55, whoosh(1.1), gain=0.42)
place(fx, OUTRO - 2.0, riser(2.0, 250, 9000), gain=0.4)
place(fx, OUTRO, impact(), gain=0.7)
place(pads, OUTRO, pad_chord(['F2', 'C3', 'A3', 'E4', 'G4', 'C5'], TOTAL - OUTRO - 0.3, bright=2200), gain=1.15)
place(bass, OUTRO, sub(hz(m('F1')), min(3.2, TOTAL - OUTRO)), gain=0.8)
for f, d in [(hz(m('C6')), 0.0), (hz(m('F6')), 0.06), (hz(m('A6')), 0.12)]:
    place(keys, OUTRO + d, bell(f, 2.8), gain=0.42)

# ---------------------------------------------------------------- mix (as in music.py)
duck = np.ones(N)
tt = np.arange(N) / SR
for t in kicks:
    i0 = int(t * SR)
    duck[i0:] = np.minimum(duck[i0:], 1 - 0.45 * np.exp(-(tt[i0:] - t) / 0.11))
pads *= duck[:, None]
bass *= duck[:, None] ** 1.5
dry = pads * 0.5 + bass * 0.55 + drums * 0.6 + keys * 0.5 + fx * 0.5 + blips * 0.5
wet = reverb(pads * 0.3 + keys * 0.55 + blips * 0.6 + fx * 0.35 + drums * 0.06)
mix = dry + wet * 0.55
mix -= np.mean(mix, axis=0)
fade = np.ones(N)
fade[: int(0.04 * SR)] = np.linspace(0, 1, int(0.04 * SR))
fo0 = int((TOTAL - 1.4) * SR)
fade[fo0:] = np.linspace(1, 0, N - fo0) ** 1.5
mix *= fade[:, None]
mix /= np.max(np.abs(mix)) + 1e-9
mix = np.tanh(mix * 1.3) / np.tanh(1.3)
mix *= 10 ** (-1 / 20) / (np.max(np.abs(mix)) + 1e-9)

with wave.open(sys.argv[2], 'wb') as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes((np.clip(mix, -1, 1) * 32767).astype('<i2').tobytes())
print('wrote', sys.argv[2], f'{TOTAL:.1f}s')
