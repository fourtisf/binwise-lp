import math, importlib.util, os
spec = importlib.util.spec_from_file_location('b', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'brandlib.py')); b = importlib.util.module_from_spec(spec); spec.loader.exec_module(b)
mark, MINT, XSVG = b.mark, b.MINT, b.XSVG
RED = '#FF6369'
HEAD = '''<!doctype html><html><head><meta charset="utf-8"><style>
@font-face{font-family:SG;src:url(../fonts/sg.woff2) format("woff2");font-weight:300 700}
@font-face{font-family:IN;src:url(../fonts/inter.woff2) format("woff2");font-weight:100 900}
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:1600px;height:900px;overflow:hidden;background:#030303;color:#F5F5F6;font-family:IN,sans-serif;-webkit-font-smoothing:antialiased}
.abs{position:absolute;inset:0}
.grain{position:absolute;inset:0;opacity:.05;mix-blend-mode:overlay;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='220' height='220'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")}
.top{position:absolute;left:80px;right:80px;top:56px;display:flex;justify-content:space-between;align-items:center}
.brand{display:flex;align-items:center;gap:12px;font-family:SG;font-weight:600;font-size:30px;letter-spacing:-.045em}
.tr{display:flex;gap:10px}
.kick{display:inline-flex;align-items:center;gap:10px;height:42px;padding:0 18px 0 15px;border-radius:999px;border:1px solid rgba(255,255,255,.13);background:rgba(255,255,255,.04);font-size:19px;font-weight:500;color:#CFCFD4}
.kick i{width:8px;height:8px;border-radius:50%;background:#3DDC97;box-shadow:0 0 12px #3DDC97}
.cnt{display:inline-flex;align-items:center;height:42px;padding:0 18px;border-radius:999px;background:linear-gradient(180deg,#fff,#DADCE1);color:#050506;font-family:SG;font-weight:600;font-size:20px}
.big{position:absolute;left:72px;top:118px;font-family:SG;font-weight:600;font-size:230px;letter-spacing:-.07em;line-height:1;background:linear-gradient(180deg,rgba(255,255,255,.16),rgba(255,255,255,0) 85%);-webkit-background-clip:text;background-clip:text;color:transparent}
h1{position:absolute;left:80px;top:300px;width:660px;font-family:SG;font-weight:600;font-size:80px;letter-spacing:-.055em;line-height:1;background:linear-gradient(180deg,#fff 35%,#9EA2AB);-webkit-background-clip:text;background-clip:text;color:transparent;padding-bottom:6px}
.desc{position:absolute;left:80px;top:500px;width:640px;font-size:27px;line-height:1.45;color:#B4B4BC}
.desc b{color:#F5F5F6;font-weight:500}
.card{position:absolute;left:800px;top:140px;width:720px;height:620px;border-radius:32px;border:1px solid rgba(255,255,255,.12);background:linear-gradient(180deg,rgba(255,255,255,.06),rgba(255,255,255,.015));box-shadow:inset 0 1px 0 rgba(255,255,255,.08),0 60px 120px -50px rgba(0,0,0,.95);overflow:hidden;padding:30px}
.ch{display:flex;justify-content:space-between;align-items:center;font-size:20px;color:#CFCFD4;font-weight:500}
.live{display:inline-flex;align-items:center;gap:8px;font-size:17px;color:#3DDC97}.live i{width:8px;height:8px;border-radius:50%;background:#3DDC97;box-shadow:0 0 10px #3DDC97}
.row{display:flex;align-items:center;gap:16px;height:72px;padding:0 18px;border-radius:20px;border:1px solid rgba(255,255,255,.08);background:rgba(255,255,255,.025);font-size:24px;font-weight:500;margin-top:12px}
.row.on{border-color:rgba(61,220,151,.35);background:rgba(61,220,151,.07)}
.row img{width:40px;height:40px;border-radius:11px}
.pill{margin-left:auto;display:inline-flex;align-items:center;gap:8px;height:36px;padding:0 15px;border-radius:999px;font-size:17px;font-weight:500;white-space:nowrap}
.pill i{width:7px;height:7px;border-radius:50%;background:currentColor}
.pill.in{background:rgba(61,220,151,.12);color:#3DDC97;border:1px solid rgba(61,220,151,.28)}
.pill.out{background:rgba(255,99,105,.12);color:#FF6369;border:1px solid rgba(255,99,105,.28)}
.pill.dim{background:rgba(255,255,255,.05);color:#95959D;border:1px solid rgba(255,255,255,.1)}
.lab{font-size:17px;color:#95959D;margin:22px 0 10px}
.seg{display:flex;gap:4px;padding:5px;border-radius:999px;border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.03)}
.seg span{flex:1;text-align:center;height:48px;line-height:48px;border-radius:999px;font-size:20px;font-weight:500;color:#95959D}
.seg span.on{background:linear-gradient(180deg,#fff,#DADCE1);color:#050506}
.lim{display:flex;justify-content:space-between;align-items:center;font-size:21px;padding:12px 2px;border-top:1px solid rgba(255,255,255,.07);color:#CFCFD4}
.tg{width:46px;height:26px;border-radius:999px;background:#3DDC97;position:relative}.tg::after{content:"";position:absolute;right:3px;top:3px;width:20px;height:20px;border-radius:50%;background:#fff}
.toks{display:inline-flex}.toks img{width:38px;height:38px;border-radius:50%;box-shadow:0 0 0 3px #101012}.toks img+img{margin-left:-11px}
.sc{position:relative;width:52px;height:52px;flex:none}.sc svg{position:absolute;inset:0;transform:rotate(-90deg)}.sc b{position:absolute;inset:0;display:grid;place-items:center;font-family:SG;font-weight:600;font-size:19px}
.rk{font-family:SG;font-weight:600;font-size:20px;color:#5D5D65;width:30px}
.bar{display:grid;grid-template-columns:200px 1fr 64px;align-items:center;gap:14px;font-size:19px;color:#CFCFD4;padding:7px 0}
.bar i{height:8px;border-radius:999px;background:rgba(255,255,255,.07);position:relative}.bar i em{position:absolute;top:0;bottom:0;border-radius:999px}
.bar b{text-align:right;font-family:SG;font-weight:600}
.chk{border-radius:22px;border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.03);padding:16px 20px;margin-top:16px}
.kv{display:flex;justify-content:space-between;font-size:21px;padding:6px 0;color:#CFCFD4}.kv b{font-family:SG;font-weight:600;color:#F5F5F6}
.note{position:absolute;right:30px;bottom:20px;font-size:15px;color:#5D5D65}
.foot{position:absolute;left:80px;right:80px;bottom:50px;display:flex;justify-content:space-between;align-items:center}
.prog{display:flex;gap:10px;align-items:center;font-size:18px;color:#95959D}.prog i{width:72px;height:6px;border-radius:999px;background:rgba(255,255,255,.1)}.prog i.on{background:linear-gradient(90deg,#3DDC97,#E7E9EE);box-shadow:0 0 14px rgba(61,220,151,.5)}
.pills{display:flex;gap:10px}.pills span{display:inline-flex;align-items:center;gap:9px;height:46px;padding:0 18px;border-radius:999px;border:1px solid rgba(255,255,255,.12);background:rgba(10,10,11,.6);font-size:18px;font-weight:500}
.pills svg{width:15px;height:15px}.pills em{font-style:normal;font-size:15px;color:#E7E9EE;background:rgba(201,205,214,.12);padding:4px 11px;border-radius:999px}
</style></head><body>'''
md, mb = mark('k', 0, 0, 1, False)
BRAND = f'<div class="brand"><svg width="44" height="44" viewBox="-33 -33 66 66"><defs>{md}</defs>{mb}</svg>Kovra</div>'
PILLS = f'<div class="pills"><span>kovra.live</span><span>{XSVG}@kovrasol</span><span>CA<em>Coming soon</em></span></div>'
GRAIN = '<div class="grain"></div>'

def ring(score, color, size=52, w=5):
    r = size / 2 - w
    return f'<span class="sc"><svg viewBox="0 0 {size} {size}"><circle cx="{size/2}" cy="{size/2}" r="{r}" fill="none" stroke="rgba(255,255,255,.08)" stroke-width="{w}"/><circle cx="{size/2}" cy="{size/2}" r="{r}" fill="none" stroke="{color}" stroke-width="{w}" stroke-linecap="round" pathLength="100" stroke-dasharray="{score} 100"/></svg><b>{score}</b></span>'

def art1():
    rows = ''
    for i, (logo, name) in enumerate([('phantom', 'Phantom'), ('backpack', 'Backpack'), ('solflare', 'Solflare')]):
        p = '<span class="pill in"><i></i>Connected</span>' if i == 0 else '<span class="pill dim">Detected</span>'
        rows += f'<div class="row{" on" if i == 0 else ""}"><img src="assets/{logo}.svg">{name}{p}</div>'
    lims = ''.join(f'<div class="lim"><span>{t}</span><span style="display:flex;align-items:center;gap:14px"><b style="font-family:SG;font-weight:600;color:#F5F5F6">{v}</b><span class="tg"></span></span></div>' for t, v in [('Max per pool', '25%'), ('Exit on 7-day trend', '−12%'), ('Daily loss stop', '4%')])
    return f'''<div class="ch"><span>Connect a wallet</span><span class="live"><i></i>One signature, no fee</span></div>{rows}
<div class="lab">Risk profile</div><div class="seg"><span>Conservative</span><span class="on">Balanced</span><span>Aggressive</span></div>
<div style="margin-top:14px">{lims}</div>'''

def art2():
    pools = [('PENGU', 'SOL', 78, 'in', 'Deploy'), ('JUP', 'SOL', 73, 'in', 'Deploy'), ('JUP', 'USDC', 67, 'in', 'Deploy'), ('WIF', 'SOL', 41, 'out', 'Avoid, downtrend')]
    rows = ''
    for i, (a, bb, s, c, lab) in enumerate(pools):
        col = MINT if s >= 62 else RED
        rows += f'<div class="row" style="height:66px;margin-top:10px"><span class="rk">0{i+1}</span><span class="toks"><img src="assets/{a}.png"><img src="assets/{bb}.png"></span>{a} / {bb}<span style="margin-left:auto;display:flex;align-items:center;gap:14px">{ring(s, col)}<span class="pill {c}" style="margin-left:0"><i></i>{lab}</span></span></div>'
    bars = ''
    for n, v, w, c in [('Volume / TVL', '+29', 72, MINT), ('7-day trend', '+10', 26, MINT), ('Holder quality', '+11', 28, MINT), ('Volatility', '−11', 28, RED)]:
        left = 50 if c == MINT else 50 - w / 2
        bars += f'<div class="bar"><span>{n}</span><i><em style="left:{left}%;width:{w/2}%;background:{c}"></em></i><b style="color:{c}">{v}</b></div>'
    return f'''<div class="ch"><span>Scanning 214 pools · 38 passed</span><span class="live"><i></i>Every minute</span></div>{rows}
<div class="lab" style="margin-top:20px">Why PENGU / SOL scores 78</div>{bars}<div class="note">Example data</div>'''

def art3():
    W, H = 660, 250
    ss = lambda a, b2, x: (lambda t: t * t * (3 - 2 * t))(max(0, min(1, (x - a) / (b2 - a))))
    price = lambda i: 100 + 7.5 * ss(60, 92, i) + 2.1 * math.sin(i * .25) + 1.0 * math.sin(i * .63 + 1.3)
    n = 120; Y = lambda v: H - 20 - (v - 94) / 21 * (H - 40); X = lambda i: 10 + i / (n - 1) * 500
    pts = ' '.join(f'{X(i):.1f},{Y(price(i)):.1f}' for i in range(n))
    R = 92
    lo0, hi0, lo1, hi1 = 96, 104, 103.6, 111.6
    band = f'<rect x="0" y="{Y(hi0):.1f}" width="{X(R):.1f}" height="{Y(lo0)-Y(hi0):.1f}" fill="rgba(61,220,151,.06)"/><rect x="{X(R):.1f}" y="{Y(hi1):.1f}" width="{W-X(R):.1f}" height="{Y(lo1)-Y(hi1):.1f}" fill="rgba(61,220,151,.09)"/>'
    edges = f'<line x1="0" x2="{X(R):.1f}" y1="{Y(hi0):.1f}" y2="{Y(hi0):.1f}" stroke="rgba(61,220,151,.4)"/><line x1="0" x2="{X(R):.1f}" y1="{Y(lo0):.1f}" y2="{Y(lo0):.1f}" stroke="rgba(61,220,151,.4)"/><line x1="{X(R):.1f}" x2="{W}" y1="{Y(hi1):.1f}" y2="{Y(hi1):.1f}" stroke="rgba(61,220,151,.5)"/><line x1="{X(R):.1f}" x2="{W}" y1="{Y(lo1):.1f}" y2="{Y(lo1):.1f}" stroke="rgba(61,220,151,.5)"/>'
    bins = ''.join(f'<rect x="530" y="{Y(lo1 + (k+1)*(hi1-lo1)/14)+2:.1f}" width="{60+50*math.exp(-((k-6.5)/4)**2):.1f}" height="{(Y(lo1)-Y(hi1))/14-4:.1f}" rx="4" fill="{"#fff" if k==4 else (MINT if k<4 else "#C9CDD6")}" opacity="{1 if k==4 else (.8 if k<4 else .3)}"/>' for k in range(14))
    mk = f'<line x1="{X(R):.1f}" x2="{X(R):.1f}" y1="{Y(price(R))+12:.1f}" y2="{H}" stroke="rgba(201,205,214,.35)" stroke-dasharray="3 5"/><circle cx="{X(R):.1f}" cy="{Y(price(R)):.1f}" r="8" fill="#080808" stroke="#E7E9EE" stroke-width="3"/><text x="{X(R)-16:.1f}" y="{Y(price(R))+36:.1f}" text-anchor="end" font-family="IN" font-weight="600" font-size="19" fill="#E7E9EE" stroke="#0E0E10" stroke-width="7" paint-order="stroke" stroke-linejoin="round">Re-centered</text>'
    svg = f'<svg viewBox="0 0 {W} {H}" style="width:100%;height:{H}px;display:block;margin-top:14px">{band}{edges}<polyline points="{pts}" fill="none" stroke="#E7E9EE" stroke-width="3" stroke-linejoin="round"/>{mk}{bins}<circle cx="{X(n-1):.1f}" cy="{Y(price(n-1)):.1f}" r="7" fill="#fff"/></svg>'
    return f'''<div class="ch"><span>JUP / SOL · Spot</span><span class="pill in" style="margin-left:0"><i></i>In range</span></div>{svg}
<div class="chk"><div class="kv"><span>Fees expected, next 6h</span><b>$4.20</b></div><div class="kv"><span>Cost to move (tx, slippage, priority)</span><b>$1.35</b></div>
<div class="kv" style="border-top:1px solid rgba(255,255,255,.08);margin-top:6px;padding-top:12px"><span>3.1× the cost · needs 1.5×</span><b style="color:{MINT}">Re-center ✓</b></div></div><div class="note">Example</div>'''

def art4():
    W, H = 660, 220; n = 90
    p = lambda i: 108 - 9 * (1 / (1 + math.exp(-(i - 50) / 8))) + 1.6 * math.sin(i * .4) + .8 * math.sin(i * 1.1)
    def ema(k):
        out = []; a = 2 / (k + 1); e = p(0)
        for i in range(n): e = a * p(i) + (1 - a) * e; out.append(e)
        return out
    e20, e50 = ema(14), ema(30)
    Y = lambda v: 20 + (110 - v) / 14 * (H - 40); X = lambda i: 10 + i / (n - 1) * (W - 20)
    line = lambda arr, c, w, dash='': f'<polyline points="{" ".join(f"{X(i):.1f},{Y(v):.1f}" for i, v in enumerate(arr))}" fill="none" stroke="{c}" stroke-width="{w}" {dash} stroke-linejoin="round"/>'
    cross = next(i for i in range(30, n) if e20[i] < e50[i])
    svg = f'''<svg viewBox="0 0 {W} {H}" style="width:100%;height:{H}px;display:block;margin-top:14px">{line([p(i) for i in range(n)], 'rgba(231,233,238,.85)', 2.5)}{line(e20, MINT, 2.5, 'stroke-dasharray="1 0"')}{line(e50, '#C9CDD6', 2.5, 'stroke-dasharray="6 6"')}
<circle cx="{X(cross):.1f}" cy="{Y(e20[cross]):.1f}" r="9" fill="#080808" stroke="{RED}" stroke-width="3"/><text x="{X(cross):.1f}" y="{Y(e20[cross])+42:.1f}" text-anchor="middle" font-family="IN" font-weight="600" font-size="19" fill="{RED}" stroke="#0E0E10" stroke-width="7" paint-order="stroke" stroke-linejoin="round">Exited here</text></svg>'''
    rules = ''.join(f'<div class="kv"><span>{t}</span><b style="color:{c}">{v}</b></div>' for t, v, c in [('7-day trend −14.6% (your limit −12%)', 'Triggered', RED), ('EMA20 crossed below EMA50, 1h', 'Triggered', RED), ('Daily loss stop 4%', 'Clear', MINT)])
    return f'''<div class="ch"><span>WIF / SOL · exit rules</span><span style="display:flex;gap:16px;font-size:16px;color:#95959D"><span style="color:{MINT}">— EMA20</span><span>- - EMA50</span></span></div>{svg}
<div class="chk" style="margin-top:8px">{rules}</div>
<div class="row" style="margin-top:14px;height:64px"><span>Withdraw to your wallet</span><span class="pill" style="background:linear-gradient(180deg,#fff,#DADCE1);color:#050506">Anytime</span></div><div class="note">Example</div>'''

STEPS = [
    ('Connect.', 'Link <b>Phantom, Backpack, Solflare</b> or any Solana wallet. One signature to log in: no transaction, no fee. Then pick a risk profile and set your limits.', art1),
    ('Scan &amp; score.', 'Every minute the agent pulls <b>every Meteora DLMM pool</b>, drops the ones that fail your filters (TVL, market cap, holder check) and scores the rest <b>0–100</b>.', art2),
    ('Deploy &amp; re-center.', 'It enters the top scores with a shape that fits the pool. When price leaves the range it waits a tick, then moves <b>only if 6 hours of fees beat 1.5× the cost</b>.', art3),
    ('Exit &amp; withdraw.', 'Out when the <b>7-day trend breaks your limit</b> or the hourly EMAs cross down; a daily loss stop guards the vault. <b>Withdraw to your wallet anytime.</b>', art4),
]
for i, (t, d, art) in enumerate(STEPS):
    prog = ''.join(f'<i class="{"on" if k <= i else ""}"></i>' for k in range(4))
    html = HEAD + f'''<div class="abs" style="background:radial-gradient(900px 420px at 30% -10%,rgba(255,255,255,.07),transparent 70%),radial-gradient(700px 400px at 80% 60%,rgba(61,220,151,.09),transparent 70%)"></div>
<div class="top">{BRAND}<div class="tr"><span class="kick"><i></i>How it works</span><span class="cnt">{i+1} / 4</span></div></div>
<div class="big">0{i+1}</div><h1>{t}</h1><div class="desc">{d}</div>
<div class="card">{art()}</div>
<div class="foot"><div class="prog">{prog}<span style="margin-left:6px">Step {i+1} of 4</span></div>{PILLS}</div>{GRAIN}</body></html>'''
    open(f'step-{i+1}.html', 'w').write(html)
print('ok')
