# Kovra intro video

`intro.html` is the whole video: one page whose `render(t)` draws the frame at time `t` (26 s). Nothing in it
plays by itself, so every frame comes out the same each time it is rendered.

- Preview single moments: `node frames.mjs prev 30 1.0,5.6,15.5` (PNGs in `prev/`).
- Render the MP4 (1920×1080, 60 fps, H.264): `node video.mjs kovra-intro.mp4 60 17`.
- Music: `python3 music.py music.wav` (needs numpy; the sounds themselves are in `synth.py`, shared with `live/`). An original cue synthesised from scratch, so there is nothing
  to license and X won't mute it. It follows the cuts in `intro.html`; move both together.
- Put them together at social-media loudness:
  `ffmpeg -i silent.mp4 -i music.wav -map 0:v -map 1:a -c:v copy -af loudnorm=I=-14:TP=-1.5:LRA=11 -c:a aac -b:a 256k -shortest -movflags +faststart kovra-intro.mp4`

Needs Node, Playwright's Chromium and ffmpeg. Fonts: Space Grotesk and Inter (SIL Open Font License).
Figures in the video are examples and say so on screen; keep those labels.

`live/` makes a different video: a recording of the real site with captions and its own soundtrack (see its README).
