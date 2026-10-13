# Kovra intro video

`intro.html` is the whole video: one page whose `render(t)` draws the frame at time `t` (26 s). Nothing in it
plays by itself, so every frame comes out the same each time it is rendered.

- Preview single moments: `node frames.mjs prev 30 1.0,5.6,15.5` (PNGs in `prev/`).
- Render the MP4 (1920×1080, 60 fps, H.264): `node video.mjs kovra-intro.mp4 60 17`.

Needs Node, Playwright's Chromium and ffmpeg. Fonts: Space Grotesk and Inter (SIL Open Font License).
Figures in the video are examples and say so on screen; keep those labels.
