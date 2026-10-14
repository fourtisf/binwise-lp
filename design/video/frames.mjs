// usage: node frames.mjs <outDir> <fps> [t1,t2,...] [page=intro.html]   (no list: every frame of the video)
import { createRequire } from 'module';
const require = createRequire(process.env.PLAYWRIGHT_REQUIRE_FROM || '/opt/node22/lib/node_modules/');
const { chromium } = require('playwright');
import { mkdirSync } from 'fs';
const [,, out, fpsArg, list, page = 'intro.html'] = process.argv;
const fps = +fpsArg || 30;
mkdirSync(out, { recursive: true });
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
const errs = [];
p.on('pageerror', (e) => errs.push(e.message));
await p.goto(new URL(page, import.meta.url).href, { waitUntil: 'networkidle' });
await p.evaluate(async () => { await document.fonts.load('600 40px SG'); await document.fonts.load('500 40px SG'); await document.fonts.load('400 20px IN'); await document.fonts.load('500 20px IN'); await document.fonts.ready; });
const dur = await p.evaluate(() => window.DURATION);
const times = list ? list.split(',').map(Number) : Array.from({ length: Math.round(dur * fps) }, (_, i) => i / fps);
const t0 = Date.now();
for (let i = 0; i < times.length; i++) {
  await p.evaluate(([t, f]) => window.render(t, f), [times[i], i]);
  const name = list ? `t${times[i].toFixed(2)}` : `f${String(i).padStart(5, '0')}`;
  await p.screenshot({ path: `${out}/${name}.png` });
}
await b.close();
console.log(`${times.length} frames in ${((Date.now() - t0) / 1000).toFixed(1)}s`, errs.length ? 'ERRORS: ' + errs.join(' | ') : 'no errors');
