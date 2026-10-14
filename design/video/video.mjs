// usage: node video.mjs <out.mp4> <fps> [crf] [page=intro.html]   frames go straight into ffmpeg (no frames on disk)
// page is relative to this folder and may carry a query, e.g. token/token-live.html?ca=...
import { createRequire } from 'module';
import { spawn } from 'child_process';
const require = createRequire(process.env.PLAYWRIGHT_REQUIRE_FROM || '/opt/node22/lib/node_modules/');
const { chromium } = require('playwright');
const [,, out, fpsArg, crf = '17', page = 'intro.html'] = process.argv;
const fps = +fpsArg || 30;
const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'png', '-i', '-',
  '-c:v', 'libx264', '-preset', 'slow', '-crf', crf, '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-movflags', '+faststart', out], { stdio: ['pipe', 'inherit', 'inherit'] });
const done = new Promise((res, rej) => ff.on('close', (c) => (c === 0 ? res() : rej(new Error('ffmpeg ' + c)))));
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
const errs = [];
p.on('pageerror', (e) => errs.push(e.message));
await p.goto(new URL(page, import.meta.url).href, { waitUntil: 'networkidle' });
await p.evaluate(async () => { await document.fonts.load('600 40px SG'); await document.fonts.load('500 40px SG'); await document.fonts.load('400 20px IN'); await document.fonts.load('500 20px IN'); await document.fonts.ready; });
const dur = await p.evaluate(() => window.DURATION);
const n = Math.round(dur * fps);
const t0 = Date.now();
for (let i = 0; i < n; i++) {
  await p.evaluate(([t, f]) => window.render(t, f), [i / fps, i]);
  const buf = await p.screenshot({ type: 'png' });
  if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
  if (i % 120 === 0) console.log(`frame ${i}/${n} ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}
ff.stdin.end();
await done;
await b.close();
console.log(`done: ${n} frames in ${((Date.now() - t0) / 1000).toFixed(0)}s`, errs.length ? 'ERRORS ' + errs.join(' | ') : 'no errors');
