# Brand images

- `brandlib.py` draws the three X headers (`python3 brandlib.py` writes `a-skyline.html`, `b-horizon.html`, `c-monolith.html`)
  and holds the shared pieces (the Bin Ring mark, the pills).
- `x-posts.py` draws the "How it works" and "Everything Kovra does" post images.
- `x-how-it-works-steps.py` draws the four-part "How it works" thread (1/4 to 4/4); it needs the wallet logos and token icons from `apps/web/public` in `assets/`.

Render any of the HTML files with Playwright (1500×500 headers, 1600×900 posts, at 2×). They read the fonts from
`../fonts/` (Space Grotesk and Inter); copy `design/video/*.woff2` there. Keep claims in step with the code: the
token check is top-holder concentration plus market-cap and TVL floors (BundleScan/DevRadar are not wired in yet).
