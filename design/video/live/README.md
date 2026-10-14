# Kovra live video

A short video of the real site, recorded straight from it: intro card, the landing page (hero and the live demo
vault), Pools, the Public tab and one public portfolio, each shot with a caption and a "Recorded live on <host> ·
<date>" stamp, then the end card, with an original soundtrack fitted to the cuts.

    cd design/video/live
    node record.mjs https://kovra.live tour     # ~45 s: frames per shot + tour.json
    node compose.mjs tour kovra-live.mp4        # ~2 min: 1920×1080, 30 fps, H.264 + AAC at -14 LUFS

- `record.mjs` films still moments in real time (the live chart and the agent keep moving) and scrolls one
  screenshot per 1/30 s, so scrolls are smooth on any machine. The Public shots are skipped while nobody has a
  public portfolio.
- `cards.html` holds the intro and end cards, the captions and the stamp; `compose.mjs` screenshots them.
- `music_live.py` writes the soundtrack from `tour/_build/cues.json` with the sounds in `../synth.py`.

Needs network access to the site, Node, Playwright's Chromium, ffmpeg and Python with numpy. Numbers on screen are
whatever the site shows at that moment; the stamp says where and when it was recorded, so never use a recording of
a local or test build as "live".
