"""The X Article cover, "Judged by one number" (5:2, as X recommends): python3 x-article.py [out_dir] writes
x-article-cover.html (1500×600; render at 2× for 3000×1200). Fonts come from ../fonts/ next to out_dir."""
import math, os, sys, importlib.util
spec = importlib.util.spec_from_file_location('b', os.path.join(os.path.dirname(__file__), 'brandlib.py')); b = importlib.util.module_from_spec(spec); spec.loader.exec_module(b)
MINT, XSVG, noise, mark = b.MINT, b.XSVG, b.noise, b.mark
W, H = 1500, 600

HEAD = '''<!doctype html><html><head><meta charset="utf-8"><style>
@font-face{font-family:SG;src:url(../fonts/sg.woff2) format("woff2");font-weight:300 700}
@font-face{font-family:IN;src:url(../fonts/inter.woff2) format("woff2");font-weight:100 900}
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:1500px;height:600px;overflow:hidden;background:#030303;color:#F5F5F6;font-family:IN,sans-serif;-webkit-font-smoothing:antialiased}
.abs{position:absolute;inset:0}
.grain{position:absolute;inset:0;opacity:.055;mix-blend-mode:overlay;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='220' height='220'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")}
.copy{position:absolute;left:96px;top:88px;width:700px}
.brand{display:flex;align-items:center;gap:12px;font-family:SG;font-weight:600;font-size:30px;letter-spacing:-.045em}
.kick{display:inline-flex;align-items:center;gap:9px;height:34px;padding:0 16px 0 13px;border-radius:999px;border:1px solid rgba(255,255,255,.13);background:rgba(255,255,255,.04);font-size:15px;font-weight:500;color:#CFCFD4;margin-left:18px}
.kick i{width:7px;height:7px;border-radius:50%;background:#3DDC97;box-shadow:0 0 12px #3DDC97}
h1{font-family:SG;font-weight:600;font-size:84px;letter-spacing:-.058em;line-height:.96;margin-top:34px;background:linear-gradient(180deg,#fff 35%,#9EA2AB);-webkit-background-clip:text;background-clip:text;color:transparent;padding-bottom:6px}
h1 b{font-weight:600;background:linear-gradient(180deg,#B8F5D9 10%,#3DDC97 90%);-webkit-background-clip:text;background-clip:text;color:transparent}
.sub{margin-top:22px;font-size:21px;line-height:1.45;color:#AEAEB6;max-width:600px}
.row{position:absolute;left:96px;bottom:64px;display:flex;gap:10px}
.row span{display:inline-flex;align-items:center;gap:8px;height:38px;padding:0 16px;border-radius:999px;border:1px solid rgba(255,255,255,.12);background:rgba(10,10,11,.6);font-size:15px;font-weight:500;color:#F5F5F6}
.row svg{width:14px;height:14px}
.row em{font-style:normal;font-size:13px;color:#E7E9EE;background:rgba(201,205,214,.12);padding:3px 10px;border-radius:999px}
.fx{position:absolute;right:86px;bottom:64px;padding:16px 22px 17px;border-radius:22px;border:1px solid rgba(255,255,255,.12);background:linear-gradient(180deg,rgba(18,18,20,.82),rgba(8,8,9,.82));backdrop-filter:blur(10px);box-shadow:inset 0 1px 0 rgba(255,255,255,.08),0 30px 60px -30px rgba(0,0,0,.9)}
.fx small{display:block;font-size:12.5px;font-weight:500;letter-spacing:.08em;text-transform:uppercase;color:#5D5D65}
.fx div{margin-top:7px;font-family:SG;font-weight:500;font-size:22px;letter-spacing:-.02em;color:#E7E9EE;white-space:nowrap}
.fx div i{font-style:normal;color:#3DDC97}
</style></head><body>'''


def ring():
    """A big ring of bins round a chrome core: the in-range arc in mint, one white bin where the price sits."""
    cx, cy, r0, n = 1120, 268, 150, 132
    out = ''
    arc = lambda i: math.atan2(math.sin(i / n * 2 * math.pi - math.pi / 2 + 0.35), math.cos(i / n * 2 * math.pi - math.pi / 2 + 0.35))
    price = min(range(n), key=lambda i: abs(arc(i) - 0.18))  # the one bin the price sits in
    for i in range(n):
        a = i / n * 2 * math.pi - math.pi / 2
        d = arc(i)  # angle from the arc's centre, up and to the right
        inr = abs(d) < 0.95
        head = i == price
        L = (64 + 92 * math.exp(-(d / 0.5) ** 2) + 18 * noise(i)) if inr else (24 + 26 * noise(i))
        col = '#fff' if head else (MINT if inr else '#C9CDD6')
        op = 1 if head else (.9 if inr else .26)
        out += f'<line x1="{cx + math.cos(a) * r0:.1f}" y1="{cy + math.sin(a) * r0:.1f}" x2="{cx + math.cos(a) * (r0 + L):.1f}" y2="{cy + math.sin(a) * (r0 + L):.1f}" stroke="{col}" stroke-opacity="{op}" stroke-width="{4.4 if head else 3.4}" stroke-linecap="round"/>'
    return f'''<svg class="abs" viewBox="0 0 {W} {H}"><defs>
<radialGradient id="core" cx=".34" cy=".26" r=".85"><stop offset="0" stop-color="#fff"/><stop offset=".3" stop-color="#D5D8DF"/><stop offset=".62" stop-color="#6B6E78"/><stop offset=".9" stop-color="#141416"/></radialGradient>
<radialGradient id="sheen" cx=".5" cy=".5" r=".5"><stop offset=".72" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#fff" stop-opacity=".22"/></radialGradient>
<filter id="bl" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="9"/></filter>
<filter id="bl2" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="30"/></filter></defs>
<circle cx="{cx}" cy="{cy}" r="330" fill="none" stroke="rgba(255,255,255,.06)" stroke-width="1.4" stroke-dasharray="3 11"/>
<circle cx="{cx}" cy="{cy}" r="420" fill="none" stroke="rgba(255,255,255,.035)" stroke-width="1"/>
<g filter="url(#bl)" opacity=".55">{out}</g>{out}
<circle cx="{cx}" cy="{cy}" r="{r0 - 16}" fill="#fff" opacity=".1" filter="url(#bl2)"/>
<circle cx="{cx}" cy="{cy}" r="{r0 - 20}" fill="url(#core)"/><circle cx="{cx}" cy="{cy}" r="{r0 - 20}" fill="url(#sheen)"/>
<circle cx="{cx}" cy="{cy}" r="{r0 - 20}" fill="none" stroke="rgba(255,255,255,.28)" stroke-width="1"/></svg>'''


def cover():
    md, mb = mark('k', 0, 0, 1, False)
    return HEAD + f'''<div class="abs" style="background:radial-gradient(620px 420px at 1120px 268px,rgba(255,255,255,.075),transparent 70%),radial-gradient(520px 320px at 1000px 120px,rgba(61,220,151,.13),transparent 70%),radial-gradient(700px 300px at 260px -80px,rgba(255,255,255,.06),transparent 70%)"></div>
{ring()}
<div class="abs" style="background:linear-gradient(90deg,rgba(3,3,3,.92) 0%,rgba(3,3,3,.7) 38%,transparent 60%)"></div>
<div class="copy">
<div style="display:flex;align-items:center"><div class="brand"><svg width="42" height="42" viewBox="-33 -33 66 66"><defs>{md}</defs>{mb}</svg>Kovra</div><span class="kick"><i></i>Introducing</span></div>
<h1>Judged by<br><b>one number.</b></h1>
<div class="sub">An autonomous LP agent for Meteora DLMM on Solana. Its only scoreboard: net return vs simply holding.</div>
</div>
<div class="row"><span>kovra.live</span><span>{XSVG}@kovrasol</span><span>CA<em>Coming soon</em></span></div>
<div class="fx"><small>The scoreboard</small><div>net vs hold = (position + fees) ÷ hold <i>− 1</i></div></div>
<div class="grain"></div></body></html>'''


out = sys.argv[1] if len(sys.argv) > 1 else '.'
open(os.path.join(out, 'x-article-cover.html'), 'w').write(cover())
print('ok')
