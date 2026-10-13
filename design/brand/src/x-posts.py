import math, importlib.util
spec = importlib.util.spec_from_file_location('b', __import__('os').path.join(__import__('os').path.dirname(__file__), 'brandlib.py')); b = importlib.util.module_from_spec(spec); spec.loader.exec_module(b)
mark, MINT, XSVG = b.mark, b.MINT, b.XSVG
HEAD = '''<!doctype html><html><head><meta charset="utf-8"><style>
@font-face{font-family:SG;src:url(../fonts/sg.woff2) format("woff2");font-weight:300 700}
@font-face{font-family:IN;src:url(../fonts/inter.woff2) format("woff2");font-weight:100 900}
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:1600px;height:900px;overflow:hidden;background:#030303;color:#F5F5F6;font-family:IN,sans-serif;-webkit-font-smoothing:antialiased}
.abs{position:absolute;inset:0}
.grain{position:absolute;inset:0;opacity:.05;mix-blend-mode:overlay;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='220' height='220'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")}
.top{position:absolute;left:80px;right:80px;top:64px;display:flex;justify-content:space-between;align-items:center}
.brand{display:flex;align-items:center;gap:12px;font-family:SG;font-weight:600;font-size:30px;letter-spacing:-.045em}
.kick{display:inline-flex;align-items:center;gap:10px;height:40px;padding:0 18px 0 15px;border-radius:999px;border:1px solid rgba(255,255,255,.13);background:rgba(255,255,255,.04);font-size:18px;font-weight:500;color:#CFCFD4}
.kick i{width:8px;height:8px;border-radius:50%;background:#3DDC97;box-shadow:0 0 12px #3DDC97}
h1{position:absolute;left:80px;top:140px;font-family:SG;font-weight:600;font-size:78px;letter-spacing:-.055em;line-height:1;background:linear-gradient(180deg,#fff 35%,#9EA2AB);-webkit-background-clip:text;background-clip:text;color:transparent;padding-bottom:6px}
.card{position:absolute;border-radius:28px;border:1px solid rgba(255,255,255,.11);background:linear-gradient(180deg,rgba(255,255,255,.055),rgba(255,255,255,.015));box-shadow:inset 0 1px 0 rgba(255,255,255,.08),0 40px 80px -40px rgba(0,0,0,.9);overflow:hidden}
.foot{position:absolute;left:80px;right:80px;bottom:52px;display:flex;justify-content:space-between;align-items:center;font-size:19px;color:#95959D}
.foot .pills{display:flex;gap:10px}
.foot .pills span{display:inline-flex;align-items:center;gap:9px;height:44px;padding:0 18px;border-radius:999px;border:1px solid rgba(255,255,255,.12);background:rgba(10,10,11,.6);font-size:18px;font-weight:500;color:#F5F5F6}
.foot svg{width:15px;height:15px}
.foot em{font-style:normal;font-size:15px;color:#E7E9EE;background:rgba(201,205,214,.12);padding:4px 11px;border-radius:999px}
.n{font-family:SG;font-weight:600;font-size:22px;color:#5D5D65;letter-spacing:-.02em}
.t{font-family:SG;font-weight:600;font-size:32px;letter-spacing:-.035em;line-height:1.08}
.d{font-size:20px;line-height:1.4;color:#AEAEB6;margin-top:10px}
.ic{width:64px;height:64px;border-radius:20px;display:grid;place-items:center;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1)}
.ic svg{width:30px;height:30px}
.art{height:150px;margin:20px -4px 22px}.art svg{display:block;width:100%;height:100%}
</style></head><body>'''
GRAIN = '<div class="grain"></div>'
md, mb = mark('k', 0, 0, 1, False)
BRAND = f'<div class="brand"><svg width="44" height="44" viewBox="-33 -33 66 66"><defs>{md}</defs>{mb}</svg>Kovra</div>'
FOOT = f'<div class="pills"><span>kovra.live</span><span>{XSVG}@kovrasol</span><span>CA<em>Coming soon</em></span></div>'

# ------------------------------------------------ How it works: four steps along one line
def step_art(k):
    """A small picture of each step, drawn in the brand's language."""
    if k == 0:  # wallet + shield
        return f'''<svg viewBox="0 0 220 120"><rect x="40" y="22" width="140" height="84" rx="18" fill="rgba(255,255,255,.04)" stroke="rgba(255,255,255,.22)" stroke-width="2"/><rect x="120" y="50" width="60" height="28" rx="14" fill="rgba(61,220,151,.14)" stroke="{MINT}" stroke-width="2"/><circle cx="138" cy="64" r="5" fill="{MINT}"/><path d="M60 22 L140 8" stroke="rgba(255,255,255,.18)" stroke-width="2"/></svg>'''
    if k == 1:  # score rings
        out = '<svg viewBox="0 0 220 120">'
        for i, (x, s) in enumerate([(50, 78), (110, 73), (170, 41)]):
            c = MINT if s >= 62 else '#FF6369'
            out += f'<circle cx="{x}" cy="60" r="24" fill="none" stroke="rgba(255,255,255,.08)" stroke-width="6"/><circle cx="{x}" cy="60" r="24" fill="none" stroke="{c}" stroke-width="6" stroke-linecap="round" pathLength="100" stroke-dasharray="{s} 100" transform="rotate(-90 {x} 60)"/><text x="{x}" y="67" text-anchor="middle" font-family="SG" font-weight="600" font-size="19" fill="#F5F5F6">{s}</text>'
        return out + '</svg>'
    if k == 2:  # range band + bins + price re-centered
        pts = ' '.join(f'{12+i*4.2:.1f},{70-18*math.sin(i*.31)-8*math.sin(i*.9)+ (0 if i<24 else -22*min(1,(i-24)/6)):.1f}' for i in range(36))
        bins = ''.join(f'<rect x="176" y="{30+i*6.5:.1f}" width="{20+18*math.exp(-((i-5.5)/3.2)**2):.1f}" height="4" rx="2" fill="{"#fff" if i==4 else (MINT if i>4 else "#C9CDD6")}" opacity="{1 if i==4 else (.8 if i>4 else .35)}"/>' for i in range(12))
        return f'''<svg viewBox="0 0 220 120"><rect x="0" y="28" width="220" height="78" fill="rgba(61,220,151,.07)"/><line x1="0" x2="220" y1="28" y2="28" stroke="rgba(61,220,151,.4)"/><line x1="0" x2="220" y1="106" y2="106" stroke="rgba(61,220,151,.4)"/><polyline points="{pts}" fill="none" stroke="#E7E9EE" stroke-width="2.5" stroke-linejoin="round"/>{bins}</svg>'''
    # exit arrow + wallet
    return f'''<svg viewBox="0 0 220 120"><polyline points="10,40 40,52 66,44 92,62 118,58 146,86 170,96" fill="none" stroke="#FF6369" stroke-width="2.5" stroke-linejoin="round" opacity=".85"/><circle cx="92" cy="62" r="7" fill="#080808" stroke="#E7E9EE" stroke-width="2.5"/><path d="M150 30 h40 M178 18 l12 12 -12 12" fill="none" stroke="{MINT}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><text x="92" y="38" text-anchor="middle" font-family="IN" font-weight="600" font-size="13" fill="#E7E9EE">Exited</text></svg>'''

STEPS = [
    ('Connect', 'Link Phantom, Backpack, Solflare or more, then pick a risk profile.'),
    ('Scan &amp; score', 'Every minute, each Meteora DLMM pool is scored 0–100.'),
    ('Deploy &amp; re-center', 'Moves only when 6 hours of fees beat 1.5× the cost.'),
    ('Exit &amp; withdraw', 'Out on a broken trend or your loss limit. Withdraw anytime.'),
]
def how():
    cards = ''
    W, gap, x0, y0, h = 345, 20, 80, 340, 420
    for i, (t, d) in enumerate(STEPS):
        x = x0 + i * (W + gap)
        cards += f'''<div class="card" style="left:{x}px;top:{y0}px;width:{W}px;height:{h}px;padding:26px 26px 28px">
<div style="display:flex;justify-content:space-between;align-items:center"><span class="n">0{i+1}</span><span style="width:12px;height:12px;border-radius:50%;background:{MINT if i<3 else '#E7E9EE'};box-shadow:0 0 14px {MINT}"></span></div>
<div class="art">{step_art(i)}</div><div class="t">{t}</div><div class="d">{d}</div></div>'''
    line = f'<svg class="abs" viewBox="0 0 1600 900"><defs><linearGradient id="lg" x1="0" x2="1"><stop offset="0" stop-color="{MINT}"/><stop offset="1" stop-color="#E7E9EE"/></linearGradient></defs><line x1="{x0+30}" x2="{x0+3*(W+gap)+W-30}" y1="{y0-1}" y2="{y0-1}" stroke="url(#lg)" stroke-opacity=".5" stroke-width="2"/></svg>'
    return HEAD + f'''<div class="abs" style="background:radial-gradient(900px 420px at 50% -10%,rgba(255,255,255,.07),transparent 70%),radial-gradient(700px 360px at 85% 105%,rgba(61,220,151,.10),transparent 70%)"></div>
<div class="top">{BRAND}<span class="kick"><i></i>How it works</span></div>
<h1>Four steps.<br>Zero babysitting.</h1>
<div style="position:absolute;right:80px;top:226px;width:600px;text-align:right;font-size:22px;line-height:1.45;color:#AEAEB6">An autonomous agent runs your Meteora DLMM liquidity on Solana, with the reason for every move on the record.</div>
{line}{cards}
<div class="foot"><span>Judged by one number: <b style="color:#F5F5F6;font-weight:500">net return vs just holding.</b></span>{FOOT}</div>{GRAIN}</body></html>'''

# ------------------------------------------------ Features: eight tiles
ICONS = {
    'shield': f'<svg viewBox="0 0 24 24" fill="none" stroke="{MINT}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v6c0 4.5-3 7.6-7 9-4-1.4-7-4.5-7-9V6z"/><path d="M9 12l2 2 4-4"/></svg>',
    'score': f'<svg viewBox="0 0 24 24" fill="none" stroke="{MINT}" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="8" stroke-opacity=".3"/><path d="M12 4a8 8 0 0 1 7.6 10.5"/><path d="M12 8v4l3 2"/></svg>',
    'range': f'<svg viewBox="0 0 24 24" fill="none" stroke="{MINT}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7h18M3 17h18" stroke-opacity=".45"/><path d="M3 14l4-3 3 2 4-5 3 3 4-2"/></svg>',
    'exit': '<svg viewBox="0 0 24 24" fill="none" stroke="#FF6369" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7l5 4 4-2 4 5 5 3"/><path d="M17 19h4v-4"/></svg>',
    'stop': '<svg viewBox="0 0 24 24" fill="none" stroke="#E7E9EE" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="8"/><path d="M10 9v6M14 9v6"/></svg>',
    'comp': '<svg viewBox="0 0 24 24" fill="none" stroke="#8DA9FF" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12a8 8 0 1 1-2.3-5.6"/><path d="M20 4v4h-4"/></svg>',
    'sim': '<svg viewBox="0 0 24 24" fill="none" stroke="#E7E9EE" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="5" width="16" height="14" rx="3"/><path d="M8 10l2 2-2 2M13 14h3"/></svg>',
    'wallet': f'<svg viewBox="0 0 24 24" fill="none" stroke="{MINT}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="18" height="13" rx="3"/><path d="M16 12.5h2"/><path d="M6 6l9-3 1 3"/></svg>',
}
FEATS = [
    ('shield', 'Live token review', 'Top-holder concentration, market cap and TVL, checked first.'),
    ('score', 'Every pool scored', 'Fees per dollar, volatility and trend. 0–100, every minute.'),
    ('range', 'Re-centers when it pays', 'Fees ahead must beat 1.5× the cost of moving.'),
    ('exit', 'Exits on broken trends', '7-day trend and hourly EMA cross, on your limits.'),
    ('stop', 'Daily loss stop', 'Hit your daily limit and the agent heads for the exit.'),
    ('comp', 'Auto-compound', 'Claims fees and reinvests when gas is under 1%.'),
    ('sim', 'Simulated before sent', 'Every transaction dry-run first, plus a kill switch.'),
    ('wallet', 'Deposit &amp; withdraw anytime', 'Your funds come back to your wallet whenever you ask.'),
]
def features():
    tiles = ''
    W, H, gx, gy, x0, y0 = 346, 210, 18, 18, 80, 300
    for i, (ic, t, d) in enumerate(FEATS):
        r, c = divmod(i, 4)
        x, y = x0 + c * (W + gx), y0 + r * (H + gy)
        tiles += f'''<div class="card" style="left:{x}px;top:{y}px;width:{W}px;height:{H}px;padding:24px 24px">
<div style="display:flex;align-items:center;gap:16px"><span class="ic" style="width:56px;height:56px;border-radius:18px">{ICONS[ic]}</span><div class="t" style="font-size:27px">{t}</div></div>
<div class="d" style="font-size:19px;margin-top:16px">{d}</div></div>'''
    return HEAD + f'''<div class="abs" style="background:radial-gradient(900px 420px at 50% -10%,rgba(255,255,255,.07),transparent 70%),radial-gradient(700px 360px at 12% 105%,rgba(61,220,151,.09),transparent 70%)"></div>
<div class="top">{BRAND}<span class="kick"><i></i>Everything Kovra does</span></div>
<h1 style="font-size:72px">Your LP desk,<br>run by an agent.</h1>
<div style="position:absolute;right:80px;top:200px;width:560px;text-align:right;font-size:22px;line-height:1.45;color:#AEAEB6">Every move logged with a plain-language reason, and pushed to Telegram if you link it.</div>
{tiles}
<div class="foot"><span>The only scoreboard: <b style="color:#F5F5F6;font-weight:500">net vs hold, not APR.</b></span>{FOOT}</div>{GRAIN}</body></html>'''

open('how-it-works.html', 'w').write(how())
open('features.html', 'w').write(features())
print('ok')
