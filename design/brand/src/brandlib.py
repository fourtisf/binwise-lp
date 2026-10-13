import math
MINT='#3DDC97'
HEAD='''<!doctype html><html><head><meta charset="utf-8"><style>
@font-face{font-family:SG;src:url(../fonts/sg.woff2) format("woff2");font-weight:300 700}
@font-face{font-family:IN;src:url(../fonts/inter.woff2) format("woff2");font-weight:100 900}
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:1500px;height:500px;overflow:hidden;background:#030303;color:#F5F5F6;font-family:IN,sans-serif;-webkit-font-smoothing:antialiased}
.abs{position:absolute;inset:0}
.grain{position:absolute;inset:0;opacity:.055;mix-blend-mode:overlay;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='220' height='220'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")}
.copy{position:absolute;left:92px;top:62px}
.kick{display:inline-flex;align-items:center;gap:9px;height:32px;padding:0 15px 0 12px;border-radius:999px;border:1px solid rgba(255,255,255,.13);background:rgba(255,255,255,.04);font-size:14px;font-weight:500;color:#CFCFD4;backdrop-filter:blur(6px)}
.kick i{width:7px;height:7px;border-radius:50%;background:#3DDC97;box-shadow:0 0 12px #3DDC97}
h1{font-family:SG;font-weight:600;letter-spacing:-.055em;line-height:.98;margin-top:18px;background:linear-gradient(180deg,#fff 35%,#9EA2AB);-webkit-background-clip:text;background-clip:text;color:transparent;padding-bottom:4px}
.row{display:flex;gap:8px;margin-top:20px}
.row span{display:inline-flex;align-items:center;gap:8px;height:34px;padding:0 15px;border-radius:999px;border:1px solid rgba(255,255,255,.12);background:rgba(10,10,11,.55);backdrop-filter:blur(8px);font-size:14px;font-weight:500;color:#F5F5F6}
.row svg{width:13px;height:13px}
.row em{font-style:normal;font-size:12.5px;color:#E7E9EE;background:rgba(201,205,214,.12);padding:3px 9px;border-radius:999px}
.row em::before{content:"";display:inline-block;width:6px;height:6px;border-radius:50%;background:#E7E9EE;margin-right:6px;vertical-align:1px}
.word{display:flex;align-items:center;gap:16px;font-family:SG;font-weight:600;letter-spacing:-.05em}
</style></head><body>'''
XSVG='<svg viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>'
ROW=f'<div class="row"><span>kovra.live</span><span>{XSVG}@kovrasol</span><span>CA<em>Coming soon</em></span></div>'
GRAIN='<div class="grain"></div>'
def noise(i): return .5+.5*math.sin(i*12.9898)*math.cos(i*4.1414)

def mark(uid, cx, cy, s, glow=True):
    """The Kovra mark (A, Bin Ring) centred at cx,cy, scale s (1 = 64-unit box)."""
    n,a0,a1,head=28,3,12,8; out=''
    for i in range(n):
        a=i/n*2*math.pi-math.pi/2; inr=a0<=i<=a1
        L=(9+7*noise(i)) if inr else (5+3*noise(i)); r0=15.5
        col='#fff' if i==head else (MINT if inr else '#C9CDD6'); op=1 if i==head else (.92 if inr else .36)
        out+=f'<line x1="{cx+math.cos(a)*r0*s:.1f}" y1="{cy+math.sin(a)*r0*s:.1f}" x2="{cx+math.cos(a)*(r0+L)*s:.1f}" y2="{cy+math.sin(a)*(r0+L)*s:.1f}" stroke="{col}" stroke-opacity="{op}" stroke-width="{2.6*s:.2f}" stroke-linecap="round"/>'
    defs=f'<radialGradient id="c{uid}" cx=".34" cy=".28" r=".85"><stop offset="0" stop-color="#fff"/><stop offset=".42" stop-color="#C9CDD6"/><stop offset=".8" stop-color="#55585F"/><stop offset="1" stop-color="#1C1D20"/></radialGradient><filter id="g{uid}" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="{2*s:.1f}"/></filter>'
    g=f'<g filter="url(#g{uid})" opacity=".6">{out}</g>' if glow else ''
    return defs, g+out+f'<circle cx="{cx}" cy="{cy}" r="{13*s:.1f}" fill="#fff" opacity=".1" filter="url(#g{uid})"/><circle cx="{cx}" cy="{cy}" r="{11*s:.1f}" fill="url(#c{uid})"/>'

# ---------------- A: Liquidity skyline (bins across the bottom, the price line flowing into the active bin)
def skyline():
    W,H=1500,500; N=118; x0,x1=-10,1510; bw=(x1-x0)/N
    lo,hi=62,96; act=80
    bars=''; glowbars=''
    for i in range(N):
        cx=x0+(i+.5)*bw
        inr=lo<=i<=hi
        if inr:
            m=(i-lo)/(hi-lo); h=120+150*math.exp(-((m-.5)/.33)**2)+18*noise(i)
        else:
            d=min(abs(i-lo),abs(i-hi)); h=34+46*math.exp(-d/22)+24*noise(i)
        if i==act: h+=26
        y=H-h+6; w=bw*.56
        if i==act:
            fill='url(#act)'; op=1
        elif inr:
            fill='url(#inr)' if i<act else 'url(#ti)'; op=1
        else:
            fill='url(#out)'; op=1
        bars+=f'<rect x="{cx-w/2:.1f}" y="{y:.1f}" width="{w:.1f}" height="{h+20:.1f}" rx="{w/2:.1f}" fill="{fill}" opacity="{op}"/>'
        if inr and i<=act: glowbars+=f'<rect x="{cx-w/2:.1f}" y="{y:.1f}" width="{w:.1f}" height="{h:.1f}" rx="{w/2:.1f}" fill="{MINT}"/>'
    # price path: wanders over the left/middle, settles into the top of the active bin
    ax=x0+(act+.5)*bw; ay=H-(120+150*math.exp(-(((act-lo)/(hi-lo)-.5)/.33)**2)+18*noise(act)+26)+6-34
    pts=[]
    for k in range(0,121):
        t=k/120; x=560+t*(ax-560)
        base=lerp=None
        y=ay+60*(1-t)**1.4*math.sin(t*9.5+.6)+26*(1-t)*math.sin(t*23)+10*math.sin(t*41)*(1-t)
        pts.append((x,y-18*(1-t)))
    d='M'+' L'.join(f'{x:.1f} {y:.1f}' for x,y in pts)
    bx0=x0+lo*bw; bx1=x0+(hi+1)*bw
    svg=f'''<svg class="abs" viewBox="0 0 {W} {H}"><defs>
<linearGradient id="inr" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="{MINT}"/><stop offset=".55" stop-color="{MINT}" stop-opacity=".45"/><stop offset="1" stop-color="{MINT}" stop-opacity="0"/></linearGradient>
<linearGradient id="ti" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#E7E9EE" stop-opacity=".55"/><stop offset="1" stop-color="#C9CDD6" stop-opacity="0"/></linearGradient>
<linearGradient id="out" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#C9CDD6" stop-opacity=".22"/><stop offset="1" stop-color="#C9CDD6" stop-opacity="0"/></linearGradient>
<linearGradient id="act" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#fff" stop-opacity=".1"/></linearGradient>
<linearGradient id="band" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="{MINT}" stop-opacity="0"/><stop offset=".6" stop-color="{MINT}" stop-opacity=".05"/><stop offset="1" stop-color="{MINT}" stop-opacity=".12"/></linearGradient>
<linearGradient id="ln" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#C9CDD6" stop-opacity="0"/><stop offset=".45" stop-color="#E7E9EE" stop-opacity=".8"/><stop offset="1" stop-color="#fff"/></linearGradient>
<filter id="bl" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="14"/></filter><filter id="bl2" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="5"/></filter></defs>
<rect x="{bx0:.1f}" y="0" width="{bx1-bx0:.1f}" height="{H}" fill="url(#band)"/>
<line x1="{bx0:.1f}" x2="{bx0:.1f}" y1="40" y2="{H}" stroke="{MINT}" stroke-opacity=".22" stroke-dasharray="2 7"/><line x1="{bx1:.1f}" x2="{bx1:.1f}" y1="40" y2="{H}" stroke="{MINT}" stroke-opacity=".22" stroke-dasharray="2 7"/>
<g filter="url(#bl)" opacity=".45">{glowbars}</g>{bars}
<path d="{d}" fill="none" stroke="#fff" stroke-width="7" opacity=".25" filter="url(#bl2)"/><path d="{d}" fill="none" stroke="url(#ln)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>
<circle cx="{ax:.1f}" cy="{ay:.1f}" r="16" fill="#fff" opacity=".35" filter="url(#bl2)"/><circle cx="{ax:.1f}" cy="{ay:.1f}" r="6" fill="#fff"/>
<line x1="{ax:.1f}" x2="{ax:.1f}" y1="{ay+10:.1f}" y2="{ay+30:.1f}" stroke="#fff" stroke-opacity=".5" stroke-dasharray="2 4"/>
</svg>'''
    md,mb=mark('k',0,0,1,False)
    html=HEAD+f'''<div class="abs" style="background:radial-gradient(700px 360px at 1050px 560px,rgba(61,220,151,.16),transparent 70%),radial-gradient(700px 300px at 380px -80px,rgba(255,255,255,.07),transparent 70%)"></div>{svg}
<div class="abs" style="background:linear-gradient(90deg,rgba(3,3,3,.85) 0%,rgba(3,3,3,.55) 32%,transparent 52%)"></div>
<div class="copy"><div class="word" style="font-size:40px"><svg width="46" height="46" viewBox="-33 -33 66 66"><defs>{md}</defs>{mb}</svg>Kovra</div>
<h1 style="font-size:58px;margin-top:16px">Liquidity that<br>manages itself.</h1>{ROW}</div>
<div style="position:absolute;right:56px;top:40px;font-size:13px;color:#5D5D65;letter-spacing:.02em">Autonomous LP agent · Meteora DLMM on Solana</div>{GRAIN}</body></html>'''
    return html

# ---------------- B: Horizon (a giant ring of bins rising like a sunrise, chrome core at the horizon)
def horizon():
    W,H=1500,500; cx,cy=1040,640; N=180; r0=250
    lines=''
    for i in range(N):
        a=i/N*2*math.pi-math.pi/2
        d=math.atan2(math.sin(a-(-math.pi/2+0.55)),math.cos(a-(-math.pi/2+0.55)))
        inr=abs(d)<0.62
        L=(150+190*math.exp(-(d/0.34)**2)+30*noise(i)) if inr else (60+70*noise(i)*math.exp(-abs(d)/1.6)+20)
        head=abs(d-0.12)<0.018
        col='#fff' if head else (MINT if inr else '#fff')
        op=1 if head else (.85 if inr else .14)
        lines+=f'<line x1="{cx+math.cos(a)*r0:.1f}" y1="{cy+math.sin(a)*r0:.1f}" x2="{cx+math.cos(a)*(r0+L):.1f}" y2="{cy+math.sin(a)*(r0+L):.1f}" stroke="{col}" stroke-opacity="{op}" stroke-width="{4.2 if head else 3}" stroke-linecap="round"/>'
    svg=f'''<svg class="abs" viewBox="0 0 {W} {H}"><defs><radialGradient id="core" cx=".36" cy=".26" r=".8"><stop offset="0" stop-color="#fff"/><stop offset=".25" stop-color="#C9CDD6"/><stop offset=".58" stop-color="#6B6E78"/><stop offset=".85" stop-color="#141416"/></radialGradient>
<filter id="bl" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="10"/></filter></defs>
<circle cx="{cx}" cy="{cy}" r="560" fill="none" stroke="rgba(255,255,255,.06)" stroke-width="1.5" stroke-dasharray="3 12"/>
<g filter="url(#bl)" opacity=".5">{lines}</g>{lines}
<circle cx="{cx}" cy="{cy}" r="{r0-12}" fill="#fff" opacity=".08" filter="url(#bl)"/><circle cx="{cx}" cy="{cy}" r="{r0-14}" fill="url(#core)"/>
<circle cx="{cx}" cy="{cy}" r="{r0-14}" fill="none" stroke="rgba(255,255,255,.25)" stroke-width="1"/></svg>'''
    md,mb=mark('h',0,0,1,False)
    html=HEAD+f'''<div class="abs" style="background:radial-gradient(800px 420px at 1040px 470px,rgba(255,255,255,.08),transparent 70%),radial-gradient(600px 300px at 1240px 260px,rgba(61,220,151,.12),transparent 70%)"></div>{svg}
<div class="abs" style="background:linear-gradient(180deg,transparent 70%,rgba(3,3,3,.6))"></div>
<div class="copy"><span class="kick"><i></i>Autonomous LP agent · Meteora DLMM on Solana</span>
<h1 style="font-size:64px">Liquidity that<br>manages itself.</h1>{ROW}</div>{GRAIN}</body></html>'''
    return html

# ---------------- C: Monolith (the mark large and lit, the name beside it)
def monolith():
    W,H=1500,500
    md,mb=mark('m',1180,250,6.2,True)
    rays=''.join(f'<line x1="1180" y1="250" x2="{1180+math.cos(a)*900:.0f}" y2="{250+math.sin(a)*900:.0f}" stroke="#fff" stroke-opacity="{.025+.02*noise(i)}" stroke-width="1"/>' for i,a in enumerate([j/72*2*math.pi for j in range(72)]))
    svg=f'''<svg class="abs" viewBox="0 0 {W} {H}"><defs>{md}</defs>{rays}
<circle cx="1180" cy="250" r="300" fill="none" stroke="rgba(255,255,255,.07)" stroke-width="1.5" stroke-dasharray="3 10"/><circle cx="1180" cy="250" r="380" fill="none" stroke="rgba(255,255,255,.04)" stroke-width="1"/>{mb}</svg>'''
    html=HEAD+f'''<div class="abs" style="background:radial-gradient(520px 420px at 1180px 250px,rgba(255,255,255,.09),transparent 70%),radial-gradient(420px 300px at 1290px 200px,rgba(61,220,151,.13),transparent 70%),radial-gradient(600px 300px at 300px -60px,rgba(255,255,255,.05),transparent 70%)"></div>{svg}
<div class="copy" style="top:58px"><div class="word grad" style="font-size:108px;line-height:1;background:linear-gradient(180deg,#fff 35%,#9EA2AB);-webkit-background-clip:text;background-clip:text;color:transparent">Kovra</div>
<div style="margin-top:14px;font-family:SG;font-weight:500;font-size:30px;letter-spacing:-.03em;color:#CFCFD4">Liquidity that manages itself.</div>
<div style="margin-top:8px;font-size:15px;color:#95959D">The autonomous LP agent for Meteora DLMM on Solana</div>{ROW}</div>{GRAIN}</body></html>'''
    return html

for name,fn in [('a-skyline',skyline),('b-horizon',horizon),('c-monolith',monolith)]:
    open(f'{name}.html','w').write(fn())
print('ok')
