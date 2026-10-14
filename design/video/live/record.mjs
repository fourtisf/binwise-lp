// Records a tour of the live site, scene by scene, as screencast frames (JPEG + the time each was painted).
// usage: node record.mjs [baseUrl=https://kovra.live] [outDir=tour]
// Writes <outDir>/<scene>/*.jpg and <outDir>/tour.json (frame times, scene lengths, caption cues).
import { createRequire } from 'module';
import { mkdirSync, writeFileSync } from 'fs';
const require = createRequire(process.env.PLAYWRIGHT_REQUIRE_FROM || '/opt/node22/lib/node_modules/');
const { chromium } = require('playwright');

const [, , base = 'https://kovra.live', out = 'tour'] = process.argv;
const W = 1920, H = 1080;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now() / 1000;

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
const cdp = await ctx.newCDPSession(page);
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

let frames = null;
cdp.on('Page.screencastFrame', async ({ data, metadata, sessionId }) => {
  if (frames) frames.push({ t: metadata.timestamp, data });
  await cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
});

async function open(path) {
  await page.goto(new URL(path, base).href, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  await sleep(3000); // live prices, charts and the agent's state come in over the socket
}
const topOf = (sel, offset = 96) => page.$eval(sel, (el, o) => el.getBoundingClientRect().top + window.scrollY - o, offset);
const grab = async () => (await page.screenshot({ type: 'jpeg', quality: 92 })).toString('base64');
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

const scenes = [];
/**
 * Records one continuous shot on a timeline of its own. `hold(ms)` films the page as it is, in real time (the live
 * chart and the agent keep moving); `glide(y, ms)` scrolls with an easing, one screenshot per 1/30 s, so scrolls
 * come out smooth however fast the machine is. `say(kicker, text)` starts a caption at that point of the timeline;
 * it runs until the next one or the end of the shot.
 */
async function scene(name, shot) {
  const cues = [], list = [];
  let vt = 0;
  const say = (kicker, text) => cues.push({ at: vt, kicker, text });
  const hold = async (ms) => {
    list.push({ t: vt, data: await grab() }); // a frame right at the start, whatever the page repaints
    frames = [];
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: W, maxHeight: H, everyNthFrame: 1 });
    const r0 = now();
    await sleep(ms);
    const r1 = now();
    await cdp.send('Page.stopScreencast');
    for (const f of frames) if (f.t > r0 && f.t < r1) list.push({ t: vt + (f.t - r0), data: f.data });
    frames = null;
    vt += r1 - r0;
  };
  const glide = async (y, ms) => {
    const y0 = await page.evaluate(() => window.scrollY);
    const n = Math.max(1, Math.round((ms / 1000) * 30));
    for (let k = 1; k <= n; k++) {
      await page.evaluate((top) => new Promise((done) => {
        window.scrollTo({ top, behavior: 'instant' });
        requestAnimationFrame(() => requestAnimationFrame(done));
      }), y0 + (y - y0) * ease(k / n));
      list.push({ t: vt, data: await grab() });
      vt += 1 / 30;
    }
  };
  await shot({ say, hold, glide });
  const dir = `${out}/${name}`;
  mkdirSync(dir, { recursive: true });
  const saved = list.map((f, i) => {
    const file = `${String(i).padStart(5, '0')}.jpg`;
    writeFileSync(`${dir}/${file}`, Buffer.from(f.data, 'base64'));
    return { file, t: f.t };
  });
  scenes.push({ name, duration: vt, cues, frames: saved });
  console.log(`${name}: ${vt.toFixed(1)}s, ${saved.length} frames`);
}

// ---------------------------------------------------------------- the tour
await open('/');
await scene('landing', async ({ say, hold, glide }) => {
  say('Live now', 'kovra.live');
  await hold(4200);
  await glide(await topOf('#live'), 1700);
  say('The public demo vault, on live prices', 'Every decision, with the reason');
  await hold(5600);
  await glide(await topOf('#product'), 1500);
  say('Built around one number', 'Net return vs simply holding');
  await hold(3800);
});

await open('/app/pools');
await scene('pools', async ({ say, hold, glide }) => {
  say('Pools', 'Every Meteora DLMM pool, scored 0–100 every minute');
  await hold(2600);
  await glide(560, 2600);
  await hold(1200);
});

await open('/app/public');
const rows = await page.locator('.lp-row').count();
if (rows) {
  await scene('public', async ({ say, hold }) => {
    say('Public portfolios', 'LPs who share their results, ranked by net vs hold');
    await hold(4600);
  });
  await open(await page.locator('.lp-row').first().getAttribute('href'));
  await scene('portfolio', async ({ say, hold, glide }) => {
    say('Proof, in public', 'Open any portfolio. No wallet needed');
    await hold(2200);
    await glide(620, 3000);
    await hold(1300);
  });
} else console.log('public: no public portfolios yet, scene skipped');

mkdirSync(out, { recursive: true });
writeFileSync(`${out}/tour.json`, JSON.stringify({ base, recordedAt: new Date().toISOString(), scenes, errors }, null, 1));
await browser.close();
console.log(errors.length ? `page errors: ${errors.join(' | ')}` : 'no page errors');
